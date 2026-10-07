#!/usr/bin/env node
import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
// Durable inbox only. Business authorization and task execution belong to dispatch.
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB = _publicDataPath("运行中心/event-ingest.sqlite");
const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(value).digest('hex');
const states = ['pending', 'dispatching', 'retry', 'dispatched', 'failed'];
const origins = ['local', 'external', 'simulation'];
export class EventIngestError extends Error {
  constructor(message, code = 'invalid_event', status = 400, detail = {}) {
    super(message); this.name = 'EventIngestError'; this.code = code; this.status = status; this.detail = detail;
  }
}
function requireText(value, name, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value))
    throw new EventIngestError(`${name} must be a nonempty string of at most ${max} characters`);
  return value;
}
function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new EventIngestError(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function jsonCopy(value, name) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { throw new EventIngestError(`${name} must be JSON serializable`); }
}
export function normalizeEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new EventIngestError('event must be a JSON object');
  const source = requireText(input.source, 'source', 200);
  const event_id = requireText(input.event_id, 'event_id');
  const type = requireText(input.type, 'type', 200);
  const origin_kind = input.origin_kind ?? 'local';
  if (!origins.includes(origin_kind)) throw new EventIngestError('origin_kind must be local, external or simulation');
  if (!Object.hasOwn(input, 'data')) throw new EventIngestError('data is required');
  const context = jsonCopy(input.context ?? {}, 'context');
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new EventIngestError('context must be an object');
  const result = {source, event_id, type, subject: input.subject ?? null, occurred_at: input.occurred_at ?? null,
    data: jsonCopy(input.data, 'data'), context, origin_kind};
  if (result.subject !== null) requireText(result.subject, 'subject');
  if (result.occurred_at !== null) {
    requireText(result.occurred_at, 'occurred_at', 100);
    if (!Number.isFinite(Date.parse(result.occurred_at))) throw new EventIngestError('occurred_at must be a valid timestamp');
    result.occurred_at = new Date(result.occurred_at).toISOString();
  }
  return result;
}
const schema = `
CREATE TABLE IF NOT EXISTS event_ingest_events (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, event_id TEXT NOT NULL, type TEXT NOT NULL,
  payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','dispatching','retry','dispatched','failed')),
  received_at TEXT NOT NULL, last_received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  delivery_count INTEGER NOT NULL DEFAULT 1, attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT, lease_until TEXT, claim_hash TEXT, retry_at TEXT,
  dispatch_ref TEXT, last_error TEXT, UNIQUE(source,event_id)
);
CREATE INDEX IF NOT EXISTS event_ingest_ready ON event_ingest_events(state,retry_at,lease_until,received_at);
CREATE TABLE IF NOT EXISTS event_ingest_receipts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_ref TEXT NOT NULL,
  at TEXT NOT NULL, outcome TEXT NOT NULL, transport TEXT NOT NULL,
  delivery_id TEXT, verification TEXT NOT NULL, payload_digest TEXT NOT NULL,
  raw_body BLOB, conflict_payload_json TEXT,
  FOREIGN KEY(event_ref) REFERENCES event_ingest_events(id)
);
CREATE INDEX IF NOT EXISTS event_ingest_receipts_event ON event_ingest_receipts(event_ref,seq);
CREATE TABLE IF NOT EXISTS event_ingest_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_ref TEXT NOT NULL, at TEXT NOT NULL,
  action TEXT NOT NULL, detail_json TEXT NOT NULL,
  FOREIGN KEY(event_ref) REFERENCES event_ingest_events(id)
);`;

export class EventStore {
  constructor(options = {}) {
    if (typeof options === 'string') options = {dbPath: options};
    this.dbPath = path.resolve(options.dbPath ?? process.env.EVENT_INGEST_DB ?? DEFAULT_DB);
    this.maxEventBytes = integer(options.maxEventBytes ?? 1048576, 'maxEventBytes', 256, 16777216);
    fs.mkdirSync(path.dirname(this.dbPath), {recursive: true});
    this.db = new DatabaseSync(this.dbPath);
    try {
      this.db.exec(`PRAGMA busy_timeout=${integer(options.busyTimeoutMs ?? 3000, 'busyTimeoutMs', 0, 60000)};
        PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;`);
      this.transaction(() => this.db.exec(schema));
    } catch (error) { this.db.close(); throw error; }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { try {this.db.exec('ROLLBACK');} catch {} throw error; }
  }
  view(row) {
    if (!row) return null;
    const {payload_json, payload_digest, claim_hash, ...metadata} = row;
    return {...JSON.parse(payload_json), ...metadata};
  }
  row(id) {
    requireText(id, 'id');
    const row = this.db.prepare('SELECT * FROM event_ingest_events WHERE id=?').get(id);
    if (!row) throw new EventIngestError('event not found', 'not_found', 404);
    return row;
  }
  history(id, action, detail = {}) {
    this.db.prepare('INSERT INTO event_ingest_history(event_ref,at,action,detail_json) VALUES(?,?,?,?)')
      .run(id, now(), action, JSON.stringify(detail));
  }
  ingest(input, receipt = {}) {
    const normalized = normalizeEvent(input), payload = canonical(normalized);
    if (Buffer.byteLength(payload) > this.maxEventBytes) throw new EventIngestError('event body too large', 'too_large', 413);
    const raw = receipt.raw_body == null ? null : Buffer.from(receipt.raw_body);
    if (raw && raw.length > this.maxEventBytes) throw new EventIngestError('raw body too large', 'too_large', 413);
    const transport = requireText(receipt.transport ?? 'local-function', 'transport', 100);
    const deliveryId = receipt.delivery_id ?? null;
    if (deliveryId !== null) requireText(deliveryId, 'delivery_id');
    const verification = requireText(receipt.verification ?? 'local-caller', 'verification', 100);
    const id = 'ev_' + digest(JSON.stringify([normalized.source, normalized.event_id]));
    const hash = digest(payload), at = now();
    const result = this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM event_ingest_events WHERE source=? AND event_id=?').get(normalized.source, normalized.event_id);
      const conflict = existing && existing.payload_digest !== hash;
      if (!existing) this.db.prepare(`INSERT INTO event_ingest_events
        (id,source,event_id,type,payload_json,payload_digest,received_at,last_received_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, normalized.source, normalized.event_id, normalized.type, payload, hash, at, at, at);
      else this.db.prepare('UPDATE event_ingest_events SET delivery_count=delivery_count+1,last_received_at=?,updated_at=? WHERE id=?').run(at, at, id);
      // Keep original bytes once, and conflicting payloads; duplicates need metadata, not repeated blobs.
      this.db.prepare(`INSERT INTO event_ingest_receipts
        (event_ref,at,outcome,transport,delivery_id,verification,payload_digest,raw_body,conflict_payload_json)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, at, conflict ? 'conflict' : existing ? 'duplicate' : 'accepted', transport, deliveryId,
          verification, hash, existing && !conflict ? null : raw, conflict ? payload : null);
      return {persisted: true, duplicate: Boolean(existing), conflict: Boolean(conflict), event: this.get(id)};
    });
    // Deliberately throw after committing conflict evidence. No overwritten event or second pending work.
    if (result.conflict) throw new EventIngestError('same source/event_id arrived with different content', 'event_conflict', 409, {event_ref: id});
    return result;
  }
  get(id) { return this.view(this.row(id)); }
  list({state, source, limit = 100, after_id} = {}) {
    integer(limit, 'limit', 1, 10000);
    const where = [], args = [];
    if (state) { if (!states.includes(state)) throw new EventIngestError('invalid state'); where.push('state=?'); args.push(state); }
    if (source) {requireText(source, 'source', 200); where.push('source=?'); args.push(source);}
    if (after_id) {
      const after = this.row(after_id);
      where.push('(received_at>? OR (received_at=? AND id>?))'); args.push(after.received_at, after.received_at, after.id);
    }
    return this.db.prepare('SELECT * FROM event_ingest_events' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY received_at,id LIMIT ?').all(...args, limit).map(row => this.view(row));
  }
  status() {
    const counts = Object.fromEntries(states.map(state => [state, 0]));
    for (const row of this.db.prepare('SELECT state,count(*) AS n FROM event_ingest_events GROUP BY state').all()) counts[row.state] = row.n;
    return {db_path: this.dbPath, at: now(), counts, total: Object.values(counts).reduce((a,b) => a+b, 0),
      receipts: this.db.prepare('SELECT count(*) AS n FROM event_ingest_receipts').get().n,
      conflicts: this.db.prepare("SELECT count(*) AS n FROM event_ingest_receipts WHERE outcome='conflict'").get().n,
      ready: this.db.prepare(`SELECT count(*) AS n FROM event_ingest_events WHERE state='pending'
        OR (state='retry' AND retry_at<=?) OR (state='dispatching' AND lease_until<=?)`).get(now(), now()).n,
      durable: {journal_mode: this.db.prepare('PRAGMA journal_mode').get().journal_mode,
        synchronous: this.db.prepare('PRAGMA synchronous').get().synchronous},
      boundary: 'Counts describe event handoff, not business completion or external platform connectivity'};
  }
  claim({owner, limit = 1, lease_ms = 60000, source} = {}) {
    requireText(owner, 'owner', 200); integer(limit, 'limit', 1, 1000); integer(lease_ms, 'lease_ms', 10, 3600000);
    if (source) requireText(source, 'source', 200);
    return this.transaction(() => {
      const at = now(), until = new Date(Date.now() + lease_ms).toISOString();
      const rows = this.db.prepare(`SELECT * FROM event_ingest_events WHERE
        (state='pending' OR (state='retry' AND retry_at<=?) OR (state='dispatching' AND lease_until<=?))
        ${source ? 'AND source=?' : ''} ORDER BY received_at,id LIMIT ?`).all(at, at, ...(source ? [source] : []), limit);
      return rows.map(row => {
        const token = randomBytes(32).toString('hex');
        this.db.prepare(`UPDATE event_ingest_events SET state='dispatching',lease_owner=?,lease_until=?,claim_hash=?,
          attempt_count=attempt_count+1,updated_at=? WHERE id=?`).run(owner, until, digest(token), at, row.id);
        this.history(row.id, row.state === 'dispatching' ? 'reclaimed' : 'claimed', {owner, lease_until: until});
        return {event: this.get(row.id), claim_token: token};
      });
    });
  }
  owned(id, token) {
    requireText(token, 'claim_token', 100);
    const row = this.row(id);
    if (row.state !== 'dispatching' || !row.claim_hash || row.claim_hash !== digest(token) || row.lease_until <= now())
      throw new EventIngestError('dispatch claim is missing, stale or expired', 'claim_rejected', 409);
    return row;
  }
  renew({id, claim_token, lease_ms = 60000}) {
    integer(lease_ms, 'lease_ms', 10, 3600000);
    return this.transaction(() => {
      this.owned(id, claim_token);
      const until = new Date(Date.now() + lease_ms).toISOString();
      this.db.prepare('UPDATE event_ingest_events SET lease_until=?,updated_at=? WHERE id=?').run(until, now(), id);
      this.history(id, 'renewed', {lease_until: until}); return this.get(id);
    });
  }
  ack({id, claim_token, dispatch_ref}) {
    requireText(dispatch_ref, 'dispatch_ref', 2000);
    return this.transaction(() => {
      this.owned(id, claim_token);
      this.db.prepare(`UPDATE event_ingest_events SET state='dispatched',dispatch_ref=?,lease_owner=NULL,lease_until=NULL,
        claim_hash=NULL,retry_at=NULL,last_error=NULL,updated_at=? WHERE id=?`).run(dispatch_ref, now(), id);
      this.history(id, 'dispatched', {dispatch_ref}); return this.get(id);
    });
  }
  fail({id, claim_token, error, retry_after_ms}) {
    requireText(error, 'error', 10000);
    if (retry_after_ms != null) integer(retry_after_ms, 'retry_after_ms', 0, 604800000);
    return this.transaction(() => {
      this.owned(id, claim_token);
      const state = retry_after_ms == null ? 'failed' : 'retry';
      const retryAt = retry_after_ms == null ? null : new Date(Date.now() + retry_after_ms).toISOString();
      this.db.prepare(`UPDATE event_ingest_events SET state=?,last_error=?,retry_at=?,lease_owner=NULL,
        lease_until=NULL,claim_hash=NULL,updated_at=? WHERE id=?`).run(state, error, retryAt, now(), id);
      this.history(id, state, {error, retry_at: retryAt}); return this.get(id);
    });
  }
  retry({id, reason}) {
    requireText(reason, 'reason', 2000);
    return this.transaction(() => {
      const row = this.row(id);
      if (!['failed','retry'].includes(row.state)) throw new EventIngestError('only failed/retry events can be requeued', 'invalid_transition', 409);
      this.db.prepare("UPDATE event_ingest_events SET state='pending',retry_at=NULL,updated_at=? WHERE id=?").run(now(), id);
      this.history(id, 'requeued', {reason}); return this.get(id);
    });
  }
  receipts(id, {include_raw = false, after_seq = 0, limit = 100} = {}) {
    this.row(id); integer(after_seq, 'after_seq', 0, Number.MAX_SAFE_INTEGER); integer(limit, 'limit', 1, 10000);
    return this.db.prepare(`SELECT * FROM event_ingest_receipts WHERE event_ref=? AND seq>? ORDER BY seq LIMIT ?`).all(id, after_seq, limit).map(row => {
      const {raw_body, conflict_payload_json, ...metadata} = row;
      return {...metadata, raw_bytes: raw_body?.length ?? 0,
        ...(include_raw ? {raw_body_base64: raw_body ? Buffer.from(raw_body).toString('base64') : null,
          conflict_payload: conflict_payload_json ? JSON.parse(conflict_payload_json) : null} : {})};
    });
  }
  audit(id) {
    this.row(id);
    return this.db.prepare('SELECT * FROM event_ingest_history WHERE event_ref=? ORDER BY seq').all(id)
      .map(({detail_json, ...row}) => ({...row, detail: JSON.parse(detail_json)}));
  }
  backup(destination) {
    const resolved = path.resolve(requireText(destination, 'destination', 2000));
    if (resolved === this.dbPath || fs.existsSync(resolved)) throw new EventIngestError('backup destination must be a new file');
    fs.mkdirSync(path.dirname(resolved), {recursive: true});
    // VACUUM INTO takes a consistent snapshot including committed WAL pages; do not copy a live .sqlite alone.
    this.db.exec("VACUUM INTO '" + resolved.replaceAll("'", "''") + "'");
    const fd = fs.openSync(resolved, 'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    return {persisted: true, backup_path: resolved, bytes: fs.statSync(resolved).size};
  }
  close() {this.db.close();}
}

export function receiveEvent(event, options = {}) {
  const store = options.store ?? new EventStore(options);
  try {return store.ingest(event, options.receipt);}
  finally {if (!options.store) store.close();}
}
export const ingestEvent = receiveEvent;

export function verifyGithubSignature(rawBody, signature, secret) {
  if (typeof secret !== 'string' || !secret || typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(signature.slice(7), 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
function bearerMatches(req, token) {
  if (typeof token !== 'string' || !token) return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7)), expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function readBody(req, maxBytes) {
  const chunks = []; let size = 0;
  const length = req.headers['content-length'];
  if (length && Number(length) > maxBytes) throw new EventIngestError('body too large', 'too_large', 413);
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new EventIngestError('body too large', 'too_large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function parseBody(raw) {
  try {return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw));}
  catch {throw new EventIngestError('body must be valid UTF-8 JSON');}
}
function respond(res, status, body, headers = {}) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});
  res.end(JSON.stringify(body));
}

// Can be mounted by system.mjs: if (await handler(req,res)) return;
export function createEventHandler({store, token = process.env.EVENT_INGEST_TOKEN, githubSources = {}, maxBodyBytes = 1048576, onAccepted} = {}) {
  if (!store) throw new EventIngestError('store is required');
  integer(maxBodyBytes, 'maxBodyBytes', 256, 16777216);
  // Do not open a route whose configuration cannot authenticate requests.
  for (const [key, cfg] of Object.entries(githubSources)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new EventIngestError('GitHub route keys must be URL-safe');
    requireText(cfg.source, 'github source', 200); requireText(cfg.secret, 'github secret', 10000);
  }
  return async (req, res) => {
    const route = new URL(req.url, 'http://127.0.0.1').pathname;
    const githubKey = route.match(/^\/webhooks\/github\/([a-zA-Z0-9_-]+)$/)?.[1];
    if (!['/events','/events/health'].includes(route) && !githubKey) return false;
    try {
      if (route === '/events/health' && req.method === 'GET') {
        respond(res, 200, {service:'event-ingest', durable_inbox:true, business_completion:false}); return true;
      }
      if (req.method !== 'POST') {respond(res, 405, {error:'method_not_allowed'}, {Allow:'POST'}); return true;}
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new EventIngestError('Content-Type must be application/json', 'content_type', 415);
      const cfg = githubKey ? githubSources[githubKey] : null;
      if (githubKey && !cfg) {respond(res,404,{error:'source_not_configured'}); return true;}
      if (!githubKey && !bearerMatches(req, token)) throw new EventIngestError('authentication failed', 'unauthorized', 401);
      const raw = await readBody(req, Math.min(maxBodyBytes, store.maxEventBytes));
      let event, receipt;
      if (cfg) {
        if (!verifyGithubSignature(raw, req.headers['x-hub-signature-256'], cfg.secret)) throw new EventIngestError('signature rejected', 'unauthorized', 401);
        const eventId = requireText(req.headers['x-github-delivery'], 'X-GitHub-Delivery');
        const eventType = requireText(req.headers['x-github-event'], 'X-GitHub-Event', 100);
        event = {source:cfg.source, event_id:eventId, type:'github.' + eventType, data:parseBody(raw), context:cfg.context ?? {}, origin_kind:'external'};
        receipt = {transport:'github-webhook', delivery_id:eventId, verification:'github-hmac-sha256', raw_body:raw};
      } else {
        event = parseBody(raw);
        receipt = {transport:'http-json', delivery_id:req.headers['x-delivery-id'] ?? null, verification:'bearer', raw_body:raw};
      }
      const result = store.ingest(event, receipt);
      // Every accepted response follows COMMIT. Do not await a model/task call in the request.
      respond(res, result.duplicate ? 200 : 202, {persisted:true, duplicate:result.duplicate, id:result.event.id, state:result.event.state});
      if (onAccepted && !result.duplicate) setImmediate(() => {
        Promise.resolve().then(() => onAccepted(result.event)).catch(() => {
          // Inbox remains pending; startup/drain must recover even when wakeup fails.
        });
      });
    } catch (error) {
      const busy = /SQLITE_BUSY|database is locked|database is busy/i.test(error.message ?? '');
      const status = error instanceof EventIngestError ? error.status : busy ? 503 : 500;
      if (!res.headersSent && !res.destroyed) respond(res, status,
        {error:error instanceof EventIngestError ? error.code : busy ? 'storage_busy' : 'storage_failed',
          ...(error instanceof EventIngestError ? {message:error.message,...error.detail} : {})}, status === 503 ? {'Retry-After':'3'} : {});
      req.resume();
    }
    return true;
  };
}
export function createEventServer(options = {}) {
  const store = options.store ?? new EventStore(options);
  const handler = createEventHandler({...options, store});
  const server = http.createServer((req, res) => handler(req, res).then(handled => {
    if (!handled) respond(res,404,{error:'not_found'});
  }).catch(() => {if (!res.headersSent) respond(res,500,{error:'handler_failed'});}));
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  if (!options.store) server.on('close', () => store.close());
  return {server, store, handler};
}

const help = `node event-ingest.mjs <command> [--db FILE] [--input JSON_FILE]
  ingest --input FILE | ingest --stdin   persist one source event
  list [--state pending|dispatching|retry|dispatched|failed] [--source NAME] [--limit N] [--after-id ID]
  get --id ID | receipts --id ID [--include-raw] | audit --id ID | status
  claim|renew|ack|fail|retry --input FILE  lease handoff API JSON, no business execution
  backup --to NEW_FILE                  consistent SQLite/WAL snapshot
  serve [--host 127.0.0.1] [--port 8766] [--github-config FILE]
EVENT_INGEST_TOKEN authenticates POST /events. GitHub config: {key:{source,secret_env,context}}.
No external account is connected merely by starting this server.`;
function cliArgs(args) {
  const parsed = {command:args.shift() ?? 'help'};
  while (args.length) {
    const flag = args.shift();
    if (!flag.startsWith('--')) throw new EventIngestError('unknown argument ' + flag);
    parsed[flag.slice(2)] = ['stdin','include-raw'].includes(flag.slice(2)) ? true : args.shift();
  }
  return parsed;
}
async function cli() {
  const args = cliArgs(process.argv.slice(2));
  if (['help','--help','-h'].includes(args.command)) {console.log(help); return;}
  const store = new EventStore({dbPath:args.db});
  let keepOpen = false;
  try {
    const input = () => {
      if (!args.input && !args.stdin) throw new EventIngestError('--input FILE or --stdin is required');
      return JSON.parse(fs.readFileSync(args.stdin ? 0 : args.input,'utf8').replace(/^\uFEFF/,''));
    };
    let result;
    switch (args.command) {
      case 'ingest': result = store.ingest(input(), {transport:args.stdin ? 'local-stdin' : 'local-file'}); break;
      case 'list': result = store.list({state:args.state,source:args.source,limit:args.limit ? Number(args.limit) : 100,after_id:args['after-id']}); break;
      case 'get': result = store.get(args.id); break;
      case 'status': result = store.status(); break;
      case 'receipts': result = store.receipts(args.id,{include_raw:Boolean(args['include-raw'])}); break;
      case 'audit': result = store.audit(args.id); break;
      case 'claim': case 'renew': case 'ack': case 'fail': case 'retry': result = store[args.command](input()); break;
      case 'backup': result = store.backup(args.to); break;
      case 'serve': {
        const githubSources = {};
        if (args['github-config']) {
          const configs = JSON.parse(fs.readFileSync(args['github-config'],'utf8').replace(/^\uFEFF/,''));
          for (const [key,cfg] of Object.entries(configs)) {
            if (Object.hasOwn(cfg,'secret')) throw new EventIngestError('use secret_env in config; secret values must remain in environment');
            requireText(cfg.secret_env,'secret_env',200);
            githubSources[key] = {...cfg,secret:process.env[cfg.secret_env]};
          }
        }
        if (!process.env.EVENT_INGEST_TOKEN && !Object.keys(githubSources).length) throw new EventIngestError('serve requires EVENT_INGEST_TOKEN or configured GitHub secrets');
        const {server} = createEventServer({store,githubSources});
        const port = integer(Number(args.port ?? 8766),'port',0,65535), host = args.host ?? '127.0.0.1';
        await new Promise((resolve,reject) => {server.once('error',reject);server.listen(port,host,resolve);});
        keepOpen = true;
        console.log(JSON.stringify({listening:true,host,port:server.address().port,db_path:store.dbPath,business_execution:false}));
        const stop = () => server.close(() => {store.close();});
        process.once('SIGINT',stop); process.once('SIGTERM',stop); return;
      }
      default: throw new EventIngestError(help);
    }
    console.log(JSON.stringify(result,null,2));
  } finally {if (!keepOpen) store.close();}
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  cli().catch(error => {
    console.error(JSON.stringify({error:error.code ?? 'event_ingest_failed',message:error.message,...error.detail})); process.exitCode = 1;
  });
}

#!/usr/bin/env node
import {integrationPath} from '../paths.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIRECTORY = process.env.FAILURE_INBOX_DIRECTORY || integrationPath('workspace/failure-inbox');
const DATA_FILE = 'failures.json';
const LOCK_FILE = 'failures.lock';
const MAX_DIAGNOSTIC = 360;
const LOCK_WAIT_MS = 1800;
const LOCK_STALE_MS = 60_000;

function redact(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|passwd|secret|token)\s*[=:]\s*)(["']?)[^\s,;&"']+\2/gi, '$1[REDACTED]')
    .replace(/([?&](?:key|token|access_token|api_key|password|secret)=)[^&#\s]*/gi, '$1[REDACTED]');
}

function diagnosticText(diagnostics) {
  let value = diagnostics;
  if (diagnostics && typeof diagnostics === 'object') {
    value = diagnostics.diagnostic ?? diagnostics.error ?? diagnostics.message ?? diagnostics.summary ?? diagnostics.stderr ?? '';
  }
  const cleaned = redact(value).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return cleaned.length > MAX_DIAGNOSTIC ? `${cleaned.slice(0, MAX_DIAGNOSTIC - 1)}…` : cleaned;
}

function normalizeDiagnostic(text) {
  // 属性、路径、错误码和版本均可区分故障，不再统一抹去引号内容与数字。
  return text
    .replace(/\s+/g, ' ')
    .trim();
}

function missingDiagnosticSource(input) {
  const args = input?.tool_response?.command;
  if (Array.isArray(args)) {
    const commandIndex = args.findIndex(value => String(value).toLowerCase() === '-command');
    const command = (commandIndex >= 0 ? args.slice(commandIndex + 1) : args).map(String).join(' ').trim();
    if (command) return `command:${crypto.createHash('sha256').update(command).digest('hex').slice(0, 20)}`;
  }
  // Without a usable command/source, keep this occurrence distinct instead of
  // merging unrelated silent failures under one tool-wide placeholder.
  return `tool-use:${String(input?.tool_use_id ?? crypto.randomUUID())}`;
}

function projectValue(saved) {
  const project = saved?.project;
  if (typeof project === 'string') return project;
  if (project && typeof project === 'object') return project.path ?? project.root ?? project.name ?? null;
  return null;
}

function evidencePointer(input, saved) {
  return {
    session_id: input?.session_id ?? null,
    agent_id: input?.agent_id ?? null,
    turn_id: input?.turn_id ?? null,
    tool_use_id: input?.tool_use_id ?? null,
    transcript_path: input?.transcript_path ?? null,
    ledger: typeof saved?.ledger === 'string' ? saved.ledger : null,
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withLock(directory, callback, waitMs = LOCK_WAIT_MS) {
  await fs.mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, LOCK_FILE);
  const until = Date.now() + waitMs;
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= until) throw new Error('failure inbox lock wait expired');
      await sleep(10 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
  }
}

async function readStore(directory) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(directory, DATA_FILE), 'utf8'));
    return { version: 1, items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, items: [] };
    throw error;
  }
}

async function writeStore(directory, store) {
  const file = path.join(directory, DATA_FILE);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function captureFailure(input = {}, diagnostics = '', saved = {}, options = {}) {
  const directory = options.directory ?? DEFAULT_DIRECTORY;
  const diagnostic = diagnosticText(diagnostics);
  const toolName = String(input.tool_name ?? 'unknown').slice(0, 100);
  const normalized = normalizeDiagnostic(diagnostic);
  const genericNoDiagnostic = /failed without diagnostic;\s*exit=/i.test(diagnostic)
    || /^ParserError:\s*$/i.test(diagnostic);
  // Missing-target identity remains explicit; v2 also preserves quoted diagnostic values.
  const missingTarget = diagnostic.match(/Cannot find (?:path|module|package)\s+['"]([^'"]+)['"]/i)?.[1]
    || diagnostic.match(/No module named\s+['"]([^'"]+)['"]/i)?.[1];
  const target = missingTarget ? missingTarget.replaceAll('\\', '/').toLowerCase() : '';
  const source = target ? `\ntarget:${target}` : genericNoDiagnostic ? `\nsource:${missingDiagnosticSource(input)}` : '';
  const id = crypto.createHash('sha256').update(`v2\n${toolName.toLowerCase()}\n${projectValue(saved) || ''}\n${normalized}${source}`).digest('hex').slice(0, 16);
  const now = new Date().toISOString();
  const session = input.session_id == null ? null : String(input.session_id);
  const project = projectValue(saved);

  return withLock(directory, async () => {
    const store = await readStore(directory);
    let item = store.items.find(entry => entry.id === id);
    if (!item) {
      item = {
        id, tool_name: toolName, diagnostic, normalized_diagnostic: normalized,
        grouping: 'v2-preserved-diagnostic-project-source',
        status: 'open', count: 0, uniqueSessions: 0, sessions: [],
        firstSeen: now, lastSeen: now, project, projects: [], evidence: [], resolution: null,
      };
      store.items.push(item);
    }
    item.count += 1;
    if (session && !item.sessions.includes(session)) item.sessions.push(session);
    item.uniqueSessions = item.sessions.length;
    item.lastSeen = now;
    if (project && !item.projects.includes(project)) item.projects.push(project);
    if (!item.project && project) item.project = project;
    item.evidence.push(evidencePointer(input, saved));
    if (item.evidence.length > 20) item.evidence = item.evidence.slice(-20);
    if (item.status === 'fixed') {
      item.status = 'needs-review';
      item.reviewReason = 'failure recurred after fixed resolution';
    } else if (item.status === 'note-only' && item.resolution) {
      const newSession = session && !(item.resolution.sessions ?? []).includes(session);
      const repeatedAgain = item.count >= (item.resolution.count ?? item.count) + 3;
      if (newSession || repeatedAgain) {
        item.status = 'needs-review';
        item.reviewReason = newSession ? 'new session after note-only resolution' : 'frequency increased after note-only resolution';
      }
    }
    await writeStore(directory, store);
    return { id, status: item.status, count: item.count, uniqueSessions: item.uniqueSessions };
  }, options.lockTimeoutMs ?? LOCK_WAIT_MS);
}

function compactItem(item, diagBudget = 160) {
  return {
    id: item.id,
    status: item.status,
    count: item.count,
    uniqueSessions: item.uniqueSessions,
    lastSeen: item.lastSeen,
    tool: item.tool_name,
    project: item.project,
    diagnostic: item.diagnostic.length > diagBudget ? `${item.diagnostic.slice(0, diagBudget - 1)}…` : item.diagnostic,
  };
}

export async function listFailures(options = {}) {
  const directory = options.directory ?? DEFAULT_DIRECTORY;
  const limit = Math.max(1, Math.min(100, Number.parseInt(options.limit ?? '5', 10) || 5));
  return withLock(directory, async () => {
    const { items } = await readStore(directory);
    return items.filter(item => ['open', 'needs-review'].includes(item.status))
      .filter(item => !options.project || item.projects?.includes(options.project) || item.project === options.project)
      .sort((a, b) => (b.count - a.count) || b.lastSeen.localeCompare(a.lastSeen))
      .slice(0, limit)
      .map(item => compactItem(item, options.diagnosticBudget ?? 160));
  }, options.lockTimeoutMs ?? LOCK_WAIT_MS);
}

export async function readFailure(id, options = {}) {
  if (!id) throw new Error('id is required');
  const directory = options.directory ?? DEFAULT_DIRECTORY;
  return withLock(directory, async () => {
    const {items} = await readStore(directory);
    const item = items.find(entry => entry.id === id);
    if (!item) throw new Error(`unknown failure id: ${id}`);
    const limit = Math.max(1, Math.min(20, Number.parseInt(options.limit ?? '1', 10) || 1));
    return {...compactItem(item, MAX_DIAGNOSTIC), firstSeen:item.firstSeen, grouping:item.grouping,
      ...(item.groupingRetired ? {legacyStatus:item.legacyStatus,groupingRetired:item.groupingRetired} : {}),
      evidenceCount:(item.evidence ?? []).length, evidence:(item.evidence ?? []).slice(-limit), resolution:item.resolution ?? null,
      ...(item.reviewReason ? {reviewReason:item.reviewReason} : {})};
  }, options.lockTimeoutMs ?? LOCK_WAIT_MS);
}

export async function resolveFailure({ id, status, evidence }, options = {}) {
  if (!['fixed', 'note-only'].includes(status)) throw new Error('status must be fixed or note-only');
  if (!id) throw new Error('id is required');
  if (!evidence || !path.isAbsolute(evidence)) throw new Error('evidence must be an absolute file path');
  const directory = options.directory ?? DEFAULT_DIRECTORY;
  return withLock(directory, async () => {
    let evidenceStat;
    try {
      evidenceStat = await fs.stat(evidence);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error('evidence must point to an existing file');
      throw error;
    }
    if (!evidenceStat.isFile()) throw new Error('evidence must point to an existing file');
    const store = await readStore(directory);
    const item = store.items.find(entry => entry.id === id);
    if (!item) throw new Error(`unknown failure id: ${id}`);
    item.status = status;
    item.resolution = { evidence, at: new Date().toISOString(), count: item.count, sessions: [...(item.sessions ?? [])] };
    delete item.reviewReason;
    await writeStore(directory, store);
    return { id, status, count: item.count, uniqueSessions: item.uniqueSessions };
  }, options.lockTimeoutMs ?? LOCK_WAIT_MS);
}

export async function retireLegacyGroups(evidence, options = {}) {
  if (!evidence || !path.isAbsolute(evidence) || !(await fs.stat(evidence)).isFile()) throw new Error('迁移依据须为存在的绝对文件路径');
  return withLock(options.directory ?? DEFAULT_DIRECTORY, async () => {
    const store = await readStore(options.directory ?? DEFAULT_DIRECTORY);
    let count = 0;
    for (const item of store.items) {
      if (item.grouping?.startsWith('v2-') || item.status === 'legacy-group') continue;
      item.legacyStatus = item.status;
      item.status = 'legacy-group';
      item.groupingRetired = {at:new Date().toISOString(), evidence, reason:'旧归组可能混合不同对象；保留原计数与证据，不推定已修复，不搬入新计数'};
      count++;
    }
    await writeStore(options.directory ?? DEFAULT_DIRECTORY, store);
    return {retired:count};
  }, options.lockTimeoutMs ?? LOCK_WAIT_MS);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--limit' || arg === '--project' || arg === '--id' || arg === '--status' || arg === '--evidence') opts[arg.slice(2)] = rest[++i];
    else throw new Error(`unknown option: ${arg}`);
  }
  return { command, opts };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, opts } = parseArgs(argv);
  if (command === 'retire-legacy') {
    process.stdout.write(JSON.stringify(await retireLegacyGroups(opts.evidence))+'\n'); return;
  }
  if (command === 'help' || command === '--help') {
    process.stdout.write('usage: failure-inbox.mjs list [--limit 5] [--json] [--project ABS] | read --id ID [--limit 1] | resolve --id ID --status fixed|note-only --evidence ABS_FILE | retire-legacy --evidence ABS_FILE\n');
    return;
  }
  if (command === 'read') {
    process.stdout.write(JSON.stringify(await readFailure(opts.id, {limit:opts.limit}), null, 2));
    return;
  }
  if (command === 'list') {
    if (opts.project && !path.isAbsolute(opts.project)) throw new Error('--project must be an absolute path');
    const items = await listFailures({ limit: opts.limit, project: opts.project });
    const output = opts.json
      ? JSON.stringify(items)
      : (items.length ? items.map(x => `${x.id}  ${x.count}x/${x.uniqueSessions} sessions  ${x.tool}  ${x.diagnostic}`).join('\n') : '');
    process.stdout.write(output);
    return;
  }
  if (command === 'resolve') {
    const result = await resolveFailure({ id: opts.id, status: opts.status, evidence: opts.evidence });
    process.stdout.write(JSON.stringify(result));
    return;
  }
  throw new Error('usage: failure-inbox.mjs list [--limit 5] [--json] [--project ABS] | read --id ID | resolve --id ID --status fixed|note-only --evidence ABS_FILE');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

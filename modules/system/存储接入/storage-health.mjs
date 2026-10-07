import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const GiB = 1024 ** 3;
export const DEFAULT_STATE_FILE = fileURLToPath(new URL('./data/storage-health.json', import.meta.url));
export const DEFAULT_VOLUMES = [{ id: 'work', path: _publicPath('$data') }];
const MAX_STATE_BYTES = 512 * 1024;
const MAX_DAYS = 30;
const MAX_DIRECTORIES = 8;

function bytes(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer`);
  return value;
}
function fail(code, message) { return Object.assign(new Error(message), { code }); }
function errorInfo(error) { return { code: String(error.code || 'ERROR').slice(0, 64), message: String(error.message).slice(0, 300) }; }
function dayKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function cutoffDay(day) { return new Date(Date.parse(`${day}T00:00:00Z`) - (MAX_DAYS - 1) * 86400000).toISOString().slice(0, 10); }
function validatePath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.length > 1024) throw new TypeError('path must be absolute and at most 1024 characters');
  return path.resolve(p);
}

// Factory dependencies support deterministic boundary tests; ordinary callers use the named wrappers below.
export function createStorageHealth(options = {}) {
  const stateFile = validatePath(options.stateFile || DEFAULT_STATE_FILE);
  const volumes = (options.volumes || DEFAULT_VOLUMES).map(v => ({ id: String(v.id), path: validatePath(v.path) }));
  if (volumes.length > 8 || new Set(volumes.map(v => v.id)).size !== volumes.length || volumes.some(v => !/^[A-Za-z0-9_-]{1,32}$/.test(v.id))) throw new TypeError('volumes must have up to 8 unique short ids');
  const statfs = options.statfs || fs.statfs;
  const realpath = options.realpath || fs.realpath;
  const now = options.now || (() => new Date());
  const timeZone = options.timeZone || 'Asia/Shanghai';
  const reserveBytes = options.reserveBytes || {};
  const warningBytes = options.warningBytes || {};
  const lockTimeoutMs = bytes(options.lockTimeoutMs ?? 10000, 'lockTimeoutMs');
  const reserve = id => bytes(reserveBytes[id] ?? 20 * GiB, `reserveBytes.${id}`);
  const warning = id => Math.max(reserve(id), bytes(warningBytes[id] ?? 30 * GiB, `warningBytes.${id}`));
  for (const v of volumes) { reserve(v.id); warning(v.id); }

  async function readState() {
    try {
      const handle = await fs.open(stateFile, 'r');
      let raw;
      try {
        if ((await handle.stat()).size > MAX_STATE_BYTES) throw fail('STATE_TOO_LARGE', 'storage state exceeds 512 KiB');
        raw = await handle.readFile('utf8');
      } finally { await handle.close(); }
      const state = JSON.parse(raw);
      if (state.version !== 1 || !Array.isArray(state.days) || state.days.length > MAX_DAYS || !Array.isArray(state.directories) || state.directories.length > MAX_DIRECTORIES) throw fail('INVALID_STATE', 'invalid storage state shape');
      const seen = new Set();
      for (const d of state.days) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || seen.has(d.date)) throw fail('INVALID_STATE', 'invalid or duplicate daily baseline');
        seen.add(d.date);
        for (const sample of [d.baseline, d.latest]) {
          if (!sample || !Number.isFinite(Date.parse(sample.measuredAt)) || !Array.isArray(sample.volumes) || sample.volumes.length > 8) throw fail('INVALID_STATE', 'invalid measurement');
          for (const v of sample.volumes) if (v.available) {
            bytes(v.totalBytes, 'totalBytes'); bytes(v.availableBytes, 'availableBytes');
            if (v.availableBytes > v.totalBytes) throw fail('INVALID_STATE', 'available space exceeds total');
          }
        }
      }
      return state;
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, days: [], directories: [] };
      throw e;
    }
  }

  async function measureVolume(v) {
    try {
      const s = await statfs(v.path, { bigint: true });
      const totalBytes = bytes(Number(BigInt(s.bsize) * BigInt(s.blocks)), 'totalBytes');
      const availableBytes = bytes(Number(BigInt(s.bsize) * BigInt(s.bavail)), 'availableBytes');
      if (availableBytes > totalBytes) throw fail('INVALID_STATFS', 'available space exceeds total');
      return { id: v.id, path: v.path, available: true, totalBytes, availableBytes, availableGiB: Number((availableBytes / GiB).toFixed(2)), reserveBytes: reserve(v.id), warningBytes: warning(v.id), level: availableBytes < reserve(v.id) ? 'critical' : availableBytes < warning(v.id) ? 'warning' : 'ok' };
    } catch (e) { return { id: v.id, path: v.path, available: false, level: 'unknown', error: errorInfo(e) }; }
  }
  async function measure() {
    return { measuredAt: now().toISOString(), volumes: await Promise.all(volumes.map(measureVolume)) };
  }

  function growthFor(v, snapshot, state) {
    if (!v.available) return { status: 'unknown', reason: 'volume_unavailable' };
    const day = dayKey(new Date(snapshot.measuredAt), timeZone);
    const candidates = state.days.filter(d => d.date >= cutoffDay(day) && d.date < day).sort((a, b) => a.date.localeCompare(b.date));
    for (const d of candidates) {
      const old = d.baseline.volumes.find(x => x.id === v.id && x.path === v.path && x.available && x.totalBytes === v.totalBytes);
      if (old) return { status: 'known', since: d.baseline.measuredAt, netUsedBytes: old.availableBytes - v.availableBytes, elapsedDays: Number(((Date.parse(snapshot.measuredAt) - Date.parse(d.baseline.measuredAt)) / 86400000).toFixed(3)), meaning: 'net volume consumption; includes all writers and deletions' };
    }
    return { status: 'unknown', reason: 'no_earlier_day_baseline' };
  }
  function report(snapshot, state, stateError = null) {
    const day = dayKey(new Date(snapshot.measuredAt), timeZone);
    const today = state.days.find(d => d.date === day);
    return {
      status: snapshot.volumes.some(v => v.level === 'critical') ? 'critical' : snapshot.volumes.some(v => v.level === 'warning') ? 'warning' : stateError || !snapshot.volumes.length || snapshot.volumes.some(v => !v.available) ? 'unknown' : 'ok',
      mode: 'quick', measuredAt: snapshot.measuredAt, stateFile, stateError,
      baselineDays: state.days.filter(d => d.date >= cutoffDay(day) && d.date <= day).length,
      volumes: snapshot.volumes.map(v => {
        const first = today?.baseline.volumes.find(x => x.id === v.id && x.path === v.path && x.available && x.totalBytes === v.totalBytes);
        return { ...v, growth: growthFor(v, snapshot, state), sinceTodayBaselineBytes: v.available && first ? first.availableBytes - v.availableBytes : null };
      }),
      directorySnapshots: state.directories,
    };
  }

  // This path is read only: neither state directory nor lock/temp files are created.
  async function status() {
    const snapshot = await measure();
    try { return report(snapshot, await readState()); }
    catch (e) { return report(snapshot, { days: [], directories: [] }, errorInfo(e)); }
  }

  async function withLock(action) {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    const lockPath = `${stateFile}.lock`;
    const start = Date.now();
    let lock;
    for (;;) {
      try { lock = await fs.open(lockPath, 'wx'); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (Date.now() - start >= lockTimeoutMs) throw fail('LOCK_TIMEOUT', `storage state is locked; inspect ${lockPath} and its owner before removing a stale lock`);
        await delay(25 + Math.floor(Math.random() * 25));
      }
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return await action();
    } finally { await lock.close(); await fs.unlink(lockPath); }
  }
  async function writeState(state) {
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw fail('STATE_TOO_LARGE', 'storage state exceeds 512 KiB');
    const temp = `${stateFile}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, 'wx');
      try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temp, stateFile);
    } finally { await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }

  async function scanDirectory(input, limits = {}) {
    const root = validatePath(input);
    if (root === path.parse(root).root) throw new TypeError('whole-volume scans are not allowed');
    const maxEntries = Math.min(bytes(limits.maxEntries ?? 50000, 'maxEntries'), 200000);
    const maxMs = Math.min(bytes(limits.maxMs ?? 5000, 'maxMs'), 30000);
    const start = Date.now();
    const result = { path: root, measuredAt: now().toISOString(), logicalBytes: 0, files: 0, entries: 0, skippedLinks: 0, errors: 0, complete: true };
    const budget = () => {
      if (result.entries >= maxEntries || Date.now() - start >= maxMs) { result.complete = false; result.reason = 'scan_budget'; return false; }
      return true;
    };
    async function walk(p) {
      if (!budget()) return;
      result.entries++;
      let s;
      try { s = await fs.lstat(p); }
      catch (e) { result.errors++; result.complete = false; result.error ||= errorInfo(e); return; }
      if (s.isSymbolicLink()) { result.skippedLinks++; return; }
      if (s.isFile()) { result.files++; result.logicalBytes += s.size; return; }
      if (!s.isDirectory()) return;
      try {
        const dir = await fs.opendir(p);
        for await (const child of dir) {
          if (!budget()) break;
          await walk(path.join(p, child.name));
        }
      } catch (e) { result.errors++; result.complete = false; result.error ||= errorInfo(e); }
    }
    await walk(root);
    result.elapsedMs = Date.now() - start;
    result.meaning = 'logical file bytes; hard links may repeat, not physical allocated bytes';
    return result;
  }

  async function record({ scanPaths = [], scanLimits = {} } = {}) {
    if (!Array.isArray(scanPaths) || scanPaths.length > MAX_DIRECTORIES) throw new TypeError('scanPaths must have at most 8 explicit paths');
    for (const p of scanPaths) validatePath(p);
    return withLock(async () => {
      const state = await readState();
      if (state.timeZone && state.timeZone !== timeZone) throw fail('TIMEZONE_MISMATCH', 'daily baseline time zone differs from the persisted state');
      const snapshot = await measure();
      const date = dayKey(new Date(snapshot.measuredAt), timeZone);
      if (state.days.some(d => d.date > date)) throw fail('CLOCK_MOVED_BACKWARD', 'current date precedes a saved baseline');
      const today = state.days.find(d => d.date === date);
      if (today) today.latest = snapshot;
      else state.days.push({ date, baseline: snapshot, latest: snapshot });
      state.days = state.days.filter(d => d.date >= cutoffDay(date)).sort((a, b) => a.date.localeCompare(b.date)).slice(-MAX_DAYS);
      for (const p of scanPaths) {
        const item = await scanDirectory(p, scanLimits);
        state.directories = state.directories.filter(x => x.path !== item.path);
        state.directories.push(item);
      }
      state.directories = state.directories.slice(-MAX_DIRECTORIES);
      state.timeZone = timeZone;
      state.updatedAt = snapshot.measuredAt;
      await writeState(state);
      return { ...report(snapshot, state), recorded: true, scanned: scanPaths.length };
    });
  }

  async function nearestExisting(input) {
    let p = validatePath(input);
    for (;;) {
      try { return await realpath(p); }
      catch (e) {
        // Permission, disconnected drives, and malformed paths must not silently fall back.
        if (e.code !== 'ENOENT') throw e;
        const parent = path.dirname(p);
        if (p === parent) throw e;
        p = parent;
      }
    }
  }
  async function preflight({ path: targetPath, expectedBytes }) {
    const target = validatePath(targetPath);
    bytes(expectedBytes, 'expectedBytes');
    let targetVolume;
    let checkedPath;
    try {
      checkedPath = await nearestExisting(target);
      const root = path.parse(checkedPath).root;
      targetVolume = volumes.find(v => path.parse(path.resolve(v.path)).root.toLowerCase() === root.toLowerCase()) || { id: root.replace(/[^A-Za-z0-9]/g, '').slice(0, 32) || 'other', path: root };
      targetVolume = await measureVolume({ ...targetVolume, path: checkedPath });
    } catch (e) { targetVolume = { available: false, error: errorInfo(e) }; }
    const enough = targetVolume.available && expectedBytes <= targetVolume.availableBytes - targetVolume.reserveBytes;
    const alternative = volumes.find(v => v.id.toUpperCase() === 'D');
    const d = !enough && targetVolume.id?.toUpperCase() !== 'D' && alternative ? await measureVolume(alternative) : null;
    const suggestD = Boolean(d?.available && expectedBytes <= d.availableBytes - d.reserveBytes);
    return {
      measuredAt: now().toISOString(), targetPath: target, checkedPath: checkedPath || null, expectedBytes,
      decision: !targetVolume.available ? 'unknown' : enough ? 'allow' : 'insufficient', enough: Boolean(enough),
      availableBytes: targetVolume.availableBytes ?? null, reserveBytes: targetVolume.reserveBytes ?? null,
      remainingBytesAfterWrite: targetVolume.available ? targetVolume.availableBytes - expectedBytes : null,
      shortfallBytes: targetVolume.available ? Math.max(0, expectedBytes - (targetVolume.availableBytes - targetVolume.reserveBytes)) : null,
      volume: targetVolume.id || null, error: targetVolume.error || null,
      suggestD, recommendation: suggestD ? { volume: 'D', root: alternative.path, availableBytes: d.availableBytes, reserveBytes: d.reserveBytes, action: 'choose an explicit D target, then preflight that path again' } : null,
      scope: 'advisory snapshot; caller enforces before writing; does not reserve bytes',
    };
  }
  return { status, record, preflight, scanDirectory };
}

export const getStatus = options => createStorageHealth(options).status();
export const recordSnapshot = (input = {}, options) => createStorageHealth(options).record(input);
export const preflightWrite = (input, options) => createStorageHealth(options).preflight(input);

export async function main(argv = process.argv.slice(2)) {
  const [command = 'status', ...args] = argv;
  if (command === 'help' || command === '--help') return { usage: ['status|quick [--state ABS]', 'sample|record [--scan ABS]... [--max-entries N --max-ms N]', 'preflight --path ABS --expected-bytes N', 'all commands: --reserve-c-gib 20 --reserve-d-gib 20 --warning-c-gib 30 --warning-d-gib 30'], api: ['getStatus(options)', 'recordSnapshot({scanPaths?,scanLimits?}, options)', 'preflightWrite({path,expectedBytes}, options)', 'createStorageHealth(options)'] };
  const options = { reserveBytes: {}, warningBytes: {} };
  const input = { scanPaths: [], scanLimits: {} };
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (value === undefined) throw new TypeError(`missing value for ${flag}`);
    if (flag === '--state') options.stateFile = value;
    else if (flag === '--scan' && ['record', 'sample'].includes(command)) input.scanPaths.push(value);
    else if (flag === '--max-entries' && ['record', 'sample'].includes(command)) input.scanLimits.maxEntries = Number(value);
    else if (flag === '--max-ms' && ['record', 'sample'].includes(command)) input.scanLimits.maxMs = Number(value);
    else if (flag === '--path' && command === 'preflight') input.path = value;
    else if (flag === '--expected-bytes' && command === 'preflight') input.expectedBytes = Number(value);
    else {
      const match = /^--(reserve|warning)-(c|d)-gib$/.exec(flag);
      if (!match) throw new TypeError(`unknown option ${flag}`);
      options[`${match[1]}Bytes`][match[2].toUpperCase()] = bytes(Number(value) * GiB, flag);
    }
  }
  const health = createStorageHealth(options);
  if (command === 'status' || command === 'quick') return health.status();
  if (command === 'record' || command === 'sample') return health.record(input);
  if (command === 'preflight') return health.preflight(input);
  throw new TypeError(`unknown command ${command}; use help`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then(result => {
    console.log(JSON.stringify(result));
    if (result.decision && result.decision !== 'allow') process.exitCode = 2;
  }).catch(error => { console.error(JSON.stringify({ error: errorInfo(error) })); process.exitCode = 1; });
}

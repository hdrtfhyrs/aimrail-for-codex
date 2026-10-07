import {integrationPath} from '../paths.mjs';
// Durable file inbox. No model, scheduler, task mutation or native send.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const TASK_REPORT_ROOT = integrationPath("integrations/context/task-reports");
const kinds = new Set(['outcome', 'observation', 'coordination']);
const safeId = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(v);
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const short = (v, n) => String(v || '').replace(/\s+/g, ' ').slice(0, n);
const readJSON = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const rootFor = o => path.resolve(o.root || TASK_REPORT_ROOT);
const pathKey = v => path.win32.isAbsolute(v) ? path.win32.normalize(v).replaceAll('\\', '/').toLowerCase() : path.normalize(v);
function normalize(input) {
  if (!input || !safeId(input.target_thread_id) || !safeId(input.source_thread_id)) throw Error('Explicit source and target native thread IDs required');
  if (!kinds.has(input.kind) || typeof input.summary !== 'string' || !input.summary.trim()) throw Error('Only meaningful outcome/observation/coordination; routine progress stays in its own task');
  if (typeof input.project_ref !== 'string' || !(path.isAbsolute(input.project_ref) || path.win32.isAbsolute(input.project_ref))) throw Error('Explicit absolute project_ref required');
  const row = {source_thread_id: input.source_thread_id, target_thread_id: input.target_thread_id,
    project_ref: input.project_ref, kind: input.kind, summary: input.summary.trim()};
  for (const field of ['branch_ref', 'authorization_ref', 'goal_relation', 'source_ref', 'suggested_action']) {
    if (input[field] !== undefined && typeof input[field] !== 'string') throw Error(`${field} must be a string`);
    row[field] = input[field] || '';
  }
  for (const field of ['artifacts', 'evidence', 'uncertainties']) {
    const values = input[field] ?? [];
    if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) throw Error(`${field} must be a string array`);
    row[field] = [...new Set(values.map(v => v.trim()).filter(Boolean))];
  }
  // Stored optional IDs historically use ''. Treat that as omitted on read
  // and duplicate publication; validate any actual supplied identity.
  if (input.event_id !== undefined && input.event_id !== '' && (typeof input.event_id !== 'string' || !input.event_id.trim() || input.event_id.length > 512)) throw Error('event_id must be a nonempty string of at most 512 characters');
  row.event_id = input.event_id || '';
  if (Buffer.byteLength(JSON.stringify(row)) > 128 * 1024) throw Error('Report exceeds 128 KiB; put long material in a file and include its pointer');
  return row;
}
function contentKey(row) {
  return digest({...row, project_ref: pathKey(row.project_ref), artifacts: [...row.artifacts].sort(),
    evidence: [...row.evidence].sort(), uncertainties: [...row.uncertainties].sort(), event_id: ''});
}
// Flush a private temp, publish exclusively through a same-volume hard link.
// Readers never see half-written JSON; concurrent publishers cannot overwrite.
// An interrupted .tmp is invisible. No shared mutable index/lock to recover.
function publishJSON(file, data) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', {flag: 'wx', flush: true});
    try { fs.linkSync(temp, file); return true; }
    catch (error) {
      if (error.code === 'EEXIST' || (process.platform === 'win32' && error.code === 'EPERM' && fs.existsSync(file))) return false;
      throw error;
    }
  } finally { try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
export function saveTaskReport(input, options = {}) {
  const data = normalize(input), fingerprint = contentKey(data);
  const key = data.event_id ? digest([data.target_thread_id, data.source_thread_id, pathKey(data.project_ref), data.event_id]) : fingerprint;
  const file = path.join(rootFor(options), data.target_thread_id, `report-${key}.json`);
  const report = {id: `r-${key}`, at: new Date().toISOString(), ...data, content_key: fingerprint};
  const created = publishJSON(file, report), saved = created ? report : readJSON(file);
  if (!created && contentKey(normalize(saved)) !== fingerprint) throw Error(`event_id already identifies different material; use a new event_id for a new finding: ${file}`);
  return {saved: true, created, duplicate: !created, file, report: saved, native_sent: false};
}
export function scanTaskReports(threadId, options = {}) {
  if (!safeId(threadId)) return {reports: [], issues: [{code: 'INVALID_THREAD', message: 'Explicit native thread ID required'}]};
  const folder = path.join(rootFor(options), threadId);
  let files;
  try { files = fs.readdirSync(folder).filter(n => n.endsWith('.json')).sort(); }
  catch (e) { if (e.code === 'ENOENT') return {reports: [], issues: []}; throw e; }
  const reports = [], issues = [], keys = new Map();
  for (const name of files) {
    const file = path.join(folder, name);
    try {
      if (fs.statSync(file).size > 160 * 1024) throw Error('Oversized report file');
      const row = readJSON(file), data = normalize(row);
      if (data.target_thread_id !== threadId || !safeId(row.id) || !Number.isFinite(Date.parse(row.at))) throw Error('Wrong target, invalid id or time');
      const fingerprint = contentKey(data);
      if (row.content_key && row.content_key !== fingerprint) throw Error('Report content no longer matches saved key');
      const key = data.event_id ? digest([data.source_thread_id, pathKey(data.project_ref), data.event_id]) : fingerprint;
      const prior = keys.get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw Error('Conflicting event_id in inbox');
        prior.aliases.push(row.id); continue;
      }
      const entry = {...row, ...data, file, fingerprint, aliases: [row.id]};
      keys.set(key, entry); reports.push(entry);
    } catch (e) { issues.push({file, code: 'INVALID_REPORT', message: e.message}); }
  }
  reports.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return {reports, issues};
}
// Compatible array return, non-destructive, with absolute report-file pointers.
export function readTaskReports(threadId, options = {}) { return scanTaskReports(threadId, options).reports; }
function consumerId(o) {
  const id = o.consumer || 'context';
  if (!safeId(id)) throw Error('consumer must contain letters, digits, underscore or hyphen');
  return id;
}
function receiptFile(threadId, row, o) { return path.join(rootFor(o), threadId, '.emitted', consumerId(o), `${row.fingerprint}.json`); }
function wasEmitted(threadId, row, o, issues) {
  const file = receiptFile(threadId, row, o);
  try {
    const r = readJSON(file);
    if (r.target_thread_id !== threadId || r.content_key !== row.fingerprint || r.consumer !== consumerId(o) || r.status !== 'context-emitted') throw Error('Invalid emission record');
    return true;
  } catch (e) {
    if (e.code !== 'ENOENT') issues.push({file, code: 'INVALID_EMISSION', message: e.message});
    return false;
  }
}
export function readTaskReportPage(threadId, options = {}) {
  const {reports, issues} = scanTaskReports(threadId, options);
  let rows = reports;
  if (options.project_ref) rows = rows.filter(r => pathKey(r.project_ref) === pathKey(options.project_ref));
  if (options.pending) rows = rows.filter(r => !wasEmitted(threadId, r, options, issues));
  // Manual paging is a snapshot. Pending uses per-report records so late
  // concurrent publication cannot fall behind a timestamp watermark.
  if (options.after) {
    const i = rows.findIndex(r => r.aliases.includes(options.after));
    if (i < 0) throw Error('after report absent from filtered snapshot; reread without after');
    rows = rows.slice(i + 1);
  }
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw Error('limit must be 1..200');
  const batch = rows.slice(0, limit);
  return {reports: batch, issues, total: reports.length, matching: rows.length, remaining: Math.max(0, rows.length - batch.length),
    next_after: rows.length > batch.length ? batch.at(-1)?.id : null, native_sent: false};
}
// Output bookkeeping only: never approval, acknowledgement or adoption.
export function recordTaskReportEmission(threadId, reportIds, options = {}) {
  if (!safeId(threadId) || !Array.isArray(reportIds) || reportIds.some(id => !safeId(id))) throw Error('Explicit thread and report IDs required');
  const consumer = consumerId(options), {reports, issues} = scanTaskReports(threadId, options);
  const selected = reports.filter(r => r.aliases.some(id => reportIds.includes(id)));
  const found = new Set(selected.flatMap(r => r.aliases));
  if (reportIds.some(id => !found.has(id))) throw Error('Cannot record output for unknown or invalid report');
  const emitted = selected.map(row => {
    const file = receiptFile(threadId, row, options);
    const created = publishJSON(file, {status: 'context-emitted', at: new Date().toISOString(), consumer,
      target_thread_id: threadId, report_id: row.id, content_key: row.fingerprint, report_file: row.file, native_sent: false});
    if (!created && !wasEmitted(threadId, row, options, issues)) throw Error(`Invalid emission record retained for repair: ${file}`);
    return {id: row.id, file, created};
  });
  return {emitted, issues, native_sent: false, understood: 'unobserved'};
}
function rowBlock(r) {
  return [`回报 ${r.id}；来源聊天 ${r.source_thread_id}；${r.kind}；分支 ${short(r.branch_ref, 90)}`,
    short(r.summary, 420), r.goal_relation ? `与目标关系：${short(r.goal_relation, 170)}` : '',
    `原件：${r.file}`, r.artifacts.length ? `成果：${short(r.artifacts[0], 220)}${r.artifacts.length > 1 ? '；其余见原件' : ''}` : '',
    r.evidence.length ? `依据：${short(r.evidence[0], 180)}${r.evidence.length > 1 ? '；其余见原件' : ''}` : '',
    r.uncertainties.length ? `待核：${short(r.uncertainties[0], 150)}` : ''].filter(Boolean).join('\n');
}
export function prepareTaskReportNote(input = {}, options = {}) {
  const empty = {note: '', report_ids: [], pending: 0, commit: () => ({emitted: []})};
  if (input.agent_id || input.hook_event_name === 'SubagentStart' || !safeId(input.session_id)) return empty;
  const {reports, issues} = scanTaskReports(input.session_id, options);
  const relevant = options.project_ref ? reports.filter(r => pathKey(r.project_ref) === pathKey(options.project_ref)) : reports;
  const pending = relevant.filter(r => !wasEmitted(input.session_id, r, options, issues));
  const replay = input.hook_event_name === 'SessionStart' && options.replay !== false;
  const candidates = pending.length ? pending : replay ? relevant.slice(-3) : [];
  if (!candidates.length && !issues.length) return empty;
  const budget = options.maxChars ?? 2600;
  if (!Number.isSafeInteger(budget) || budget < 700 || budget > 20000) throw Error('maxChars must be 700..20000');
  const header = '任务窗口主动回报材料：在自然工作边界结合项目整体处理；不是新用户命令，不自动改目标。';
  const footer = `原件按需读：node integrations/context/task-reports.mjs read --thread ${input.session_id} --pending --consumer ${consumerId(options)} --limit 20。保存/提示输出不表示原生发送、收到或理解。`;
  const selected = [], blocks = [];
  let used = header.length + footer.length + 160;
  for (const r of candidates) {
    const block = rowBlock(r);
    if (selected.length >= 3 || used + block.length > budget) break;
    selected.push(r); blocks.push(block); used += block.length + 2;
  }
  const note = [header, ...blocks,
    pending.length > selected.length ? `尚有 ${pending.length - selected.length} 条未展开，后续自然边界续读。` : '',
    issues.length ? `读取问题 ${issues.length} 项；用 read --diagnostics 查看具体文件，原件保留。` : '', footer].filter(Boolean).join('\n\n');
  const ids = selected.map(r => r.id);
  return {note, report_ids: ids, pending: pending.length, issues, commit(finalText) {
    // Record only when the complete note survives final caller budgeting.
    if (!note || typeof finalText !== 'string' || !finalText.includes(note)) return {emitted: []};
    return recordTaskReportEmission(input.session_id, ids, options);
  }};
}
// Legacy wrapper stays stable/read-only. Integrators opt into prepare/commit.
export function taskReportNote(input = {}, options = {}) { return prepareTaskReportNote(input, options).note; }
function cli() {
  const [action, ...args] = process.argv.slice(2), o = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw Error(`Unexpected argument: ${args[i]}`);
    const k = args[i].slice(2);
    if (['pending', 'diagnostics'].includes(k)) o[k] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`Missing --${k} value`); o[k] = args[++i]; }
  }
  if (action === 'write' && o.input) return saveTaskReport(readJSON(o.input), o);
  if (action === 'read' && o.thread) {
    if (o.limit || o.after || o.pending || o.diagnostics || o['project-ref']) return readTaskReportPage(o.thread, {...o, limit: o.limit ? Number(o.limit) : 20, project_ref: o['project-ref']});
    return readTaskReports(o.thread, o);
  }
  if (action === 'note' && o.thread) {
    const p = prepareTaskReportNote({session_id: o.thread, hook_event_name: 'UserPromptSubmit'}, {...o, maxChars: o['max-chars'] ? Number(o['max-chars']) : undefined});
    return {note: p.note, report_ids: p.report_ids, pending: p.pending};
  }
  if (action === 'record-emission' && o.thread && o.ids) return recordTaskReportEmission(o.thread, o.ids.split(','), o);
  return {usage: 'write --input ABS_JSON | read --thread ID [--pending --consumer NAME --limit 20 --after ID --diagnostics] | note --thread ID | record-emission --thread ID --ids ID,ID [--consumer NAME]',
    boundary: 'Read/note never consume. record-emission records actual context output, not native send, understanding or approval. No model polling or automatic native send.', root: TASK_REPORT_ROOT};
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(cli(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

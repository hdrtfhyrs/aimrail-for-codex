import {integrationPath} from '../paths.mjs';
// 统一本地召回：知识/经验/错误/方法卡、对象、资源、成果登记。
// 做法沿 qmd、claude-mem、codemem 的成熟路线：SQLite FTS5（trigram，中文无需分词）
// 与向量检索（Ollama bge-m3，可用时）各自排名，再用 RRF(k=60) 融合。
// 召回只是线索：返回总数、来源与行号，采用前由 AI 读原件。
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = process.env.RECALL_CACHE_DIR || integrationPath('workspace/.cache/recall-system');
const DB_FILE = path.join(CACHE, 'recall.sqlite');
const OBJECTS = integrationPath("modules/system/资料中心/object-knowledge/data/objects.json");
const REGISTRY = integrationPath("modules/system/资料中心/data/资料登记.json");
const PROJECTS = integrationPath("workspace/projects");
const INFO_DB = integrationPath("modules/system/信息中心/data/information.sqlite");
const OLLAMA = process.env.OLLAMA_HOST ? process.env.OLLAMA_HOST.replace(/\/$/, '') : 'http://127.0.0.1:11434';
const EMBED_MODEL = process.env.RECALL_EMBED_MODEL || 'bge-m3';
// RRF常数60沿Cormack等2009年原论文与多数实现；只影响名次融合，不是相关性门槛。
const RRF_K = 60;
const EMBED_CHARS = 1600; // 单块向量输入上限：知识卡节一般在此以内，长节取开头。
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
const slash = value => String(value).replaceAll('\\', '/');

// node:sqlite在Node 24仍标实验性，警告异步打印到stderr，会混进hook输出；只滤掉这一条。
let warningFiltered = false;
function sqlite() {
  if (!warningFiltered) {
    const original = process.emitWarning;
    process.emitWarning = (warning, ...rest) => { if (!String(warning?.message || warning).includes('SQLite is an experimental')) original.call(process, warning, ...rest); };
    warningFiltered = true;
  }
  return createRequire(import.meta.url)('node:sqlite');
}

function open() {
  fs.mkdirSync(CACHE, {recursive: true});
  const {DatabaseSync} = sqlite();
  const db = new DatabaseSync(DB_FILE);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS docs(id TEXT PRIMARY KEY, kind TEXT, title TEXT, source TEXT, start INTEGER, end INTEGER, text TEXT, hash TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(id UNINDEXED, title, text, tokenize='trigram');
    CREATE TABLE IF NOT EXISTS vec(id TEXT PRIMARY KEY, hash TEXT, v BLOB);
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);`);
  return db;
}

const mtime = file => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
function deliverableIndexes() {
  try { return fs.readdirSync(PROJECTS, {withFileTypes: true}).filter(e => e.isDirectory()).map(e => path.join(PROJECTS, e.name, '成果', 'INDEX.md')).filter(f => fs.existsSync(f)); }
  catch { return []; }
}

async function collect() {
  const rows = [];
  const add = (id, kind, title, source, start, end, text) => {
    const body = String(text || '').replace(/\s+\n/g, '\n').trim();
    if (body) rows.push({id, kind, title: String(title || '').slice(0, 200), source: slash(source || ''), start: start || 0, end: end || 0, text: body});
  };
  const knowledge = await import(pathToFileURL(path.join(HERE, 'knowledge.mjs')).href);
  for (const doc of knowledge.knowledgeDocuments().docs) add(doc.id, doc.type, doc.title, doc.source, doc.startLine, doc.endLine, doc.title + '\n' + doc.body);
  try {
    for (const r of JSON.parse(fs.readFileSync(OBJECTS, 'utf8').replace(/^\uFEFF/, '')).records || []) {
      const parts = [r.name, (r.aliases || []).join(' '), r.summary, (r.categories || []).join(' '), (r.unknowns || []).join('；'),
        ...(r.claims || r.properties || []).map(c => [c.key || c.name, c.value || c.text, c.condition].filter(Boolean).join('：'))];
      add('obj:' + r.id, 'object', r.name || r.id, OBJECTS, 0, 0, parts.filter(Boolean).join('\n'));
    }
  } catch {}
  try {
    const {redactResourceOutput} = await import(pathToFileURL(path.join(HERE, 'resources.mjs')).href);
    const master = JSON.parse(fs.readFileSync(REGISTRY, 'utf8').replace(/^\uFEFF/, ''));
    // 账号只收名称、平台、用途和状态；标识、凭据引用和入口地址不进索引。
    const fields = ['name', 'platform', 'product', 'category', 'scope', 'purpose', 'usage', 'notes', 'status', 'nextAction', 'blockedBy'];
    for (const kind of ['accounts', 'benefits', 'resources', 'sources']) for (const r of master[kind] || []) {
      add('res:' + r.id, 'resource', r.name || r.id, REGISTRY, 0, 0, redactResourceOutput(fields.filter(k => r[k]).map(k => k + '：' + r[k]).join('\n')) + '\n读取：node "' + slash(path.join(HERE, 'resources.mjs')) + '" read --id ' + r.id);
    }
  } catch {}
  // 信息中心近30天值得学习、跟踪或行动的条目：按相关度送到任何会话，替代只推两个分支的白名单。
  try {
    const {DatabaseSync} = sqlite();
    const info = new DatabaseSync(INFO_DB, {readOnly: true});
    try {
      for (const e of info.prepare("SELECT id,title,category,disposition,importance,summary,why_useful,next_action,evidence_urls_json,updated_at FROM events WHERE disposition IN ('action','learn','watch') AND updated_at > date('now','-30 day')").all()) {
        let url = ''; try { url = JSON.parse(e.evidence_urls_json)[0] || ''; } catch {}
        add('info:' + e.id, 'info', `${e.title}（${e.disposition}，${e.updated_at.slice(0, 10)}）`, INFO_DB, 0, 0,
          [e.title, e.summary, e.why_useful, e.next_action ? '下一步：' + e.next_action : '', url].filter(Boolean).join('\n'));
      }
    } finally { info.close(); }
  } catch {}
  // 反复出现、仍未处理的工具失败（失败收件箱，出现3次以上或跨2个会话）：让相关任务看到“这里栽过”。
  try {
    const store = JSON.parse(fs.readFileSync((process.env.FAILURE_INBOX_DIRECTORY ? path.join(process.env.FAILURE_INBOX_DIRECTORY,'failures.json') : integrationPath('workspace/failure-inbox/failures.json')), 'utf8'));
    for (const f of (store.items || store)) {
      if (!['open', 'needs-review'].includes(f.status) || (f.count < 3 && (f.uniqueSessions || 0) < 2)) continue;
      add('fail:' + f.id, 'failure', `${f.tool_name}失败 ×${f.count}（${f.uniqueSessions}个会话）`, (process.env.FAILURE_INBOX_DIRECTORY ? path.join(process.env.FAILURE_INBOX_DIRECTORY,'failures.json') : integrationPath('workspace/failure-inbox/failures.json')), 0, 0,
        `${f.diagnostic}\n状态：${f.status}；最近：${f.lastSeen}；项目：${(f.projects || []).join('、')}\n查看：node "${slash(path.join(HERE, 'failure-inbox.mjs'))}" read --id ${f.id}`);
    }
  } catch {}
  // 各项目共享状态的分支：供未归属会话找候选任务（默认不进普通召回块）。
  try {
    const {readSharedState} = await import(pathToFileURL(path.join(HERE, 'shared-state.mjs')).href);
    for (const entry of fs.readdirSync(PROJECTS, {withFileTypes: true}).filter(e => e.isDirectory())) {
      const project = path.join(PROJECTS, entry.name), state = fs.existsSync(path.join(project, '共享状态.md')) ? readSharedState(project) : null;
      for (const b of state?.branches || []) {
        if (b.archived) continue; // 历史沿稳定ID/归档索引查，不混入未归属任务候选。
        const f = b.fields || {};
        add('branch:' + entry.name + ':' + b.id, 'branch', b.name, slash(project), 0, 0,
          [b.name, '项目：' + entry.name, '分支ID：' + b.id, '阶段：' + (f['阶段'] || ''), '负责人：' + (f['负责人'] || ''), '本轮目标：' + (f['本轮目标'] || ''), '有效条件：' + String(f['有效条件'] || '').slice(0, 400)].join('\n'));
      }
    }
  } catch {}
  for (const file of deliverableIndexes()) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^- (.+?)｜.*`(deliverable:[0-9a-f]+)`/);
      if (!m) continue;
      let j = i + 1; const detail = [];
      while (j < lines.length && /^\s+- /.test(lines[j])) detail.push(lines[j++].trim());
      add('dlv:' + m[2], 'deliverable', m[1], file, i + 1, j, m[1] + '\n' + detail.join('\n'));
    }
  }
  return rows;
}

function signature() {
  let knowledgeRev = '';
  try { knowledgeRev = fs.readdirSync(path.join(HERE, 'knowledge-cache')).map(f => f + mtime(path.join(HERE, 'knowledge-cache', f))).join('|'); } catch {}
  return hash([knowledgeRev, mtime(OBJECTS), mtime(REGISTRY), mtime(INFO_DB), mtime((process.env.FAILURE_INBOX_DIRECTORY ? path.join(process.env.FAILURE_INBOX_DIRECTORY,'failures.json') : integrationPath('workspace/failure-inbox/failures.json'))), ...deliverableIndexes().map(f => f + mtime(f)),
    ...deliverableIndexes().map(f => mtime(path.join(path.dirname(path.dirname(f)), '共享状态.md'))),
    ...[integrationPath("workspace/memory/errors"), integrationPath("workspace/memory/experiences"), integrationPath("workspace/memory/knowledge"), integrationPath("workspace/memory/knowledge/方法与演进库/cards")]
      .map(d => { try { return fs.readdirSync(d).map(f => f + mtime(path.join(d, f))).join(','); } catch { return ''; } })].join('\n'));
}

export async function refresh(options = {}) {
  const db = open();
  try {
    const sig = signature();
    const prior = db.prepare('SELECT value FROM meta WHERE key=?').get('signature')?.value;
    if (!options.force && prior === sig) return {changed: false, docs: db.prepare('SELECT count(*) n FROM docs').get().n};
    const rows = await collect();
    const seen = new Set();
    db.exec('BEGIN');
    try {
      const getHash = db.prepare('SELECT hash FROM docs WHERE id=?');
      const upsert = db.prepare('INSERT OR REPLACE INTO docs(id,kind,title,source,start,end,text,hash) VALUES (?,?,?,?,?,?,?,?)');
      const delFts = db.prepare('DELETE FROM fts WHERE id=?'), addFts = db.prepare('INSERT INTO fts(id,title,text) VALUES (?,?,?)');
      for (const r of rows) {
        if (seen.has(r.id)) continue; seen.add(r.id);
        const h = hash(r.kind + r.title + r.source + r.start + r.text);
        if (getHash.get(r.id)?.hash === h) continue;
        upsert.run(r.id, r.kind, r.title, r.source, r.start, r.end, r.text, h);
        delFts.run(r.id); addFts.run(r.id, r.title, r.text);
      }
      for (const {id} of db.prepare('SELECT id FROM docs').all()) if (!seen.has(id)) {
        db.prepare('DELETE FROM docs WHERE id=?').run(id); delFts.run(id); db.prepare('DELETE FROM vec WHERE id=?').run(id);
      }
      db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('signature', sig);
      db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('refreshedAt', new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return {changed: true, docs: seen.size};
  } finally { db.close(); }
}

async function ollamaUp(timeoutMs) {
  try { const r = await fetch(OLLAMA + '/api/version', {signal: AbortSignal.timeout(timeoutMs)}); return r.ok; } catch { return false; }
}
async function embed(texts, timeoutMs) {
  const r = await fetch(OLLAMA + '/api/embed', {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({model: EMBED_MODEL, input: texts, keep_alive: '30m'}), signal: AbortSignal.timeout(timeoutMs)});
  if (!r.ok) throw Error('embed HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return (await r.json()).embeddings.map(v => { const a = Float32Array.from(v); let n = 0; for (const x of a) n += x * x; n = Math.sqrt(n) || 1; for (let i = 0; i < a.length; i++) a[i] /= n; return a; });
}

// 显式建向量：Ollama未运行时尝试启动本机ollama serve（只在index --embed里做，hook不启动进程）。
export async function embedMissing(options = {}) {
  if (!(await ollamaUp(800))) {
    if (options.start === false) return {status: 'ollama-unavailable'};
    const exe = process.env.AI_OLLAMA_EXECUTABLE || 'ollama';
    spawn(exe, ['serve'], {detached: true, stdio: 'ignore', windowsHide: true}).unref();
    const until = Date.now() + 30000;
    while (Date.now() < until && !(await ollamaUp(800))) await new Promise(r => setTimeout(r, 700));
    if (!(await ollamaUp(800))) return {status: 'ollama-unavailable', detail: '尝试启动ollama serve后30秒内仍不可连'};
  }
  const db = open();
  try {
    const todo = db.prepare('SELECT d.id, d.title, d.text, d.hash FROM docs d LEFT JOIN vec v ON v.id=d.id WHERE v.id IS NULL OR v.hash<>d.hash').all();
    const put = db.prepare('INSERT OR REPLACE INTO vec(id,hash,v) VALUES (?,?,?)');
    let done = 0;
    for (let i = 0; i < todo.length; i += 16) {
      const batch = todo.slice(i, i + 16);
      const vectors = await embed(batch.map(r => (r.title + '\n' + r.text).slice(0, EMBED_CHARS)), 120000);
      db.exec('BEGIN');
      batch.forEach((r, k) => put.run(r.id, r.hash, Buffer.from(vectors[k].buffer)));
      db.exec('COMMIT');
      done += batch.length;
    }
    return {status: 'ok', embedded: done, total: db.prepare('SELECT count(*) n FROM vec').get().n};
  } finally { db.close(); }
}

// 中文连续段取三字滑窗，英文/数字词整体；FTS5 trigram 以子串匹配，免分词。
function queryGrams(query) {
  const text = String(query || '').normalize('NFKC').toLowerCase();
  const grams = new Set(), short = new Set();
  for (const run of text.match(/[\p{Script=Han}]+/gu) || []) {
    if (run.length < 3) { if (run.length === 2) short.add(run); continue; }
    for (let i = 0; i + 3 <= run.length; i++) grams.add(run.slice(i, i + 3));
  }
  for (const word of text.match(/[a-z0-9][a-z0-9._+-]*/g) || []) word.length >= 3 ? grams.add(word) : null;
  return {grams: [...grams].slice(0, 80), short: [...short].slice(0, 12)};
}

function snippet(text, grams) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const g of grams) { const i = lower.indexOf(g); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const start = Math.max(0, at - 50);
  return (start ? '…' : '') + text.slice(start, start + 170).replace(/\s+/g, ' ') + (text.length > start + 170 ? '…' : '');
}

export async function recall(query, options = {}) {
  const started = Date.now();
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 10)), offset = Math.max(0, Number(options.offset) || 0);
  const kinds = options.kinds ? new Set(String(options.kinds).split(',').map(s => s.trim())) : null;
  if (options.refresh !== false) await refresh();
  const db = open();
  try {
    const {grams, short} = queryGrams(query);
    const lexical = new Map();
    let lexicalTotal = 0;
    if (grams.length) {
      const match = grams.map(g => '"' + g.replaceAll('"', '""') + '"').join(' OR ');
      const rows = db.prepare('SELECT id, title, text, bm25(fts, 4.0, 1.0) s FROM fts WHERE fts MATCH ? ORDER BY s LIMIT 400').all(match);
      lexicalTotal = db.prepare('SELECT count(*) n FROM fts WHERE fts MATCH ?').get(match).n;
      // OR查询下，单个三字片段重复多次会压过覆盖整句的文档；“有什么”“的办法”这类常见片段
      // 又会压过主题词。按覆盖片段的IDF之和排序（稀有片段权重高），同分再按BM25。
      const total = db.prepare('SELECT count(*) n FROM docs').get().n || 1;
      const countGram = db.prepare('SELECT count(*) n FROM fts WHERE fts MATCH ?');
      const idf = new Map(grams.map(g => [g, Math.log((total + 1) / (countGram.get('"' + g.replaceAll('"', '""') + '"').n + 0.5))]));
      for (const r of rows) { const body = (r.title + '\n' + r.text).toLowerCase(); r.cover = grams.reduce((n, g) => n + (body.includes(g) ? Math.max(0, idf.get(g)) : 0), 0); }
      rows.sort((a, b) => b.cover - a.cover || a.s - b.s).forEach((r, i) => lexical.set(r.id, i + 1));
    }
    if (!grams.length && short.length) {
      const rows = db.prepare(`SELECT id FROM docs WHERE ${short.map(() => 'instr(lower(text), ?) > 0').join(' OR ')} LIMIT 400`).all(...short);
      lexicalTotal = rows.length; rows.forEach((r, i) => lexical.set(r.id, i + 1));
    }
    const vector = new Map();
    let vectorStatus = 'off';
    if (options.vector !== false) {
      const count = db.prepare('SELECT count(*) n FROM vec').get().n;
      if (!count) vectorStatus = 'no-index';
      else if (!(await ollamaUp(options.probeMs ?? 400))) vectorStatus = 'ollama-unavailable';
      else {
        try {
          const [q] = await embed([String(query).slice(0, EMBED_CHARS)], options.embedTimeoutMs ?? 4000);
          const scored = [];
          for (const r of db.prepare('SELECT id, v FROM vec').all()) {
            const v = new Float32Array(r.v.buffer, r.v.byteOffset, r.v.byteLength / 4);
            let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * q[i];
            scored.push([r.id, s]);
          }
          scored.sort((a, b) => b[1] - a[1]).slice(0, 200).forEach(([id], i) => vector.set(id, i + 1));
          vectorStatus = 'ok';
        } catch (error) { vectorStatus = 'error: ' + error.message.slice(0, 120); }
      }
    }
    const fused = new Map();
    for (const [id, rank] of lexical) fused.set(id, (fused.get(id) || 0) + 1 / (RRF_K + rank));
    for (const [id, rank] of vector) fused.set(id, (fused.get(id) || 0) + 1 / (RRF_K + rank));
    const get = db.prepare('SELECT id, kind, title, source, start, end, text FROM docs WHERE id=?');
    // 同一张卡/文档的多个节只留排名最前的一节，其余由读原件展开，免得一张卡占满名额。
    const docKey = new Set();
    const ranked = [...fused].sort((a, b) => b[1] - a[1]).map(([id, score]) => ({...get.get(id), score}))
      .filter(r => r.id && (kinds ? kinds.has(r.kind) : r.kind !== 'branch') && !(options.exclude || []).includes(r.id))
      .filter(r => { const k = r.source + '\0' + (r.kind === 'resource' || r.kind === 'object' || r.kind === 'deliverable' ? r.id : r.title); if (docKey.has(k)) return false; docKey.add(k); return true; });
    const items = ranked.slice(offset, offset + limit).map(r => ({id: r.id, kind: r.kind, title: r.title,
      ref: r.start ? `${r.source}:${r.start}-${r.end}` : r.source, signals: [lexical.has(r.id) ? 'lex#' + lexical.get(r.id) : '', vector.has(r.id) ? 'vec#' + vector.get(r.id) : ''].filter(Boolean).join(' '),
      snippet: snippet(r.text, grams)}));
    return {query: String(query).slice(0, 300), total: ranked.length, lexicalTotal, vector: vectorStatus, offset, items,
      more: Math.max(0, ranked.length - offset - limit), ms: Date.now() - started,
      boundary: '召回线索：按字面与语义相近排序，不是适用性判断；采用前读ref原件。kind=resource用resources.mjs read，object用objects.mjs read。'};
  } finally { db.close(); }
}

// 负责人字段写明“宿主:会话ID”的分支（会话登记了分支却未绑定时用于自动绑定）。
export async function branchOwnedBy(token) {
  await refresh();
  const db = open();
  try {
    return db.prepare("SELECT id, title, text FROM docs WHERE kind='branch' AND instr(text, ?) > 0").all(token)
      .filter(r => r.text.split('\n').some(line => line.startsWith("负责人：") && line.includes(token))).map(({id, title}) => ({id, title}));
  } finally { db.close(); }
}

export function formatRecall(result, options = {}) {
  const budget = options.maxChars || 2400;
  if (!result?.items?.length) return '';
  const head = `本地相关知识/经验/成果（程序按本条消息检索；共${result.total}条候选${result.vector === 'ok' ? '，字面+语义' : '，字面'}；线索不是结论，用前读原件）：`;
  const tail = `更多：node "${slash(path.join(HERE, 'recall.mjs'))}" search --query "…" --offset ${result.offset + result.items.length}`;
  const lines = [];
  for (const item of result.items) {
    const line = `- [${item.kind}] ${item.title} — ${item.ref}\n  ${item.snippet}`;
    if ([head, ...lines, line, tail].join('\n').length > budget) break;
    lines.push(line);
  }
  return lines.length ? [head, ...lines, tail].join('\n') : '';
}

// 后台补向量：只在Ollama已运行时补，不启动进程。
export function spawnEmbedIfStale() {
  try {
    const db = open();
    const stale = db.prepare('SELECT count(*) n FROM docs d LEFT JOIN vec v ON v.id=d.id WHERE v.id IS NULL OR v.hash<>d.hash').get().n;
    db.close();
    if (!stale) return false;
    const lock = path.join(CACHE, 'embed.lock');
    if (Date.now() - mtime(lock) < 10 * 60 * 1000) return false;
    fs.writeFileSync(lock, String(process.pid));
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'index', '--embed', '--no-start'], {detached: true, stdio: 'ignore', windowsHide: true}).unref();
    return true;
  } catch { return false; }
}

async function main(argv) {
  const [cmd = 'help', ...rest] = argv, opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) continue;
    const key = rest[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    opts[key] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  }
  if (cmd === 'index') {
    const lexical = await refresh({force: opts.force === true});
    const vectors = opts.embed ? await embedMissing({start: !opts.noStart}) : {status: 'skipped（加 --embed 建向量）'};
    try { fs.unlinkSync(path.join(CACHE, 'embed.lock')); } catch {}
    return {lexical, vectors};
  }
  if (cmd === 'search') {
    const result = await recall(opts.query || '', {limit: opts.limit, offset: opts.offset, kinds: opts.kinds, vector: opts.noVector ? false : undefined});
    return opts.json ? result : formatRecall(result, {maxChars: Number(opts.maxChars) || 6000}) || `无候选（${result.vector}）；换叫法或沿目录/原件找，无命中不表示没有。`;
  }
  if (cmd === 'status') {
    await refresh();
    const db = open();
    try {
      const kinds = db.prepare('SELECT kind, count(*) n FROM docs GROUP BY kind').all();
      return {db: DB_FILE, kinds, vectors: db.prepare('SELECT count(*) n FROM vec').get().n, refreshedAt: db.prepare('SELECT value FROM meta WHERE key=?').get('refreshedAt')?.value, ollama: await ollamaUp(800)};
    } finally { db.close(); }
  }
  return 'recall.mjs search --query TEXT [--limit 10] [--offset N] [--kinds knowledge,experience,error,object,resource,deliverable] [--no-vector] [--json]\n'
    + 'recall.mjs index [--embed] [--force]   建/更新索引；--embed 用 Ollama bge-m3 补向量（未运行时尝试启动 ollama serve）\nrecall.mjs status';
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(r => console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
}

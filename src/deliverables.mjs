/** User-level, bounded deliverable navigation. Metadata is not proof of acceptance.
 * Refresh discovers only immediate 成果/ children. Brief reads cached metadata only.
 */
import fs from 'node:fs';
import path from 'node:path';
import {PROJECTS_ROOT} from './paths.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const OWNER = 'codex-deliverables-v1';
const MARKER = `<!-- owner:${OWNER} -->`;
const DEFAULT_ROOT = PROJECTS_ROOT;
const REGISTRY = '成果登记.json';
const CACHE = '.成果目录.json';
const UNVERIFIED = '已存档；验收未登记';
const statusLabel = value => ({ archived: '存档/验收未登记', delivered: '已交付', verified: '已实测（边界见条目）', pending: '待续接' }[value] || value);
const slash = s => s.replaceAll('\\', '/');
const cap = (v, n) => String(v ?? '').length <= n ? String(v ?? '') : String(v ?? '').slice(0, Math.max(0, n - 1)) + '…';
const line = (v, n = 200) => cap(String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim(), n);
const limit = (v, fallback, max) => Math.max(0, Math.min(max, Number.isFinite(Number(v)) ? Math.floor(Number(v)) : fallback));
const rootOf = options => path.resolve(options.projectsDir || DEFAULT_ROOT);
const inside = (base, target) => { const rel = path.relative(base, target); return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); };
function contained(base, target) {
  base = path.resolve(base); target = path.resolve(target);
  if (!inside(base, target)) throw new Error(`目录逃逸: ${target}`);
  // Resolve the nearest existing ancestor, so new paths through junctions are checked too.
  let ancestor = target;
  while (!fs.existsSync(ancestor)) { const next = path.dirname(ancestor); if (next === ancestor) break; ancestor = next; }
  let baseAncestor = base;
  while (!fs.existsSync(baseAncestor)) { const next = path.dirname(baseAncestor); if (next === baseAncestor) break; baseAncestor = next; }
  const actualBase = path.resolve(fs.realpathSync(baseAncestor), path.relative(baseAncestor, base));
  const actualTarget = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, target));
  if (!inside(actualBase, actualTarget)) throw new Error(`目录链接逃逸: ${target}`);
  return target;
}
function projectPath(project) {
  const p = path.resolve(project);
  if (!fs.statSync(p).isDirectory() || !fs.existsSync(path.join(p, '核心.md'))) throw new Error(`缺项目核心原件: ${p}`);
  return p;
}
function outcomePath(project, entry) {
  if (!entry || /[\0]/.test(entry)) throw new Error('需要成果/内路径');
  const outcomes = contained(project, path.join(project, '成果'));
  return contained(outcomes, path.isAbsolute(entry) ? entry : path.join(project, entry.startsWith('成果/') ? entry : '成果/' + entry));
}
const refOf = (project, entry) => 'deliverable:' + createHash('sha256').update(slash(path.resolve(project)).toLowerCase() + '\n' + slash(entry)).digest('hex').slice(0, 20);
function jsonFile(file, fallback) { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function readRegistry(project) {
  const data = jsonFile(path.join(project, '成果', REGISTRY), { entries: [] });
  if (!Array.isArray(data.entries)) throw new Error(`成果登记格式无效: ${project}`);
  return data;
}
function writeOwned(file, content, json = false) {
  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file, 'utf8');
    if (old === content) return 'unchanged';
    if (json ? JSON.parse(old.replace(/^\uFEFF/, '')).owner !== OWNER : !old.startsWith(MARKER)) return 'protected';
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const backupDir = path.join(path.dirname(file), '.catalog-backups'); fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(file, path.join(backupDir, path.basename(file) + '.' + Date.now() + '.' + randomUUID() + '.bak'), fs.constants.COPYFILE_EXCL);
  }
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, content, 'utf8'); fs.renameSync(temp, file);
  return 'written';
}
function serialize(value) { return JSON.stringify(value, null, 2) + '\n'; }
function withLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 2000; let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(file, 'wx'); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) throw new Error(`成果目录正在更新；请稍后重试。若持续失败，检查仍持有锁的进程：${file}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return fn(); } finally { fs.closeSync(fd); fs.unlinkSync(file); }
}
function metadata(project, item, registered) {
  const entry = slash(path.relative(path.join(project, '成果'), outcomePath(project, item.entry)));
  const target = outcomePath(project, entry);
  const directory = (item.directory ? slash(path.relative(path.join(project, '成果'), outcomePath(project, item.directory))) : (fs.existsSync(target) && fs.statSync(target).isDirectory() ? entry : slash(path.dirname(entry)))) || '.';
  if (!inside(outcomePath(project, directory === '.' ? './' : directory), target)) throw new Error('entry 不在指定档案 directory 内');
  const exists = fs.existsSync(target);
  return { ref: refOf(project, directory === '.' ? entry : directory), project: slash(project), projectName: path.basename(project), directory, entry,
    title: line(item.title || path.basename(entry), 100), summary: line(item.summary, 220),
    status: registered ? line(item.status || UNVERIFIED, 140) : UNVERIFIED,
    boundary: line(item.boundary || (registered ? '仅记录登记者报告的层级；未独立验收' : '只发现已存档路径；未读正文、未验收'), 220),
    next: line(item.next, 180), branch: line(item.branch, 100), ledger: line(item.ledger, 400),
    evidence: Array.isArray(item.evidence) ? item.evidence.slice(0, 8).map(v => line(v, 400)) : [],
    registered, exists, kind: exists ? (fs.statSync(target).isDirectory() ? 'directory' : 'file') : 'missing' };
}
function discoverProjects(root) {
  const roots = new Set([path.resolve(root)]), candidates = [];
  if (path.resolve(root).toLowerCase() === path.resolve(DEFAULT_ROOT).toLowerCase()) {
    const registry = jsonFile(path.join(os.homedir(), '.codex', 'context', 'projects.json'), {});
    for (const directory of registry.roots || []) if (typeof directory === 'string' && path.isAbsolute(directory)) roots.add(path.resolve(directory));
    for (const item of registry.projects || []) if (typeof item.projectPath === 'string' && path.isAbsolute(item.projectPath)) candidates.push(path.resolve(item.projectPath));
  }
  for (const directory of roots) {
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, {withFileTypes:true})) if (entry.isDirectory()) candidates.push(path.join(directory, entry.name));
  }
  const seen = new Set(), projects = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(path.join(candidate, '核心.md'))) continue;
    const physical = fs.realpathSync(candidate), identity = physical.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity); projects.push(physical);
  }
  return projects.sort((a, b) => a.localeCompare(b));
}
function collect(project) {
  const outcomes = path.join(project, '成果');
  if (fs.existsSync(outcomes)) contained(project, outcomes);
  const entries = readRegistry(project).entries.map(item => metadata(project, item, true));
  const registered = new Set(entries.map(e => e.entry.split('/')[0]));
  if (fs.existsSync(outcomes)) for (const child of fs.readdirSync(outcomes, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (child.name.startsWith('.') || [REGISTRY, 'INDEX.md'].includes(child.name) || registered.has(child.name)) continue;
    // Symlinks/junctions are not followed during discovery.
    if (child.isFile() || child.isDirectory()) {
      try { entries.push(metadata(project, { entry: child.name }, false)); }
      catch (err) { if (!String(err.message).includes('逃逸')) throw err; }
    }
  }
  return entries.sort((a, b) => a.entry.localeCompare(b.entry));
}
function renderProject(project, entries) {
  const text = [MARKER, '# 成果目录', '', '登记状态是记录者报告的验证层级；未登记档案不代表已验收。按 ref 展开原件。', '', `全局导航：[成果树](<${slash(path.join(DEFAULT_ROOT, '成果总览.md'))}>)`, `接续先读：[共享状态](<${slash(path.join(project, '共享状态.md'))}>)；再按当前目标核对应分支主线，历史条目不替代新条件。`, ''];
  for (const e of entries) {
    text.push(`- ${e.title}｜${statusLabel(e.status)}${e.exists ? '' : '｜原件缺失'}｜\`${e.ref}\``);
    text.push(`  - 原件：[${e.entry}](<${slash(path.join(project, '成果', e.entry))}>)${e.summary ? '；' + e.summary : ''}`);
    text.push('  - 验证边界：' + e.boundary);
    if (e.next) text.push('  - 接续：' + e.next);
  }
  return text.join('\n') + '\n';
}
function renderGlobal(root, projects, entries) {
  const text = [MARKER, '# 项目成果总览', '', '只作跨项目导航；项目与业务条件按需读取原件。状态不由文件名或文件存在推断。', ''];
  for (const p of projects) {
    text.push(`- [${p.name}](<${slash(path.join(p.project, '成果', 'INDEX.md'))}>)｜${p.count} 个档案`);
    text.push(`  - 成果/ → 项目短目录 → ref 元数据 → 原件；${p.registered} 个已登记验证层级`);
    for (const e of entries.filter(e => e.project === p.project)) text.push(`  - [${line(e.title, 65)}](<${slash(path.join(e.project, '成果', e.entry))}>)｜${statusLabel(e.status)}${e.exists ? '' : '｜原件缺失'}｜\`${e.ref}\``);
  }
  text.push('', '展开：node "src/deliverables.mjs" list --project 项目绝对目录；read --ref deliverable:…');
  return text.join('\n') + '\n';
}
export function refreshDeliverables(options = {}) {
  const root = rootOf(options);
  return withLock(path.join(root, '.成果目录.lock'), () => {
  const projects = []; const entries = []; const writes = [];
  for (const project of discoverProjects(root)) {
    const found = collect(project); entries.push(...found);
    projects.push({ project: slash(project), name: path.basename(project), count: found.length, registered: found.filter(e => e.registered).length });
    writes.push({ file: slash(path.join(project, '成果', 'INDEX.md')), result: writeOwned(path.join(project, '成果', 'INDEX.md'), renderProject(project, found)) });
  }
  const catalog = { owner: OWNER, version: 1, projects, entries };
  writes.push({ file: slash(path.join(root, CACHE)), result: writeOwned(path.join(root, CACHE), serialize(catalog), true) });
  writes.push({ file: slash(path.join(root, '成果总览.md')), result: writeOwned(path.join(root, '成果总览.md'), renderGlobal(root, projects, entries)) });
  return { projects: projects.length, entries: entries.length, writes };
  });
}
export function readDeliverables(options = {}) {
  const file = path.join(rootOf(options), CACHE);
  const catalog = jsonFile(file, { owner: OWNER, version: 1, projects: [], entries: [] });
  if (catalog.owner !== OWNER || !Array.isArray(catalog.entries)) throw new Error('成果目录缓存格式无效');
  return catalog;
}
export function listDeliverables(options = {}) {
  const project = options.project ? slash(path.resolve(options.project)) : null;
  return readDeliverables(options).entries.filter(e => !project || e.project.toLowerCase() === project.toLowerCase());
}
function score(e, query) {
  const q = String(query || '').trim().normalize('NFKC').toLowerCase();
  if (!q) return 0;
  const text = [e.title, e.summary, e.next, e.status, e.boundary, e.projectName, e.branch, e.entry].join(' ').normalize('NFKC').toLowerCase();
  if (text.includes(q)) return 100;
  const tokens = q.split(/[\s，。；、!?]+/).filter(t => t.length > 1);
  return tokens.reduce((s, t) => s + (text.includes(t) ? 1 : 0), 0);
}
export function searchDeliverables(query, options = {}) {
  return listDeliverables(options).map(e => ({ ...e, score: score(e, query) })).filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref)).slice(0, limit(options.limit, 20, 100));
}
export function readDeliverableBrief(project, options = {}) {
  const max = limit(options.maxChars, 1000, 1000); if (!max) return '';
  const root = rootOf(options); let catalog;
  const globalNav = `全局成果树：[成果总览](${slash(path.join(root, '成果总览.md'))})`;
  const lines = []; let used = 0;
  const add = value => { if (used + value.length + (lines.length ? 1 : 0) <= max) { lines.push(value); used += value.length + (lines.length > 1 ? 1 : 0); return true; } return false; };
  try { catalog = readDeliverables(options); } catch { add(globalNav); add('目录缓存待修复；运行 deliverables.mjs refresh。'); return lines.join('\n'); }
  const current = project ? slash(path.resolve(project)).toLowerCase() : '';
  let found = catalog.entries.filter(e => e.project.toLowerCase() === current);
  const recent = (a, b) => Number(b.registered) - Number(a.registered) || b.directory.localeCompare(a.directory) || b.entry.localeCompare(a.entry);
  const matched = options.query ? found.filter(e => score(e, options.query) > 0) : [];
  found = matched.length ? matched.sort((a, b) => score(b, options.query) - score(a, options.query) || recent(a, b)) : found.sort(recent);
  add(globalNav);
  if (project) add(`本项目：[成果索引](${slash(path.join(path.resolve(project), '成果', 'INDEX.md'))})`);
  const others = catalog.projects.filter(p => p.project.toLowerCase() !== current);
  if (others.length) add('项目短导航：' + others.slice(0, 12).map(p => `${line(p.name, 30)}(${p.count})`).join('、') + (others.length > 12 ? '…' : '') + ' → 全局树');
  for (const e of found.slice(0, 3)) add(`- ${line(e.title, 45)}｜${line(statusLabel(e.status), 35)}${e.exists ? '' : '｜原件缺失'}｜${e.ref}${e.summary ? '；' + line(e.summary, 55) : ''}；边界：${e.boundary}${e.next ? '；接续：' + line(e.next, 45) : ''}`);
  if (project && !found.length) add('当前项目暂无目录记录；刷新：node "src/deliverables.mjs" refresh');
  if (!catalog.projects.length && !project) add('刷新：node "src/deliverables.mjs" refresh');
  return lines.join('\n');
}
export function readDeliverable(ref, options = {}) {
  const e = readDeliverables(options).entries.find(e => e.ref === ref);
  if (!e) throw new Error(`未知成果 ref: ${ref}`);
  const target = outcomePath(e.project, e.entry); const max = limit(options.chars, 6000, 12000);
  let content; let format;
  if (!fs.existsSync(target)) { content = '原件缺失；登记内容保留，不能据此宣称成果仍可用。'; format = 'missing'; }
  else if (fs.statSync(target).isDirectory()) {
    format = 'directory'; content = fs.readdirSync(target, { withFileTypes: true }).slice(0, 80).map(c => `${c.isDirectory() ? '目录' : '文件'} ${c.name}`).join('\n');
  } else if (/\.(md|txt|json|mjs|js|ts|py|csv|tsv|yaml|yml|toml|html|css|log)$/i.test(target)) {
    format = 'text'; const fd = fs.openSync(target, 'r');
    try { const buffer = Buffer.alloc(Math.min(fs.statSync(target).size, max * 4 + 4)); const count = fs.readSync(fd, buffer, 0, buffer.length, 0); content = buffer.subarray(0, count).toString('utf8'); }
    finally { fs.closeSync(fd); }
  } else { format = 'binary-pointer'; content = '二进制原件，请通过 source 路径按需打开。'; }
  return { ...e, source: slash(target), exists: fs.existsSync(target), format, content: cap(content, max) };
}
function validateClaim(project, input) {
  if (input.status === 'verified') {
    if (!line(input.boundary, 220)) throw new Error('verified 需要明确 boundary');
    if (!Array.isArray(input.evidence) || !input.evidence.some(v => typeof v === 'string' && fs.existsSync(path.isAbsolute(v) ? v : path.join(project, v)))) throw new Error('verified 需要至少一个实际存在的 evidence 指针');
  }
}
function validateInput(project, input) {
  if (!input || typeof input !== 'object') throw new Error('登记需要 JSON 对象');
  const target = outcomePath(project, input.entry);
  if (!fs.existsSync(target)) throw new Error(`缺成果原件: ${target}`);
  if (!line(input.title, 100)) throw new Error('登记需要 title');
  validateClaim(project, input);
  return metadata(project, input, true);
}
export function registerDeliverable(project, input, options = {}) {
  project = projectPath(project);
  const value = validateInput(project, input); const file = path.join(project, '成果', REGISTRY);
  const lock = path.join(project, '成果', '.成果登记.lock');
  const result = withLock(lock, () => {
    const registry = readRegistry(project);
    if (fs.existsSync(file) && registry.owner !== OWNER) throw new Error(`人工成果登记文件受保护: ${file}`);
    const fields = ['ref', 'directory', 'entry', 'title', 'summary', 'status', 'boundary', 'next', 'branch', 'ledger', 'evidence'];
    const item = Object.fromEntries(fields.map(k => [k, value[k]]));
    const entries = registry.entries.filter(e => e.ref !== value.ref); entries.push(item); entries.sort((a, b) => a.entry.localeCompare(b.entry));
    return writeOwned(file, serialize({ owner: OWNER, version: 1, entries }), true);
  });
  return { ref: value.ref, registry: slash(file), result, refresh: refreshDeliverables(options) };
}
export function saveDeliverable(project, input, options = {}) {
  project = projectPath(project);
  const directory = input.directory;
  if (!directory) throw new Error('save 需要明确成果目录 directory（成果/内相对或绝对路径）');
  const destination = outcomePath(project, directory);
  if (fs.existsSync(destination) && !fs.statSync(destination).isDirectory()) throw new Error('directory 必须是档案目录');
  const entryPath = outcomePath(project, input.entry || directory);
  contained(destination, entryPath);
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > 100) throw new Error('save 需要 1..100 个明确单文件 files');
  if (!line(input.title, 100)) throw new Error('save 需要 title');
  validateClaim(project, input);
  const registryFile = path.join(project, '成果', REGISTRY);
  if (fs.existsSync(registryFile) && readRegistry(project).owner !== OWNER) throw new Error('人工成果登记文件受保护');
  const plans = input.files.map(spec => {
    if (!spec.source || !spec.target || path.isAbsolute(spec.target) || /^[a-z]:/i.test(spec.target)) throw new Error('files 需要 source 和相对 target');
    const source = fs.realpathSync(path.resolve(spec.source)); if (!fs.statSync(source).isFile()) throw new Error(`只保存明确单文件: ${source}`);
    const target = contained(destination, path.join(destination, spec.target)); contained(path.join(project, '成果'), target);
    if (fs.existsSync(target) && (!fs.statSync(target).isFile() || !fs.readFileSync(target).equals(fs.readFileSync(source)))) throw new Error(`拒绝覆盖不同原件: ${target}`);
    return { source, target };
  });
  if (new Set(plans.map(p => p.target.toLowerCase())).size !== plans.length) throw new Error('files target 重复');
  if (entryPath !== destination && !fs.existsSync(entryPath) && !plans.some(p => p.target === entryPath)) throw new Error('entry 必须是已存原件或本次保存的入口文件');
  const copied = [];
  for (const p of plans) {
    if (!fs.existsSync(p.target)) {
      fs.mkdirSync(path.dirname(p.target), { recursive: true });
      try { fs.copyFileSync(p.source, p.target, fs.constants.COPYFILE_EXCL); copied.push(slash(p.target)); }
      catch (err) { if (err.code !== 'EEXIST' || !fs.statSync(p.target).isFile() || !fs.readFileSync(p.target).equals(fs.readFileSync(p.source))) throw err; }
    }
  }
  const registration = registerDeliverable(project, { ...input, entry: input.entry || directory }, options);
  return { copied, ...registration };
}
function argsOf(argv) {
  const out = { command: argv[0] || 'list' };
  for (let i = 1; i < argv.length; i++) { if (!argv[i].startsWith('--') || i + 1 === argv.length) throw new Error(`无效参数: ${argv[i]}`); out[argv[i].slice(2)] = argv[++i]; }
  return out;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some(a => ['--help', '-h', 'help'].includes(a))) {
      console.log('成果目录：refresh | list [--project PATH] | search --query TEXT | read --ref REF [--chars 0..12000] | brief [--project PATH] | register/save --project PATH --input JSONFILE\n可选 --projects-dir PATH；默认当前工作区的 projects/。登记 input: directory,entry,title,summary,status,boundary,next,branch,ledger,evidence。save 另需 files:[{source,target}]，保留原件。brief只读短缓存<=1000字符。');
    } else {
    const args = argsOf(process.argv.slice(2)); const options = { project: args.project, projectsDir: args['projects-dir'], chars: args.chars, limit: args.limit };
    let result;
    if (args.command === 'refresh') result = refreshDeliverables(options);
    else if (args.command === 'list') result = args.project ? listDeliverables(options) : readDeliverables(options).projects;
    else if (args.command === 'search') result = searchDeliverables(args.query, options);
    else if (args.command === 'read') result = readDeliverable(args.ref, options);
    else if (['register', 'save'].includes(args.command)) {
      if (!args.project || !args.input) throw new Error('需要 --project 和 --input JSON文件');
      const input = jsonFile(path.resolve(args.input)); result = args.command === 'register' ? registerDeliverable(args.project, input, options) : saveDeliverable(args.project, input, options);
    } else if (args.command === 'brief') result = readDeliverableBrief(args.project, { ...options, query: args.query, maxChars: args.chars });
    else throw new Error('命令: refresh/list/search/read/register/save/brief');
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    }
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}

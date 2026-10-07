// Markdown 是唯一状态原件；这里的结构仅为读写视图，不另存语义快照。
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

// Existing create callers still require only the original seven fields. Goal
// and criteria are optional, independent of a local done/next progress update.
const REQUIRED_FIELDS = ['阶段', '负责人', '已做', '下一步', '有效条件', '主线', '依据'];
const FIELDS = [...REQUIRED_FIELDS, '本轮目标', '完成标准'];
const ALIASES = {phase: '阶段', owner: '负责人', done: '已做', next: '下一步', conditions: '有效条件', ledger: '主线', evidence: '依据', goal: '本轮目标', criteria: '完成标准'};
const BRANCH = /^###\s+(.+?)\s*<!--\s*branch:([A-Za-z0-9_-]+)\s*-->\s*(?:<!--\s*archived:(\S+)\s*-->)?\s*$/;
const FIELD = /^\s*[-*]\s+([^：:]+)[：:]\s*(.*)$/;
const REVISION = /<!--\s*shared-state revision:(\d+)\s*-->/;

function absolute(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) throw new Error(`${label}须为绝对路径。`);
  return path.resolve(value);
}
function projectFile(project) { return path.join(absolute(project, '项目目录'), '共享状态.md'); }
function branchId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('分支 ID 仅允许字母、数字、下划线和连字符。');
  return id;
}
function ledgerPath(value, strict = false) {
  if (!value || value.trim() === '无') return null;
  let target = value.trim();
  const link = target.match(/^\[[^\]]*\]\((?:<([^>]+)>|([^\)]+))\)$/);
  if (link) target = link[1] || link[2];
  target = target.replace(/^`([^`]+)`$/, '$1').replace(/^<([^>]+)>$/, '$1');
  if (!path.isAbsolute(target) || path.extname(target).toLowerCase() !== '.md') {
    if (strict) throw new Error('主线须为绝对 Markdown 文件路径或“无”。');
    return null;
  }
  return path.resolve(target);
}
function normalizedPath(value) { return process.platform === 'win32' ? value.toLowerCase() : value; }

function parse(file, text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^##\s+(.+?)\s*$/);
    if (match) sections.push({name: match[1], start: index});
  }
  sections.forEach((section, index) => { section.end = sections[index + 1]?.start ?? lines.length; });
  const branches = [];
  for (const branchSection of sections.filter(section => ['当前分支','已归档分支'].includes(section.name))) {
    const local = [];
    for (let index = branchSection.start + 1; index < branchSection.end; index++) {
      const match = lines[index].match(BRANCH);
      if (match) local.push({id: match[2], name: match[1], start: index, archiveRef:match[3] || null, archived:Boolean(match[3])});
    }
    local.forEach((branch, index) => {
      branch.end = local[index + 1]?.start ?? branchSection.end;
      branch.text = lines.slice(branch.start, branch.end).join('\n').trimEnd();
      branch.fields = {};
      branch.fieldRanges = {};
      const starts = [];
      for (let line = branch.start + 1; line < branch.end; line++) {
        const match = lines[line].match(FIELD);
        // Only unindented field markers begin a field; indented lines belong to its value.
        if (match && /^[-*]\s/.test(lines[line])) starts.push({name: match[1].trim(), value: match[2], start: line});
      }
      starts.forEach((field, position) => {
        if (!FIELDS.includes(field.name)) return;
        if (branch.fieldRanges[field.name]) throw new Error(`分支 ${branch.id} 的字段重复：${field.name}`);
        let end = starts[position + 1]?.start ?? branch.end;
        while (end > field.start + 1 && !lines[end - 1].trim()) end--;
        const rest = lines.slice(field.start + 1, end).map(line => line.replace(/^  /, ''));
        branch.fields[field.name] = [field.value, ...rest].join('\n').trimEnd();
        branch.fieldRanges[field.name] = {start: field.start, end};
      });
      branch.ledger = ledgerPath(branch.fields['主线']);
    });
    branches.push(...local);
  }
  if (new Set(branches.map(branch => branch.id)).size !== branches.length) throw new Error(`共享状态含重复分支 ID：${file}`);
  const revision = Number(text.match(REVISION)?.[1] || 0);
  if (!Number.isSafeInteger(revision)) throw new Error('共享状态 revision 超出安全整数范围。');
  return {file, full: file, text, revision, branches, sections, lines, newline: text.includes('\r\n') ? '\r\n' : '\n'};
}

export function readSharedState(project) {
  const file = projectFile(project);
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const state = parse(file,text);
  for (const branch of state.branches.filter(b=>b.archived)) {
    const target = path.resolve(project,branch.archiveRef), root = path.resolve(project,'共享状态归档');
    if (path.dirname(target) !== root || path.extname(target) !== '.md') throw new Error('分支归档路径越界：'+branch.id);
    const archived = parse(target,fs.readFileSync(target,'utf8'));
    if (archived.branches.length !== 1 || archived.branches[0].id !== branch.id || archived.branches[0].archived) throw new Error('分支归档原件不匹配：'+branch.id);
    const original = archived.branches[0];
    Object.assign(branch,{fields:original.fields,ledger:original.ledger,text:original.text,source:target});
  }
  return state;
}

// One selector for initial, incremental and recovery readers. Ambiguous routes
// never become a first/latest-branch guess in a downstream consumer.
export function selectSharedBranch(state, {ledger, branchId: targetId} = {}) {
  let selected = null;
  let selection = '未指定目标分支；以下分支均为索引，不标记当前。';
  if (!state) return {selected, selection: '共享状态原件不存在。'};
  if (targetId !== undefined && targetId !== null) {
    branchId(targetId);
    selected = state.branches.find(branch => branch.id === targetId) || null;
    selection = selected ? `显式目标分支：${targetId}` : `指定分支 ${targetId} 不在共享原件中；未替换为其他分支。`;
  } else if (ledger) {
    const wanted = ledgerPath(absolute(ledger, '主线'), true);
    const matches = state.branches.filter(branch => branch.ledger && normalizedPath(branch.ledger) === normalizedPath(wanted));
    if (matches.length === 1) { selected = matches[0]; selection = `主线匹配目标分支：${selected.id}`; }
    else selection = matches.length ? '指定主线对应多个分支；未猜测当前分支。' : '指定主线未匹配共享分支；未替换为其他分支。';
  }
  return {selected, selection};
}

// Project-wide navigation stays visible even when execution belongs to one branch.
// Names are source labels, not inferred goals or authorization to execute siblings.
export function projectBranchOverview(state) {
  if (!state) return '';
  return [`## 项目全部分支概况（${state.branches.length}项）`,
    `当前原件版本：${state.revision}；用于发现整体材料变化，不证明理解。`,
    '项目承接一个核心问题；对话分担分支。先结合总目的、全体分支及已有成果理解当前执行，责任归属不隔离理解。',
    ...state.branches.map(branch => `- ${branch.name} [${branch.id}]${branch.archived?'（归档）':''}`),
    `各项完整目标、条件、进展与出处：${state.file}；有影响的原件继续展开，不从名称或下一步猜目标。`].join('\n');
}

export function summarizeSharedState(project, {ledger, branchId: targetId, compact = false} = {}) {
  const state = readSharedState(project);
  if (!state) return null;
  const {selected, selection} = selectSharedBranch(state, {ledger, branchId: targetId});
  const content = [`共享状态原件：${state.file}\n版本：${state.revision}\n${selection}`];
  // Goals/common conditions stay complete. Compact mode omits history and source-index details only.
  const firstSection = state.sections[0]?.start ?? state.lines.length;
  const preamble = state.lines.slice(0, firstSection).join('\n').trim();
  if (preamble) content.push(preamble);
  for (const section of state.sections) {
    if (section.name === '当前分支') {
      content.push(projectBranchOverview(state));
      content.push('## 当前分支');
      const prefixEnd = state.branches.find(b=>!b.archived)?.start ?? section.end;
      const prefix = state.lines.slice(section.start + 1, prefixEnd).join('\n').trim();
      if (prefix) content.push(prefix);
      for (const branch of state.branches) {
        if (branch.archived) continue;
        if (branch === selected) content.push(branch.text);
        else if (!(compact && selected)) content.push(`- ${branch.name} [${branch.id}]｜阶段：${(branch.fields['阶段'] || '未注明').replace(/\s*\n\s*/g, '；')}｜主线：${branch.fields['主线'] || '无'}`);
      }
    } else if (section.name === '已归档分支') {
      content.push(`## 已归档分支\n共${state.branches.filter(b=>b.archived).length}项；一行索引与稳定ID保留在${state.file}，指定ID读取完整原件。`);
      if (selected?.archived) content.push(`归档原件：${selected.source}\n${selected.text}`);
    } else if (section.name === '已完成里程碑') {
      if (compact) continue;
      const body = state.lines.slice(section.start + 1, section.end);
      // One line per existing item/paragraph, with its source links intact; no character clipping.
      const items = []; let current = [];
      const flush = () => { if (current.length) items.push(current.join(' ').replace(/\s+/g, ' ').trim()); current = []; };
      for (const line of body) {
        if (!line.trim()) { flush(); continue; }
        if (/^\s*(?:[-*]|\d+\.)\s/.test(line)) flush();
        current.push(line.trim());
      }
      flush();
      content.push(compact
        ? `## 已完成里程碑\n共 ${items.length} 条。完整里程碑及历史出处保留在共享状态原件：${state.file}`
        : ['## 已完成里程碑', ...items].join('\n'));
    } else if (compact && ['原件索引', '原件'].includes(section.name)) {
      content.push(`原件索引：${state.file}；引用编号的具体来源按需从该文件展开。`);
    } else content.push(state.lines.slice(section.start, section.end).join('\n').trimEnd());
  }
  const text = content.join('\n\n');
  return {file: state.file, full: state.file, revision: state.revision, text, context: text,
    branchId: selected?.id || null, selectedBranchId: selected?.id || null, selection, compact,
    overview: projectBranchOverview(state),
    branches: state.branches.map(({id, name, ledger, fields}) => ({id, name, ledger, phase: fields['阶段']}))};
}

function validateChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('changes 须为字段对象。');
  const result = {};
  for (const [key, raw] of Object.entries(changes)) {
    const field = ALIASES[key] || key;
    if (!FIELDS.includes(field)) throw new Error(`不支持的分支字段：${key}`);
    if (Object.hasOwn(result, field)) throw new Error(`同一字段同时使用多个名称：${field}`);
    if (typeof raw !== 'string' && !(Array.isArray(raw) && raw.every(item => typeof item === 'string'))) throw new Error(`${field}须为字符串或字符串数组。`);
    const value = Array.isArray(raw) ? raw.join('\n') : raw;
    if (value.includes('\r') || value.includes('\0')) throw new Error(`${field}含无效控制字符。`);
    if (field === '主线') ledgerPath(value, true);
    result[field] = value;
  }
  if (!Object.keys(result).length) throw new Error('changes 不能为空。');
  return result;
}
function renderField(field, value) {
  const [first, ...rest] = value.split('\n');
  return [`- ${field}：${first}`, ...rest.map(line => `  ${line}`)];
}
function changedText(state, id, changes, options) {
  if (!REVISION.test(state.text)) throw new Error('更新须有头部 <!-- shared-state revision:N -->；请先迁移原件。');
  for (const name of ['共同条件', '当前分支', '已完成里程碑']) {
    if (state.sections.filter(section => section.name === name).length !== 1) throw new Error(`更新须有唯一“${name}”节。`);
  }
  const lines = [...state.lines];
  const branch = state.branches.find(item => item.id === id);
  if (!branch) {
    if (!options.create) throw new Error(`分支不存在：${id}；未修改原件。`);
    const name = options.name;
    if (typeof name !== 'string' || !name.trim() || /[\r\n<>]/.test(name)) throw new Error('新分支须提供单行 name。');
    for (const field of REQUIRED_FIELDS) if (!Object.hasOwn(changes, field)) throw new Error(`新分支缺少字段：${field}`);
    const section = state.sections.find(item => item.name === '当前分支');
    lines.splice(section.end, 0, `### ${name.trim()} <!-- branch:${id} -->`, ...FIELDS.filter(field => Object.hasOwn(changes, field)).flatMap(field => renderField(field, changes[field])), '');
  } else {
    const edits = [];
    const missing = [];
    for (const [field, value] of Object.entries(changes)) {
      const range = branch.fieldRanges[field];
      if (range) edits.push({...range, lines: renderField(field, value)});
      else missing.push(...renderField(field, value));
    }
    if (missing.length) {
      let end = branch.end;
      while (end > branch.start + 1 && !lines[end - 1].trim()) end--;
      edits.push({start: end, end, lines: missing});
    }
    edits.sort((a, b) => b.start - a.start).forEach(edit => lines.splice(edit.start, edit.end - edit.start, ...edit.lines));
  }
  const next = state.revision + 1;
  if (!Number.isSafeInteger(next)) throw new Error('revision 超出安全整数范围。');
  return lines.join(state.newline).replace(REVISION, `<!-- shared-state revision:${next} -->`);
}

async function acquireLock(file, timeoutMs, retryMs) {
  const token = randomUUID();
  const started = Date.now();
  for (;;) {
    let handle;
    try {
      handle = await fs.promises.open(file, 'wx');
      await handle.writeFile(JSON.stringify({pid: process.pid, token, createdAt: new Date().toISOString()}));
      return {handle, token};
    } catch (error) {
      if (handle) { await handle.close(); await fs.promises.unlink(file); throw error; }
      // Windows can report EPERM for exclusive create on an existing lock file.
      // Treat it as contention only with direct existence evidence, not as a blanket permission retry.
      if (error.code !== 'EEXIST' && !(process.platform === 'win32' && error.code === 'EPERM' && fs.existsSync(file))) throw error;
      if (Date.now() - started >= timeoutMs) throw new Error(`共享状态锁超时：${file}；未删除现有锁。核对持锁进程后再处理。`);
      await new Promise(resolve => setTimeout(resolve, Math.min(retryMs, Math.max(1, timeoutMs - (Date.now() - started)))));
    }
  }
}

export async function updateSharedBranch(project, options = {}) {
  const id = branchId(options.id);
  const changes = validateChanges(options.changes);
  if (options.expectedRevision !== undefined && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0)) throw new Error('expectedRevision 须为非负整数。');
  const timeoutMs = options.lockTimeoutMs ?? 10000;
  const retryMs = options.lockRetryMs ?? 30;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(retryMs) || retryMs < 1) throw new Error('锁等待参数无效。');
  const file = projectFile(project);
  const lockFile = `${file}.lock`;
  const lock = await acquireLock(lockFile, timeoutMs, retryMs);
  let temporary;
  try {
    let state = readSharedState(project); // Re-read after taking the lock, never merge a caller's full snapshot.
    if (!state) throw new Error(`共享状态不存在：${file}`);
    if (options.expectedRevision !== undefined && state.revision !== options.expectedRevision) throw new Error(`共享状态版本冲突：期望 ${options.expectedRevision}，实际 ${state.revision}；未修改原件。`);
    const archived = state.branches.find(b=>b.id===id && b.archived);
    if (archived) {
      // 更新即重新启用；同一次锁内原子提交移回当前分支及字段修改。
      const lines = [...state.lines], current = state.sections.find(s=>s.name==='当前分支');
      const edits = [{start:archived.start,end:archived.end,lines:[]},{start:current.end,end:current.end,lines:[archived.text,'']}];
      edits.sort((a,b)=>b.start-a.start).forEach(e=>lines.splice(e.start,e.end-e.start,...e.lines));
      state = parse(file,lines.join(state.newline));
    }
    const text = changedText(state, id, changes, options);
    parse(file, text); // Reject malformed/duplicate fields before touching the original.
    temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await fs.promises.open(temporary, 'wx');
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await fs.promises.rename(temporary, file);
    temporary = null;
    return readSharedState(project);
  } finally {
    if (temporary) await fs.promises.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await lock.handle.close();
    // Remove only the exact lock we own; never reclaim an existing live/stale lock automatically.
    const current = JSON.parse(await fs.promises.readFile(lockFile, 'utf8'));
    if (current.token === lock.token) await fs.promises.unlink(lockFile);
    else throw new Error(`共享状态锁归属发生变化，保留现有锁：${lockFile}`);
  }
}

export async function archiveSharedBranches(project, options = {}) {
  if (!Array.isArray(options.ids) || !options.ids.length) throw new Error('归档须明确非空 ids');
  const ids = [...new Set(options.ids.map(branchId))];
  const file = projectFile(project), lockFile = file+'.lock';
  const lock = await acquireLock(lockFile,10000,30);
  try {
    const state = readSharedState(project);
    if (!state) throw new Error('共享状态不存在');
    if (options.expectedRevision !== state.revision) throw new Error('归档版本变化，请重新读取后选择；未移动分支');
    const selected = ids.map(id=>{
      const branch = state.branches.find(b=>b.id===id);
      if (!branch || branch.archived) throw new Error('分支不存在或已归档：'+id);
      return branch;
    });
    const root = path.join(path.dirname(file),'共享状态归档');
    fs.mkdirSync(root,{recursive:true});
    const refs=[];
    for (const b of selected) {
      const ref=`共享状态归档/${b.id}-r${state.revision}.md`, target=path.resolve(project,ref);
      if(path.dirname(target)!==path.resolve(root)) throw new Error('归档目标越界');
      const body=`<!-- shared-state revision:1 -->\n# 已归档分支\n\n共同条件、来源编号与项目关系沿 [共享状态](../共享状态.md)；归档不表示未验事项已达成。\n\n## 共同条件\n归档时完整分支原文如下；按稳定ID更新会移回当前分支。\n\n## 当前分支\n${b.text}\n\n## 已完成里程碑\n归档来源：共享状态 revision ${state.revision}。\n`;
      // 先落完整正文，再发布索引；失败时最多留下未引用的恢复原件。
      if(fs.existsSync(target)) {
        if(fs.readFileSync(target,'utf8')!==body) throw new Error('已有不同归档原件，保留并停止：'+target);
      } else fs.writeFileSync(target,body,{encoding:'utf8',flag:'wx'});
      refs.push(`### ${b.name} <!-- branch:${b.id} --> <!-- archived:${ref} -->`);
    }
    const lines=[...state.lines];
    selected.sort((a,b)=>b.start-a.start).forEach(b=>lines.splice(b.start,b.end-b.start));
    let text=lines.join(state.newline);
    const parsed=parse(file,text), section=parsed.sections.find(s=>s.name==='已归档分支');
    if(section) { const updated=[...parsed.lines];updated.splice(section.end,0,...refs,'');text=updated.join(state.newline); }
    else text=text.trimEnd()+state.newline+state.newline+'## 已归档分支'+state.newline+refs.join(state.newline)+state.newline;
    text=text.replace(REVISION,`<!-- shared-state revision:${state.revision+1} -->`);
    parse(file,text);
    const temporary=file+'.'+randomUUID()+'.tmp';
    fs.writeFileSync(temporary,text,{encoding:'utf8',flag:'wx'});
    fs.renameSync(temporary,file);
    return {archived:ids,revision:state.revision+1,file};
  } finally {
    await lock.handle.close();
    if(JSON.parse(fs.readFileSync(lockFile,'utf8')).token===lock.token) fs.unlinkSync(lockFile);
  }
}

async function cli() {
  const [command = 'read', ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help') {
    process.stdout.write('read --project ABS_DIR [--branch ID|--ledger ABS_MD] [--compact] [--json]\nupdate --project ABS_DIR --input ABS_JSON\narchive --project ABS_DIR --input ABS_JSON（{ids:[ID],expectedRevision:N}）\nJSON: {id,changes:{phase,owner,done,next,conditions,ledger,evidence,goal?,criteria?},expectedRevision?,create?,name?,lockTimeoutMs?}\n字段也接受：阶段、负责人、已做、下一步、有效条件、主线、依据、本轮目标、完成标准。goal/criteria可选，criteria用[ ]/[x]保留未完成/已核结果；更新done/next不会覆盖它们。\n'); return;
  }
  if (!['read', 'update', 'archive'].includes(command)) throw new Error(`未知命令：${command}`);
  const input = {}; let json = false;
  const flags = {'--project': 'project', '--branch': 'branchId', '--ledger': 'ledger', '--input': 'inputFile'};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--json') { json = true; continue; }
    if (flag === '--compact' && command === 'read') { input.compact = true; continue; }
    if (!flags[flag] || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`无效参数：${flag}`);
    input[flags[flag]] = args[++index];
  }
  if (!input.project) throw new Error('须明确 --project；不会猜测项目归属。');
  if (command === 'read' && input.branchId && input.ledger) throw new Error('--branch 与 --ledger 只能选一项。');
  const result = command === 'read' ? summarizeSharedState(input.project, input)
    : await (command==='archive'?archiveSharedBranches:updateSharedBranch)(input.project, JSON.parse(fs.readFileSync(absolute(input.inputFile, 'JSON 输入文件'), 'utf8').replace(/^\uFEFF/, '')));
  process.stdout.write(json || command !== 'read' ? `${JSON.stringify(result, null, 2)}\n` : result ? `${result.text}\n` : '该项目没有共享状态原件。\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cli().catch(error => { process.stderr.write(`共享状态错误：${error.message}\n`); process.exitCode = 1; });
}

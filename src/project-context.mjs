// Codex / Claude 共用路由和原件读取。绑定只存归属，不存目标、状态或授权。
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {summarizeSharedState, readSharedState, selectSharedBranch, projectBranchOverview} from './shared-state.mjs';
import {readDeliverableBrief} from './deliverables.mjs';
import {resourceNavigation} from './resources.mjs';
import {objectNavigation} from './object-access.mjs';
import {projectDirectory} from './project-registry.mjs';
import {WORKSPACE,PROJECTS_ROOT} from './paths.mjs';

export const DEFAULT_BINDINGS_DIR = path.join(WORKSPACE,'bindings');
export const DEFAULT_PROJECTS_DIR = PROJECTS_ROOT;

// Explicit project-wide material for a task handoff; no binding/state writes.
// Reuses the existing project originals instead of creating another knowledge store.
export function readProjectFrame(projectRef) {
  if (typeof projectRef !== 'string' || !path.isAbsolute(projectRef)) return {available:false,reason:'explicit_project_required'};
  const project = path.resolve(path.basename(projectRef).toLowerCase() === '核心.md' ? path.dirname(projectRef) : projectRef);
  const core = path.join(project,'核心.md'), coordination = path.join(project,'协作总览.md');
  const errors = [];
  let coreText;
  try { coreText = readFile(core); }
  catch(error) { return {available:false,project,core_source:core,reason:error.message}; }
  let state = null;
  try { state = readSharedState(project); }
  catch(error) { errors.push({source:path.join(project,'共享状态.md'),reason:error.message}); }
  if (!state && !errors.length) errors.push({source:path.join(project,'共享状态.md'),reason:'共享状态原件不存在；未从旧主线补猜。'});
  let relationSource = '', relationOverview = '', resident = '', frameMode = 'full-core', frameReason = '';
  // Only a deliberately maintained frame can replace the automatic full core.
  // The content binding is checked on every read, including a new session.
  const frameFile = path.join(project,'项目概况.md');
  let relationFromFrame = false;
  try {
    if (fs.existsSync(frameFile)) {
      const original = readFile(frameFile);
      const digest = original.match(/<!--\s*project-frame schema:1 core-sha256:([a-f0-9]{64})\s*-->/)?.[1];
      const hasResident = /^## 常驻整体目的与有效共同条件\s*$/m.test(original);
      if (!hasResident && !digest) {
        // 只维护分支关系的概况：整体目的直接注入核心全文，不需要摘要同步，也不报过期。
        const relation = original.match(/^## 全部[^\n]*分支怎样连接\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]?.trim() || '';
        if (relation) { relationSource = frameFile; relationOverview = relation; relationFromFrame = true; }
      } else if (digest) {
        const current = createHash('sha256').update(coreText).digest('hex');
        resident = original.match(/^## 常驻整体目的与有效共同条件\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]?.replace(/<!--\s*project-frame[^>]*-->/g, '').trim() || '';
        const relation = original.match(/^## 全部[^\n]*分支怎样连接\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]?.trim() || '';
        if (digest === current && resident && relation) {
          frameMode = 'maintained-frame'; relationSource = frameFile; relationOverview = relation;
        } else frameReason = digest !== current ? '项目概况对应的核心正文已变化' : '项目概况缺少完整常驻节或分支关系节';
      } else frameReason = '项目概况未记录有效核心内容摘要';
    }
  } catch(error) { frameReason = '项目概况读取失败：'+error.message; }
  if (frameReason) errors.push({source:frameFile,reason:frameReason+'；本次自动保留完整核心。'});
  let coordinationText = '';
  try {
    if (fs.existsSync(coordination)) {
      coordinationText = readFile(coordination);
      if (frameMode !== 'maintained-frame' && !relationFromFrame) relationSource = coordinationText.match(/^全项目关系原件：(.+)$/m)?.[1]?.trim() || '';
      if (relationSource && frameMode !== 'maintained-frame' && !relationFromFrame) {
        if (!path.isAbsolute(relationSource) || !inside(project, path.resolve(relationSource))) throw new Error('关系原件须位于本项目内；未跟随外部指针。');
        const original = readFile(relationSource);
        relationOverview = original.match(/^## 全部[^\n]*分支怎样连接\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]?.trim() || '';
        if (!relationOverview) errors.push({source:relationSource,reason:'关系原件未含可提取的分支关系节；沿原件按需读取。'});
      }
    }
  } catch(error) { errors.push({source:relationSource||coordination,reason:error.message}); if (frameMode !== 'maintained-frame' && !relationFromFrame) relationOverview = ''; }
  const goalContext = frameMode === 'maintained-frame'
    ? '项目整体目的与有效共同条件（当前核心对应的维护正文）：'+frameFile+'\n'+resident+'\n\n当前确认的完整项目目标：'+core+'；核心按含义原位维护，原话与历次变化沿进展、所属分支及原会话按需回查。'
    : '当前确认的完整项目目标原件（持续维护正文；历史原话沿来源回查）：'+core+'\n'+coreText;
  return {available:true,project,core_source:core,core:coreText,goal_context:goalContext,frame_mode:frameMode,frame_reason:frameReason,
    branch_source:state?.file||path.join(project,'共享状态.md'),branch_overview:projectBranchOverview(state),
    common:state?.sections.filter(section=>['目标','共同条件'].includes(section.name))
      .map(section=>state.lines.slice(section.start,section.end).join('\n').trim()).join('\n\n')||'',
    branches:state?.branches.map(({id,name,fields})=>({id,name,goal:fields['本轮目标']||'',phase:fields['阶段']||'',source:state.file,ledger:fields['主线']||''}))||[],
    relationship_source:relationSource||coordination,relationships:relationOverview,
    coordination_source:coordination,coordination_available:Boolean(coordinationText),
    deliverables_source:path.join(project,'成果','INDEX.md'),errors};
}

// Reads the complete selected task only from the current shared original.
// A missing goal remains a gap; next steps and parent ledgers never fill it.
export function readBranchTask(projectRef, targetId) {
  const project = validateProject(typeof projectRef==='string' && path.basename(projectRef).toLowerCase()==='核心.md' ? path.dirname(projectRef) : projectRef);
  if (typeof targetId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(targetId)) throw new Error('文件交接须明确有效分支 ID。');
  const state = readSharedState(project);
  const {selected} = selectSharedBranch(state,{branchId:targetId});
  if (!selected) throw new Error(`目标分支 ${targetId} 不在本项目共享原件中；未猜测替代分支。`);
  const f = selected.fields;
  return {id:selected.id,name:selected.name,source:selected.source || state.file,archived:Boolean(selected.archived),text:selected.text,
    goal:f['本轮目标']||'',criteria:f['完成标准']||'',conditions:f['有效条件']||'',
    stage:f['阶段']||'',owner:f['负责人']||'',done:f['已做']||'',next:f['下一步']||'',
    evidence:f['依据']||'',ledger:selected.ledger,
    gaps:['本轮目标','完成标准','有效条件','依据'].filter(key=>!f[key]?.trim()).map(key=>`共享分支缺${key}；未从旧历史或下一步补猜。`)};
}

// 只列目录中的原件索引；不按提示词打分，也不写任何会话绑定。
export function readProjectCandidates(options = {}) {
  const directory=projectDirectory(options.projectsDir?{roots:[options.projectsDir]}:{});
  return {candidates:directory.projects.map(({name,goal,core,projectPath,aliases,sectionId})=>({name,goal,core,project:projectPath,aliases,sectionId})),omitted:0,errors:directory.errors.map(e=>`${e.project}：${e.reason}`),roots:directory.roots,registry:directory.source};
}

function unboundContext(cwd, id, options) {
  const index = readProjectCandidates(options);
  const content = ['当前会话未关联项目。候选来自现有项目原件及持久项目目录；结合整段交办、完整用途及已有成果，判断已有项目、该项目子分支、新独立项目或一次性未绑定。同名/别名和可复用核心优先；独立业务有自己的目标与持续成果时才建项目，通用支持关系另存，不因出现一个词就新建。一次性问答可保持未绑定。'];
  for (const item of index.candidates) content.push(`候选项目：${item.name}\n目标句（节选）：${item.goal}\n核心原件：${item.core}`);
  content.push(`完整动态目录：${index.registry}；读取及独立创建入口：node bin/ai-work.mjs projects；新建使用 project init --name "项目名称" --goal "最终结果"。本公开版维护文件项目；宿主界面的分组由宿主提供。`);
  if (index.omitted) content.push(`另有 ${index.omitted} 个项目，完整目录：${options.projectsDir || DEFAULT_PROJECTS_DIR}`);
  if (index.errors.length) content.push(`候选原件读取失败：${index.errors.slice(0, 2).join('；')}`);
  if (options.includeDiscovery !== false) {
    content.push(resourceNavigation(options));
    content.push(objectNavigation());
  }
  if (id) content.push(`显式关联入口：node "${fileURLToPath(import.meta.url)}" bind --host ${options.host} --session ${id} --cwd "${cwd}" --project "所选项目绝对目录"。bind 后 read 展开核心与本会话主线。`);
  else content.push('缺少完整会话 ID；先取得真实 ID 再 bind，不猜测其他会话主线。');
  try {
    const brief = readDeliverableBrief(null, {projectsDir:options.projectsDir, maxChars:1000});
    if (brief) content.push(brief);
  } catch (error) { content.push(`成果导航暂不可读：${error.message}；现有项目原件继续可用。`); }
  return {context: content.join('\n\n'), project: null, ledger: null, source: '未关联项目', ...index};
}

function absolute(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) throw new Error(`${label}须为绝对路径。`);
  return path.resolve(value);
}
function sessionId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw new Error('缺少有效的完整 session_id（仅允许字母、数字、下划线、连字符）。');
  return value;
}
function hostName(value = 'shared') {
  if (!['codex', 'claude', 'antigravity', 'shared'].includes(value)) throw new Error('host 必须是 codex、claude、antigravity 或 shared。');
  return value;
}
function workingDirectory(value) {
  const cwd = absolute(value || process.cwd(), '工作目录');
  if (!fs.statSync(cwd).isDirectory()) throw new Error(`工作目录不是目录：${cwd}`);
  return cwd;
}
function readFile(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`不是文件：${file}`);
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
}

// A project may have a newly authorized standalone task before shared branch
// registration. Only exact ownership evidence permits its current text to be
// used; inherited/ambiguous/explicit branch routes never borrow this fallback.
export function readOwnedLedger(saved = {}) {
  if (saved.branchId || saved.requestedBranchId || !saved.sessionId || !saved.ledger) return null;
  if (saved.project) {
    const state = readSharedState(saved.project);
    if (!state) return null; // A broken shared original is not a new task.
    const wanted = path.resolve(saved.ledger).toLowerCase();
    if (state.branches.some(b => b.ledger && path.resolve(b.ledger).toLowerCase() === wanted)) return null;
  }
  try {
    const text = readFile(saved.ledger);
    const markers = [...text.matchAll(/^<!--\s*session_id:\s*([a-zA-Z0-9_-]+)\s*-->\s*$/gm)];
    if (markers.length !== 1 || markers[0][1] !== saved.sessionId) return null;
    if (!['当前分支', '有效状态', '阶段', '接续'].every(title => new RegExp(`^#{1,6}\\s+${title}\\s*$`, 'm').test(text))) return null;
    return {source:saved.ledger,text};
  } catch { return null; }
}
function validateProject(value) {
  const project = absolute(value, '项目');
  readFile(path.join(project, '核心.md'));
  return project;
}
function validateLedger(value, id, allowMissing = true) {
  const ledger = absolute(value, '主线');
  if (path.extname(ledger).toLowerCase() !== '.md') throw new Error(`主线必须是 Markdown 文件：${ledger}`);
  if (fs.existsSync(ledger)) {
    const owner = readFile(ledger).match(/^<!--\s*session_id:\s*([a-zA-Z0-9_-]+)\s*-->/m)?.[1];
    if (id && owner && owner !== id) throw new Error(`主线 session_id 标记与当前会话不一致：${ledger}`);
  } else if (!allowMissing) throw new Error(`主线不存在：${ledger}`);
  return ledger;
}
function bindingPath(id, options) {
  return path.join(options.bindingsDir || DEFAULT_BINDINGS_DIR, hostName(options.host), `${sessionId(id)}.json`);
}
function explicitBranch(project, targetId, ledger) {
  if (targetId === undefined || targetId === null) return null;
  if (!project) throw new Error('显式分支须同时有明确项目；不从其他项目补配。');
  const {selected} = selectSharedBranch(readSharedState(project), {branchId: targetId});
  if (!selected) throw new Error(`目标分支 ${targetId} 不在本项目共享原件中；未猜测替代分支。`);
  if (ledger && selected.ledger && path.resolve(ledger).toLowerCase() !== path.resolve(selected.ledger).toLowerCase()) {
    throw new Error(`显式主线与目标分支 ${targetId} 的原件不一致。`);
  }
  return selected;
}
function getBinding(id, options) {
  const file = bindingPath(id, options);
  if (!fs.existsSync(file)) return null;
  let record;
  try { record = JSON.parse(readFile(file)); }
  catch (error) { throw new Error(`会话绑定损坏：${file}；${error.message}`); }
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).some(key => !['project', 'ledger', 'branchId'].includes(key))) throw new Error(`会话绑定格式无效：${file}`);
  const project = record.project === null ? null : validateProject(record.project);
  if (record.branchId !== undefined && (typeof record.branchId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(record.branchId) || !project)) {
    throw new Error(`会话绑定分支格式无效：${file}`);
  }
  // A branch can intentionally retain an earlier conversation's source ledger.
  // Its explicit ID is routing only, never a copy of target/conditions.
  return {project, ledger: validateLedger(record.ledger, record.branchId ? null : id), file,
    ...(record.branchId ? {branchId: record.branchId} : {})};
}
function inside(project, cwd) {
  const relative = path.relative(project, cwd);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function discoverProject(cwd) {
  const pointerFile = path.join(cwd, '项目.md');
  if (fs.existsSync(pointerFile)) {
    const first = readFile(pointerFile).split(/\r?\n/)[0].replace(/^[#>*\-\s`"']+|[`"'\s]+$/g, '');
    return {project: validateProject(first), source: pointerFile};
  }
  for (let directory = cwd; ;) {
    if (fs.existsSync(path.join(directory, '核心.md'))) return {project: validateProject(directory), source: cwd};
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}
function discoverLedger(cwd, project, id) {
  const folder = path.join(inside(project, cwd) ? project : cwd, '主线');
  const stable = path.join(folder, `${id}.md`);
  if (fs.existsSync(stable)) return validateLedger(stable, id);
  let candidates = [];
  if (fs.existsSync(folder)) candidates = fs.readdirSync(folder).filter(name => /^\d{4}-\d{2}-\d{2}-/.test(name)
    && name.endsWith(`-${id.slice(0, 8)}.md`)).map(name => path.join(folder, name));
  const legacy = path.join(cwd, '主线.md');
  if (fs.existsSync(legacy)) candidates.push(legacy);
  const owned = candidates.filter(file => readFile(file).match(/^<!--\s*session_id:\s*([a-zA-Z0-9_-]+)\s*-->/m)?.[1] === id);
  if (owned.length === 1) return validateLedger(owned[0], id);
  if (owned.length > 1) throw new Error(`同一会话有多份已标记主线，请显式指定有效路径：${owned.join('、')}`);
  if (candidates.length) throw new Error(`旧主线缺少当前完整会话归属证据，正文未注入；请核对原会话后显式 bind。候选：${candidates.join('、')}`);
  return stable;
}

export function bindContext(input, options = {}) {
  options = {...options, host: hostName(options.host || input.host)};
  const id = sessionId(input.session_id);
  const cwd = workingDirectory(input.cwd);
  // 只给明确主线时绑定独立任务；不借 cwd 的项目指针补配核心。
  const project = input.project ? validateProject(input.project) : input.ledger ? null : discoverProject(cwd)?.project || null;
  if (!project && !input.ledger) throw new Error('没有明确项目或任务。请指定 --project / --ledger，或在 cwd 放置有效项目指针。');
  const selected = explicitBranch(project, input.branchId, input.ledger);
  const ledger = input.ledger ? validateLedger(input.ledger, selected ? null : id)
    : selected?.ledger ? validateLedger(selected.ledger, null) : discoverLedger(cwd, project, id);
  const selectedId = selected?.id || null;
  const file = bindingPath(id, options);
  if (fs.existsSync(file) && !options.rebind) {
    const existing = getBinding(id, options);
    if (existing.project === project && existing.ledger === ledger && (existing.branchId || null) === selectedId) return existing;
    throw new Error(`会话已绑定；如确需切换项目或主线，请显式 rebind：${file}`);
  }
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const record = {project, ledger, ...(selectedId ? {branchId: selectedId} : {})};
  const data = `${JSON.stringify(record, null, 2)}\n`;
  if (!options.rebind) fs.writeFileSync(file, data, {encoding: 'utf8', flag: 'wx'});
  else {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, data, {encoding: 'utf8', flag: 'wx'});
    fs.renameSync(temporary, file);
  }
  // Separate provenance preserves the strict binding JSON contract. A cwd
  // discovery is an initial hint; user/API binding remains authoritative.
  const originFile=path.join(options.bindingsDir||DEFAULT_BINDINGS_DIR,'origins',hostName(options.host),`${id}.json`);
  fs.mkdirSync(path.dirname(originFile),{recursive:true});
  const originTemp=`${originFile}.${process.pid}.tmp`;
  fs.writeFileSync(originTemp,JSON.stringify({kind:options.bindingOrigin||'explicit',project,branchId:selectedId,at:new Date().toISOString()},null,2)+'\n');
  fs.renameSync(originTemp,originFile);
  return {...record, file};
}

export function readContext(input = {}, options = {}) {
  options = {...options, host: hostName(options.host || input.host)};
  const cwd = workingDirectory(input.cwd);
  const explicit = Boolean(input.project || input.ledger);
  const id = input.session_id ? sessionId(input.session_id) : null;
  let route;
  if (explicit) {
    // 显式路径读取无需聊天身份，不改变任何会话绑定。
    route = {project: input.project ? validateProject(input.project) : null,
      ledger: input.ledger ? validateLedger(input.ledger, input.branchId ? null : id, false) : null, source: '显式路径（未修改会话归属）'};
    if (route.project && !route.ledger && id) route.ledger = discoverLedger(cwd, route.project, id);
  } else {
    if (id) {
      const bound = getBinding(id, options);
      if (bound) route = {...bound, source: `会话绑定：${bound.file}`};
    }
    if (!route) {
      const discovered = discoverProject(cwd);
      if (!discovered) {
        const standalone = id ? path.join(cwd, '主线', `${id}.md`) : null;
        if (!standalone || !fs.existsSync(standalone)) return unboundContext(cwd, id, options);
        const bound = bindContext({cwd, session_id: id, ledger: validateLedger(standalone, id, false)}, options);
        route = {...bound, source: `首次明确独立任务：${standalone}；绑定：${bound.file}`};
      } else if (id) {
        const bound = bindContext({cwd, session_id: id, project: discovered.project}, {...options,bindingOrigin:'directory-discovery'});
        route = {...bound, source: `首次明确目录发现：${discovered.source}；绑定：${bound.file}`};
      } else route = {...discovered, ledger: null, source: `明确目录：${discovered.source}；缺少会话 ID，未猜测主线`};
    }
  }
  const content = [`保存状态来源：${route.source}`];
  const sourceLedger = route.ledger;
  const targetId = input.branchId ?? route.branchId;
  let shared = null;
  let sharedReadFailed = false;
  let independentLedger = null;
  if (id) content.push(`宿主及完整会话 ID：${options.host} / ${id}`);
  if (route.project) {
    const core = path.join(route.project, '核心.md');
    try { shared = summarizeSharedState(route.project, {ledger: route.ledger, branchId: targetId, compact:Boolean(options.compact)}); }
    catch (error) {
      sharedReadFailed = true;
      content.push(`项目共享状态暂不可读：${path.join(route.project,'共享状态.md')}；${error.message}。保留本项目核心；旧主线只作定位和历史证据，不冒充当前状态。`);
    }
    if (!shared && !sharedReadFailed) {
      sharedReadFailed = true;
      content.push(`项目当前状态尚不可读：${path.join(route.project,'共享状态.md')}。旧主线只作定位和历史证据；需要独立主线时显式 read --ledger，不从缺失状态推定当前条件。`);
    }
    if (shared && !shared.selectedBranchId && !targetId) independentLedger = readOwnedLedger({...route,sessionId:id});
    if (options.compact && shared && !shared.selectedBranchId) {
      // Project understanding includes all branches. Missing responsibility
      // still never means selecting or executing a sibling task automatically.
      const state = readSharedState(route.project);
      shared = {...shared, text: [`共享状态原件：${shared.file}\n${shared.selection}`,
        ...state.sections.filter(section => ['目标', '共同条件'].includes(section.name))
          .map(section => state.lines.slice(section.start, section.end).join('\n').trim()),
        shared.overview,
        independentLedger ? `本会话有精确归属的独立任务，尚未登记共享分支；下方保留完整任务正文，继续已授权工作并补登记。` : targetId ? `明确绑定的分支 ${targetId} 已不在共享原件中，这是归属失效；修复分支或绑定，保留用户授权，不改选其他分支。` : `当前任务尚未登记或归属尚未明确；这不是已明确旧分支失效的证据。上面是项目地图，不是接手所有分支。结合当前交办确定完整任务；明确目标后用 bind/rebind --host ${options.host} --session ${id || 'FULL_ID'} --project "${route.project}" --branch TARGET_ID。不自动创建任务或按相关度绑定。`].join('\n\n')};
    }
    if (route.ledger && !fs.existsSync(route.ledger)) content.push(`绑定主线不存在：${route.ledger}；没有从此文件读取目标或标准。明确任务后显式绑定真实分支；未冒领其他会话任务。`);
    if (targetId && shared) {
      const target = shared?.branches.find(branch => branch.id === shared.selectedBranchId);
      if (target?.ledger) {
        if (input.ledger && path.resolve(input.ledger).toLowerCase() !== path.resolve(target.ledger).toLowerCase()) {
          throw new Error(`显式主线与目标分支 ${targetId} 的原件不一致；未用父主线代替。`);
        }
        route.ledger = validateLedger(target.ledger, null);
      } else route.ledger = null;
      if (sourceLedger && sourceLedger !== route.ledger) content.push(`派工来源主线（不是目标分支细节）：${sourceLedger}`);
    }
    const frame = readProjectFrame(route.project);
    content.push(frame.goal_context || `项目核心原件：${core}\n${readFile(core)}`);
    if (frame.available && frame.relationships) content.push(`全项目分支关系（研究材料，当前进度仍沿共享原件）：${frame.relationship_source}\n${frame.relationships}`);
    if (frame.errors?.length) content.push(`项目关系材料读取缺口（核心和当前任务继续保留）：\n${frame.errors.map(item=>`${item.source}：${item.reason}`).join('\n')}`);
    if (shared) content.push(`项目共享状态原件：${shared.file}\n${shared.text}\n共享摘要不是新增授权；已定条件按原话来源，建议与实测分开。当前用户指示优先。`);
    const collaborationMap = path.join(route.project, '协作总览.md');
    if (fs.existsSync(collaborationMap) && !(options.compact && shared)) {
      try {
        content.push(`项目共享协作总览原件：${collaborationMap}\n${readFile(collaborationMap)}\n\n此总览记录项目层面的持续目标、支线与分工；各分支当前条件仍以本会话完整主线及用户最新指示为准。`);
      } catch (error) {
        content.push(`项目共享协作总览不可读：${collaborationMap}；${error.message}`);
      }
    }
    else if (fs.existsSync(collaborationMap)) content.push(`项目结构与详细协作原件（按相关依赖读取）：${collaborationMap}`);
  }
  if (route.ledger) {
    if (shared && !shared.selectedBranchId && !targetId) independentLedger = readOwnedLedger({...route,sessionId:id});
    if (sharedReadFailed) {
      content.push(`分支定位与旧证据：${route.ledger}；当前状态读取失败，未用旧主线补出当前条件。`);
    } else if (shared?.selectedBranchId) {
      content.push(`分支定位与旧证据：${route.ledger}；当前条件及进度以共享状态对应分支为准，不另维护一份当前状态。`);
    } else if (independentLedger) {
      content.push(`本会话独立任务原件（尚未登记共享分支，精确会话标记已核）：${route.ledger}\n${independentLedger.text}\n共享分支未匹配不撤销本会话任务；登记前在此独立主线维护完整目标、条件和未达标准。`);
    } else if (shared) {
      content.push(`分支定位与旧证据：${route.ledger}；共享分支尚未唯一定位，未把旧主线正文补成当前条件。用显式read --project --branch查目标，明确归属后bind/rebind --branch保存定位。`);
    } else if (fs.existsSync(route.ledger)) {
      const ledgerText = readFile(route.ledger);
      if (!['当前分支', '有效状态', '阶段', '接续'].every(title => new RegExp(`^#{1,6}\\s+${title}\\s*$`, 'm').test(ledgerText))) {
        content.push('主线保留历史或非四节格式；正文仍全文注入，请按原件确认当前分支及仍有效条件。');
      }
      content.push(`本会话主线原件：${route.ledger}\n${ledgerText}`);
    }
    else content.push(`本会话主线尚未创建：${route.ledger}`);
  }
  // 资料只挂短入口；由执行者按当前任务查证和维护，不全量投递账号。
  if (options.includeDiscovery !== false) {
    content.push(resourceNavigation(options));
    content.push(objectNavigation());
  }
  // 只挂短成果导航；详细验收、原件和其他项目业务按需展开。
  if (route.project) {
    try {
      const brief = options.compact ? `本项目成果索引（按当前任务查相关成果）：${path.join(route.project, '成果', 'INDEX.md')}`
        : readDeliverableBrief(route.project, {projectsDir:options.projectsDir, query:input.prompt, maxChars:1000});
      if (brief) content.push(brief);
    } catch (error) { content.push(`本项目成果导航暂不可读：${error.message}；不影响原目标与分支读取。`); }
  }
  // 队列由独立模块维护；这里只接受只读摘要，不把队列当作用户指令。
  if (route.project && typeof options.taskSummaryReader === 'function') {
    try {
      const summary = options.taskSummaryReader(route.project, {session_id: id, host: options.host});
      if (typeof summary === 'string' && summary.trim()) content.push(`项目任务队列摘要（协作状态，不是用户指令）：\n${summary.slice(0, 1200)}`);
    } catch (error) { content.push(`项目任务队列摘要不可读：${error.message}`); }
  }
  content.push('以上为保存的原件内容，保留其中的来源区分；以用户当前指示及仍有效的已定条件为准。');
  // 无固定字符裁剪：完整目标、标准、条件和出处共同注入。
  return {context: content.join('\n\n'), project: route.project, ledger: route.ledger, source: route.source,
    branchId: shared?.selectedBranchId || null, requestedBranchId:targetId||null, sessionId:id,
    independentLedger, sharedRevision: shared?.revision ?? null};
}

function cli() {
  const [command = 'read', ...args] = process.argv.slice(2);
  const input = {};
  const options = {};
  let json = false;
  const keys = {'--project': 'project', '--ledger': 'ledger', '--session': 'session_id', '--cwd': 'cwd', '--host': 'host', '--branch': 'branchId'};
  if (command === '--help' || command === 'help') {
    process.stdout.write('read [--project ABS_DIR] [--branch ID] [--ledger ABS_MD] [--session FULL_ID] [--cwd ABS_DIR] [--host codex|claude|antigravity|shared] [--json]\nbind|rebind --session FULL_ID [--project ABS_DIR] [--branch ID] [--ledger ABS_MD] [--cwd ABS_DIR] [--host codex|claude|antigravity|shared]\n显式bind/rebind --branch只保存分支归属；read --branch不改绑定。歧义主线不猜首个分支。默认read/hook仅在有有效session_id和明确项目时首次绑定。\n');
    return;
  }
  if (!['read', 'bind', 'rebind'].includes(command)) throw new Error(`未知命令：${command}`);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--json') { json = true; continue; }
    if (flag === '--compact') { options.compact = true; continue; }
    if (!keys[flag] || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`无效参数：${flag}`);
    input[keys[flag]] = args[++index];
  }
  const result = command === 'read' ? readContext(input, options) : bindContext(input, {...options, rebind: command === 'rebind'});
  process.stdout.write(json || command !== 'read' ? `${JSON.stringify(result, null, 2)}\n` : `${result.context}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { cli(); }
  catch (error) { process.stderr.write(`项目上下文错误：${error.message}\n`); process.exitCode = 1; }
}

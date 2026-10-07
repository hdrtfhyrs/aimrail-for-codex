import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolveDialogueContext, dialogueContextFor, renderDialogueContext} from './dialogue-context.mjs';
const {readSharedState, selectSharedBranch, updateSharedBranch} = await import(pathToFileURL(_publicPath("$codex/context/shared-state.mjs")).href);
const {readProjectFrame} = await import(pathToFileURL(_publicPath("$codex/context/project-context.mjs")).href);

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RULES = _publicPath("$codex/AGENTS.md");
const OPEN = '<!-- context-manager:v1 -->';
const CLOSE = '<!-- /context-manager -->';
const ROLES = new Set(['user', 'assistant', 'system', 'developer', 'tool']);
const KINDS = new Set(['user-condition', 'user-goal-change', 'assistant-proposal', 'inference', 'verified-evidence', 'correction', 'open-question']);
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label}须为绝对路径。`);
  return path.resolve(value);
}
function cleanText(value, label, {empty = false} = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || /[\r\0]/.test(value)) throw new Error(`${label}须为有效文本（换行用 LF）。`);
  return value;
}
function optionalFile(file) { return fs.existsSync(file) ? {path: file, text: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')} : {path: file, missing: true}; }
function readCurrent(project, branchId, rulesPath = RULES) {
  project = absolute(project, 'project');
  const state = readSharedState(project);
  const selected = selectSharedBranch(state, {branchId}).selected;
  if (!selected) throw new Error(`指定共享分支不存在：${branchId}；未猜测其他分支。`);
  const core = optionalFile(path.join(project, '核心.md'));
  const rules = optionalFile(absolute(rulesPath, 'rules'));
  if (core.missing || rules.missing) throw new Error('缺核心.md或基础规则原件；不能准备脱离根基的融合。');
  const common = state.sections.find(section => section.name === '共同条件');
  const commonText = common ? state.lines.slice(common.start, common.end).join('\n').trimEnd() : '';
  const frame = readProjectFrame(project);
  // Other branches are navigation. Their unrelated revisions do not invalidate this branch.
  const baselineHash = sha({branch: selected.text, core: core.text, rules: rules.text, common: commonText, relationships: frame.relationships || ''});
  return {project, state, selected, core, rules, commonText, frame, baselineHash};
}
function managerEvidence(evidence = '') {
  const starts = evidence.split(OPEN).length - 1;
  const ends = evidence.split(CLOSE).length - 1;
  if (!starts && !ends) return {base: evidence.trimEnd(), metadata: null};
  if (starts !== 1 || ends !== 1) throw new Error('上下文融合依据块重复或不完整；保留原件，须先定位原因。');
  const start = evidence.indexOf(OPEN), end = evidence.indexOf(CLOSE);
  if (end < start) throw new Error('上下文融合依据块顺序无效。');
  const metadata = JSON.parse(evidence.slice(start + OPEN.length, end).trim());
  if (metadata.version !== 1 || !Number.isSafeInteger(metadata.processedCount) || metadata.processedCount < 0 || !/^[a-f0-9]{64}$/.test(metadata.prefixHash) || !metadata.archive) throw new Error('上下文融合依据游标结构无效。');
  return {base: (evidence.slice(0, start) + evidence.slice(end + CLOSE.length)).trim(), metadata};
}
function locations(project, branchId, stateDir, metadata) {
  const dir = absolute(stateDir || _publicDataPath("任务协作/context-manager/runtime"), 'state-dir');
  const key = sha({project: process.platform === 'win32' ? project.toLowerCase() : project, branchId});
  const archive = metadata?.archive ? absolute(metadata.archive, '来源记录') : path.join(dir, key, 'sources.json');
  return {archive, directory: path.dirname(archive)};
}
async function atomicJson(file, value) {
  await fs.promises.mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.promises.open(temp, 'wx');
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync(); await handle.close(); handle = null;
    await fs.promises.rename(temp, file);
  } finally {
    if (handle) await handle.close();
    await fs.promises.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
async function withArchiveLock(location, operation, timeoutMs = 10000) {
  await fs.promises.mkdir(location.directory, {recursive: true});
  const file = `${location.archive}.lock`, token = randomUUID(), started = Date.now();
  let handle;
  for (;;) {
    try { handle = await fs.promises.open(file, 'wx'); break; }
    catch (error) {
      if (error.code !== 'EEXIST' && !(error.code === 'EPERM' && fs.existsSync(file))) throw error;
      if (Date.now() - started >= timeoutMs) throw new Error(`来源记录锁超时：${file}；未自动删锁。`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  try {
    await handle.writeFile(JSON.stringify({pid: process.pid, token}));
    return await operation();
  } finally {
    await handle.close();
    const current = readJson(file);
    if (current.token === token) await fs.promises.unlink(file);
    else throw new Error(`来源记录锁归属改变；保留 ${file}`);
  }
}
function normalizeMessages(input) {
  const wrapper = Array.isArray(input) ? {messages: input} : input;
  if (!wrapper || !Array.isArray(wrapper.messages)) throw new Error('messages JSON须为数组或含messages数组的对象。');
  return wrapper.messages.map(raw => {
    const source = raw.source ?? wrapper.source;
    const thread = raw.thread ?? wrapper.thread;
    const line = raw.line;
    let id = raw.id ?? raw.sourceId;
    if (!id && typeof source === 'string' && thread && Number.isSafeInteger(line) && line > 0) id = `jsonl:${source}#thread=${thread}&line=${line}`;
    if (typeof id !== 'string' || !id.trim()) throw new Error('每条消息须提供准确id/sourceId，或source+thread+line；不按内容猜ID。');
    if (!ROLES.has(raw.role)) throw new Error(`来源 ${id} 的role无效。`);
    if (!(typeof source === 'string' && source.trim()) && !(source && typeof source === 'object' && !Array.isArray(source))) throw new Error(`来源 ${id} 缺可回查source。`);
    if (typeof raw.text !== 'string' || raw.text.includes('\0')) throw new Error(`${id}.text须为原话文本。`);
    const message = {id, role: raw.role, text: raw.text, source};
    if (thread !== undefined) message.thread = thread;
    if (line !== undefined) message.line = line;
    if (raw.timestamp !== undefined) message.timestamp = raw.timestamp;
    if (raw.messageId !== undefined) message.messageId = raw.messageId;
    message.hash = sha(message);
    return message;
  });
}
function loadArchive(location, project, branchId, metadata) {
  let archive;
  if (fs.existsSync(location.archive)) archive = readJson(location.archive);
  else if (metadata) throw new Error(`已有融合游标的原话记录缺失：${location.archive}；未丢弃游标重建。`);
  else archive = {version: 1, project, branchId, messages: []};
  if (archive.version !== 1 || archive.project !== project || archive.branchId !== branchId || !Array.isArray(archive.messages)) throw new Error('来源记录归属或结构不一致。');
  const ids = new Set();
  for (const message of archive.messages) {
    const {hash, ...raw} = message;
    if (hash !== sha(raw) || ids.has(message.id)) throw new Error(`来源记录被改写或重复：${message.id}`);
    ids.add(message.id);
  }
  if (metadata && (metadata.processedCount > archive.messages.length || metadata.prefixHash !== prefixHash(archive, metadata.processedCount))) throw new Error('融合游标与原话前缀不一致；未改写来源或重置游标。');
  return archive;
}
function appendMessages(archive, incoming) {
  const byId = new Map(archive.messages.map(message => [message.id, message]));
  for (const message of incoming) {
    const previous = byId.get(message.id);
    if (previous && previous.hash !== message.hash) throw new Error(`相同来源ID内容/角色被改写：${message.id}；未覆盖原话。`);
    if (!previous) { archive.messages.push(message); byId.set(message.id, message); }
  }
}
const sourceEntry = ({id, hash, role}) => ({id, hash, role});
const prefixHash = (archive, count) => sha(archive.messages.slice(0, count).map(sourceEntry));
const pendingMessages = (archive, metadata) => archive.messages.slice(metadata?.processedCount || 0);
function enabledBranch(project, branchId) {
  project = absolute(project, 'project');
  const state = readSharedState(project);
  const selected = selectSharedBranch(state, {branchId}).selected;
  if (!selected) return {project, branchId, metadata: null};
  return {project, branchId, state, selected, metadata: managerEvidence(selected.fields['依据']).metadata};
}
function rawTailText(messages) {
  return messages.map(message => `## role=${message.role}；id=${message.id}\n来源：${JSON.stringify(message.source)}${message.thread ? `；thread=${message.thread}` : ''}${message.line ? `；line=${message.line}` : ''}\n\n${message.text}`).join('\n\n');
}
// A hook may only append to an archive already enabled by an authoritative
// branch evidence block. This path does not load rules/core or change state.
export async function captureEnabledSubmission({project, branchId, message, lockTimeoutMs = 1000}) {
  let current = enabledBranch(project, branchId);
  if (!current.metadata) return {status: 'skipped', reason: 'branch-not-enabled', project: current.project, branchId};
  const incoming = normalizeMessages([message]);
  const location = {archive: absolute(current.metadata.archive, 'archive'), directory: path.dirname(current.metadata.archive)};
  if (!fs.existsSync(location.archive)) throw new Error(`已启用来源档案缺失：${location.archive}；未重置游标。`);
  return withArchiveLock(location, async () => {
    current = enabledBranch(current.project, branchId);
    if (!current.metadata) return {status: 'skipped', reason: 'branch-no-longer-enabled', project: current.project, branchId};
    if (path.resolve(current.metadata.archive) !== location.archive) throw new Error('来源档案指针已变化；本次提交未保存，未消费。');
    const archive = loadArchive(location, current.project, branchId, current.metadata);
    const before = archive.messages.length;
    appendMessages(archive, incoming);
    if (archive.messages.length !== before) await atomicJson(location.archive, archive);
    const snapshotFile = path.join(location.directory, 'dialogue-background.json');
    const context = resolveDialogueContext(incoming[0], {mode: 'capture-before-log'});
    let contextWarning;
    try {
      const snapshots = fs.existsSync(snapshotFile) ? readJson(snapshotFile) : {version: 1, contexts: {}};
      snapshots.contexts[incoming[0].id] = {sourceHash: incoming[0].hash, context};
      await atomicJson(snapshotFile, snapshots);
    } catch (error) { contextWarning = `原话已保存，相邻背景快照未保存：${error.message}`; }
    return {status: archive.messages.length === before ? 'duplicate' : 'captured', project: current.project, branchId,
      sourceId: incoming[0].id, archive: location.archive, pendingCount: archive.messages.length - current.metadata.processedCount,
      contextStatus: context.status, ...(contextWarning ? {contextWarning} : {})};
  }, lockTimeoutMs);
}

// Synchronous, strictly read-only source for an existing hook's change digest.
export function pendingHookContext(project, branchId) {
  try {
    const current = enabledBranch(project, branchId);
    if (!current.metadata) return {status: 'disabled', available: false, name: 'context-manager-pending', text: '', pendingCount: 0};
    const location = {archive: absolute(current.metadata.archive, 'archive'), directory: path.dirname(current.metadata.archive)};
    const archive = loadArchive(location, current.project, branchId, current.metadata);
    const pending = pendingMessages(archive, current.metadata);
    const context = dialogueContextFor(pending, {snapshotFile: path.join(location.directory, 'dialogue-background.json')});
    const planned = plannedContextView(current.metadata, archive);
    if (!pending.length && !planned.openCount && !planned.referenceCount && !planned.error) return {status: 'empty', available: false, name: 'context-manager-pending', text: '', pendingCount: 0, archive: location.archive};
    const managementEntry = `node "${path.join(ROOT, 'context-manager.mjs')}" prepare --project "${current.project}" --branch ${branchId}`;
    const text = `# 尚未融合的原话（${pending.length}条）\n来源档案：${location.archive}\n共享游标：已融合${current.metadata.processedCount}条；前缀哈希${current.metadata.prefixHash}。\n下列材料尚未进入连续理解。source.kind=hook-submission的role=user表示收到提交事件；本地occurrence UUID不证明源消息唯一或真人再次确认，同turn同文本可能重投也可能是新补充，均保留。请沿原话语境融合，不把重复次数当授权或采纳。本入口不启动模型。\n\n${rawTailText(pending)}\n\n${pending.length ? renderDialogueContext(context) : ''}\n\n${planned.text}\n\n整理入口：${managementEntry}\nprepare只生成候选调用材料；由负责人核原话并apply同一分支。`;
    return {status: 'pending', available: true, name: 'context-manager-pending', text, pendingCount: pending.length,
      project: current.project, branchId, archive: location.archive, managementEntry, dialogueContext: context, openCount: planned.openCount};
  } catch (error) {
    return {status: 'failed', available: true, name: 'context-manager-pending', text: `未融合原话读取失败：${error.message}\n未推进融合游标；请核当前分支依据中的档案原件。`, error: error.message};
  }
}
function candidateTemplate(job) {
  return {jobId: job.id, baselineHash: job.baselineHash,
    consumedSourceIds: job.sources.map(message => message.id),
    conditions: '在此写融合后的完整有效条件与连续理解；保留仍有效的硬条件、原因、依赖、当前缺口和不确定性。',
    observations: [], crossBranchMaterials: [], contextPlan: job.sources.map(item => ({sourceId: item.id, placement: 'open', reason: '由AI结合本句含义和下一步行动填写处理依据。', contextIds: []}))};
}
function delegation(job, inputFile, candidateFile) {
  return `请把当前任务理解和新话融合成可接续的连续文本，候选写入 ${candidateFile}。本次只整理候选，不提交共享状态。\n\n原话和助手解释必须分别处理。旧共享正文里写“用户明确”不能证明来自用户；尤其固定数量、否定路线和授权范围等硬条件，须沿相关用户原话及前后文核对。若旧goal/criteria已传播误解，返回user-goal-change或correction证据与纠正范围给负责人；不要把旧摘要继续当用户决定。输入没有相应原话时沿evidence/ledger原件回查，仍缺来源则标明缺口，不能补造。\n\n输入：${inputFile}\n先读基础规则、核心目的和当前分支完整goal/criteria/conditions/evidence；结合尚未融合的原话及已有成果，按需要展开项目概况、经验和其他分支原件。当前分支是任务归属，其他分支只是关系材料。\n\ninput.dialogueContext是自动配齐的上一完整问答及原件定位，不是程序已确定本句指代。用户说“对”可以用sourceIds保留直接用户依据，另以contextIds关联它回应的assistant答复；assistant只解释确认对象，不自动升级为用户要求。\n\n重要性由你结合“接手者不知道它，会不会误解本句或选错下一步”判断。contextPlan逐条给本批消息sourceId、placement(active/open/reference)、reason和必要contextIds：active维持目标、对象、条件并实际融入conditions；open保留当前讨论和因果的相关原话；reference只留过程出处或待展开原件，并说清为何当前只需出处。无需数字评分、关键词筛选或永久重要性标签。此前previousContextPlan中的open必须继续带着，只有你明确转active/reference才退出全文。计划和详细关系留外部候选，活跃evidence只存短指针。\n\nconditions须给出完整替换正文，保留所有仍有效的条件，讲清新话接着什么、改变哪一部分、为什么影响当前做法。核旧条件逐项保留、纠正或退役，并在observations说明纠正依据与范围。连续理解重写，避免每轮追加流水账。程序不靠关键词判断含义。用户明确目标与条件、助手提案、AI推测及实测须分清；role=assistant的文字不能变成用户已定。不生成新授权，不因局部纠正暂停其余授权。goal/criteria保持原件；若原话确实改目标，写user-goal-change候选给负责人处理。\n\n从candidateTemplate的字段产出JSON，不加其他顶层字段。sourceIds可引用本job消息原ID、此前已融合档案消息ID、已提供foundation.path/core.path/materials.path，以及currentBranch.id和projectOverview.relationshipSource。文件是material，当前分支及关系概况是derived；这些不是用户消息，不能用来声明用户已定。未提供的新文件和job后新话不能引用。详细判断留候选及回执，活动依据只存短游标和详情指针。consumedSourceIds必须准确覆盖本job整批来源且顺序一致；不要写未读来源。observations每项为{kind,text,sourceIds}，kind可用user-condition/user-goal-change/assistant-proposal/inference/verified-evidence/correction/open-question。用户条件/目标候选仅引用户来源；推测保留推测身份；纠正说明纠正哪段理解及仍有效范围。原件无直接支撑的联系明确写为inference。\n\n跨分支影响仅返回crossBranchMaterials，每项为{branchId,relationship,text,sourceIds,status:"pending-owner-review"}；说明关系和出处，不能称已同步或已处理其他分支。不评分、不按字数判断是否需要整理、不要求用户每轮签字。完成后停止，由当前负责人读候选并调用apply提交同一分支。\n\njobId=${job.id}\nbaselineHash=${job.baselineHash}\n`;
}

export async function prepare({project, branchId, messages, stateDir, jobDir, rulesPath = RULES, materials = []}) {
  const current = readCurrent(project, branchId, rulesPath);
  const prior = managerEvidence(current.selected.fields['依据']);
  const location = locations(current.project, branchId, stateDir, prior.metadata);
  const incoming = messages === undefined ? [] : normalizeMessages(messages);
  const archive = await withArchiveLock(location, async () => {
    const value = loadArchive(location, current.project, branchId, prior.metadata);
    appendMessages(value, incoming);
    await atomicJson(location.archive, value); // Intake is durable before any AI job exists.
    return value;
  });
  const pending = pendingMessages(archive, prior.metadata);
  const dialogueContext = dialogueContextFor(pending, {snapshotFile: path.join(location.directory, 'dialogue-background.json')});
  const previousContextPlan = plannedContextView(prior.metadata, archive);
  const id = randomUUID();
  const directory = absolute(jobDir || path.join(location.directory, 'jobs', id), 'job-dir');
  if (fs.existsSync(path.join(directory, 'job.json'))) throw new Error(`job-dir已有job；请使用新目录：${directory}`);
  const job = {version: 1, id, createdAt: new Date().toISOString(), project: current.project, branchId,
    rulesPath: current.rules.path, archive: location.archive, baselineHash: current.baselineHash,
    revision: current.state.revision, startCursor: {processedCount: prior.metadata?.processedCount || 0, prefixHash: prefixHash(archive, prior.metadata?.processedCount || 0)},
    sources: pending.map(sourceEntry)};
  const input = {job: structuredClone(job), foundation: current.rules, core: current.core,
    currentBranch: {id: branchId, name: current.selected.name, fields: current.selected.fields, text: current.selected.text},
    commonConditions: current.commonText,
    projectOverview: {sharedState: current.state.file, relationshipSource: current.frame.relationship_source,
      relationships: current.frame.relationships, errors: current.frame.errors,
      branches: current.state.branches.map(({id, name, ledger, fields}) => ({id, name, ledger, phase: fields['阶段']})),
      entries: ['协作总览.md', '成果/INDEX.md'].map(file => ({path: path.join(current.project, file), exists: fs.existsSync(path.join(current.project, file))})),
      experiences: _publicPath("$user/.pi/agent/knowledge/experiences/INDEX.md")},
    sourceArchive: {path: location.archive, ...job.startCursor, note: '原话可按id回查；当前未融合原话完整附在messages。逐条来源留此档案，活动依据只保留短游标。'},
    messages: pending, dialogueContext, previousContextPlan, materials: materials.map(file => optionalFile(absolute(file, 'material'))),
    candidateTemplate: {...candidateTemplate(job), contextPlan: [...candidateTemplate(job).contextPlan, ...(previousContextPlan.carryOpenEntries || [])]}};
  job.inputHash = sha(input);
  const inputFile = path.join(directory, 'input.json'), candidateFile = path.join(directory, 'candidate.json');
  await atomicJson(inputFile, input);
  await atomicJson(path.join(directory, 'job.json'), job);
  await atomicJson(path.join(directory, 'candidate-template.json'), input.candidateTemplate);
  await atomicJson(path.join(directory, 'dialogue-context.json'), dialogueContext);
  await fs.promises.writeFile(path.join(directory, 'dialogue-context.md'), renderDialogueContext(dialogueContext), 'utf8');
  await fs.promises.writeFile(path.join(directory, 'prompt.md'), delegation(job, inputFile, candidateFile), 'utf8');
  return {jobId: id, jobFile: path.join(directory, 'job.json'), inputFile, promptFile: path.join(directory, 'prompt.md'), candidateFile,
    archive: location.archive, pendingCount: pending.length, baselineHash: job.baselineHash, revision: job.revision,
    dialogueContextFile: path.join(directory, 'dialogue-context.json'), dialogueContextText: path.join(directory, 'dialogue-context.md')};
}

function candidateSourceTable(input, job, archive, count) {
  const sources = new Map(archive.messages.slice(0, count + job.sources.length).map(message => [message.id, {kind: 'message', role: message.role}]));
  function add(id, kind) {
    if (typeof id !== 'string' || !id) return;
    const prior = sources.get(id);
    if (prior?.kind === 'message') throw new Error(`消息与材料来源ID重名，须明确区分：${id}`);
    sources.set(id, {kind, role: kind});
  }
  for (const context of input.dialogueContext || []) {
    for (const item of [...(context.messages || []), ...(context.anchorCandidates || [])]) {
      if (!sources.has(item.id)) sources.set(item.id, {kind: 'dialogue-message', role: item.role});
    }
  }
  for (const item of input.previousContextPlan?.sources || []) if (!sources.has(item.id)) sources.set(item.id, {kind: item.kind, role: item.role});
  for (const file of [input.foundation, input.core, ...(input.materials || [])]) {
    if (file && !file.missing && typeof file.text === 'string') add(file.path, 'material');
  }
  if (input.currentBranch?.id === job.branchId) add(input.currentBranch.id, 'derived');
  if (input.projectOverview?.relationships) add(input.projectOverview.relationshipSource, 'derived');
  return sources;
}
function validateCandidate(candidate, job, archive, metadata, input, {requireBatchPlan = true} = {}) {
  const allowed = new Set(['jobId', 'baselineHash', 'consumedSourceIds', 'conditions', 'observations', 'crossBranchMaterials', 'contextPlan']);
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('候选须为JSON对象。');
  for (const field of Object.keys(candidate)) if (!allowed.has(field)) throw new Error(`管理候选不允许更新字段：${field}；goal/criteria由负责人处理。`);
  if (candidate.jobId !== job.id || candidate.baselineHash !== job.baselineHash) throw new Error('候选job或基线引用不一致。');
  if (!same(candidate.consumedSourceIds, job.sources.map(item => item.id))) throw new Error('候选融合来源游标须准确覆盖本job整批来源且顺序一致。');
  cleanText(candidate.conditions, 'conditions');
  if (candidate.conditions.includes(OPEN) || candidate.conditions.includes(CLOSE)) throw new Error('conditions不能包含程序来源游标块。');
  const count = metadata?.processedCount || 0;
  if (!same(job.startCursor, {processedCount: count, prefixHash: prefixHash(archive, count)}) || !same(job.sources, archive.messages.slice(count, count + job.sources.length).map(sourceEntry))) throw new Error('job来源游标与尚未融合的连续前缀不一致；未消费原话。');
  const sourceMap = candidateSourceTable(input, job, archive, count);
  function refs(item) {
    if (!Array.isArray(item.sourceIds) || !item.sourceIds.length || new Set(item.sourceIds).size !== item.sourceIds.length || item.sourceIds.some(id => !sourceMap.has(id))) throw new Error('判断依据须引用已提供消息/材料/派生原件的准确来源；不能引用任意新文件或job之后的新话。');
    cleanText(item.text, '判断text');
    if (item.contextIds !== undefined && (!Array.isArray(item.contextIds) || new Set(item.contextIds).size !== item.contextIds.length || item.contextIds.some(id => !sourceMap.has(id)))) throw new Error('contextIds须引用已提供背景；不能把未知回答作为确认对象。');
  }
  if (!Array.isArray(candidate.observations) || !Array.isArray(candidate.crossBranchMaterials)) throw new Error('observations与crossBranchMaterials须为数组。');
  for (const item of candidate.observations) {
    refs(item);
    if (!KINDS.has(item.kind)) throw new Error(`未知判断归属：${item.kind}`);
    if (['user-condition', 'user-goal-change'].includes(item.kind) && item.sourceIds.some(id => !['message', 'dialogue-message'].includes(sourceMap.get(id).kind) || sourceMap.get(id).role !== 'user')) throw new Error('用户已定候选不能把助手/工具/材料或派生文字充当用户来源；解释语境可另用contextIds。');
  }
  for (const item of candidate.crossBranchMaterials) {
    refs(item);
    if (!/^[A-Za-z0-9_-]+$/.test(item.branchId) || item.branchId === job.branchId || item.status !== 'pending-owner-review') throw new Error('跨分支材料须指向其他明确分支，并保持pending-owner-review。');
    cleanText(item.relationship, '跨分支relationship');
  }
  if (candidate.contextPlan !== undefined) {
    if (!Array.isArray(candidate.contextPlan)) throw new Error('contextPlan须为处理说明数组。');
    const seen = new Set();
    for (const item of candidate.contextPlan) {
      if (!sourceMap.has(item.sourceId) || seen.has(item.sourceId) || !['active', 'reference', 'open'].includes(item.placement)) throw new Error('contextPlan须引用已提供来源且每个来源只有一个去向。');
      cleanText(item.reason, 'contextPlan.reason'); seen.add(item.sourceId);
      if (item.contextIds !== undefined && (!Array.isArray(item.contextIds) || item.contextIds.some(id => !sourceMap.has(id)))) throw new Error('contextPlan.contextIds引用了未提供背景。');
    }
    if (requireBatchPlan && job.sources.some(item => !seen.has(item.id))) throw new Error('contextPlan须说明本批每条消息如何影响理解本句或下一行动。');
  }
}
function nextEvidence(prior, job, archive, detailsFile, detailsHash) {
  const processedCount = (prior.metadata?.processedCount || 0) + job.sources.length;
  const metadata = {version: 1, archive: job.archive, lastJobId: job.id,
    processedCount, prefixHash: prefixHash(archive, processedCount), detailsFile, detailsHash};
  return [prior.base, `${OPEN}\n${JSON.stringify(metadata)}\n${CLOSE}`].filter(Boolean).join('\n\n');
}

function verifiedJob(jobFile) {
  jobFile = absolute(jobFile, 'job');
  const job = readJson(jobFile);
  if (job.version !== 1 || !Array.isArray(job.sources)) throw new Error('job结构无效。');
  const input = readJson(path.join(path.dirname(jobFile), 'input.json'));
  if (sha(input) !== job.inputHash) throw new Error('prepare输入被改写；请基于最新原件重新prepare。');
  const {inputHash, ...jobSnapshot} = job;
  if (!same(jobSnapshot, input.job)) throw new Error('job归属或执行元数据被改写；拒绝提交。');
  return {jobFile, job, input};
}

function effectiveCandidate(candidate, input) {
  const previousOpen = input.previousContextPlan?.carryOpenEntries || [];
  if (!previousOpen.length) return candidate;
  const current = candidate.contextPlan || [];
  const handled = new Set(current.map(item => item.sourceId));
  const retained = previousOpen.filter(item => !handled.has(item.sourceId));
  return {...candidate, contextPlan: [...current, ...retained]};
}

function plannedContextView(metadata, archive) {
  const empty = {text: '', openCount: 0, referenceCount: 0, sources: [], carryOpenEntries: []};
  if (!metadata?.detailsFile) return empty;
  try {
    const candidate = readJson(metadata.detailsFile);
    if (sha(candidate) !== metadata.detailsHash) throw new Error('已应用语境分配详情被改写。');
    if (!candidate.contextPlan?.length) return empty;
    const {input} = verifiedJob(path.join(path.dirname(metadata.detailsFile), 'job.json'));
    const byId = new Map(archive.messages.map(item => [item.id, item]));
    for (const context of input.dialogueContext || []) for (const item of [...(context.messages || []), ...(context.anchorCandidates || [])]) byId.set(item.id, item);
    for (const file of [input.foundation, input.core, ...(input.materials || [])]) if (file?.path) byId.set(file.path, {id: file.path, role: 'material', text: file.text || '', source: file.path});
    byId.set(input.currentBranch.id, {id: input.currentBranch.id, role: 'derived', text: input.currentBranch.text, source: input.projectOverview.sharedState});
    if (input.projectOverview.relationshipSource) byId.set(input.projectOverview.relationshipSource, {id: input.projectOverview.relationshipSource, role: 'derived', text: input.projectOverview.relationships, source: input.projectOverview.relationshipSource});
    for (const item of input.previousContextPlan?.sources || []) if (!byId.has(item.id)) byId.set(item.id, item);
    const open = new Map(), references = [];
    for (const item of candidate.contextPlan) {
      if (item.placement === 'open') {
        for (const id of [item.sourceId, ...(item.contextIds || [])]) {
          const source = byId.get(id); if (source) open.set(id, source);
        }
      }
      if (item.placement === 'reference') references.push(`- ${item.sourceId}；出处：${JSON.stringify(byId.get(item.sourceId)?.source || item.sourceId)}；原因：${item.reason}`);
    }
    const text = ['# AI已分配的语境', 'active内容以当前有效条件的连贯正文为准；计划不删改核心、goal或criteria。已处理问答不会默认全量重灌。',
      ...(references.length ? ['## 只留出处的材料', ...references] : []),
      ...(open.size ? ['## 当前开放讨论及关联背景', rawTailText([...open.values()])] : []),
      `完整处理理由与关系：${metadata.detailsFile}`].join('\n\n');
    const sources = [...open.values()].map(item => ({...item, kind: item.kind || (archive.messages.some(raw => raw.id === item.id) ? 'message' : item.source?.kind === 'adjacent-dialogue' ? 'dialogue-message' : item.role === 'material' ? 'material' : 'derived')}));
    return {text, openCount: open.size, referenceCount: references.length, sources,
      carryOpenEntries: candidate.contextPlan.filter(item => item.placement === 'open')};
  } catch (error) { return {...empty, error: error.message, text: `语境分配详情读取失败：${error.message}；当前任务与未融合原话继续保留。`}; }
}

export function validateApplication({jobFile, candidate, candidateFile}) {
  const verified = verifiedJob(jobFile), {job, input} = verified;
  candidate = candidate ?? readJson(absolute(candidateFile, 'candidate'));
  const requireBatchPlan = candidate.contextPlan !== undefined;
  candidate = effectiveCandidate(candidate, input);
  const current = readCurrent(job.project, job.branchId, job.rulesPath);
  if (current.baselineHash !== job.baselineHash) throw new Error('当前分支、核心、共同条件或基础规则已变化；旧job不能覆盖。请重新prepare；原话仍未消费。');
  const prior = managerEvidence(current.selected.fields['依据']);
  const location = {archive: absolute(job.archive, 'archive'), directory: path.dirname(job.archive)};
  if (prior.metadata && path.resolve(prior.metadata.archive) !== location.archive) throw new Error('当前来源记录指针改变；拒绝旧job。');
  const archive = loadArchive(location, current.project, job.branchId, prior.metadata);
  validateCandidate(candidate, job, archive, prior.metadata, input, {requireBatchPlan});
  const table = candidateSourceTable(input, job, archive, prior.metadata?.processedCount || 0);
  const sourceKinds = {};
  for (const id of new Set([...candidate.observations, ...candidate.crossBranchMaterials].flatMap(item => item.sourceIds))) {
    const kind = table.get(id).kind;
    sourceKinds[kind] = (sourceKinds[kind] || 0) + 1;
  }
  return {status: 'valid', jobId: job.id, branchId: job.branchId, revision: current.state.revision, consumedCount: job.sources.length,
    pendingAfterApply: archive.messages.length - (prior.metadata?.processedCount || 0) - job.sources.length, sourceKinds,
    note: '纯只读校验；未修改分支、来源档案、游标或回执。实际apply仍在锁内重核。'};
}

export async function apply({jobFile, candidate, candidateFile, lockTimeoutMs = 10000}) {
  jobFile = absolute(jobFile, 'job');
  const job = readJson(jobFile);
  const receiptFile = path.join(path.dirname(jobFile), 'receipt.json');
  try {
    const {input} = verifiedJob(jobFile);
    candidate = candidate ?? readJson(absolute(candidateFile, 'candidate'));
    const requireBatchPlan = candidate.contextPlan !== undefined;
    candidate = effectiveCandidate(candidate, input);
    const location = {archive: absolute(job.archive, 'archive'), directory: path.dirname(job.archive)};
    const result = await withArchiveLock(location, async () => {
      const started = Date.now();
      for (;;) {
        const current = readCurrent(job.project, job.branchId, job.rulesPath);
        if (current.baselineHash !== job.baselineHash) throw new Error('当前分支、核心、共同条件或基础规则已变化；旧job不能覆盖。请重新prepare；原话仍未消费。');
        const prior = managerEvidence(current.selected.fields['依据']);
        if (prior.metadata && path.resolve(prior.metadata.archive) !== location.archive) throw new Error('当前来源记录指针改变；拒绝旧job。');
        const archive = loadArchive(location, current.project, job.branchId, prior.metadata);
        validateCandidate(candidate, job, archive, prior.metadata, input, {requireBatchPlan});
        const detailsHash = sha(candidate);
        const detailsFile = path.join(path.dirname(jobFile), `applied-candidate-${detailsHash}.json`);
        // Persist the exact accepted candidate before linking it from state.
        // The active evidence block holds only a cursor and this detail pointer.
        if (fs.existsSync(detailsFile)) {
          if (sha(readJson(detailsFile)) !== detailsHash) throw new Error('已存候选详情被改写；未提交共享状态。');
        } else await atomicJson(detailsFile, candidate);
        try {
          const updated = await updateSharedBranch(job.project, {id: job.branchId, expectedRevision: current.state.revision,
            changes: {conditions: candidate.conditions, evidence: nextEvidence(prior, job, archive, detailsFile, detailsHash)}, lockTimeoutMs});
          return {status: 'applied', jobId: job.id, branchId: job.branchId, revision: updated.revision,
            consumedCount: job.sources.length, pendingCount: archive.messages.length - (prior.metadata?.processedCount || 0) - job.sources.length,
            crossBranchMaterials: candidate.crossBranchMaterials, observations: candidate.observations,
            ...(candidate.contextPlan ? {contextPlan: candidate.contextPlan} : {}), detailsFile, detailsHash, archive: location.archive};
        } catch (error) {
          if (!error.message.startsWith('共享状态版本冲突：')) throw error;
          if (Date.now() - started >= lockTimeoutMs) throw new Error('共享原件持续并发更新；本次未提交，原话仍未消费。');
          // Retry only after re-reading and rechecking this branch's exact baseline.
        }
      }
    }, lockTimeoutMs);
    try { await atomicJson(receiptFile, {...result, completedAt: new Date().toISOString()}); }
    catch (error) { result.receiptWarning = `共享分支已提交，回执写入失败：${error.message}`; }
    return result;
  } catch (error) {
    // A failure receipt never advances the cursor. The authoritative cursor lives in evidence only.
    await atomicJson(receiptFile, {status: 'failed', jobId: job.id, error: error.message, at: new Date().toISOString()}).catch(() => {});
    throw error;
  }
}

export async function readContext({project, branchId, messages, stateDir, rulesPath = RULES}) {
  let current = readCurrent(project, branchId, rulesPath);
  let prior = managerEvidence(current.selected.fields['依据']);
  const location = locations(current.project, branchId, stateDir, prior.metadata);
  const archive = await withArchiveLock(location, async () => {
    current = readCurrent(project, branchId, rulesPath);
    prior = managerEvidence(current.selected.fields['依据']);
    if (prior.metadata && path.resolve(prior.metadata.archive) !== location.archive) throw new Error('当前来源记录指针改变；请重读context。');
    const value = loadArchive(location, current.project, branchId, prior.metadata);
    if (messages !== undefined) { appendMessages(value, normalizeMessages(messages)); await atomicJson(location.archive, value); }
    return value;
  });
  const pending = pendingMessages(archive, prior.metadata);
  const dialogueContext = dialogueContextFor(pending, {snapshotFile: path.join(location.directory, 'dialogue-background.json')});
  const planned = plannedContextView(prior.metadata, archive);
  const text = [`# 基础行为规则\n原件：${current.rules.path}\n\n${current.rules.text}`,
    `# 核心目的\n原件：${current.core.path}\n\n${current.core.text}`,
    `# 项目概况\n关系原件：${current.frame.relationship_source}\n\n${current.frame.relationships || '项目关系概况未展开；沿关系原件核查。'}\n\n共享原件：${current.state.file}\n成果目录：${path.join(current.project, '成果', 'INDEX.md')}\n其他分支为关系材料；按当前任务展开。\n${current.state.branches.map(item => `- ${item.name} [${item.id}]；主线：${item.ledger || '无'}`).join('\n')}`,
    `# 共同条件\n${current.commonText}`,
    `# 当前分支完整状态\n共享版本：${current.state.revision}\n\n${current.selected.text}`,
    `# 尚未融合的原话（${pending.length}条）\n这些话尚未进入连续理解，须结合当前语境阅读；失败和旧job拒绝不会吞掉这些输入。\n\n${rawTailText(pending)}`,
    ...(pending.length ? [renderDialogueContext(dialogueContext)] : []), ...(planned.text ? [planned.text] : [])].join('\n\n');
  return {project: current.project, branchId, revision: current.state.revision, baselineHash: current.baselineHash,
    pendingCount: pending.length, pendingMessages: pending, archive: location.archive, text, dialogueContext, openCount: planned.openCount};
}

async function cli() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (['help', '--help'].includes(command)) {
    process.stdout.write('prepare --project ABS --branch ID --messages ABS_JSON [--job-dir ABS --state-dir ABS --material ABS ...]\nvalidate --job ABS_JOB_JSON --candidate ABS_JSON（纯只读）\napply --job ABS_JOB_JSON --candidate ABS_JSON\ncontext|read --project ABS --branch ID [--messages ABS_JSON --state-dir ABS --out ABS_MD --json]\nprepare持久保留输入并生成委托；apply由负责人调用，仅更新同分支conditions/evidence；context实际附未融合原话。\n'); return;
  }
  const options = {materials: []}; let json = false, out;
  const flags = {'--project': 'project', '--branch': 'branchId', '--messages': 'messagesFile', '--state-dir': 'stateDir', '--job-dir': 'jobDir', '--job': 'jobFile', '--candidate': 'candidateFile', '--rules': 'rulesPath'};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json') { json = true; continue; }
    if (flag === '--material' || flag === '--out' || flags[flag]) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`参数缺值：${flag}`);
      if (flag === '--material') options.materials.push(value);
      else if (flag === '--out') out = absolute(value, 'out');
      else options[flags[flag]] = value;
    } else throw new Error(`未知参数：${flag}`);
  }
  if (options.messagesFile) options.messages = readJson(absolute(options.messagesFile, 'messages'));
  let result;
  if (command === 'prepare') result = await prepare(options);
  else if (command === 'validate') result = validateApplication(options);
  else if (command === 'apply') result = await apply(options);
  else if (['context', 'read'].includes(command)) {
    result = await readContext(options);
    if (out) { await fs.promises.mkdir(path.dirname(out), {recursive: true}); await fs.promises.writeFile(out, result.text + '\n', 'utf8'); }
  } else throw new Error(`未知命令：${command}`);
  process.stdout.write(!json && ['context', 'read'].includes(command) ? result.text + '\n' : JSON.stringify(result, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cli().catch(error => { process.stderr.write(`上下文融合错误：${error.message}\n`); process.exitCode = 1; });
}

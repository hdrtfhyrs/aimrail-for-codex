import {integrationPath} from '../paths.mjs';
// Codex / Claude 共用状态入口；读原件，不判定授权、不自行总结或筛选内容。
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readContext, readProjectFrame, DEFAULT_PROJECTS_DIR} from '../context/project-context.mjs';
import {readInformationNote} from './information-note.mjs';
import {readTaskSummary} from '../context/task-summary.mjs';
import {isFailedToolResponse, failureDiagnostics, enrichToolResponse} from './knowledge-note.mjs';
import {captureFailure} from '../context/failure-inbox.mjs';
import {readSharedState, selectSharedBranch} from '../context/shared-state.mjs';
import {boundaryNote, postToolContext, recoveryDelivery} from './work-note.mjs';
import {prepareAgentMemory} from './agent-memory.mjs';
import {localNavigation} from '../context/local-navigation.mjs';
import {objectNavigation} from '../context/object-access.mjs';
import {taskWindowNotes} from './task-window-note.mjs';
import {prepareTaskReportNote} from '../context/task-reports.mjs';
import {projectMapNavigation,buildProjectMap} from '../../modules/system/资料中心/project-map.mjs';
import {resourceNavigation} from '../context/resources.mjs';
import {processPromptOperation} from '../../modules/system/本地统一/对话记录/action-manager/action-manager.mjs';
import {actionBoundary} from './action-boundary.mjs';
import {captureHookSubmission, pendingHookContext} from '../../modules/system/任务协作/context-manager/hook-adapter.mjs';
import {budgetHookBlocks, sourceDigest} from './context-budget.mjs';
import {promptRecall, agentTaskRecall} from './recall-note.mjs';
import {rememberPrompt, pendingResearchPacket, researchNavigation} from './research-packet.mjs';

const defaultRules = integrationPath("integrations/AGENTS.md");
const claudeRuleLoader = integrationPath("workspace/hosts/claude/CLAUDE.md");

function hasNativeRuleSource(options, currentRules) {
  if (options.nativeRules === false || !currentRules) return false;
  const body=currentRules.slice(currentRules.indexOf('\n')+1);
  try {
    if(options.host==='codex') {
      const home=options.codexHome || process.env.CODEX_HOME || integrationPath("integrations");
      const override=path.join(home,'AGENTS.override.md');
      const loader=options.nativeRulesFile || (fs.existsSync(override)?override:path.join(home,'AGENTS.md'));
      return fs.readFileSync(loader,'utf8').replace(/^\uFEFF/,'').trim()===body;
    }
    if(options.host==='claude') {
      const loader=options.claudeRuleLoader || claudeRuleLoader;
      const expected=path.resolve(options.rulesFile || defaultRules).replaceAll('\\','/');
      return fs.readFileSync(loader,'utf8').split(/\r?\n/).some(line=>line.trim()==='@'+expected);
    }
  } catch {}
  return false;
}

function currentNativeRuleReceipt(input, options, currentRules) {
  if(options.host!=='codex' || !currentRules || !input.transcript_path) return false;
  try {
    // A bounded tail is only evidence when it contains the actual boundary.
    // Missing/invalid/encrypted records cannot suppress a needed update.
    const fd=fs.openSync(input.transcript_path,'r');
    let tail;
    try {const size=fs.fstatSync(fd).size,bytes=Math.min(size,1024*1024),buffer=Buffer.alloc(bytes);fs.readSync(fd,buffer,0,bytes,size-bytes);tail=buffer.toString('utf8');if(size>bytes)tail=tail.slice(tail.indexOf('\n')+1);}
    finally{fs.closeSync(fd);}
    const records=tail.split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
    const latestStart=records.findLastIndex(record=>record.type==='event_msg'&&record.payload?.type==='task_started');
    let boundary=-1;
    if(typeof input.turn_id==='string' && input.turn_id && latestStart>=0
        && records[latestStart].payload.turn_id===input.turn_id) boundary=latestStart;
    else if(input.hook_event_name==='SessionStart' && input.source==='compact')
      boundary=records.findLastIndex(record=>record.type==='compacted');
    if(boundary<0)return false;
    const native=records.slice(boundary+1).filter(record=>record.type==='response_item'&&record.payload?.type==='message'&&record.payload.role==='user')
      .map(record=>(record.payload.content||[]).filter(item=>item.type==='input_text').map(item=>item.text||'').join('\n'))
      .filter(text=>text.replace(/\r\n/g,'\n').startsWith('# AGENTS.md instructions\n\n<INSTRUCTIONS>')).at(-1);
    const body=currentRules.slice(currentRules.indexOf('\n')+1).replace(/\r\n/g,'\n');
    return Boolean(native && native.replace(/\r\n/g,'\n').includes(body));
  } catch{return false;}
}

function knowledgeEmissionCollector(options) {
  const pending = [];
  const observer = options.knowledgeEmissionObserver;
  return {options: {...options, knowledgeEmissionObserver(record) {
    pending.push(record.commit);
    if (typeof observer === 'function') observer(record);
  }}, commit(finalText) { for (const commit of pending) commit(finalText); }};
}

export function revisionNotice(saved, options = {}) {
  const projects = new Set(saved.project ? [saved.project] : []);
  try { for (const entry of fs.readdirSync(options.projectsDir || DEFAULT_PROJECTS_DIR,{withFileTypes:true})) {
    if (entry.isDirectory()) projects.add(path.join(options.projectsDir || DEFAULT_PROJECTS_DIR,entry.name));
  }} catch {}
  const versions=[];
  for(const project of projects) {
    const file=path.join(project,'共享状态.md');
    try {
      const stat=fs.statSync(file);
      const header=fs.readFileSync(file,'utf8').match(/<!--\s*shared-state revision:(\d+)\s*-->/)?.[1] || '未标记';
      versions.push(`${path.basename(project)}：r${header}，保存时间${stat.mtimeMs}`);
    } catch {}
  }
  const rules=options.rulesFile || defaultRules;
  let stamp='不可读';try{const s=fs.statSync(rules);stamp=`${s.mtimeMs}/${s.size}`;}catch{}
  return `原件版本（非新授权）：${versions.join('；') || '暂无共享原件'}；规则${stamp}。只重读本任务的新版本；父缓存不代替子代理。`;
}

function traceHook(input, options, saved, outcome, context) {
  if (!process.env.SHARED_CONTEXT_PROBE_LOG) return;
  try { fs.appendFileSync(process.env.SHARED_CONTEXT_PROBE_LOG,JSON.stringify({
    event:input.hook_event_name || 'UserPromptSubmit',source:input.source || null,trigger:input.trigger || null,session:input.session_id,agent:input.agent_id || null,
    tool:input.tool_name || null,responseType:typeof input.tool_response,responseStatus:input.tool_response?.status || null,
    responseKeys:input.tool_response && typeof input.tool_response === 'object' ? Object.keys(input.tool_response) : [],
    toolFailed:isFailedToolResponse(input.tool_response),
    hasAgentId:Boolean(input.agent_id),transcript:input.transcript_path ? path.basename(input.transcript_path) : null,
    project:saved.project || null,outcome,characters:context?.length || 0,
    hasRules:Boolean(context?.includes('用户共用规则原件：')),hasShared:Boolean(context?.includes('项目共享状态原件：')),
    hasGoalFrame:Boolean(context?.includes('保存的任务范围（本条新消息尚未合入')),
    hasPendingCriteria:Boolean(context?.includes('待覆盖标准'))})+'\n'); } catch {}
}

export function readUserRules(options = {}) {
  const file = options.rulesFile || defaultRules;
  return `用户共用规则原件：${file}；按相关任务读取，未声称正文已经注入。`;
}

export function buildContext(input, options = {}) {
  options = {taskSummaryReader: readTaskSummary, ...options, hookDeadlineMs: options.hookDeadlineMs || Date.now() + 8000};
  const emissions = knowledgeEmissionCollector(options);
  options = emissions.options;
  try {
    const event = input.hook_event_name || 'UserPromptSubmit';
    const saved = readContext(input, {...options, compact: true, includeDiscovery: false});
    const inherited = event === 'SubagentStart' || input.agent_id
      ? '\n这是派工来源上下文；任务明确的目标项目、分支及主线优先。跨项目/跨分支先用共同CLI显式read，不能把父主线自动当作子任务分支。' : '';
    const information = event === 'UserPromptSubmit' && !input.agent_id ? readInformationNote(input, saved, options) : '';
    const context = readUserRules(options) + '\n\n' + saved.context + inherited + '\n\n'+localNavigation({project:saved.project,includeCounts:false,includeObjects:false}) + '\n\n' + resourceNavigation({...options,includeCounts:false,persist:false}) + '\n\n' + objectNavigation() + information;
    emissions.commit(context);
    return context;
  }
  catch (error) {
    // 归属错误只停止上下文路由，不限制执行能力，也不重置已授权范围。
    return `保存状态归属未解析：${error.message}\n未从其他项目或 cwd 指针补入正文。请用共享上下文 CLI 的显式 read 查原件，bind/rebind 修正会话归属；此路由错误不改变用户已授权任务。`;
  }
}

const defaultSeen = integrationPath("integrations/context/injection-seen");
const clean = value => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);

function deliveryFile(input, options, consumer) {
  return path.join(options.seenDir || defaultSeen, options.host || 'codex', `${clean(input.session_id)}-${consumer}.json`);
}
function loadDelivery(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if(data.schema===3) return data;
    // Old records stored full sources even when Claude or Codex had clipped
    // their bodies. Keep only identity/native rule baseline, and re-deliver
    // task sources once under the new honest receipt semantics.
    if(data.schema===2) return {nativeRules:data.nativeRules||data.sources?.rules,receiver:data.receiver};
    return {};
  }
  catch { return {}; }
}
function saveDelivery(file, value) {
  // Only delivery state: this never means the model read/accepted the source.
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(temporary, JSON.stringify({...value,schema:3}));
    fs.renameSync(temporary, file);
  } catch {} // Cache failure allows retry; it cannot hide new conditions.
  finally {
    // A failed Windows replacement must not leave this call's temporary file.
    try { fs.unlinkSync(temporary); } catch {}
  }
}
function deliveryConsumer(input, options, event) {
  if (input.agent_id) return `agent-${clean(input.agent_id)}`;
  if (event === 'SubagentStart') return 'anonymous-start';
  if (options.host === 'claude' || !['PreToolUse', 'PostToolUse'].includes(event)) return 'root';
  // Same-version receipts show UserPromptSubmit and root tool events share
  // session/turn/transcript. Reuse that receiver only on an exact match;
  // absence of agent_id by itself never identifies the root.
  const receiver = loadDelivery(deliveryFile(input, options, 'root')).receiver;
  const turn = typeof input.turn_id === 'string' ? input.turn_id : '';
  const transcript = typeof input.transcript_path === 'string' ? input.transcript_path : '';
  if (turn && receiver?.turn === turn && receiver.transcript === transcript) return 'root';
  // Unknown turns/transcripts do not borrow a parent receipt. Distinct supplied
  // receiver evidence gets separate state; wholly missing identity cannot be
  // safely deduplicated against the next caller, so it stays read-only below.
  if (turn || transcript) return 'anonymous-' + createHash('sha256').update(JSON.stringify([turn,transcript])).digest('hex').slice(0,32);
  return 'anonymous-tools';
}
function acquireDeliveryLocks(files, options) {
  const held = [];
  const release = () => {
    for (const {file, fd} of held.reverse()) {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(file); } catch {}
    }
  };
  const deadline = Math.min(Date.now() + 2000, options.hookDeadlineMs - 1000);
  try {
    // Serialize the whole read/compare/save transaction, not just replacement.
    // Multiple delivery keys, when requested, use one lock order.
    for (const target of [...new Set(files)].sort()) {
      const file = `${target}.lock`;
      fs.mkdirSync(path.dirname(file), {recursive: true});
      for (;;) {
        try {
          const fd = fs.openSync(file, 'wx');
          held.push({file, fd});
          fs.writeFileSync(fd, JSON.stringify({pid: process.pid, createdAt: new Date().toISOString()}));
          break;
        } catch (error) {
          const busy = error.code === 'EEXIST' || process.platform === 'win32' && error.code === 'EPERM' && fs.existsSync(file);
          if (!busy || Date.now() >= deadline) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(20, Math.max(1, deadline - Date.now())));
        }
      }
    }
    return release;
  } catch (error) {
    release();
    // Keep new conditions visible if storage is unavailable. Do not overwrite
    // another caller's delivery record or remove a lock it may still own.
    process.stderr.write(`上下文投递记录暂未取得锁；本次只读并保留后续重试：${error.code || error.message}\n`);
    return null;
  }
}
function relevantSources(saved, options) {
  const sources = {};
  if (options.contextSubmissionFailure) sources.contextSubmissionFailure = options.contextSubmissionFailure;
  sources.localNavigation=localNavigation({project:saved.project,includeCounts:false,includeObjects:false});
  sources.objects=objectNavigation();
  sources.resources=resourceNavigation({...options,includeCounts:false,persist:false});
  sources.research=researchNavigation();
  const rulesFile = options.rulesFile || defaultRules;
  try { sources.rules = `用户共用规则原件：${rulesFile}\n${fs.readFileSync(rulesFile, 'utf8').replace(/^\uFEFF/, '').trim()}`; }
  catch (error) { sources.rulesError = `用户共用规则暂不可读：${rulesFile}；${error.message}。未视为已投递新规则；下一事件重试。`; }
  if (saved.project) {
    // Local CLI navigation only; discovery never executes providers or a model.
    // Existing source delivery dedup applies when new entries appear on disk.
    try {
      const manifest=path.join(saved.project,'运行中心/modules.json');
      const registry=JSON.parse(fs.readFileSync(manifest,'utf8').replace(/^\uFEFF/,''));
      sources.runtime=`系统中央入口：node "${path.join(saved.project,'运行中心/system.mjs')}" help；modules列模块，module KEY按模块原参数调用。`;
      const index=buildProjectMap({project:saved.project});
      sources.systemMap=projectMapNavigation({project:saved.project,branchId:saved.branchId,maxChars:1100,includeCounts:false,index});
      sources._systemMapStructure=JSON.stringify(index.groups.map(({id,name,purpose,branches})=>({id,name,purpose,branches})));
    } catch {} // Optional central runtime; other projects keep their existing path.
    const frame=readProjectFrame(saved.project);
    if(frame.available) {
      sources.relationships=frame.relationships ? '全项目分支关系（用途与依赖，当前职责仍沿任务原件）：'+frame.relationship_source+'\n'+frame.relationships : '全项目关系原件：'+frame.relationship_source+'；相关依赖按需读取。';
      if(frame.errors?.length) sources.frameError='项目整体材料读取情况：'+frame.errors.map(item=>item.source+'：'+item.reason).join('；');
    }
    const core=path.join(saved.project,'核心.md');
    try {
      const full=frame.available ? frame.core : fs.readFileSync(core,'utf8').replace(/^\uFEFF/,'').trim();
      sources._coreFull=full; // Content comparison includes every confirmed appendix.
      sources.goal=frame.goal_context || '项目完整核心与确认补充原件：'+core+'\n'+full;
    }
    catch(error){sources.goalError='项目核心暂不可读：'+core+'；'+error.message;}
    try {
      const state=readSharedState(saved.project);
      if(!state){sources.stateError='共享状态暂不可读：'+path.join(saved.project,'共享状态.md');}
      else {
        const {selected,selection}=selectSharedBranch(state,saved);
        const sections=state.sections.filter(s=>['目标','共同条件'].includes(s.name));
        sources.common='项目共同目标与条件：'+state.file+'\n'+sections.map(s=>state.lines.slice(s.start,s.end).join('\n').trim()).join('\n\n');
        sources.branches='全项目分支目录与完整状态：'+state.file+'；全部分支沿共享原件或map index读取，有影响的依赖按需展开；目录不是当前职责或新增授权。';
        if(selected){
          const f=selected.fields,scope=['本轮目标','完成标准','有效条件','主线','依据'];
          sources.task='当前完整任务（保存原件，结合本条新话判断补充或变更）：'+selected.name+' ['+selected.id+']；原件'+(selected.source || state.file)+'\n'+scope.filter(k=>f[k]).map(k=>k+'：'+f[k]).join('\n');
          const pendingUnderstanding=pendingHookContext(saved.project,selected.id);
          if(pendingUnderstanding.available&&pendingUnderstanding.text) sources.pendingUnderstanding=pendingUnderstanding.text;
          const progress=['阶段','负责人','已做','下一步'];
          sources.progress='当前任务进度：'+selected.name+' ['+selected.id+']\n'+progress.filter(k=>f[k]).map(k=>k+'：'+f[k]).join('\n');
        }else if(saved.independentLedger) sources.task='本会话独立任务原件（精确会话标记已核，尚未登记共享分支）：'+saved.independentLedger.source+'\n'+saved.independentLedger.text;
        else sources.task=selection+(saved.requestedBranchId ? '这是明确分支归属失效；修复对应原件或绑定，保留用户授权，不改选其他任务。' : '当前任务尚未登记或归属尚未明确；不表示用户已授权工作失效。一次性问答可保持未绑定；需要持续接续的交办再形成完整任务并登记，不接手其他分支。');
      }
    }catch(error){sources.stateError='共享状态读取失败：'+error.message;}
  }
  if (saved.ledger && !sources.task) {
    try { sources.ledger = saved.project
      ? `本会话主线原件：${saved.ledger}；仅作定位、历史和证据入口。当前共享状态不可读时，未把旧主线补成当前条件；请修复或显式读取目标共享分支。`
      : `本会话主线原件：${saved.ledger}\n${fs.readFileSync(saved.ledger, 'utf8').trim()}`; }
    catch (error) { sources.ledgerError = `本会话主线暂不可读：${saved.ledger}；${error.message}`; }
  }
  if (!saved.project && !saved.ledger) sources.route = saved.context || '';
  return sources;
}

function orderedSourceKeys(keys) {
  // Task scope precedes optional navigation even when a host spills output.
  // Ordering never clips a goal/condition or treats our cache as a host receipt.
  const priority=['rules','task','pendingUnderstanding','contextSubmissionFailure','window','objects','common','progress','goal','ledger','route'];
  return keys.filter(key=>key!=='cooperation'&&!key.startsWith('_'))
    .sort((a,b)=>(priority.includes(a)?priority.indexOf(a):priority.length)-(priority.includes(b)?priority.indexOf(b):priority.length));
}

export function buildHookOutput(input, options = {}) {
  options = {...options, host: options.host || input.host || 'codex'};
  const outputEvent = input.hook_event_name || 'UserPromptSubmit';
  if (outputEvent === 'PostToolUseFailure') {
    if (options.host !== 'claude' || input.is_interrupt) return null;
    input = {...input, hook_event_name: 'PostToolUse', tool_response: {isError: true, output: String(input.error || '')}};
  }
  const event = input.hook_event_name || 'UserPromptSubmit';
  if (!['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'PreToolUse', 'PostToolUse'].includes(event)) return null;
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(String(input.session_id || ''))) return null;
  if (event === 'UserPromptSubmit' && !String(input.prompt || '').trim()) return null;
  let actionNote = null;
  if (event === 'PreToolUse' && !options.disableActionBoundary) {
    try {
      actionNote = (options.actionBoundaryReader || actionBoundary)(input,options);
      if (actionNote?.hookSpecificOutput?.permissionDecision === 'deny') return actionNote;
    } catch (error) {
      actionNote = {systemMessage:'动作控制模块异常：'+error.message+'；本次未声称拦截，继续原任务并修复控制入口。'};
    }
  }
  options = {...options, hookDeadlineMs: options.hookDeadlineMs || Date.now() + 8000};
  const consumer = deliveryConsumer(input, options, event);
  const file = deliveryFile(input, options, consumer);
  const files = [file];
  const release = acquireDeliveryLocks(files, options);
  let output;
  try {
    output = buildConsumerOutput(input, {...options, actionContext:actionNote?.hookSpecificOutput?.additionalContext, deliveryReadOnly: !release || consumer === 'anonymous-tools'}, outputEvent, event, consumer, file);
  } finally { if (release) release(); }
  if (actionNote) {
    output = {...(output||{}),...(actionNote.systemMessage?{systemMessage:actionNote.systemMessage}:{})};
  }
  return output;
}

function buildConsumerOutput(input, options, outputEvent, event, consumer, file) {
  const emissions = knowledgeEmissionCollector(options);
  options = emissions.options;
  let saved;
  try { saved = readContext(input, {...options, compact: true, includeDiscovery: false}); }
  catch (error) { saved = {context: `保存状态归属未解析：${error.message}\n未从其他项目或 cwd 指针补入正文。请用共享 CLI 显式 read 修正归属；此路由错误不改变用户已授权任务。`}; }
  let materials = event === 'PostToolUse' ? null : taskWindowNotes(input, {...options,currentProject:saved.project,currentBranch:saved.branchId||input.branchId});
  // Exact window linkage is explicit assignment evidence, not keyword routing.
  // Use it only for an unresolved route, never to replace an explicit branch.
  if (materials?.target && !saved.branchId && !saved.requestedBranchId && !input.branchId && !input.ledger
      && (!saved.project || path.resolve(saved.project).toLowerCase() === path.resolve(materials.target.project).toLowerCase())
      && (!input.project || path.resolve(input.project).toLowerCase() === path.resolve(materials.target.project).toLowerCase())) {
    try {
      saved = readContext({...input, ...materials.target}, {...options,compact:true,includeDiscovery:false});
      materials = taskWindowNotes(input, {...options,currentProject:saved.project,currentBranch:saved.branchId});
    } catch {} // Keep unread assignment visible; never substitute old snapshots.
  }
  const failureContext = event === 'PostToolUse' ? postToolContext(input) : '';
  const agentMemory=event === 'PostToolUse' ? null : prepareAgentMemory(input,options);
  const unidentifiedChild = event === 'SubagentStart' && !input.agent_id;
  const prior = consumer === 'anonymous-tools' ? {} : loadDelivery(file);
  // PostToolUse has only a short failure slot. Leave all full source changes
  // for the next tool/session boundary instead of recording unseen blocks.
  const sources = event === 'PostToolUse' ? {...prior.sources}
    : relevantSources({...saved, branchId: saved.branchId || input.branchId}, options);
  if (event === 'PostToolUse') materials = {window:prior.sources?.window||'',cooperation:prior.sources?.cooperation||'',project:prior.sources?.project||''};
  const window = materials.window;
  if (window) sources.window = window;
  if (materials.cooperation) sources.cooperation = materials.cooperation;
  if (materials.project && !saved.project) sources.project=materials.project;
  const reportMaterial=event==='PostToolUse'?null:prepareTaskReportNote(input,{consumer,project_ref:saved.project});
  const reports=event==='PostToolUse'?prior.sources?.reports||'':reportMaterial?.note||'';
  if(reports)sources.reports=reports;else delete sources.reports;
  // Codex re-enters SessionStart with source=compact after root compaction.
  // PostCompact is advisory and cannot deliver additionalContext.
  const recover = event === 'SessionStart';
  const first = event !== 'PostToolUse' && (!prior.sources || recover || unidentifiedChild);
  // Codex AGENTS and Claude's user-scope @import are the native startup source.
  // Keep the native baseline separate from delivered hook bodies. Recovery
  // must not overwrite it: a change made while running still needs delivery.
  const currentRules = sources.rules;
  const nativeRules = hasNativeRuleSource(options,currentRules);
  const ruleBaseline = prior.nativeRules || prior.sources?.rules || currentRules;
  const rulesChanged = Boolean(currentRules && ruleBaseline && currentRules !== ruleBaseline);
  // The current user message is itself input to this receiver. Omit a second
  // copy only when it contains this exact whole current rule body, never on
  // a filename mention, claimed read, substring summary or parent receipt.
  const provided = [];
  if (nativeRules && !rulesChanged) provided.push('rules');
  if (!provided.includes('rules') && currentNativeRuleReceipt(input,options,currentRules)) provided.push('rules');
  if (event === 'UserPromptSubmit' && sources.rules) {
    const ruleBody = sources.rules.slice(sources.rules.indexOf('\n') + 1).replace(/\r\n/g, '\n');
    if (ruleBody && String(input.prompt || '').replace(/\r\n/g, '\n').includes(ruleBody) && !provided.includes('rules')) provided.push('rules');
  }
  const changed = Object.keys(sources).filter(key => !provided.includes(key) && (first || sources[key] !== prior.sources?.[key])
    && (first || prior.deferred?.[key]?.digest !== sourceDigest(sources[key])));
  const removed = event==='PostToolUse' ? [] : [...new Set([...Object.keys(prior.sources || {}),...Object.keys(prior.deferred || {})])].filter(key => !Object.hasOwn(sources, key) && key!=='hostRuleLoader');
  const names = {_coreFull:'完整核心原件变更',common:'项目共同条件',branches:'分支导航',task:'当前完整任务',pendingUnderstanding:'尚未融合的原话',contextSubmissionFailure:'原话保存情况',progress:'当前任务进度',hostRuleLoader:'Claude加载定位',rules: '用户规则', goal: '核心目的与全文指针', state: '旧合并状态', relationships:'全项目分支关系', ledger: '任务主线', route: '会话归属', resources:'系统资料短目录', window:'本任务完整材料', cooperation:'协作观察原件导航',project:'窗口目标项目导航',reports:'任务主动回报材料',
    runtime:'系统中央入口导航',systemMap:'AI用系统结构索引',objects:'任务理解中的对象知识入口',localNavigation:'本地经验/配置/成果导航',rulesError: '规则读取情况', frameError:'整体材料读取情况', goalError: '目标读取情况', stateError: '状态读取情况', ledgerError: '主线读取情况'};
  let content = '', blocks = [];
  if (first) {
    const firstKeys=Object.keys(sources).filter(key=>!provided.includes(key));
    blocks = orderedSourceKeys(firstKeys).map(key=>({key,label:names[key]||key,text:sources[key]}));
    if(materials.cooperation)blocks.push({key:'cooperation',label:names.cooperation,text:materials.cooperation});
    if(event==='SubagentStart'||input.agent_id)blocks.push({key:'_assignment',label:'派工来源边界',text:'这是派工来源；明确目标项目、分支和交接文件优先，不把父任务当本项。'});
  } else if (changed.length || removed.length) {
    const displayedChanges = [...changed, ...removed].filter(key => !key.startsWith('_'));
    if(displayedChanges.length)blocks.push({key:'_changes',label:'原件变更说明',text:`原件更新：${displayedChanges.map(key => names[key] || key.replace(/Error$/, '') + '读取情况').join('、')}。沿以下正文接续当前任务。`});
    blocks.push(...orderedSourceKeys(changed).map(key=>({key,label:names[key]||key,text:sources[key]})));
    if(changed.includes('_coreFull')&&!changed.includes('goal'))content+='\n\n项目核心确认原件内容有更新：'+path.join(saved.project,'核心.md')+'；按全文核有效要求。';
    if(changed.includes('_systemMapStructure') && prior.sources?._systemMapStructure)content+='\n\n项目分组及分支关系有变更：沿map index和relationships原件展开相关依赖，当前目标与职责仍以对应共享分支为准。';
    if(changed.includes('cooperation')) blocks.unshift({key:'cooperation',label:names.cooperation,text:materials.cooperation});
    const removedSources = removed.filter(key => !key.endsWith('Error') && key!=='state'&&!key.startsWith('_'));
    if (removedSources.length) content += `\n\n此前来源已不在当前可读原件中：${removedSources.map(key => names[key] || key).join('、')}；不要继续把旧内容当作当前状态。`;
  }
  // Incremental notes keep their own existing deduplication and failure behavior.
  let informationCommit;
  const information = ['SessionStart', 'UserPromptSubmit'].includes(event) && !input.agent_id
    ? readInformationNote(input, saved, {...options,informationEmissionObserver:commit=>{informationCommit=commit;}}) : '';
  const knowledge = event === 'PostToolUse' ? failureContext : '';
  // A session-wide prose cache hid later failures that needed the same advice.
  // Retain only bounded receipts keyed to the actual tool invocation and turn.
  const recovery = recoveryDelivery(input, knowledge, prior.recoveryDelivery, recover);
  const knowledgeDelta = recovery.text;
  const boundary = sources.rules ? '' : boundaryNote(input, saved, {...options,includeGoalFrame:!sources.task});
  const boundaryDelta = boundary && (first || boundary !== prior.boundary) ? boundary : '';
  blocks.push(...[['metadata',content],['information',information],['recall',options.recallContext],['research',options.researchContext],['failure',options.failureContext],['knowledge',knowledgeDelta],['boundary',boundaryDelta],['action',options.actionContext],['route',options.routeContext]].filter(([,text])=>text).map(([key,text])=>({key:'_'+key,label:key,text})));
  const delivery = budgetHookBlocks(blocks, input, {...options,consumer});
  content = delivery.text;
  informationCommit?.(content);
  // Persist only actual current source content, not filesystem timestamps.
  if (!options.deliveryReadOnly) {
    const receiver = event === 'UserPromptSubmit' && consumer === 'root'
      ? {turn:typeof input.turn_id === 'string' ? input.turn_id : '',transcript:typeof input.transcript_path === 'string' ? input.transcript_path : ''}
      : prior.receiver;
    const deliveredSources = {}, deferred = {};
    for(const [key,value] of Object.entries(sources)) {
      if (provided.includes(key)) continue;
      if (delivery.delivered.includes(key) || key.startsWith('_') || !first && prior.sources?.[key] === value) deliveredSources[key]=value;
      else if (delivery.file && delivery.deferred.includes(key)) deferred[key]={digest:sourceDigest(value),file:delivery.file,bodyDelivered:false};
      else if (!first && prior.deferred?.[key]?.digest===sourceDigest(value)) deferred[key]=prior.deferred[key];
    }
    const ruleDelivered=delivery.delivered.includes('rules') || provided.includes('rules');
    saveDelivery(file, {...prior, sources:event==='PostToolUse'?prior.sources:deliveredSources,
      deferred:event==='PostToolUse'?prior.deferred:deferred, nativeRules:event==='PostToolUse'?prior.nativeRules:(nativeRules ? (ruleDelivered ? currentRules : ruleBaseline) : undefined),
      receiver, userProvidedSources:provided, boundary: event === 'PostToolUse' ? prior.boundary : (delivery.delivered.includes('_boundary')?boundary:prior.boundary),
      recoveryNotes: [], recoveryDelivery:delivery.delivered.includes('_knowledge')||!knowledgeDelta ? recovery.state : prior.recoveryDelivery,
      lastDiagnostic: knowledge || prior.lastDiagnostic});
  }
  if (!content) { traceHook(input, options, saved, 'unchanged', ''); return agentMemory; }
  // Final whole blocks emitted by this script; host receipt/read/adoption are
  // separate observations, never inferred from this local cache.
  emissions.commit(content);
  reportMaterial?.commit(content);
  traceHook(input, options, saved, first ? 'initial-or-recovery' : 'changed-or-incremental', content);
  return {hookSpecificOutput: {...(agentMemory?.hookSpecificOutput||{}),hookEventName: outputEvent, additionalContext: content}};
}

async function main() {
  // One-shot project classifier reuses ChatGPT login in ephemeral CLI. Its own
  // hooks must not recursively route or inject another user's active task.
  if (process.env.CODEX_PROJECT_ROUTER === '1') return;
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); }
  catch { return; }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const args = process.argv.slice(2);
  const options = {};
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--host') {
      process.stderr.write('intent-check 参数只支持 --host codex|claude|shared\n');
      process.exitCode = 1;
      return;
    }
    options.host = args[1];
  }
  input = enrichToolResponse(input);
  const contextSubmission = await captureHookSubmission(input,{host:options.host||input.host||'codex'});
  if(contextSubmission.status==='failed') options.contextSubmissionFailure=contextSubmission.fallbackText;
  const failureInput = options.host === 'claude' && input.hook_event_name === 'PostToolUseFailure' && !input.is_interrupt
    ? {...input, hook_event_name: 'PostToolUse', tool_response: {isError: true, output: String(input.error || '')}} : input;
  let failureNote = '';
  if (failureInput.hook_event_name === 'PostToolUse' && isFailedToolResponse(failureInput.tool_response) && !process.env.KNOWLEDGE_PROBE_LOG) {
    let saved = {};
    try { saved = readContext(failureInput, {...options, compact:true}); } catch {}
    try {
      const captured = await captureFailure(failureInput, failureDiagnostics(failureInput), saved);
      // 反复出现的同一失败当场说明次数，便于这次就修掉，而不是再记一条。
      if (captured?.count >= 3) failureNote = `这类错误已记录${captured.count}次（${captured.uniqueSessions}个会话），状态${captured.status}；次数是错误分组记录，不证明同一原因。先核本次对象与原因并修复；仅该记录覆盖的原因已解决时，用 node "integrations/context/failure-inbox.mjs" resolve --id ${captured.id} --status fixed --evidence 证据文件 标记。`;
    } catch {} // 线索登记失败不遮蔽原结果，不阻止已授权工作。
  }
  // Process this real submit once; no background process or semantic provider.
  let routeNote='';
  try {
    const route = await processPromptOperation(input, options);
    if (route?.note) routeNote=route.note;
  } catch (error) { process.stderr.write('本次对话归属暂未处理：'+error.message+'\n'); }
  // 本地候选主动送达；外部研究由AI形成问题后显式启动，读取/编辑技能不触发搜索。
  const host = options.host || input.host || 'codex', hookEvent = input.hook_event_name || 'UserPromptSubmit';
  let recallNote = null, researchNote = null;
  if (hookEvent === 'UserPromptSubmit' && !input.agent_id) {
    let researchSaved = null;
    try { researchSaved = readContext(input, {...options, compact:true}); } catch {}
    rememberPrompt(input, researchSaved, host, String(input.prompt || ''));
    try { recallNote = await promptRecall(input, host); } catch {}
  }
  if (['UserPromptSubmit', 'PreToolUse', 'SessionStart'].includes(hookEvent)) researchNote = pendingResearchPacket(input, host);
  let agentRecall = '';
  if (hookEvent === 'PreToolUse' && /^(?:Agent|spawn_agent|collaboration[._]spawn_agent)$/i.test(String(input.tool_name || ''))) {
    try { agentRecall = (await agentTaskRecall(input))?.text || ''; } catch {}
  }
  let output;
  try {
    output = buildHookOutput(input, {...options,routeContext:routeNote,recallContext:recallNote?.text,researchContext:researchNote?.text,failureContext:failureNote,agentRecall});
    const emitted = output?.hookSpecificOutput?.additionalContext || '';
    if (emitted) { recallNote?.commit(emitted); researchNote?.commit(emitted); }
  } finally { researchNote?.cancel(); }
  // Stop has no additionalContext delivery event. Preserve the pre-existing
  // route-only fallback without passing a cached source through a second cap.
  const finalOutput=output || (routeNote?{hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:
    budgetHookBlocks([{key:'route',label:'本次对话归属提示',text:routeNote}],input,options).text}}:null);
  if (finalOutput) process.stdout.write(JSON.stringify(finalOutput));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();

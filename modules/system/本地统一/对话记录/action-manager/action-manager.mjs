import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
const {readSharedState,selectSharedBranch} = await import(_publicURL("$codex/context/shared-state.mjs"));
import {redact,search,read,refreshThread} from '../conversations.mjs';
import {resumeConversation} from '../management.mjs';
import {AppClient,jsonContent} from '../original-manager/app-client.mjs';

import {sortNativeSections} from './native-sort.mjs';
import {syncNativeDecision,applyNativeBatch} from './native-routing.mjs';
import {historyUserEvents} from './history-user-events.mjs';
import {catalog,addSystem,batchArchive,groupProject} from './catalog-extension.mjs';
import {nativeSections,currentNativeSection,catalogVersion} from './native-sections.mjs';
import {registerProject,createProject} from './project-registry.mjs';
import {queueSemanticRouting,resumeDeferredRouting} from './semantic-routing.mjs';
const {bindContext} = await import(_publicURL("$codex/context/project-context.mjs"));
const HERE=path.dirname(fileURLToPath(import.meta.url));
const RECORDS=path.dirname(HERE);
const STATE=_publicDataPath("本地统一/对话记录/action-manager/decisions.json");
const DB=_publicPath("$codex/state_5.sqlite");
const BINDINGS=_publicPath("$codex/context/bindings/codex");
const CLI='node "'+path.join(HERE,'action-manager.mjs')+'"';
const json=(p,d=null)=>{try{return JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));}catch{return d;}};
const norm=s=>String(s||'').replaceAll('\\','/').replace(/\/$/,'').toLowerCase();
const layout=()=>json(_publicDataPath("本地统一/对话记录/organization.json"),{groups:[],assignments:[]});
const binding=id=>json(path.join(BINDINGS,id+'.json'));
const rootRow=r=>r&&!r.agent_path&&!/subagent/i.test(String(r.thread_source))&&!/\/work\/(behavior|activation-behavior)\/runs\//i.test(norm(r.cwd));
function rows(id){const db=new DatabaseSync(DB,{readOnly:true});try{const sql='SELECT id,title,cwd,source,thread_source,agent_path,archived,rollout_path,updated_at FROM threads WHERE archived=0 AND source IN (\'desktop\',\'vscode\')';return (id?db.prepare(sql+' AND id=?').all(id):db.prepare(sql+' ORDER BY updated_at DESC,id').all()).filter(rootRow);}finally{db.close();}}
function task(b){if(!b?.project)return null;const s=readSharedState(b.project),branch=selectSharedBranch(s,{branchId:b.branchId||undefined,ledger:b.ledger||undefined}).selected;return {project:b.project,core:path.join(b.project,'核心.md'),branchId:branch?.id||b.branchId||null,fields:branch?.fields||null,ledger:b.ledger||null};}
function save(d){fs.mkdirSync(HERE,{recursive:true});const lock=STATE+'.lock';let fd;try{fd=fs.openSync(lock,'wx');}catch(e){if(e.code==='EEXIST')return {status:'busy-preserve-current-decision',threadId:d.threadId};throw e;}try{const s=json(STATE,{schemaVersion:1,decisions:{}});const prior=s.decisions[d.threadId];if(JSON.stringify({...prior,at:null})===JSON.stringify({...d,at:null}))return {...prior,write:'unchanged'};s.decisions[d.threadId]=d;s.updatedAt=new Date().toISOString();const tmp=STATE+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(s,null,2)+'\n');fs.renameSync(tmp,STATE);return d;}finally{fs.closeSync(fd);fs.unlinkSync(lock);}}
export function resolveKnownDuty({currentBinding,boundTask,groups,currentDecision,historicDecision}){
 const activeBranch=boundTask?.branchId||currentBinding?.branchId||null;
 const project=boundTask?.project||currentBinding?.project||null;
 if(activeBranch){
  const group=groups.find(g=>norm(project)===norm(groupProject(g))&&(g.branches||[]).includes(activeBranch));
  if(group)return {group,source:'current-binding-and-shared-goal',reason:'复用已有明确绑定、有效共享目标及原话职责证据'};
 }
 for(const [decision,source]of [[currentDecision,'previous-current-operation-decision'],[historicDecision,'previous-original-source-decision']]){
  if(decision?.semanticPending||decision?.status!=='classified'||!String(decision.reason||'').trim())continue;
  if(project&&norm(project)!==norm(decision.project))continue;
  // A real branch switch must not inherit an old unrelated duty. An explicitly
  // classified standalone ledger, however, does not need an invented branch.
  if(activeBranch&&decision.branchId!==activeBranch)continue;
  const group=groups.find(g=>g.key===decision.groupKey&&norm(groupProject(g))===norm(decision.project));
  if(group)return {group,source,reason:decision.reason};
 }
 return null;
}
function known(row){
 const b=binding(row.id),t=task(b),l=layout();
 const sections=nativeSections(),version=catalogVersion(sections),current=currentNativeSection(row.id,sections);
 const priorDecision=json(STATE,{decisions:{}}).decisions[row.id];
 const receipt=json(_publicDataPath("本地统一/对话记录/action-manager/native-routing-receipts.json"),{moves:{}}).moves[row.id];
 const config=json(_publicDataPath("本地统一/对话记录/action-manager/native-routing-config.json"),{systems:[]});
 const userSection=current&&(!receipt||receipt.sectionId!==current.sectionId||!config.systems.some(s=>s.sectionId===current.sectionId));
 if(userSection)return save({threadId:row.id,status:'classified',project:b?.project||priorDecision?.project||null,branchId:b?.branchId||null,groupKey:priorDecision?.groupKey||null,groupName:current.name,sectionId:current.sectionId,nativeCatalogVersion:version,reason:'保留当前原生分组；旧项目绑定不覆盖用户选择',source:'current-native-section',at:new Date().toISOString(),nativeMoveApplied:false});
 if(receipt&&!current&&receipt.sectionId)return {status:'preserved-user-section',threadId:row.id,reason:'聊天已离开之前自动移动的分组，保留当前Chats位置'};
 if(priorDecision?.sectionId&&(!b?.project||norm(b.project)===norm(priorDecision.project))&&(!b?.branchId||b.branchId===priorDecision.branchId)){
  const section=sections.find(s=>s.sectionId===priorDecision.sectionId);
  if(!section)return {status:'semantic-required',threadId:row.id,reason:'之前的原生分组已删除；不回退到旧项目分组'};
  return save({...priorDecision,groupName:section.name,nativeCatalogVersion:version,at:new Date().toISOString(),nativeMoveApplied:false});
 }
 if(priorDecision?.nativeCatalogVersion!==version&&sections.some(s=>!config.systems.some(m=>m.sectionId===s.sectionId)))return {status:'semantic-required',threadId:row.id,boundTask:t,reason:'现有原生分组超出旧项目映射；须把全部分组纳入当前语义判断'};
 const resolved=resolveKnownDuty({currentBinding:b,boundTask:t,groups:l.groups,
  currentDecision:json(STATE,{decisions:{}}).decisions[row.id],
  historicDecision:json(_publicDataPath("本地统一/对话记录/original-routing-state.json"),{decisions:{}}).decisions[row.id]});
 if(!resolved){
  const fileProject=catalog().systems.find(p=>norm(p.projectPath)===norm(b?.project));
  if(fileProject?.sectionId&&t?.fields)return save({threadId:row.id,status:'classified',project:fileProject.projectPath,groupKey:null,groupName:fileProject.name,sectionId:fileProject.sectionId,branchId:t.branchId,nativeCatalogVersion:version,reason:'复用明确文件项目绑定及其有效完整任务；新话用途仍由当前AI判断',source:'explicit-file-project-binding',at:new Date().toISOString(),nativeMoveApplied:false});
  return {status:'semantic-required',threadId:row.id,boundTask:t};
 }
 const {group:g,source,reason}=resolved;
 return save({threadId:row.id,status:'classified',project:t?.project||b?.project||groupProject(g),groupKey:g.key,groupName:g.name,branchId:t?.branchId||b?.branchId||null,nativeCatalogVersion:version,reason,source,at:new Date().toISOString(),nativeMoveApplied:false});
}

// Called only by an actual UserPromptSubmit. Never starts a worker/model/timer.
export async function processPromptOperation(input,{host='codex'}={}){
 if(host!=='codex'||!['UserPromptSubmit','Stop'].includes(input.hook_event_name)||input.agent_id)return null;
 const id=input.session_id;if(!/^[0-9a-f-]{36}$/i.test(id||''))return null;
 let capture;try{capture=await refreshThread(id);}catch(error){capture={status:'failed',threadId:id,error:redact(error.message)};}
 const row=rows(id)[0];
 const result=row?known(row):{status:'semantic-required',threadId:id,reason:'New chat row may not be persisted until the current message starts'};
 if(input.hook_event_name==='Stop'){const native=result.status==='classified'?await syncNativeDecision(result):null;const semantic=row?resumeDeferredRouting(id):null;return {...result,capture,native,semantic,note:''};}
 const semantic=queueSemanticRouting({...input,deferUntilRow:!row});
 const assessment=`结合当前完整交办的用途判断：延续已有项目、在项目内形成子分支、建立独立项目、或一次性保持未绑定。看持续目的、成果归属和维护责任，不因使用AI就归AI工作系统，不按词/标题新建。已有效绑定和同名/别名先复用；普通续聊、异步范围回答及条件补充继续原绑定，不调用额外分类模型。当前AI发现真实目的变化候选时用 ${CLI} semantic-route --id ${id} --candidate purpose-change 启动一次结构判定与自动保存；packet保留完整问题/答案、相邻原目标和多件事。也可沿实际已理解的授权直接create-project/register-project/commit。创建须完整原件，分支沿现行shared-state。既有显式绑定只有用户直接改归属、拆出当前业务或明确替换主线时才可rebind；变化类型、逐字原话及来源留存。用户手动位置优先，归类不阻断已授权工作。`;
 const note=(semantic?.job?`已用本人现有ChatGPT Codex权益启动一次结构化项目归属判断并自动保存适用结果，状态${semantic.status}，真实任务与回执：${semantic.job}。当前AI继续交办；并发人工移动/绑定优先保留，未确认结果不报自动创建完成。 `:``)+(result.status==='preserved-user-section'?`已保留用户当前分组位置，不按旧绑定搬回。`
 :result.status==='classified'?`当前显示分组：${result.groupName}。${result.project?'任务文件项目：'+path.basename(result.project)+'。':''}`
 :`本次聊天归属尚需当前处理消息的AI作完整语义判断；不启动额外模型或轮询。`)+' '+assessment;
 // A fresh message can introduce a new independent goal. Do not move it from
 // an old file binding before the current task AI has understood that message.
 const native=null;
 const warning=native?.status==='failed'?` 原生归组本次失败：${native.error}；归属已保留，可用 sync-native 重试当前聊天。`:native?.status==='saved-ui-unverified'?` 归属已保存，但当前侧栏仍返回临时编号，尚未确认显示成功；保留原聊天入口，不能报告归组完成。`:``;
 return {...result,capture,semantic,nativeMoveApplied:['applied','already-applied'].includes(native?.status),native,note:note+warning};
}
export async function packet(id){
 const row=rows(id)[0];if(!row)throw Error('Active original root thread unavailable');
 const events=[],fallback=[],conversationContext=[];let historyProjection=null;
 const envelope=text=>/^# AGENTS\.md instructions|^<environment_context>|^<heartbeat/.test(String(text||''));
 if(!fs.existsSync(row.rollout_path)){historyProjection=await historyUserEvents(id);events.push(...historyProjection.events);conversationContext.push(...historyProjection.conversationContext);}
 if(!historyProjection){
  const stream=readline.createInterface({input:fs.createReadStream(row.rollout_path,{encoding:'utf8'}),crlfDelay:Infinity});
  for await(const line of stream){
   let o;try{o=JSON.parse(line);}catch{continue;}const p=o.payload||{};
   if(o.type==='event_msg'&&p.type==='user_message'&&!envelope(p.message))events.push({at:o.timestamp,text:redact(p.message||''),images:p.images||[],localImages:p.local_images||[]});
   if(o.type==='response_item'&&p.type==='message'&&['user','assistant'].includes(p.role)&&p.channel!=='analysis'){
    const text=redact((p.content||[]).filter(c=>['input_text','output_text','text'].includes(c.type)).map(c=>c.text).join('\n'));
    if(text&&!envelope(text)){
     conversationContext.push({at:o.timestamp,role:p.role,text});
     if(p.role==='user')fallback.push({at:o.timestamp,text,images:(p.content||[]).filter(c=>c.type==='input_image').map(()=>({kind:'image-in-original-message'}))});
    }
   }
   if(o.type==='response_item'&&p.type==='function_call'&&/request_user_input/.test(p.name||'')){
    let questions;try{questions=JSON.parse(p.arguments).questions;}catch{}
    if(questions)conversationContext.push({at:o.timestamp,role:'assistant',kind:'native-async-question',questions});
   }
  }
 }
 const actualUserMessages=events.length?events:fallback;
 const asyncAnswers=[];
 for(const message of actualUserMessages){
  const match=message.text?.match(/<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/);
  if(match){try{asyncAnswers.push(...JSON.parse(match[1]).map(a=>({...a,at:message.at})));}catch{}}
 }
 const directory=catalog();
 const projects=directory.systems.map(({projectPath:project,name,aliases,sectionId,relations,groups})=>{const core=path.join(project,'核心.md');let branches=[];if(fs.existsSync(path.join(project,'共享状态.md')))branches=readSharedState(project).branches;return {name,aliases,sectionId,relations,project,core:fs.existsSync(core)?redact(fs.readFileSync(core,'utf8')):null,groups:groups.map(g=>({key:g.key,name:g.name,responsibility:g.description,branches:g.branches})),branches:branches.map(b=>({id:b.id,name:b.name,goal:b.fields?.['本轮目标']}))};});
 const sections=nativeSections();
 return {threadId:id,binding:binding(id),currentTask:task(binding(id)),nativeSections:sections.map(({itemKeys,...s})=>({...s,memberCount:itemKeys.length})),currentNativeSection:currentNativeSection(id,sections),actualUserMessages,conversationContext,asyncAnswers,historyProjection:historyProjection?{source:historyProjection.source,boundary:historyProjection.boundary}:null,projects,projectRoots:directory.roots,registry:directory.source,createRoot:directory.createRoot,dispositions:['existing-project','subbranch','independent','one-off'],boundary:'All current projects and native groups are candidates. Packet retains full real goals, adjacent assistant context and native async question/answer relationships. Scope answers and supplements preserve the existing explicit binding. Unknown purpose changes remain candidates. Name/alias and semantic core reuse precede creation. Manual native placement wins. No native move or task execution.'};
}
export async function commit(input){
 if(!input||typeof input!=='object')throw Error('Decision JSON required');
 const row=rows(input.threadId)[0];if(!row)throw Error('Active original root thread unavailable');
 if(!String(input.reason||'').trim())throw Error('Concrete purpose/relationship reason required');
 if(input.disposition&&!['existing-project','subbranch','independent','one-off'].includes(input.disposition))throw Error('Unknown disposition');
 const b=binding(row.id),sections=nativeSections(),directory=catalog(),g=layout().groups.find(g=>g.key===input.groupKey);
 const p=input.project?directory.systems.find(p=>norm(p.projectPath)===norm(input.project)):null;
 if(input.project&&!p)throw Error('Target must be a current file project; create-project or register-project first');
 if(input.groupKey&&(!g||norm(groupProject(g))!==norm(input.project)))throw Error('Existing duty does not belong to target project');
 if(input.disposition==='subbranch'&&!input.branchId)throw Error('Subbranch requires an actual shared-state branchId');
 if(input.disposition==='one-off'||(!p&&!input.sectionId&&!g)){
  if(input.project||input.branchId||input.groupKey)throw Error('One-off decision cannot bind a file project');
  return save({threadId:row.id,status:'unassigned',disposition:'one-off',project:b?.project||null,branchId:b?.branchId||null,groupKey:null,reason:redact(input.reason),source:'current-operation-semantic-decision',at:new Date().toISOString(),nativeMoveApplied:false,bindingPreserved:!!b});
 }
 const requestedSection=input.sectionId||p?.sectionId||null,section=sections.find(s=>s.sectionId===requestedSection);
 if(requestedSection&&!section)throw Error('Target must be a current native section');
 const branchChange=input.branchId&&input.branchId!==b?.branchId,projectChange=b&&input.project&&norm(b.project)!==norm(input.project);
 const rebind=input.bindingAction==='rebind';
 const userCorrection=String(input.userDirective||'').trim()&&String(input.directiveSource||'').trim();
 if(!input.viewOnly&&(projectChange||b&&branchChange)&&(!rebind||!userCorrection))throw Error('Existing binding preserved; user correction requires bindingAction=rebind, userDirective and directiveSource');
 if(rebind&&!userCorrection)throw Error('Rebind requires original user instruction and source');
 if(p&&!input.viewOnly&&(!b||projectChange||branchChange)){
  // Validate real shared-state identity; never invent a first-match branch.
  const target={host:'codex',session_id:row.id,cwd:row.cwd.replace(/^\\\\\?\\/,''),
   project:p.projectPath,...(input.branchId?{branchId:input.branchId}:{ledger:input.ledger||path.join(p.projectPath,'主线',row.id+'.md')})};
  const result=bindContext(target,{rebind});
  fs.mkdirSync(path.join(HERE,'binding-recovery'),{recursive:true});
  fs.writeFileSync(path.join(HERE,'binding-recovery',row.id+'.'+Date.now()+'.json'),JSON.stringify({threadId:row.id,prior:b||null,createdValue:result,userDirective:input.userDirective||null,directiveSource:input.directiveSource||null},null,2));
 }
 const currentBinding=binding(row.id),current=currentNativeSection(row.id,sections),receipt=json(_publicDataPath("本地统一/对话记录/action-manager/native-routing-receipts.json"),{moves:{}}).moves[row.id];
 const manual=current&&(!receipt||receipt.sectionId!==current.sectionId);
 const explicitNativeTarget=input.nativeAction==='move'&&!!userCorrection;
 const saved=save({threadId:row.id,status:'classified',disposition:input.disposition||'existing-project',project:input.viewOnly&&p?p.projectPath:currentBinding?.project||p?.projectPath||null,executionProject:currentBinding?.project||null,groupKey:g?.key||null,groupName:section?.name||g?.name||current?.name||null,sectionId:requestedSection,nativeCatalogVersion:catalogVersion(sections),branchId:input.viewOnly&&projectChange?input.branchId||null:currentBinding?.branchId||null,viewOnly:!!input.viewOnly||!p,reason:redact(input.reason),source:'current-operation-semantic-decision',at:new Date().toISOString(),nativeMoveApplied:false});
 if(saved.status!=='classified')return saved;
 if(manual&&current.sectionId!==requestedSection&&!explicitNativeTarget)return {...saved,native:{status:'preserved-user-section',sectionId:current.sectionId},nativeMoveApplied:false};
 const native=await syncNativeDecision({...saved,explicitNativeTarget},{sort:false});
 return {...saved,nativeMoveApplied:['applied','already-applied'].includes(native.status),native};
}
export function recent({limit=50,query=''}={}){if(!Number.isInteger(limit)||limit<1||limit>500)throw Error('limit must be 1..500');const l=layout(),latest=json(STATE,{decisions:{}}).decisions,old=json(_publicDataPath("本地统一/对话记录/original-routing-state.json"),{decisions:{}}).decisions;const items=rows().map(r=>{const b=binding(r.id),d=latest[r.id]||old[r.id],g=l.groups.find(g=>g.key===d?.groupKey);return {threadId:r.id,title:r.title,updatedAt:r.updated_at,updatedAtSource:'original threads.updated_at',project:b?.project||d?.project||null,branchId:b?.branchId||null,groupName:d?.groupName||g?.name||null,sectionId:d?.sectionId||null,groupKey:g?.key||null};}).filter(r=>!query||JSON.stringify([r.title,r.project,r.groupName,r.branchId]).toLowerCase().includes(query.toLowerCase()));return {items:items.slice(0,limit),total:items.length,boundary:'Read-only local original Codex root threads; includes all groups. This strict native update order is an AI management query, not a change to native sidebar sorting and not cloud account-wide coverage.'};}
export async function open(id){const row=rows(id)[0];if(!row)throw Error('Active original root thread unavailable');const decision=known(row),c=new AppClient();try{await c.initialize();return {threadId:id,decision,result:jsonContent(await c.call('navigate_to_codex_page',{threadId:id})),boundary:'Native original-app navigation only. Does not submit a message or execute another task. Unresolved semantics remain for current task AI; no background provider.'};}finally{c.close();}}
export async function main(argv=process.argv.slice(2)){const cmd=argv.shift()||'help',a={};for(let i=0;i<argv.length;i++){if(!argv[i].startsWith('--')||!argv[i+1])throw Error('Use named options');a[argv[i].slice(2)]=argv[++i];}if(cmd==='help')return {commands:{catalog:'list dynamic systems and responsibilities',
'add-system':'legacy duty registration only: --input ABS_JSON name, projectPath, groups',
'register-project':'--input ABS_JSON: existing name/projectPath/reason, aliases/relations/sectionId; reuse native section or create one through official bridge',
'create-project':'--input ABS_JSON: disposition=independent, name, reason, independentReason, reuseAssessment, documents{core,state,overview}; exact name/alias reuse before configured project-root creation',
'semantic-route':'--id UUID: reroute the latest actual original human message with existing ChatGPT Codex CLI; one-shot event job, no API key or timer',
'sort-native':'sort original system groups by true updated_at once; sync native UI and persistent positions',
'sync-native':'--id UUID: apply current saved classification to native system section once',
'archive-batch':'--input ABS_JSON: decisions[{threadId,project,groupKey,reason}], optional dryRun; one atomic write, preserves execution bindings and raw chats',
route:'--id UUID: one existing bound/current thread only',packet:'--id UUID: original full user messages + current core/task/duties',commit:'--input ABS_JSON: threadId,project,groupKey,reason; existing bindings preserved',recent:'--limit 1..500 --query TEXT: strict real updated_at, cross duties',search:'--query TEXT: original content via shared conversation index',resume:'--id ID: shared goal and actual recent text',open:'--id UUID: navigate original app without submitting messages'},idle:'No listener, timer, watch or model invocation',nativeSidebarComplete:false};if(cmd==='catalog')return catalog();if(cmd==='add-system')return addSystem(json(a.input));if(cmd==='register-project')return registerProject(json(a.input));if(cmd==='create-project')return createProject(json(a.input));if(cmd==='semantic-route'){const material=await packet(a.id),last=material.actualUserMessages.at(-1);if(!last?.text)throw Error('Actual original human message unavailable');return queueSemanticRouting({hook_event_name:'UserPromptSubmit',session_id:a.id,cwd:rows(a.id)[0].cwd,prompt:last.text,routingCandidate:a.candidate==='purpose-change',transcript_path:'original user event '+last.at});}if(cmd==='archive-batch'){const input=json(a.input),saved=batchArchive(input);if(input.dryRun)return saved;const native=await applyNativeBatch(input.decisions,{receiptFile:_publicDataPath("本地统一/对话记录/action-manager/native-batch-last.json")});return {...saved,native:{applied:native.applied,failed:native.failed}};}if(cmd==='sort-native')return sortNativeSections({receiptFile:_publicDataPath("本地统一/对话记录/action-manager/native-sort-last.json")});if(cmd==='sync-native'){const item=recent({limit:500}).items.find(i=>i.threadId===a.id);if(!item)throw Error('Original thread unavailable');return syncNativeDecision(json(STATE,{decisions:{}}).decisions[a.id]||item,{force:true,sort:false});}if(cmd==='route'){const r=rows(a.id)[0];if(!r)throw Error('Original thread unavailable');return known(r);}if(cmd==='packet')return packet(a.id);if(cmd==='commit')return commit(json(a.input));if(cmd==='recent')return recent({limit:Number(a.limit||50),query:a.query||''});if(cmd==='search')return search(a.query,{limit:20});if(cmd==='resume')return resumeConversation(a.id,{chars:2500},read);if(cmd==='open')return open(a.id);if(cmd==='status')return {state:STATE,decisions:Object.values(json(STATE,{decisions:{}}).decisions),idleProcessRequired:false};throw Error('Unknown command');}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(r=>process.stdout.write(JSON.stringify(r,null,2)+'\n')).catch(e=>{process.stdout.write(JSON.stringify({error:redact(e.message)})+'\n');process.exitCode=1;});

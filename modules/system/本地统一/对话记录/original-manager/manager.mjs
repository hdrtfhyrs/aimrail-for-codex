import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const {readSharedState,selectSharedBranch} = await import(_publicURL("$codex/context/shared-state.mjs"));
const {execute} = await import(_publicURL("$system/运行中心/providers/gemini.mjs"));
const {redact} = await import(_publicURL("$system/本地统一/对话记录/conversations.mjs"));
import {AppClient,jsonContent} from './app-client.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const RECORDS=_publicPath("$system/本地统一/对话记录");
const STATE=_publicDataPath("本地统一/对话记录/original-routing-state.json");
const BINDINGS=_publicPath("$codex/context/bindings/codex");
const DATABASE=_publicPath("$codex/state_5.sqlite");
const json=(f,d={})=>{try{return JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));}catch{return d;}};
const atomic=(f,o)=>{fs.mkdirSync(path.dirname(f),{recursive:true});const tmp=f+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(o,null,2)+'\n');fs.renameSync(tmp,f);};
const norm=s=>String(s||'').replaceAll('\\','/').replace(/\/$/,'').toLowerCase();
const digest=o=>createHash('sha256').update(JSON.stringify(o)).digest('hex');
const inFlightKeys=new Map();
async function saveDecision(id,decision){const lock=STATE+'.lock';let fd;for(let i=0;i<100;i++){try{fd=fs.openSync(lock,'wx');break;}catch(e){if(e.code!=='EEXIST')throw e;await new Promise(r=>setTimeout(r,40));}}if(fd===undefined)throw Error('Original routing state busy');try{const fresh=json(STATE,{schemaVersion:1,decisions:{}});fresh.decisions[id]=decision;fresh.updatedAt=new Date().toISOString();fresh.boundary='Original app metadata and transcripts, same-source project bindings. Project/duty semantic decisions are live; no native tree/Recents/collapse modification and no native move.';atomic(STATE,fresh);}finally{fs.closeSync(fd);fs.unlinkSync(lock);}}
function nativeRows(){const db=new DatabaseSync(DATABASE,{readOnly:true});try{return db.prepare("SELECT id,cwd,source,thread_source,agent_path,archived,rollout_path,updated_at,has_user_event FROM threads WHERE archived=0 AND source IN ('desktop','vscode') ORDER BY updated_at DESC").all().filter(r=>!r.agent_path&&!/subagent/i.test(String(r.thread_source))&&!norm(r.cwd).includes('/work/behavior/runs/')&&!norm(r.cwd).includes('/work/activation-behavior/runs/'));}finally{db.close();}}
async function actualMessages(row){if(!row.rollout_path||!fs.existsSync(row.rollout_path))return [];const events=[],fallback=[];const lines=readline.createInterface({input:fs.createReadStream(row.rollout_path,{encoding:'utf8'}),crlfDelay:Infinity});for await(const line of lines){let o;try{o=JSON.parse(line);}catch{continue;}const p=o.payload||{};if(o.type==='event_msg'&&p.type==='user_message'&&typeof p.message==='string')events.push({at:o.timestamp,text:redact(p.message)});if(o.type==='response_item'&&p.type==='message'&&p.role==='user')fallback.push({at:o.timestamp,text:redact((p.content||[]).filter(c=>c.type==='input_text').map(c=>c.text).join('\n'))});}return (events.length?events:fallback).filter(m=>m.text&&!/^<(?:heartbeat|send_user_message_question_reply)/.test(m.text));}
function layout(){return json(_publicDataPath("本地统一/对话记录/organization.json"),{groups:[],assignments:[]});}
function current(binding){if(!binding?.project)return null;let state;try{state=readSharedState(binding.project);}catch{}const selected=selectSharedBranch(state,{branchId:binding.branchId||undefined,ledger:binding.ledger||undefined}).selected;return {project:binding.project,branchId:selected?.id||binding.branchId||null,fields:selected?.fields||null,stateFile:state?.file||null,ledger:binding.ledger||null};}
function sources(groups){return [...new Set(groups.map(g=>g.project))].map(name=>{const project=_publicPath("$projects/")+name;let state;try{state=readSharedState(project);}catch{}return {project,core:redact(fs.readFileSync(path.join(project,'核心.md'),'utf8')),groups:groups.filter(g=>g.project===name).map(g=>({key:g.key,responsibility:g.description,branches:g.branches})),currentBranches:state?.branches?.map(b=>({id:b.id,name:b.name,goal:b.fields?.['本轮目标']}))||[]};});}
async function route(row,{semantic=true}={}){
 const binding=json(path.join(BINDINGS,row.id+'.json'),null),bound=current(binding),l=layout(),messages=await actualMessages(row),key=digest({algorithmVersion:2,messages,bound});
 inFlightKeys.set(row.id,key);
 const state=json(STATE,{schemaVersion:1,decisions:{}});const old=state.decisions[row.id];if(old?.inputKey===key)return {threadId:row.id,status:old.status==='failed'?'same-input-failure-preserved':'unchanged',decision:old};
 if(!messages.length&&!bound)return {threadId:row.id,status:'awaiting-original-text'};
 const direct=bound?.branchId?l.groups.find(g=>g.project===path.basename(bound.project)&&g.branches.includes(bound.branchId)):null;
 const known=l.groups.find(g=>g.key===l.assignments.find(a=>a.id===row.id)?.group);
 let target,source,receipt;
 if(direct){source='current-binding-and-shared-goal';target={project:bound.project,groupKey:direct.key,branchId:bound.branchId,reason:'已有明确绑定、当前有效共享目标与职责映射'};}
 else if(known&&(!bound||norm(bound.project)===norm(_publicPath("$projects/")+known.project))){source='previous-source-reviewed-assignment';target={project:bound?.project||_publicPath("$projects/")+known.project,groupKey:known.key,branchId:bound?.branchId||null,reason:'已沿真实原话与目标核过的既有职责；保留当前绑定'};}
 else{
  if(!semantic)return {threadId:row.id,status:'semantic-required'};
  const packet={knownCurrentTask:bound,actualUserMessages:messages,projects:sources(l.groups),boundary:'Titles and recency are not classification evidence. All available original visible user messages included; tool/system/developer text omitted.'};
  const prompt='只做聊天语义归属，不执行任务、不调用工具。结合当前项目核心、全体职责、当前有效任务与全部实际用户原话，判断本聊天主要服务哪个已有项目和职责。引用或例子不能覆盖完整任务。已有明确绑定优先，不改用户目标，不为归类创造新项目或分支。与已有项目无关/信息不足则project和groupKey为null。只有原话与已有明确分支吻合才填该真实branchId，否则null。返回纯JSON {"project":完整现有路径或null,"groupKey":现有key或null,"branchId":真实现有ID或null,"reason":具体任务和职责关系}。材料：'+JSON.stringify(packet);
  if(Buffer.byteLength(prompt)>900000)throw Error('Original cumulative context exceeds adapter input; needs source-aware splitting, not silent truncation');
  const run=await execute({prompt,mode:'generate',artifactName:'classification.json',timeoutMs:120000},{attemptDir:path.join(_publicDataPath("本地统一/对话记录/original-manager/semantic"),row.id,key.slice(0,12))},{noLastCall:true});receipt=run.receiptFile;
  if(!run.success)throw Error('Semantic provider failed: '+run.status+'; '+receipt);
  target=JSON.parse(fs.readFileSync(run.artifacts[0],'utf8').trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));source='original-user-text-gemini';
 }
 // Semantic grouping cannot manufacture an execution branch for an old chat.
 target.branchId=bound?.branchId||null;
 const group=l.groups.find(g=>g.key===target.groupKey);
 if(target.project&&(!group||norm(target.project)!==norm(_publicPath("$projects/")+group.project)))throw Error('Semantic target outside existing projects/responsibilities');
 if(bound&&target.project&&norm(bound.project)!==norm(target.project))throw Error('Existing explicit project binding conflict; no overwrite');
 if(target.branchId){const selected=selectSharedBranch(readSharedState(target.project),{branchId:target.branchId}).selected;if(!selected||selected.id!==target.branchId)throw Error('Unknown branch rejected');}
 let bindingCreated=false;
 const latestBinding=json(path.join(BINDINGS,row.id+'.json'),null);if(JSON.stringify(latestBinding)!==JSON.stringify(binding))throw Error('Binding changed during semantic classification; preserve newer binding');
 if(target.project&&!latestBinding){const ledger=path.join(row.cwd.replace(/^\\\\\?\\/,''),'主线',row.id+'.md');const args=[_publicPath("$codex/context/project-context.mjs"),'bind','--host','codex','--session',row.id,'--cwd',row.cwd,'--project',target.project,'--ledger',ledger];if(target.branchId)args.push('--branch',target.branchId);const result=spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true});if(result.status!==0)throw Error('Same-source bind failed: '+redact(result.stderr||result.stdout));bindingCreated=true;const bindingFile=path.join(BINDINGS,row.id+'.json');atomic(path.join(HERE,'binding-recovery',row.id+'.json'),{threadId:row.id,file:bindingFile,prior:'absent',createdValue:json(bindingFile),at:new Date().toISOString()});}
 const decision={threadId:row.id,inputKey:key,status:target.project?'classified':'unassigned',project:target.project||null,groupKey:group?.key||null,sectionId:group?.sectionId||null,branchId:target.branchId||null,reason:target.reason,source,actualUserMessageCount:messages.length,originalTranscript:row.rollout_path,semanticReceipt:receipt||null,bindingCreated,at:new Date().toISOString(),nativeMoveApplied:false,nativeMoveReason:'Native custom sections remove membership from Tasks/Recents; preserve current native recent location until cross-group Recents can coexist.'};
 if(old?.bindingCreated)decision.bindingCreated=true;
 await saveDecision(row.id,decision);return {threadId:row.id,status:decision.status,bindingCreated,groupKey:decision.groupKey,source,nativeMoveApplied:false};
}
export async function reconcile(id,opts={}){const row=nativeRows().find(r=>r.id===id);if(!row)return {threadId:id,status:'native-thread-no-longer-active'};const lock=path.join(HERE,id+'.lock');let fd;try{fd=fs.openSync(lock,'wx');}catch(e){if(e.code==='EEXIST')return {threadId:id,status:'already-processing'};throw e;}try{return await route(row,opts);}catch(e){const state=json(STATE,{decisions:{}});await saveDecision(id,{...state.decisions[id],inputKey:inFlightKeys.get(id),status:'failed',error:redact(e.message),at:new Date().toISOString(),nativeMoveApplied:false});return {threadId:id,status:'failed',error:redact(e.message)};}finally{inFlightKeys.delete(id);fs.closeSync(fd);fs.unlinkSync(lock);}}
async function watch(){return {status:'disabled-by-user',active:false};}
const cmd=process.argv[2]||'status';if(cmd==='watch')console.log(JSON.stringify({status:'disabled-by-user',active:false,reason:'Continuous listening withdrawn; no polling or waiting'}));else if(cmd==='reconcile')console.log(JSON.stringify(await reconcile(process.argv[3],{semantic:!process.argv.includes('--no-semantic')})));else if(cmd==='native-proof'){const c=new AppClient();try{await c.initialize();const proof=await c.call('list_threads',{limit:50});atomic(_publicDataPath("本地统一/对话记录/original-manager/native-readback.json"),proof);const list=jsonContent(proof);console.log(JSON.stringify({ok:true,schemaVersion:list.schemaVersion,pinned:list.pinnedThreads.length,groups:list.sections?.length,preferences:list.sidebarPreferences}));}finally{c.close();}}else if(cmd==='status'){const state=json(STATE,{decisions:{}});console.log(JSON.stringify({state:STATE,heartbeat:json(_publicDataPath("本地统一/对话记录/original-manager/heartbeat.json"),null),counts:Object.fromEntries([...new Set(Object.values(state.decisions).map(d=>d.status))].map(k=>[k,Object.values(state.decisions).filter(d=>d.status===k).length])),nativeMoves:0,boundary:state.boundary}));}else throw Error('Unknown command');

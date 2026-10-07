import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const {readProjectFrame} = await import(_publicURL("$codex/context/project-context.mjs"));
const {prepareAgentMemory} = await import(_publicURL("$codex/hooks/agent-memory.mjs"));
import {buildTaskHandoff,writeHandoff} from './handoff-files.mjs';

// Prepare local navigation even when native dispatch skips
// PreToolUse. This remains a pure parameter generator, with no outbound call.
function prepareWindowArgs(method,args) {
 return prepareAgentMemory({hook_event_name:'PreToolUse',tool_name:method,tool_input:args})?.hookSpecificOutput.updatedInput||args;
}

const listFields=['conditions','necessary_files','criteria','file_ownership','dependencies'];
const fields=['id','title','project_ref','ledger_ref','branch_ref','authorization_ref','user_source','user_request','goal',...listFields,'core_relation','stage','report_to','state','lifecycle','version','revision','next_step','artifact','evidence','thread_id','host_id','parent_task_id','execution_kind'];
function decode(row) {
 for(const key of listFields) row[key]=JSON.parse(row[key]||'[]');
 if(row.lifecycle&&row.lifecycle!=='active'){row.execution_state=row.state;row.state=row.lifecycle;}
 return row;
}
// Read only this linked native window and its relevant task/ancestor evidence.
// No migration, acknowledgement write, global feed, token access or outbound call.
export function readWindowContext({thread_id,host_id,databasePath}={}) {
 const tasks=[];
 if(typeof thread_id!=='string'||!thread_id.trim()) return {available:false,reason:'missing_thread_id',tasks};
 const database=databasePath||process.env.TASK_BRIDGE_DB||_publicDataPath('任务协作/tasks.sqlite');
 if(!existsSync(database)) return {available:false,reason:'database_not_found',tasks};
 let db;
 try {
  db=new DatabaseSync(database,{readOnly:true,timeout:5000});
  const columns=new Set(db.prepare('PRAGMA table_info(tasks)').all().map(x=>x.name));
  if(!columns.has('thread_id')) return {available:false,reason:'legacy_schema_without_window_links',tasks};
  const selection=fields.filter(x=>columns.has(x)).join(',');
  const rows=db.prepare(`SELECT ${selection} FROM tasks WHERE thread_id=? AND execution_kind='window'${host_id?' AND host_id=?':''} ORDER BY created_at,id`).all(...(host_id?[thread_id,host_id]:[thread_id]));
  const hasObservations=!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations'").get();
  for(const raw of rows) {
   const row=decode(raw),ancestors=[],seen=new Set([row.id]);let current=row;
   while(current.parent_task_id) {
    const parent=db.prepare(`SELECT ${selection} FROM tasks WHERE id=?`).get(current.parent_task_id);
    if(!parent||seen.has(parent.id)) throw Error('missing or cyclic ancestor task');
    seen.add(parent.id);ancestors.unshift(decode(parent));current=parent;
   }
   const related=db.prepare(`WITH RECURSIVE related(id) AS (SELECT id FROM tasks WHERE id=? UNION SELECT t.id FROM tasks t JOIN related r ON t.parent_task_id=r.id WHERE t.execution_kind='subagent') SELECT id FROM related`).all(row.id).map(x=>x.id);
   const ids=[...new Set([...ancestors.map(x=>x.id),...related])];
   row.ancestors=ancestors;
   row.project_context=readProjectFrame(row.project_ref);
   row.observations=hasObservations?db.prepare(`SELECT * FROM observations WHERE task_id IN (${ids.map(()=>'?').join(',')}) ORDER BY id`).all(...ids).map(x=>({...x,evidence_refs:JSON.parse(x.evidence_refs),uncertainties:JSON.parse(x.uncertainties)})):[];
   tasks.push(row);
  }
  return {available:true,thread_id,host_id:host_id||null,tasks};
 }catch(e){return {available:false,reason:'read_failed',error:e.message,tasks:[]};}
 finally{db?.close();}
}
// Pure parameter generator; native messages keep their native steering/queue behavior.
export function windowDispatch(task,a={}) {
 const mode=a.mode||'fresh';
 if(!['fresh','steer','designated'].includes(mode)) throw Error('mode must be fresh, steer or designated');
 if(mode==='fresh'&&((task.owner&&task.lease_until&&Date.parse(task.lease_until)>Date.now())||(task.active_descendant_executors||[]).length)) throw Error('active executor lease; save progress and hand off affected work before fresh execution dispatch');
 if(mode==='steer'&&(!['claimed','blocked','failed'].includes(task.state)||!task.owner)) throw Error('steer requires an in-flight task; use fresh for a new assignment or designated for a human-specified chat');
 if(mode!=='fresh'&&!task.thread_id) throw Error('explicit existing-window dispatch requires a linked thread_id');
 if(mode!=='fresh'&&(typeof a.send_authorization_ref!=='string'||!a.send_authorization_ref.trim())) throw Error('send_authorization_ref must cite actual human authorization to message this task');
 if(task.execution_kind!=='window') throw Error('internal subagents execute inside their parent window; do not create another user chat');
 if(!task.user_source||!task.user_request||!task.goal||!task.branch_ref) throw Error('window packet requires actual user_request, user_source, goal and branch_ref; revise legacy records first');
 let fileHandoff,currentHandoff;
 try {
  currentHandoff=buildTaskHandoff(task);
  const historyRefs=[...(currentHandoff.metadata.history_refs||[]),{kind:'user_original',source:task.user_source},{kind:'task_original',task_id:task.id,source:`task-bridge task ${task.id}`,
    reader:{entry:path.join(currentHandoff.project,'任务协作/task-bridge.mjs'),action:'get',input:{id:task.id},environment:{TASK_BRIDGE_DB:process.env.TASK_BRIDGE_DB||path.join(currentHandoff.project,'任务协作/tasks.sqlite')}}},
    ...(task.observations||[]).map(o=>({kind:'observation_original',id:o.id,task_id:o.task_id,source:o.source_ref||o.user_source_ref||o.source||`task ${o.task_id||task.id} observation ${o.id}`,evidence_refs:o.evidence_refs||[]}))];
  const metadata={...currentHandoff.metadata,...(a.handoff_metadata||{}),execution:currentHandoff.execution,user:{sources:currentHandoff.metadata.user?.sources||[]},supplements:[],history_refs:historyRefs};
  fileHandoff=writeHandoff({project:currentHandoff.project,branchId:currentHandoff.branch_id,metadata},
    {directory:a.handoff_directory||path.join(currentHandoff.project,'任务协作/window-handoffs')});
 }catch(error){fileHandoff={available:false,error:error.message,note:'文件交接暂未生成，下面保留已有任务快照；不猜其他分支，不重置已授权任务。'};}
 const packet={task_id:task.id,project_ref:task.project_ref,branch_ref:task.branch_ref,ledger_ref:task.ledger_ref,
  execution:{mode,history_inheritance:'none',previous_window:task.thread_id?{thread_id:task.thread_id,host_id:task.host_id}:null,notice:'任务与成果沿文件继续；旧窗口只是可追出处。有效租约与外部运行中的动作须先交接，不重复启动。'},
  file_handoff:fileHandoff,
  core:{relation:task.core_relation||'',project:currentHandoff?{project:currentHandoff.project,core_source:currentHandoff.core.source,
    branch_source:currentHandoff.task.source,relationship_source:currentHandoff.project_frame.relationship_source}:{project:task.project_ref,core_source:path.join(task.project_ref,'核心.md'),branch_source:path.join(task.project_ref,'共享状态.md'),branch_id:task.branch_ref,read_notice:'当前共享任务未读取成功；已有任务字段只作快照，先读对应原件，不从其他任务补条件。'},
    ancestors:(task.ancestors||[]).map(p=>({id:p.id,project_ref:p.project_ref,branch_ref:p.branch_ref,ledger_ref:p.ledger_ref,relation:p.core_relation||''}))},
  user:{source:task.user_source,authorization_ref:task.authorization_ref,history_reader:{action:'get',task_id:task.id}},
  outcome:{goal:currentHandoff?.task.goal||task.goal,criteria:currentHandoff?.task.criteria?[currentHandoff.task.criteria]:task.criteria||[],conditions:currentHandoff?.task.conditions?[currentHandoff.task.conditions]:task.conditions},
  current:{state:task.state,stage:task.stage||'',version:task.version,revision:task.revision,next_step:task.next_step,artifact:task.artifact,evidence:task.evidence},
  necessary_files:task.necessary_files,file_ownership:task.file_ownership||[],dependencies:task.dependencies||[],report_to:task.report_to||'',observation_refs:(task.observations||[]).map(o=>({id:o.id,task_id:o.task_id,source:o.source_ref||o.source||'',evidence_refs:o.evidence_refs||[]}))};
 const prompt=`接手任务：${task.title} [${task.id}]。先结合项目核心、当前完整任务、有效条件及实际成果理解本次工作，自主研究和选择实现办法，完成本次授权范围内的成果。主控建议沿交接材料读取，先理解建议要解决什么问题，再自主研究采用或调整；建议不自动成为用户要求。\n当前任务原件：${packet.core.project.branch_source}；分支：${task.branch_ref}。\n项目核心：${packet.core.project.core_source}。\n${fileHandoff.json?`文件交接：${fileHandoff.markdown}；接续用 system.mjs handoff read --file "${fileHandoff.json}" --live 读取最新原件。`:`交接文件读取失败：${fileHandoff.error}；以下已有任务仅为快照，先核对应原件。\n${JSON.stringify(packet,null,2)}`}\n本次分工成果：${task.goal}。\n本次工作与改动点：${a.change_point||task.next_step}。\n文件归属和已有成果沿交接文件读取，保护其他人的编辑；交实际成果、验证结果和未达项。回报对象：${task.report_to||'当前负责人'}。执行者可替换，能力沿文件恢复；外部在途工作先核状态。`;
 if(mode!=='fresh') {
  if(typeof a.send_authorization_ref!=='string'||!a.send_authorization_ref.trim()) throw Error('send_authorization_ref must cite actual human authorization to message this task');
  return {method:'send_message_to_thread',args:prepareWindowArgs('send_message_to_thread',{threadId:task.thread_id,hostId:task.host_id,prompt}),task_packet:packet,mode,task_id:task.id,version:task.version,revision:task.revision,authorization_ref:a.send_authorization_ref,generated_only:true};
 }
 const target=a.target||{type:'projectless'};
 if(target.type==='project') {
  if(typeof target.projectId!=='string'||!target.projectId.trim()||target.environment?.type!=='local') throw Error('project target requires projectId from list_projects and environment type local');
 }else if(target.type!=='projectless') throw Error('target must be projectless or project with local environment');
 const safeTarget=target.type==='project'?{type:'project',projectId:target.projectId,environment:{type:'local'}}:{type:'projectless'};
 return {method:'create_thread',args:prepareWindowArgs('create_thread',{target:safeTarget,title:task.title,prompt}),task_packet:packet,mode,task_id:task.id,version:task.version,revision:task.revision,authorization_ref:task.authorization_ref,
  link_after_creation:{action:'link-window',id:task.id,expected_version:task.version,...(task.thread_id?{replace:true,expected_thread_id:task.thread_id,expected_host_id:task.host_id,handoff_ref:fileHandoff.json,replacement_reason:'new executor continues the same task from project files'}:{}),notice:'只填写真实create_thread完成结果thread_id/host_id；clientThreadId尚未就绪时等待实际完成。有效owner先保存进度并update handoff_to，不能抢在途写入。'},generated_only:true};
}

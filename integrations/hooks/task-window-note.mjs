// Default context carries the effective shared task and historical pointers.
// Original requests/observations remain readable in the existing task bridge.
import path from 'node:path';
import {readWindowContext} from '../../modules/system/任务协作/task-window.mjs';
import {buildTaskHandoff} from '../../modules/system/任务协作/handoff-files.mjs';

export function taskWindowNotes(input = {}, options = {}) {
 const empty={window:'',cooperation:'',project:'',target:null};
 if (!input.session_id || input.agent_id || input.hook_event_name === 'SubagentStart') return empty;
 const result=readWindowContext({thread_id:input.session_id,host_id:options.windowHost,databasePath:options.windowDatabasePath});
 if(!result.available||!result.tasks?.length)return empty;
 if(result.tasks.length>1)return {window:'本聊天关联多个任务：'+result.tasks.map(t=>t.id).join('、')+'。按明确ID读取当前任务，不从首项猜职责。',cooperation:'',project:''};
 const task=result.tasks[0];let current;
 try{current=buildTaskHandoff(task);}catch{}
 const same=options.currentProject&&path.resolve(options.currentProject)===path.resolve(task.project_ref)&&options.currentBranch===task.branch_ref;
 const conflict=Boolean(options.currentProject&&path.resolve(options.currentProject).toLowerCase()!==path.resolve(task.project_ref).toLowerCase()
  || options.currentBranch&&options.currentBranch!==task.branch_ref);
 const lines=['本窗口任务原件导航：历史要求与观察按需读原记录，当前有效目标及条件以对应共享分支为准。',
  `任务${task.id}；项目${task.project_ref}；分支${task.branch_ref}；主线${task.ledger_ref}`,
  `用户原件出处：${task.user_source}；授权引用：${task.authorization_ref||'沿原任务记录'}`,
  `历史读取：task-bridge.mjs get --input含id=${task.id}；观察读取：observations --input含task_id。`];
 if(conflict)lines.push('窗口登记与明确当前路由不同；保留当前明确项目/分支，未把窗口目标或条件合入。沿原件核对是否已明确切换，不自动覆盖当前职责。');
 else if(!same){
  if(current){for(const [label,key]of [['当前完整目标','goal'],['完成标准','criteria'],['有效条件','conditions']])if(current.task[key])lines.push(label+'：'+current.task[key]);}
  else lines.push('当前共享任务暂未读取成功；请显式读取对应分支，不把旧任务桥快照补成当前目标或条件。');
 }
 for(const [label,value]of [['文件归属',task.file_ownership?.join('\n')],['必要原件',task.necessary_files?.join('\n')],['依赖',task.dependencies?.join('\n')],['回报方式',task.report_to]])if(value)lines.push(label+'：'+value);
 const observations=task.observations||[];
 const cooperation=observations.length?['协作观察原件导航：普通观察供负责人分析，不自动改用户目标；默认不重播历次正文。',...observations.map(o=>`任务${o.task_id}；观察${o.id}；出处${o.source_ref||o.user_source_ref||o.source||'原任务桥记录'}；证据${(o.evidence_refs||[]).join('；')}`)].join('\n'):'';
 const project=['窗口项目完整确认核心：'+(current?.core.source||path.join(task.project_ref,'核心.md'))+'；首次及恢复时读全文，包括确认补充。',
  '当前分支原件：'+(current?.task.source||path.join(task.project_ref,'共享状态.md'))+'；分支'+task.branch_ref,
  '全项目关系与成果按任务依赖沿结构导航展开；不授权接手其他分支。'].join('\n');
 return {window:lines.join('\n'),cooperation,project,
  target:current ? {project:task.project_ref,branchId:task.branch_ref,ledger:current.task.ledger||undefined,taskId:task.id} : null};
}
export const taskWindowNote=(input,options)=>taskWindowNotes(input,options).window;

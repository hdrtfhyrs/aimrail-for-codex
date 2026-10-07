import {integrationPath} from '../paths.mjs';
// 只按当前消费者的任务送少量资源索引；缓存不保存事实/授权。
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {candidateResources,formatResourceCandidates,redactResourceOutput} from '../context/resources.mjs';
import {resolveTaskRetrievalContext,retrievalPrompt} from './task-retrieval-context.mjs';
const clean=value=>String(value||'').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,180);
const home=integrationPath("integrations/context/resource-seen");
export function readResourceNote(input,saved={},options={}){
 if(options.disableResources)return '';const event=input.hook_event_name||'UserPromptSubmit';if(!['SessionStart','UserPromptSubmit','SubagentStart'].includes(event))return '';
 if(event==='SubagentStart'&&(!input.agent_id||!String(input.prompt||'').trim()))return '';
 // Rule replacement is not a new task. Preserve the last concrete task cache.
 if(/^#\s*AGENTS\.md instructions\b/i.test(retrievalPrompt(input)))return '';
 const session=clean(input.session_id);if(!session)return '';
 const file=path.join(options.resourceSeenDir||home,`${clean(options.host||input.host||'codex')}-${session}-${clean(input.agent_id||'root')}.json`);
 let state={};try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}state.seen||={};state.contextGeneration||=0;if(event==='SessionStart'){state.seen={};state.contextGeneration++;}
 // This helper reads only an explicitly selected shared goal/conditions and
 // retains the last concrete task for continuation/condition additions. Child
 // queries never use the parent's saved scope. Cache remains delivery state.
 const context=resolveTaskRetrievalContext(input,saved,state,options);
 if(state.queryScope!==context.nextScope)state.seen={};
 const query=resourceRetrievalQuery([context.query,
  !context.nextQuery&&(context.continuation||context.contextAddition) ? context.taskContext : ''].filter(Boolean).join('\n'));
 state.query=redactResourceOutput(String(context.nextQuery||'').slice(0,1600));
 state.queryScope=context.nextScope;state.queryOrigin=context.nextOrigin||context.origin;
 state.queryFrame=context.nextQueryFrame;state.retrievalConstraints=context.nextRetrievalConstraints;
 let text='';try{
  const found=candidateResources(query,{...(options.resourceOptions||{}),limit:2}),selection=JSON.stringify(found.items.map(r=>r.id));
  if(state.selection!==selection)state.seen={};state.selection=selection;
  const items=found.items.filter(r=>state.seen[r.id]!==JSON.stringify(r));text=formatResourceCandidates({...found,items},{maxChars:600});
  for(const r of items)if(text.includes('"id":'+JSON.stringify(r.id)))state.seen[r.id]=JSON.stringify(r);
 }catch{text='任务资料检索暂不可读；保留原件，按资源入口续查。';}
 try{fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(redactResourceOutput(state)));fs.renameSync(temp,file);}catch{}
 return text;
}

// Explicitly excluded clauses do not activate their product tag. This is a
// bounded lexical guard, not a judgement of intent/authorization. Keep the
// rest of the current assignment for the model to interpret.
export function resourceRetrievalQuery(value){
 return String(value||'').split(/(?<=[，,、。!！?？;；\n])|\.(?=\s|$)/).filter(clause=>{
  const text=clause.trim();
  return !/^(?:不要|别|不用|不再|无需|排除|先别|先不用|先不要)/.test(text)
   && !/\b(?:do not|don['’]t|exclude|not using)\b/i.test(text)
   && !/(?:不用了|不再用了|不使用了|不需要了)/.test(text)
   // Business constraints alone must not activate an unrelated platform.
   // Positive investigation clauses ("排查BOSS，不投递") retain the subject.
   && !/^[\w\u3400-\u9fff/\s]+(?:不(?:发帖|投递|联系|发送|发消息|交易|调用|使用)|只读不发帖)[^。]*[，,、。;；!?！？\n]?$/.test(text)
   && !/^(?:论坛只读|论坛只读取|账号凭据不输出|凭据不输出|无职位投递)[，,、。;；!?！？\n]?$/.test(text);
 }).join(' ');
}

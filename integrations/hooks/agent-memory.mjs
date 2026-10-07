// Destination-local navigation, not automatic keyword-selected experience.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {localNavigation} from '../context/local-navigation.mjs';
const digest=text=>createHash('sha256').update(text).digest('hex').slice(0,20);
const START=/\r?\n\r?\n<(?:task_memory_candidates|local_context_navigation) origin="(?:codex-agent-memory-v1|codex-local-navigation-v1)" (?:task|task_hash)="[a-f0-9]{20}">\r?\n/g;
const PACKET=/^\r?\n\r?\n<(task_memory_candidates|local_context_navigation) origin="(?:codex-agent-memory-v1|codex-local-navigation-v1)" (?:task|task_hash)="([a-f0-9]{20})">\r?\n([\s\S]*)\r?\n<\/\1>$/;
function stripOwnedTail(original){
 let task=original,previous=[];
 for(;;){let owned;
  for(const start of [...task.matchAll(START)].reverse()){
   const packet=task.slice(start.index),m=packet.match(PACKET);if(!m)continue;
   const size=m[3].match(/^packet_body_chars=(\d+)\n/);if(!size||m[3].slice(size[0].length).length!==Number(size[1]))continue;
   const prefix=task.slice(0,start.index);if(m[2]===digest(prefix)){owned={packet,prefix};break;}
  }
  if(!owned)break;previous.unshift(owned.packet);task=owned.prefix;
 }return {task,previous};
}
export function prepareAgentMemory(input,options={}){
 const tool=String(input.tool_name||''),native=/^(?:(?:mcp__codex_app(?:__|\.)|codex_app[._]))?(?:create_thread|send_message_to_thread)$/i.test(tool);
 const fresh=/^(?:(?:mcp__codex_app(?:__|\.)|codex_app[._]))?create_thread$/i.test(tool)||/^(?:Agent|spawn_agent|collaboration[._]spawn_agent)$/i.test(tool);
 if(input.hook_event_name!=='PreToolUse'||!(native||/^(?:Agent|spawn_agent|followup_task|send_input|send_message|collaboration[._](?:spawn_agent|followup_task|send_input|send_message))$/i.test(tool)))return null;
 let args=input.tool_input;if(typeof args==='string'){try{args=JSON.parse(args);}catch{return null;}}
 if(!args||typeof args!=='object'||Array.isArray(args))return null;
 const field=typeof args.message==='string'?'message':typeof args.prompt==='string'?'prompt':null;if(!field||!args[field].trim())return null;
 const {task,previous}=stripOwnedTail(args[field]);
 // Existing tasks already own their navigation and current task material.
 // Corrections/messages stay intact; remove only our authenticated old tail.
 if(!fresh || (tool==='Agent'&&typeof args.resume==='string'&&args.resume))return previous.length?{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{...args,[field]:task}}}:null;
 let project;
 if(native&&task.startsWith('独立任务窗口。')){try{project=JSON.parse(task.slice(task.indexOf('\n{')+1)).project_ref;}catch{}}
 const navigation=localNavigation({includeCounts:false,...(typeof project==='string'&&path.isAbsolute(project)?{project}:{})});
 const consumer=digest(JSON.stringify({field,target:args.target,thread:args.threadId,task_name:args.task_name,agent:args.agent_id||args.id}));
 // 派工正文检索到的相关经验/错误/成果（recall-note.agentTaskRecall）随导航一起附上。
 const recallText=typeof options.agentRecall==='string'&&options.agentRecall?'\n\n'+options.agentRecall:'';
 const body='prefetch_policy='+(recallText?'navigation-plus-recall':'navigation-only')+'\ntask_source=consumer-message\ntask_consumer='+consumer+'\nnavigation_key='+digest(navigation)+'\n'+navigation+recallText;
 const packet='\n\n<local_context_navigation origin="codex-local-navigation-v1" task="'+digest(task)+'">\npacket_body_chars='+body.length+'\n'+body+'\n</local_context_navigation>';
 if(previous.length===1&&previous[0]===packet)return null;
 const updatedInput={...args,[field]:task+packet};
 return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput}};
}
// A direct preparation entry is needed on native dispatch paths that do not
// emit the local PreToolUse callback. The original tool argument schema stays
// intact; the caller forwards this prepared message/prompt to the normal tool.
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [command,...argv]=process.argv.slice(2);
    if(command!=='prepare') throw new Error('Usage: node agent-memory.mjs prepare --input ABS_JSON --output ABS_JSON [--tool TOOL_NAME]');
    const opts={};
    for(let i=0;i<argv.length;i++) {
      if(!['--input','--output','--tool'].includes(argv[i]) || !argv[i+1] || argv[i+1].startsWith('--')) throw new Error('Invalid prepare arguments');
      if(opts[argv[i]]) throw new Error('Duplicate prepare argument');
      opts[argv[i]]=argv[++i];
    }
    if(!opts['--input'] || !opts['--output'] || !path.isAbsolute(opts['--input']) || !path.isAbsolute(opts['--output'])) throw new Error('input/output must be absolute JSON paths');
    if(path.resolve(opts['--input']).toLowerCase()===path.resolve(opts['--output']).toLowerCase()) throw new Error('output must differ from the original input file');
    const args=JSON.parse(fs.readFileSync(opts['--input'],'utf8').replace(/^\uFEFF/,''));
    if(!args || typeof args!=='object' || Array.isArray(args) || !(typeof args.message==='string'||typeof args.prompt==='string')) throw new Error('input must be the original agent arguments with message/prompt');
    const tool=opts['--tool']||'spawn_agent';
    const prepared=prepareAgentMemory({hook_event_name:'PreToolUse',tool_name:tool,tool_input:args});
    const updated=prepared?.hookSpecificOutput.updatedInput||args;
    fs.writeFileSync(opts['--output'],JSON.stringify(updated,null,2));
    process.stdout.write(JSON.stringify({output:opts['--output'],prepared:Boolean(prepared),field:typeof updated.message==='string'?'message':'prompt',args:updated}));
  } catch(error){process.stderr.write(error.message+'\n');process.exitCode=2;}
}

import {integrationPath} from '../paths.mjs';
// Known revoked operations only. No natural-language intent classifier and no
// approval ceremony. Hook denials use the host's supported JSON contract.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const DEFAULT_POLICY=integrationPath("integrations/context/action-boundaries.json");
const normalize=value=>String(value||'').replaceAll('\\','/').replace(/\/{2,}/g,'/').replace(/\/$/,'').toLowerCase();
const runtime=value=>/^(?:node|node\.exe)$/.test(value.toLowerCase())||/\/node(?:\.exe)?$/i.test(normalize(value));

// Small literal-command lexer. Quoted prose is one token, not an invocation.
// Unknown/evaluated shell expressions are deliberately not claimed covered.
export function commandTokens(text){
 const tokens=[];let value='',quote=null;
 const push=()=>{if(value){tokens.push(value);value='';}};
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(quote){
   if(c===quote){if(text[i+1]===quote){value+=c;i++;}else quote=null;}
   else if(c==='`'&&i+1<text.length)value+=text[++i];
   else value+=c;
   continue;
  }
  if(c==='"'||c==="'"){quote=c;continue;}
  if(c==='`'&&i+1<text.length){value+=text[++i];continue;}
  if(c==='\n'||c===';'||c==='|'||c==='&'||c==='('){push();tokens.push(c);continue;}
  if(/\s/.test(c)){push();continue;}
  value+=c;
 }
 push();return tokens;
}
export function scriptCalls(command,cwd,depth=0){
 if(depth>2)return [];
 const tokens=commandTokens(String(command));const calls=[];
 for(let i=0;i<tokens.length;i++){
  const head=i===0||['\n',';','|','&','('].includes(tokens[i-1]);
  if(head&&runtime(tokens[i])&&tokens[i+1]){
   const script=tokens[i+1];
   if(!script.startsWith('-'))calls.push({script:normalize(path.isAbsolute(script)?script:path.resolve(cwd||'.',script)),verb:tokens[i+2]||''});
  }
  // A shell's explicitly supplied literal program is executable, unlike echo
  // or a comment containing an example command.
  if(head&&/^(?:powershell|pwsh)(?:\.exe)?$/i.test(path.basename(normalize(tokens[i])))){
   for(let j=i+1;j<tokens.length;j++)if(/^-command$/i.test(tokens[j])&&tokens[j+1]){
    calls.push(...scriptCalls(tokens[j+1],cwd,depth+1));break;
   }
  }
 }
 return calls;
}
function argumentsOf(input){
 const value=input.tool_input;
 if(value&&typeof value==='object')return value;
 if(typeof value==='string'){try{return JSON.parse(value);}catch{return {command:value};}}
 return {};
}
function sameUrl(actual,expected){
 try{
  const a=new URL(actual),b=new URL(expected);
  const local=new Set(['127.0.0.1','localhost','[::1]']);
  return a.protocol===b.protocol&&(a.hostname===b.hostname||local.has(a.hostname)&&local.has(b.hostname))&&a.port===b.port&&a.pathname===b.pathname;
 }catch{return false;}
}
function inScope(rule,input){
 if(!rule.sessions?.length)return true;
 // A same-session child can own a different result. Do not infer its task from
 // the root session: only explicitly included agent identities inherit scope.
 if(input.agent_id&&!(rule.agents||[]).includes(input.agent_id))return false;
 return rule.sessions.includes(input.session_id);
}
export function decideAction(input,policy){
 if(input.hook_event_name!=='PreToolUse'||policy?.schema!==1)return null;
 const args=argumentsOf(input),tool=String(input.tool_name||'');
 // Also accept the PowerShell tool identity with tool_input.command. The direct
 // exec_command cmd field remains supported; only exact shell tool identities
 // are recognized, never a name merely containing "PowerShell".
 const shell=/^(?:Bash|PowerShell|exec_command|functions[._]exec_command|exec)$/i.test(tool);
 const command=args.command??args.cmd;
 for(const rule of policy.rules||[]){
  if(rule.enabled===false||!inScope(rule,input))continue;
  if(rule.activeMarker&&!fs.existsSync(rule.activeMarker))continue;
  if(rule.kind==='script-start'&&shell&&typeof command==='string'){
   for(const call of scriptCalls(command,input.cwd)){
    const target=(rule.scripts||[]).find(s=>normalize(s.path)===call.script);
    if(!target)continue;
    const verb=call.verb.toLowerCase();
    const matches=target.verbs?target.verbs.includes(verb):!(target.allowVerbs||['status','stop','help','--help']).includes(verb);
    if(matches)return {id:rule.id,reason:rule.reason,source:rule.source};
   }
  }
  if(rule.kind==='browser-resource'){
   if(/(?:^|[._])open_in_codex$/i.test(tool)&&args.target?.type==='browser'&&(rule.urls||[]).some(u=>sameUrl(args.target.url,u)))
    return {id:rule.id,reason:rule.reason,source:rule.source};
   if(/mcp__cua_repl[._]+js$/i.test(tool)&&typeof args.code==='string'){
    const opens=/(?:createBrowserTab|getTab)\s*\(/.test(args.code);
    if(opens&&(rule.urls||[]).some(u=>args.code.includes(u)))return {id:rule.id,reason:rule.reason,source:rule.source};
   }
  }
 }
 return null;
}
export function actionBoundary(input,{policyFile=DEFAULT_POLICY,policy}={}){
 if(input.hook_event_name!=='PreToolUse')return null;
 if(!policy){
  try{policy=JSON.parse(fs.readFileSync(policyFile,'utf8').replace(/^\uFEFF/,''));}
  catch(error){return {hookSpecificOutput:{hookEventName:'PreToolUse',additionalContext:`动作控制原件暂不可读：${policyFile}；${error.code||error.message}。本次没有伪称已拦截，继续处理原任务并修复控制入口。`}};}
 }
 if(policy?.schema!==1||!Array.isArray(policy.rules))return {hookSpecificOutput:{hookEventName:'PreToolUse',additionalContext:`动作控制原件格式不支持：${policyFile}；本次未据此声称已拦截，请修复原件。`}};
 const denied=decideAction(input,policy);
 if(!denied)return null;
 return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',
  permissionDecisionReason:`${denied.reason} 依据：${denied.source}；控制项：${denied.id}。继续解决原目标的实际缺口。`}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 let text='';for await(const chunk of process.stdin)text+=chunk;
 try{const input=JSON.parse(text);const output=actionBoundary(input);if(output)process.stdout.write(JSON.stringify(output));}
 catch(error){
  // This runtime's exit-2 denial was observed to fail open. Emit valid deny
  // JSON only for a concrete matched rule; malformed input is a reported fault.
  process.stdout.write(JSON.stringify({systemMessage:`动作控制输入失败：${error.message}；未据此声称阻止调用。`}));
 }
}

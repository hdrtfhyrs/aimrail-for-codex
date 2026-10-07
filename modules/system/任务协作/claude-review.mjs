import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

// Official Claude CLI is the provider; no desktop control or token extraction.
const cliRoot=path.join(os.homedir(),'AppData/Roaming/Claude/claude-code');
function locate(){
  if(process.env.CLAUDE_REVIEW_CLI && fs.existsSync(process.env.CLAUDE_REVIEW_CLI))return process.env.CLAUDE_REVIEW_CLI;
  const versions=fs.existsSync(cliRoot)?fs.readdirSync(cliRoot).filter(v=>/^\d+\.\d+\.\d+$/.test(v)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})):[];
  for(const v of versions)for(const name of fs.readdirSync(path.join(cliRoot,v))){const f=path.join(cliRoot,v,name,'claude.exe');if(fs.existsSync(f))return f;}
  throw Error('Official Claude CLI not found; install/sign in through its documented route.');
}
function call(exe,args,input,cwd){
  const r=spawnSync(exe,args,{input,cwd,encoding:'utf8',windowsHide:true,maxBuffer:5_000_000,timeout:600000});
  if(r.error)throw r.error;return r;
}
async function main(){
  const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i]]=process.argv[i+1];
  if(!args['--request']||!args['--out'])throw Error('Usage: node claude-review.mjs --request ABS_JSON --out ABS_JSON');
  const requestFile=args['--request'],out=args['--out'];if(!path.isAbsolute(requestFile)||!path.isAbsolute(out))throw Error('Absolute paths required');
  const req=JSON.parse(fs.readFileSync(requestFile,'utf8'));for(const k of ['project','branch','authorization_ref','message'])if(typeof req[k]!=='string'||!req[k].trim())throw Error('Missing '+k);
  const cli=locate();const authCall=call(cli,['auth','status'],undefined,req.project);let auth;
  try{auth=JSON.parse(authCall.stdout);}catch{throw Error('Claude auth status did not return JSON');}
  const result={at:new Date().toISOString(),provider:'Claude official CLI',cli,project:req.project,branch:req.branch,request:requestFile,model_review_performed:false};
  if(auth.loggedIn!==true){
    Object.assign(result,{status:'needs_provider_login',auth:{loggedIn:false,authMethod:auth.authMethod},next:'Complete the official Claude CLI auth login on this machine, then rerun this same request; desktop sign-in is a separate observation.'});
  }else{
    // Explicit branch only. The new read-only reviewer never inherits a missing ledger.
    const session=randomUUID();
    const bind=call(process.execPath,[path.join(os.homedir(),'.codex/context/project-context.mjs'),'bind','--host','claude','--session',session,'--project',req.project,'--branch',req.branch],undefined,req.project);
    if(bind.status!==0)throw Error('Explicit Claude branch binding failed: '+bind.stderr);
    const run=call(cli,['-p','--session-id',session,'--output-format','json','--tools','Read,Glob,Grep','--permission-mode','dontAsk','--strict-mcp-config','--mcp-config','{"mcpServers":{}}'],req.message,req.project);
    let payload;try{payload=JSON.parse(run.stdout);}catch{payload={is_error:true,result:'Claude result was not valid JSON'};}
    Object.assign(result,{session,model_review_performed:Boolean(payload.modelUsage && Object.keys(payload.modelUsage).length),status:run.status===0&&payload.is_error!==true?'review_completed':'review_failed',exit_code:run.status,result:payload.result,usage:payload.usage,modelUsage:payload.modelUsage,terminal_reason:payload.terminal_reason});
  }
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,model_review_performed:result.model_review_performed,output:out}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

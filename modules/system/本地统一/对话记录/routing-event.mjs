import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {redact} from './conversations.mjs';

const FILE=fileURLToPath(import.meta.url), DIR=path.dirname(FILE);
const DEFAULT_HOME=_publicPath("$codex");
const DEFAULT_INBOX=path.join(_publicDataPath("本地统一/对话记录/routing-events"),'inbox');
const DEFAULT_ROUTER=path.join(DIR,'auto-routing.mjs');
const DEFAULT_RECOVERY=_publicPath("$data/host-workspaces/2026-10-02/new-chat-11/work/routing-events/recovery");
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const hash=o=>crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function json(file,fallback=null){try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''))}catch(e){if(e.code==='ENOENT')return fallback;throw Error('Unreadable JSON: '+file)}}
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n');fs.renameSync(tmp,file)}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp)}}
function absolute(value,name){if(!path.isAbsolute(value))throw Error(name+' requires an absolute path');return path.resolve(value)}
function timestamp(value){if(value===undefined||value===null||value==='')return null;let ms;if(typeof value==='number')ms=value<1e11?value*1000:value;else if(/^\d+(?:\.\d+)?$/.test(value))ms=Number(value)<1e11?Number(value)*1000:Number(value);else ms=Date.parse(value);return Number.isFinite(ms)&&ms>0?new Date(ms).toISOString():null}
function isInternal(o={}){return !!(o.agent_id||o.agentId||o.agent_path||o.agentPath||o.parent_thread_id||o.parentThreadId||o.parent_id||o.parentId||o.parentSessionId||o.isSubagent||o.isSidechain||o.internalAgent||o.isTest||o.test||o.synthetic||['internal-agent','test','experiment','subagent'].includes(o.kind)||o.hook_event_name==='SubagentStart'||(o.source&&typeof o.source==='object')||(o.thread_source&&typeof o.thread_source==='object')||/subagent|collaboration|^test$|^experiment$/i.test(String(o.source||o.thread_source||'')))}
function within(file,root){const relative=path.relative(root,file);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)}
function sessionHeader(file,home){if(!file||!path.isAbsolute(file))return null;const resolved=path.resolve(file);if(!['sessions','archived_sessions'].some(d=>within(resolved,path.join(home,d))))return null;let fd;try{fd=fs.openSync(resolved,'r');const chunk=Buffer.alloc(1024*1024);const n=fs.readSync(fd,chunk,0,chunk.length,0),text=chunk.subarray(0,n).toString('utf8');const first=text.split(/\r?\n/,1)[0];const row=JSON.parse(first.replace(/^\uFEFF/,''));return row.type==='session_meta'?{...row.payload,evidence:resolved+'#session_meta'}:null}catch{return null}finally{if(fd!==undefined)fs.closeSync(fd)}}
export function normalizeEvent(input,options={}){
 if(!input||typeof input!=='object'||Array.isArray(input))return {skip:'invalid-object'};
 const event=input.event||input.hook_event_name;
 if(!['conversation-updated','UserPromptSubmit','SessionStart'].includes(event))return {skip:'unsupported-event'};
 if(isInternal(input))return {skip:'internal-or-test'};
 if((input.hostId&&input.hostId!=='local')||(input.host_id&&input.host_id!=='local')||(input.platform&&input.platform!=='codex')||(input.host&& !['codex','local'].includes(input.host)))return {skip:'nonlocal-or-noncodex'};
 const id=input.threadId||input.thread_id||input.session_id;
 if(typeof id!=='string'||!UUID.test(id))return {skip:'missing-full-uuid'};
 if([input.threadId,input.thread_id,input.session_id].filter(Boolean).some(v=>String(v).toLowerCase()!==id.toLowerCase()))return {skip:'conflicting-thread-id'};
 const threadId=id.toLowerCase(),home=absolute(options.codexHome||process.env.CODEX_HOME||DEFAULT_HOME,'codex-home');
 const index=path.resolve(home)===path.resolve(DEFAULT_HOME)?json(_publicDataPath("本地统一/对话记录/index.json"),{items:[]}):{items:[]};
 const known=index.items?.find(r=>r.platform==='codex'&&r.nativeId===threadId);
 if(known&&isInternal(known))return {skip:'known-internal-or-test'};
 const header=sessionHeader(input.transcript_path,home);
 if(header&&isInternal(header))return {skip:'transcript-internal-or-test'};
 if(header&&(header.id||header.session_id)?.toLowerCase()!==threadId)return {skip:'transcript-thread-mismatch'};
 const native=event==='conversation-updated'&&input.source==='native-ui'&&input.hostId==='local';
 const rootHeader=header&&['vscode','desktop'].includes(header.source);
 const rootKnown=known&&['vscode','desktop'].includes(known.source)&&!known.agentPath&&!known.parentId;
 if(!native&&!rootHeader&&!rootKnown)return {skip:'root-ui-unverified'};
 const prompt=typeof input.prompt==='string'&&input.prompt.trim()?redact(input.prompt):null;
 if(event==='UserPromptSubmit'&&!prompt)return {skip:'missing-user-prompt'};
 const source=native?'native-ui':'codex-hook';
 const eventAt=timestamp(input.timestamp||input.eventAt||input.event_at),nativeUpdatedAt=timestamp(input.nativeUpdatedAt||input.native_updated_at);
 const turnId=typeof input.turn_id==='string'?input.turn_id:typeof input.turnId==='string'?input.turnId:null;
 const fingerprint=hash({event,threadId,source,turnId,eventAt,nativeUpdatedAt,promptHash:prompt?hash(prompt):null,eventId:input.eventId||input.event_id||null});
 return {schemaVersion:1,threadId,platform:'codex',hostId:'local',event,source,turnId,eventAt,nativeUpdatedAt,prompt,receivedAt:new Date().toISOString(),fingerprint,evidence:native?'native-ui conversation-updated callback':rootHeader?header.evidence:known?.metadataEvidence||known?.path||'existing root UI metadata'};
}

// The owner token also prevents an old owner from releasing a replacement lock.
export async function withFileLock(file,fn,{waitMs=900}={}){
 fs.mkdirSync(path.dirname(file),{recursive:true});const token=crypto.randomUUID(),deadline=Date.now()+waitMs;let fd;
 while(fd===undefined){try{fd=fs.openSync(file,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token,createdAt:new Date().toISOString()}));}catch(e){if(e.code!=='EEXIST')throw e;let old;try{old=json(file)}catch{}let dead=false;if(Number.isInteger(old?.pid)&&old.pid>0){try{process.kill(old.pid,0)}catch(err){dead=err.code==='ESRCH'}}if(dead){try{const current=json(file);if(current?.token===old.token&&current.pid===old.pid)fs.unlinkSync(file)}catch{}}else{if(Date.now()>=deadline)throw Object.assign(Error('Live or unknown lock owner; pending input preserved'),{code:'LOCK_BUSY'});await sleep(25)}}}
 try{return await fn()}finally{fs.closeSync(fd);try{if(json(file)?.token===token)fs.unlinkSync(file)}catch{}}
}
function mergeInbox(previous,events){let state=previous||{schemaVersion:1,threadId:events[0].threadId,platform:'codex',hostId:'local',revision:0,eventFingerprints:[]};const seen=new Set(state.eventFingerprints||[]);let accepted=0;
 for(const e of events.sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt)||a.fingerprint.localeCompare(b.fingerprint))){if(seen.has(e.fingerprint))continue;seen.add(e.fingerprint);accepted++;state.revision=(state.revision||0)+1;state.status='pending';state.receivedAt ||= e.receivedAt;state.lastReceivedAt=e.receivedAt;
  if(e.prompt){const incoming=e.eventAt||e.receivedAt,current=state.promptEventAt||state.promptReceivedAt||'';if(incoming>=current){state.latestPrompt=e.prompt;state.promptEventAt=e.eventAt;state.promptReceivedAt=e.receivedAt;}}
  if(e.nativeUpdatedAt&&e.nativeUpdatedAt>(state.nativeUpdatedAt||''))state.nativeUpdatedAt=e.nativeUpdatedAt;
  if(e.eventAt&&e.eventAt>(state.eventUpdatedAt||''))state.eventUpdatedAt=e.eventAt;
  state.updatedAt=state.nativeUpdatedAt||state.eventUpdatedAt||null;state.updatedAtSource=state.nativeUpdatedAt?'native-ui':state.eventUpdatedAt?'event-timestamp':'unknown';
  state.lastEvent={event:e.event,source:e.source,turnId:e.turnId,eventAt:e.eventAt,nativeUpdatedAt:e.nativeUpdatedAt,receivedAt:e.receivedAt,fingerprint:e.fingerprint,evidence:e.evidence};
 }
 state.eventFingerprints=[...seen];return {state,accepted};
}
async function dispatch(threadId,options){const router=absolute(options.router||DEFAULT_ROUTER,'router');if(options.noSpawn)return {status:'disabled'};if(!fs.existsSync(router))return {status:'not-ready',router};const args=[router,'process','--thread',threadId];if(options.inboxDir)args.push('--inbox-dir',options.inboxDir);if(options.codexHome)args.push('--codex-home',options.codexHome);
 return new Promise(resolve=>{let child;try{child=spawn(process.execPath,args,{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,NODE_NO_WARNINGS:'1'}})}catch(e){resolve({status:'spawn-failed',error:redact(e.message)});return}child.once('error',e=>resolve({status:'spawn-failed',error:redact(e.message)}));child.once('spawn',()=>{const pid=child.pid;child.unref();resolve({status:'spawned',pid,at:new Date().toISOString()})});});
}
export async function collectEvent(input,options={}){
 // WITHDRAWN_CLONE_ROUTE_20261002
 return {ok:true,status:'disabled-route-withdrawn'};

 const e=normalizeEvent(input,options);if(e.skip)return {ok:true,status:'skipped',reason:e.skip};
 const inbox=absolute(options.inboxDir||DEFAULT_INBOX,'inbox-dir'),target=path.join(inbox,e.threadId+'.json'),pendingDir=path.join(inbox,'.pending',e.threadId),pending=path.join(pendingDir,e.fingerprint+'.json');
 fs.mkdirSync(pendingDir,{recursive:true});try{fs.writeFileSync(pending,JSON.stringify(e)+'\n',{flag:'wx'})}catch(err){if(err.code!=='EEXIST')throw err}
 return drainThread(e.threadId,options);
}
// Called on an actual event or explicit recovery, never on a model polling timer.
export async function drainThread(threadId,options={}){
 // WITHDRAWN_CLONE_ROUTE_20261002
 return {ok:true,status:'disabled-route-withdrawn'};

 if(typeof threadId!=='string'||!UUID.test(threadId))throw Error('Full --thread UUID required');threadId=threadId.toLowerCase();
 const inbox=absolute(options.inboxDir||DEFAULT_INBOX,'inbox-dir'),target=path.join(inbox,threadId+'.json'),pendingDir=path.join(inbox,'.pending',threadId);
 if(!fs.existsSync(pendingDir))return {ok:true,status:'no-pending',threadId};
 try{return await withFileLock(target+'.lock',async()=>{const files=fs.readdirSync(pendingDir).filter(f=>/^[0-9a-f]{64}\.json$/.test(f)).map(f=>path.join(pendingDir,f));const events=files.map(f=>json(f)).filter(v=>v?.threadId===threadId);
  if(!events.length)return {ok:true,status:'no-pending',threadId};const {state,accepted}=mergeInbox(json(target),events);
  if(!accepted){for(const file of files)fs.unlinkSync(file);return {ok:true,status:'duplicate',threadId,revision:state.revision};}
  // Commit all pending text before starting the child. Failed dispatch never deletes the inbox.
  state.dispatch={status:'pending',at:new Date().toISOString()};atomic(target,state);for(const file of files)fs.unlinkSync(file);
  state.dispatch=await dispatch(threadId,options);atomic(target,state);return {ok:true,status:'accepted',threadId,revision:state.revision,accepted,dispatch:state.dispatch.status,pid:state.dispatch.pid||null};
 })}catch(err){if(err.code==='LOCK_BUSY')return {ok:true,status:'queued',threadId,reason:'lock-busy'};throw err}
}

const registrationCommand='node '+FILE.replaceAll('\\','/')+' event';
function owns(h){return h?.type==='command'&&(h.command===registrationCommand||h.commandWindows===registrationCommand)}
export async function registerHook(mode,options={}){if(mode==='install')throw Error('DISABLED: withdrawn clone route cannot register production hooks');const hooks=absolute(options.hooksFile||path.join(DEFAULT_HOME,'hooks.json'),'hooks-file'),recovery=absolute(options.recoveryDir||DEFAULT_RECOVERY,'recovery-dir');return withFileLock(hooks+'.lock',()=>{const current=json(hooks,{hooks:{}});if(!current.hooks||typeof current.hooks!=='object'||Array.isArray(current.hooks))throw Error('Unexpected hooks schema');const original=JSON.stringify(current);const groups=current.hooks.UserPromptSubmit||[];if(!Array.isArray(groups))throw Error('Unexpected UserPromptSubmit schema');const cleaned=groups.map(g=>({...g,hooks:(g.hooks||[]).filter(h=>!owns(h))})).filter(g=>g.hooks.length);
 if(mode==='install')cleaned.push({hooks:[{type:'command',command:registrationCommand,commandWindows:registrationCommand,timeout:3}]});
 current.hooks.UserPromptSubmit=cleaned;if(JSON.stringify(current)===original)return {ok:true,status:'unchanged',hooksFile:hooks};
 fs.mkdirSync(recovery,{recursive:true});const backup=path.join(recovery,'hooks-before-'+Date.now()+'-'+crypto.randomUUID()+'.json');fs.copyFileSync(hooks,backup);atomic(hooks,current);return {ok:true,status:mode==='install'?'installed':'uninstalled',hooksFile:hooks,backup,command:registrationCommand};});}
export async function main(argv=process.argv.slice(2)){const command=argv.shift()||'help',opts={};const names={'input':'input','inbox-dir':'inboxDir','router':'router','codex-home':'codexHome','hooks-file':'hooksFile','recovery-dir':'recoveryDir','thread':'threadId'};for(let i=0;i<argv.length;i++){if(argv[i]==='--no-spawn'){opts.noSpawn=true;continue}const key=names[argv[i].slice(2)];if(!argv[i].startsWith('--')||!key||!argv[i+1]||argv[i+1].startsWith('--'))throw Error('Invalid option '+argv[i]);const value=argv[++i];opts[key]=key==='threadId'?value:absolute(value,argv[i-1]);}
 if(command==='event'){const text=fs.readFileSync(opts.input||0,'utf8').replace(/^\uFEFF/,'');return collectEvent(JSON.parse(text||'{}'),opts)}
 if(['install','uninstall'].includes(command))return registerHook(command,opts);
 if(command==='recover')return drainThread(opts.threadId,opts);
 if(command==='help')return {commands:{event:'stdin JSON or --input ABS [--no-spawn] [--inbox-dir ABS --router ABS --codex-home ABS]',recover:'--thread UUID; drain lock-busy pending events; same event options; does not invent a new event',install:'[--hooks-file ABS --recovery-dir ABS]',uninstall:'Only removes this collector command, preserving other entries'},inbox:DEFAULT_INBOX,router:DEFAULT_ROUTER,output:'Single short JSON object; never emits hookSpecificOutput/additionalContext'};
 throw Error('Unknown command '+command);
}
if(process.argv[1]&&path.resolve(process.argv[1])===FILE){main().then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(error=>{process.stdout.write(JSON.stringify({ok:false,status:'error',error:redact(error.message)})+'\n');process.exitCode=1})}

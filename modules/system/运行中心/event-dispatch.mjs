#!/usr/bin/env node
import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
// Durable local dispatch. Tokens fence concurrent writers; they are not semantic acceptance.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID, createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const home=path.dirname(fileURLToPath(import.meta.url));
export const defaultDispatchDb=path.join(home,'event-dispatch-data','queue.sqlite');
const json=value=>JSON.stringify(value);
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const required=(value,label)=>{if(typeof value!=='string'||!value.trim())throw Error(`${label} required`);return value;};
const positive=(n,fallback,min=1,max=Number.MAX_SAFE_INTEGER)=>{n=n??fallback;if(!Number.isSafeInteger(n)||n<min||n>max)throw Error('invalid positive integer');return n;};
function writeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,json(value)+'\n');fs.renameSync(temp,file);}
function view(row){if(!row)return null;const {lease_token,...safe}=row;for(const k of ['task','result','checkpoint'])safe[k]=row[k]?JSON.parse(row[k]):null;return safe;}
export class DispatchFailure extends Error {
 constructor(message,{blocked=false,retryable=true,retryAfterMs,details}={}){super(message);this.blocked=blocked;this.retryable=retryable;this.retryAfterMs=retryAfterMs;this.details=details;}
}

export class EventDispatcher {
 constructor({databasePath=process.env.EVENT_DISPATCH_DB||defaultDispatchDb,artifactRoot,providers=[],clock=Date.now,leaseMs=120000,maxAttempts=4,backoffMs=10000,maxBackoffMs=3600000,maxStalls=2}={}){
  this.databasePath=path.resolve(databasePath);this.artifactRoot=path.resolve(artifactRoot||path.join(path.dirname(this.databasePath),'artifacts'));this.providers=providers;this.clock=clock;
  this.leaseMs=positive(leaseMs,120000,100);this.maxAttempts=positive(maxAttempts,4);this.backoffMs=positive(backoffMs,10000,0);this.maxBackoffMs=positive(maxBackoffMs,3600000);this.maxStalls=positive(maxStalls,2);
  fs.mkdirSync(path.dirname(this.databasePath),{recursive:true});
  this.db=new DatabaseSync(this.databasePath);this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  this.db.exec(`CREATE TABLE IF NOT EXISTS dispatch_jobs(
   id TEXT PRIMARY KEY,event_key TEXT NOT NULL,action TEXT NOT NULL,task TEXT NOT NULL,
   state TEXT NOT NULL CHECK(state IN ('ready','running','retry','waiting_capability','completed','failed')),
   created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,available_at INTEGER NOT NULL,
   attempts INTEGER NOT NULL DEFAULT 0,stalls INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL,
   provider_id TEXT,lease_token TEXT,lease_until INTEGER,resource_key TEXT,result TEXT,error TEXT,checkpoint TEXT,
   UNIQUE(event_key,action));
   CREATE INDEX IF NOT EXISTS dispatch_ready ON dispatch_jobs(state,available_at);
   CREATE TABLE IF NOT EXISTS dispatch_attempts(job_id TEXT NOT NULL,attempt INTEGER NOT NULL,provider_id TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER,state TEXT NOT NULL,error TEXT,result_ref TEXT,PRIMARY KEY(job_id,attempt));
   CREATE TABLE IF NOT EXISTS dispatch_outbox(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL,delivered_at INTEGER,error TEXT);
   CREATE TABLE IF NOT EXISTS dispatch_log(seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,at INTEGER NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS dispatch_provider_cooldowns(id TEXT PRIMARY KEY,until_at INTEGER NOT NULL,reason TEXT NOT NULL);`);
 }
 close(){this.db.close();}
 tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 log(id,action,detail={}){this.db.prepare('INSERT INTO dispatch_log(job_id,at,action,detail) VALUES(?,?,?,?)').run(id,this.clock(),action,json(detail));}
 get(id){return view(this.db.prepare('SELECT * FROM dispatch_jobs WHERE id=?').get(id));}
 list({states}={}){return this.db.prepare('SELECT * FROM dispatch_jobs ORDER BY created_at,id').all().filter(x=>!states||states.includes(x.state)).map(view);}
 attempts(id){return this.db.prepare('SELECT * FROM dispatch_attempts WHERE job_id=? ORDER BY attempt').all(id);}
 history(id){return this.db.prepare('SELECT at,action,detail FROM dispatch_log WHERE job_id=? ORDER BY seq').all(id).map(x=>({...x,detail:JSON.parse(x.detail)}));}
 enqueue(event,task){
  if(!event||!task)throw Error('event and full task required');
  const eventKey=event.event_key||event.id||event.event_id;required(eventKey,'event identity');
  for(const k of ['project_ref','branch_ref','user_source','user_request','goal','core_relation','authorization_ref'])required(task[k],k);
  if(!path.isAbsolute(task.project_ref))throw Error('project_ref must be absolute');
  for(const k of ['criteria','conditions','necessary_files','capabilities'])if(!Array.isArray(task[k])||task[k].some(x=>typeof x!=='string'||!x.trim()))throw Error(`${k} must be a string array`);
  if(!task.criteria.length||!task.capabilities.length)throw Error('criteria and capabilities cannot be empty');
  const action=required(task.action||event.type,'action');
  const stableKey=event.source?`${event.source}:${eventKey}`:eventKey;
  const id='dispatch-'+createHash('sha256').update(json([stableKey,action])).digest('hex').slice(0,28);
  // One event may legitimately drive several actions. Identity uses event+action, never type alone.
  return this.tx(()=>{
   const existing=this.get(id);if(existing)return {created:false,duplicate:true,job:existing};
   const now=this.clock();const complete={...task,action,event:{id:eventKey,source:event.source||'',type:event.type||action,data:event.data??null,context:event.context??null,origin_kind:event.origin_kind||'local'},event_ref:{id:eventKey,source:event.source||'',type:event.type||action,evidence_ref:event.evidence_ref||event.raw_ref||'',received_at:event.received_at||null},idempotency_key:id};
   this.db.prepare("INSERT INTO dispatch_jobs(id,event_key,action,task,state,created_at,updated_at,available_at,max_attempts,resource_key) VALUES(?,?,?,?,'ready',?,?,?,?,?)").run(id,stableKey,action,json(complete),now,now,now,positive(task.max_attempts,this.maxAttempts),task.resource_key||null);
   this.log(id,'enqueued',{event_key:stableKey,action});return {created:true,job:this.get(id)};
  });
 }
 fence(id,token){const row=this.db.prepare("SELECT * FROM dispatch_jobs WHERE id=? AND state='running' AND lease_token=? AND lease_until>?").get(id,token,this.clock());if(!row)throw new DispatchFailure('lease lost; late writer rejected',{retryable:false});return row;}
 renew(id,token){return this.tx(()=>{this.fence(id,token);this.db.prepare('UPDATE dispatch_jobs SET lease_until=?,updated_at=? WHERE id=?').run(this.clock()+this.leaseMs,this.clock(),id);return true;});}
 checkpoint(id,token,value){return this.tx(()=>{this.fence(id,token);this.db.prepare('UPDATE dispatch_jobs SET checkpoint=?,updated_at=? WHERE id=?').run(json(value),this.clock(),id);});}
 outbox(id,kind,body){const cause=body.error?':'+createHash('sha256').update(body.error).digest('hex').slice(0,12):'';const key=`${id}:${kind}:${body.attempt||0}${cause}`;this.db.prepare('INSERT OR IGNORE INTO dispatch_outbox(id,job_id,kind,body,created_at) VALUES(?,?,?,?,?)').run(key,id,kind,json(body),this.clock());}
 recover(){return this.tx(()=>{
  const expired=this.db.prepare("SELECT * FROM dispatch_jobs WHERE state='running' AND lease_until<=?").all(this.clock());
  for(const row of expired){
   const terminal=row.stalls+1>=this.maxStalls||row.attempts>=row.max_attempts;const state=terminal?'failed':'retry';
   this.db.prepare('UPDATE dispatch_jobs SET state=?,stalls=stalls+1,lease_token=NULL,lease_until=NULL,provider_id=NULL,available_at=?,updated_at=?,error=? WHERE id=?').run(state,this.clock(),this.clock(),'executor lease expired',row.id);
   this.db.prepare("UPDATE dispatch_attempts SET state='expired',finished_at=?,error='executor lease expired' WHERE job_id=? AND attempt=?").run(this.clock(),row.id,row.attempts);
   this.log(row.id,'recovered',{state,attempt:row.attempts});
   if(terminal)this.outbox(row.id,'failure',{attempt:row.attempts,error:'executor lease expired',next:'Repair executor and call resume; task and checkpoint retained.'});
  }return expired.map(x=>this.get(x.id));
 });}
 resume(id){return this.tx(()=>{const job=this.get(id);if(!job)throw Error('job not found');if(job.state==='running'||job.state==='completed')throw Error(`cannot resume ${job.state}`);
  this.db.prepare("UPDATE dispatch_jobs SET state='ready',available_at=?,updated_at=?,max_attempts=MAX(max_attempts,attempts+?),stalls=0,error=NULL WHERE id=?").run(this.clock(),this.clock(),this.maxAttempts,id);this.log(id,'resumed');return this.get(id);
 });}
 interrupt(id,reason){return this.tx(()=>{const job=this.get(id);if(!job||job.state!=='running')throw Error('interrupt requires an existing running job');required(reason,'interruption reason');this.db.prepare("UPDATE dispatch_jobs SET state='retry',error=?,available_at=?,updated_at=?,lease_token=NULL,lease_until=NULL WHERE id=?").run(reason,this.clock(),this.clock(),id);this.db.prepare("UPDATE dispatch_attempts SET state='interrupted',finished_at=?,error=? WHERE job_id=? AND attempt=?").run(this.clock(),reason,id,job.attempts);this.log(id,'interrupted',{reason,attempt:job.attempts});return this.get(id);});}
 amendExecution(id,changes){return this.tx(()=>{const job=this.get(id);if(!job||['running','completed'].includes(job.state))throw Error('execution amendment requires a saved non-running incomplete task');const allowed=['execution_mode','user_request','asset_copies','necessary_files','required_artifacts','verification_commands','timeout_ms','model'];if(!changes||Object.keys(changes).some(k=>!allowed.includes(k)))throw Error('execution amendment cannot change goal, criteria, ownership or authorization');this.db.prepare('UPDATE dispatch_jobs SET task=?,updated_at=? WHERE id=?').run(json({...job.task,...changes}),this.clock(),id);this.log(id,'execution_amended',{previous:Object.fromEntries(Object.keys(changes).map(k=>[k,job.task[k]??null])),changes});return this.get(id);});}
 async availability(){return Promise.all(this.providers.map(async p=>{try{
  required(p.id,'provider.id');if(!Array.isArray(p.capabilities)||typeof p.execute!=='function')throw Error('provider requires capabilities and execute');
  const cooldown=this.db.prepare('SELECT * FROM dispatch_provider_cooldowns WHERE id=? AND until_at>?').get(p.id,this.clock());
  const a=cooldown?{available:false,reason:cooldown.reason}:p.probe?await p.probe():{available:true};return {id:p.id,available:a.available===true,reason:a.reason||a.status||'',priority:p.priority??0,capabilities:p.capabilities,maxConcurrency:positive(p.maxConcurrency,1)};
 }catch(e){return {id:p.id,available:false,reason:e.message,capabilities:p.capabilities||[]};}}));}
 claim(availability,{jobIds}={}){return this.tx(()=>{
  const jobs=this.db.prepare("SELECT * FROM dispatch_jobs WHERE state IN ('ready','retry','waiting_capability') AND available_at<=? ORDER BY created_at,id").all(this.clock());
  for(const row of jobs){
   if(jobIds&&!jobIds.includes(row.id))continue;
   const task=JSON.parse(row.task);const candidates=availability.filter(p=>p.available&&task.capabilities.every(c=>p.capabilities.includes(c))&&(!task.provider_id||task.provider_id===p.id)).sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id));
   if(!candidates.length){const reason=availability.filter(p=>task.capabilities.every(c=>p.capabilities.includes(c))).map(p=>`${p.id}: ${p.reason}`).join('; ')||'no registered provider matches required capabilities';
    if(row.state!=='waiting_capability'||row.error!==reason){this.db.prepare("UPDATE dispatch_jobs SET state='waiting_capability',error=?,updated_at=? WHERE id=?").run(reason,this.clock(),row.id);this.log(row.id,'waiting_capability',{reason});this.outbox(row.id,'coordination',{attempt:row.attempts,error:reason,next:'Register/login matching capability, then drain; no task recreation needed.'});}continue;
   }
   if(row.resource_key&&this.db.prepare("SELECT id FROM dispatch_jobs WHERE state='running' AND resource_key=?").get(row.resource_key))continue;
   const chosen=candidates.find(p=>this.db.prepare("SELECT count(*) AS n FROM dispatch_jobs WHERE state='running' AND provider_id=?").get(p.id).n<p.maxConcurrency);
   if(!chosen)continue;const token=randomUUID();const now=this.clock();
   this.db.prepare("UPDATE dispatch_jobs SET state='running',attempts=attempts+1,provider_id=?,lease_token=?,lease_until=?,updated_at=?,error=NULL WHERE id=?").run(chosen.id,token,now+this.leaseMs,now,row.id);
   this.db.prepare("INSERT INTO dispatch_attempts(job_id,attempt,provider_id,started_at,state) VALUES(?,?,?,?,'running')").run(row.id,row.attempts+1,chosen.id,now);this.log(row.id,'claimed',{provider:chosen.id,attempt:row.attempts+1});
   return {job:this.get(row.id),token,provider:this.providers.find(p=>p.id===chosen.id)};
  }return null;
 });}
 validateResult(result){
  if(!result||result.success!==true||(result.status&&!['completed','success','succeeded'].includes(result.status))||(result.errors&&(!Array.isArray(result.errors)||result.errors.length)))throw new DispatchFailure(result?.error||result?.reason||'executor did not report business success',{blocked:result?.blocked===true||result?.status==='needs_provider_login',retryable:result?.retryable!==false,details:result});
  if(!Array.isArray(result.artifacts)||!result.artifacts.length)throw new DispatchFailure('success requires actual artifact paths');
  for(const file of result.artifacts){if(typeof file!=='string'||!path.isAbsolute(file)||!fs.existsSync(file)||!fs.statSync(file).isFile()||fs.statSync(file).size===0)throw new DispatchFailure(`missing/empty artifact: ${file}`);}
  return result;
 }
 async executeClaim({job,token,provider}){
  const attemptDir=path.join(this.artifactRoot,job.id,`attempt-${job.attempts}`);fs.mkdirSync(attemptDir,{recursive:true});
  const taskFile=path.join(attemptDir,'task.json');writeJson(taskFile,{...job.task,job_id:job.id,attempt:job.attempts,checkpoint:job.checkpoint});
  const controller=new AbortController();let lost=null;
  const renewal=setInterval(()=>{try{this.renew(job.id,token);}catch(e){lost=e;controller.abort(e);}},Math.max(30,Math.floor(this.leaseMs/3)));renewal.unref();
  let timeout;const timeoutMs=positive(job.task.timeout_ms,900000);
  const timeoutPromise=new Promise((_,reject)=>{timeout=setTimeout(()=>{const e=new DispatchFailure(`executor timeout after ${timeoutMs}ms`);controller.abort(e);reject(e);},timeoutMs);});
  try{
   const result=this.validateResult(await Promise.race([provider.execute(job.task,{job,attemptDir,taskFile,signal:controller.signal,checkpoint:job.checkpoint,saveCheckpoint:value=>this.checkpoint(job.id,token,value),idempotencyKey:job.id}),timeoutPromise]));
   if(lost)throw lost;const resultFile=path.join(attemptDir,'result.json');writeJson(resultFile,{...result,provider_id:provider.id,job_id:job.id,attempt:job.attempts});
   this.tx(()=>{this.fence(job.id,token);this.db.prepare("UPDATE dispatch_jobs SET state='completed',result=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(json({...result,result_ref:resultFile}),this.clock(),job.id);
    this.db.prepare("UPDATE dispatch_attempts SET state='completed',finished_at=?,result_ref=? WHERE job_id=? AND attempt=?").run(this.clock(),resultFile,job.id,job.attempts);
    this.outbox(job.id,'outcome',{attempt:job.attempts,result_ref:resultFile,artifacts:result.artifacts,summary:result.summary||job.task.goal});this.log(job.id,'completed',{result_ref:resultFile});});
  }catch(e){
   const failure={success:false,error:e.message,blocked:e.blocked===true,retryable:e.retryable!==false,at:this.clock(),attempt:job.attempts,provider_id:provider.id};
   writeJson(path.join(attemptDir,'failure.json'),failure);
   try{this.tx(()=>{
    this.fence(job.id,token);const state=e.blocked?'waiting_capability':e.retryable===false||job.attempts>=job.max_attempts?'failed':'retry';
    const delay=e.retryAfterMs??Math.min(this.maxBackoffMs,this.backoffMs*2**Math.min(job.attempts-1,20));
    const available=e.blocked?this.clock():this.clock()+Math.max(0,delay);
    if(e.blocked)this.db.prepare('INSERT OR REPLACE INTO dispatch_provider_cooldowns(id,until_at,reason) VALUES(?,?,?)').run(provider.id,this.clock()+Math.max(60000,delay),e.message);
    this.db.prepare('UPDATE dispatch_jobs SET state=?,available_at=?,updated_at=?,error=?,lease_token=NULL,lease_until=NULL,max_attempts=max_attempts+? WHERE id=?').run(state,available,this.clock(),e.message,e.blocked?1:0,job.id);
    this.db.prepare("UPDATE dispatch_attempts SET state=?,finished_at=?,error=?,result_ref=? WHERE job_id=? AND attempt=?").run(state,this.clock(),e.message,path.join(attemptDir,'failure.json'),job.id,job.attempts);
    this.log(job.id,state,{error:e.message,next_at:available});
    if(state!=='retry')this.outbox(job.id,state==='waiting_capability'?'coordination':'failure',{attempt:job.attempts,error:e.message,result_ref:path.join(attemptDir,'failure.json'),next:state==='failed'?'Repair cause then resume existing job.':'Restore authentication/capability then drain.'});
   });}catch(fenceError){this.log(job.id,'late_result_ignored',{attempt:job.attempts,error:fenceError.message});}
  }finally{clearInterval(renewal);clearTimeout(timeout);}
  return this.get(job.id);
 }
 async drain({concurrency=4,maxJobs=100,jobIds}={}){
  if(jobIds&&(!Array.isArray(jobIds)||!jobIds.length||jobIds.some(id=>typeof id!=='string')))throw Error('jobIds must be a nonempty string array');
  concurrency=positive(concurrency,4,1,128);maxJobs=positive(maxJobs,100);this.recover();const availability=await this.availability();let started=0;const results=[];
  const worker=async()=>{while(started<maxJobs){const claim=this.claim(availability,{jobIds});if(!claim)break;started++;const result=await this.executeClaim(claim);results.push(result);if(result.state==='waiting_capability'){const provider=availability.find(p=>p.id===claim.provider.id);provider.available=false;provider.reason=result.error;}}};
  await Promise.all(Array.from({length:concurrency},worker));return {started,results,pending:this.list({states:['ready','retry','waiting_capability','running']}),availability};
 }
 async flushReports(deliver,{jobIds}={}){
  const sent=[],failed=[];for(const row of this.db.prepare('SELECT * FROM dispatch_outbox WHERE delivered_at IS NULL ORDER BY created_at,id').all()){
   if(jobIds&&!jobIds.includes(row.job_id))continue;
   try{await deliver({id:row.id,job_id:row.job_id,kind:row.kind,...JSON.parse(row.body)},this.get(row.job_id));this.db.prepare('UPDATE dispatch_outbox SET delivered_at=?,error=NULL WHERE id=?').run(this.clock(),row.id);sent.push(row.id);}
   catch(e){this.db.prepare('UPDATE dispatch_outbox SET error=? WHERE id=?').run(e.message,row.id);failed.push({id:row.id,error:e.message});}
  }return {sent,failed};
 }
}

// Genuine deterministic local capability: preserves current project runtime evidence.
// No vendor calls, external messages or implicit read-all-account access.
export function projectEvidenceProvider(){return {id:'local-project-evidence',capabilities:['project.evidence.snapshot'],priority:10,maxConcurrency:4,probe:async()=>({available:true}),execute:async(task,ctx)=>{
 const files=task.necessary_files;const missing=files.filter(f=>!path.isAbsolute(f)||!fs.existsSync(f)||!fs.statSync(f).isFile());if(!files.length||missing.length)throw new DispatchFailure(`missing required project evidence: ${missing.join(', ')||'no files supplied'}`,{retryable:false});
 const records=files.map(file=>({file,bytes:fs.statSync(file).size,modified_at:fs.statSync(file).mtime.toISOString()}));
 const artifact=path.join(ctx.attemptDir,'project-evidence.json');writeJson(artifact,{goal:task.goal,criteria:task.criteria,conditions:task.conditions,project_ref:task.project_ref,branch_ref:task.branch_ref,event_ref:task.event_ref,records,context_refs:{core:path.join(task.project_ref,'核心.md'),shared_state:path.join(task.project_ref,'共享状态.md')},boundary:'Local evidence inventory only; not model interpretation or vendor execution.'});
 return {success:true,status:'completed',artifacts:[artifact],summary:`Saved ${records.length} current project evidence references.`,errors:[]};
 }};}

export async function fileReportSink({sourceThreadId,targetThreadId,reportModule=_publicPath("$codex/context/task-reports.mjs")}={}){
 const {saveTaskReport}=await import(pathToFileURL(reportModule).href);
 return async(report,job)=>saveTaskReport({source_thread_id:sourceThreadId,target_thread_id:targetThreadId||job.task.report_to,project_ref:job.task.project_ref,branch_ref:job.task.branch_ref,kind:report.kind==='failure'?'coordination':report.kind,summary:report.summary||`${job.task.goal}: ${report.error}`,artifacts:report.artifacts||[],evidence:[report.result_ref||'',job.task.user_source].filter(Boolean),uncertainties:report.kind==='outcome'?[]:[report.next||''],authorization_ref:job.task.authorization_ref,event_id:report.id});
}

// Outbox-style bridge: commit durable jobs before acknowledging intake delivery.
// Crash between enqueue and ack leads to redelivery and reuse of the same job.
export async function importPendingEvents({store,dispatcher,resolveTasks,owner=`dispatch:${process.pid}`,limit=50}={}){
 if(typeof resolveTasks!=='function')throw Error('resolveTasks(event) required; events alone do not define authorized tasks');
 const imported=[],failed=[];
 positive(limit,50,1,1000);
 for(let count=0;count<limit;count++){
  const next=store.claim({owner,limit:1,lease_ms:120000})[0];if(!next)break;
  const {event,claim_token}=next;
  const renew=setInterval(()=>{try{store.renew({id:event.id,claim_token,lease_ms:120000});}catch{}},40000);renew.unref();
  try{
   const resolved=await resolveTasks(event);const tasks=Array.isArray(resolved)?resolved:[resolved];if(!tasks.length||tasks.some(x=>!x))throw Error('no complete task route for event');
   const jobs=tasks.map(task=>dispatcher.enqueue(event,task));
   store.ack({id:event.id,claim_token,dispatch_ref:json({database:dispatcher.databasePath,job_ids:jobs.map(x=>x.job.id)})});
   imported.push({event_id:event.id,jobs:jobs.map(x=>({id:x.job.id,created:x.created}))});
  }catch(e){
   try{store.fail({id:event.id,claim_token,error:e.message,retry_after_ms:30000});}catch(failError){failed.push({event_id:event.id,error:e.message,receipt_error:failError.message});continue;}
   failed.push({event_id:event.id,error:e.message});
  }finally{clearInterval(renew);}
 }return {imported,failed};
}

export async function dispatchCli(argv=process.argv.slice(2)){
 const command=argv[0]||'status';const arg=name=>{const i=argv.indexOf(name);return i<0?undefined:argv[i+1];};
 const providers=[projectEvidenceProvider()];const providerFile=arg('--providers');if(providerFile){const module=await import(pathToFileURL(path.resolve(providerFile)).href);providers.push(...await module.createProviders());}
 const queue=new EventDispatcher({databasePath:arg('--db'),artifactRoot:arg('--artifacts'),providers});try{
  if(command==='enqueue'){const input=readJson(required(arg('--input'),'--input'));return queue.enqueue(input.event,input.task);}
  if(command==='drain')return await queue.drain({concurrency:arg('--concurrency')?Number(arg('--concurrency')):4});
  if(command==='recover')return queue.recover();
  if(command==='resume')return queue.resume(required(arg('--id'),'--id'));
  if(command==='get')return {job:queue.get(required(arg('--id'),'--id')),attempts:queue.attempts(arg('--id')),history:queue.history(arg('--id'))};
  if(command==='flush-reports')return await queue.flushReports(await fileReportSink({sourceThreadId:required(arg('--source-thread'),'--source-thread'),targetThreadId:arg('--target-thread')}));
  if(command==='status')return {database:queue.databasePath,jobs:queue.list(),availability:await queue.availability()};
  if(command==='help')return 'enqueue --input ABS_JSON | drain [--providers ABS_MJS] | recover | resume --id ID | get --id ID | status | flush-reports --source-thread ID [--target-thread ID]. All support --db ABS_SQLITE.';
  throw Error('unknown dispatch command');
 }finally{queue.close();}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{console.log(json(await dispatchCli()));}catch(e){console.error(json({error:e.message}));process.exitCode=1;}}

import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
// Startup inventory is read-only; resume only drains already-authorized persisted jobs.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath,pathToFileURL} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const parse=s=>JSON.parse(s.replace(/^\uFEFF/,''));
function read(file,errors){try{return parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')errors.push({file,error:e.message});return null;}}
function database(file,fn,errors){
 if(!fs.existsSync(file))return {present:false,file};
 let db;try{db=new DatabaseSync(file,{readOnly:true});db.exec('PRAGMA busy_timeout=3000');return {present:true,file,...fn(db)};}
 catch(e){errors.push({file,error:e.message});return {present:true,file,error:e.message};}finally{db?.close();}
}
function groups(db,table,key){return Object.fromEntries(db.prepare(`SELECT "${key}" AS k,COUNT(*) AS n FROM "${table}" GROUP BY "${key}"`).all().map(r=>[r.k,r.n]));}
function hasTable(db,name){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
function jobSummary(row){const task=parse(row.task);return {id:row.id,state:row.state,goal:task.goal,branch_ref:task.branch_ref,
 authorization_ref:task.authorization_ref,capabilities:task.capabilities,provider_id:row.provider_id,attempts:row.attempts,
 available_at:row.available_at,lease_until:row.lease_until,error:row.error,checkpointAvailable:!!row.checkpoint};}
export function inventory({runtimeRoot=here,dispatchDb,taskDb,ingestDb}={}){
 runtimeRoot=path.resolve(runtimeRoot);const project=path.dirname(runtimeRoot),errors=[];
 const bridge=database(taskDb||_publicDataPath("任务协作/tasks.sqlite"),db=>{
  const rows=db.prepare('SELECT * FROM tasks ORDER BY created_at,id').all();const byId=new Map(rows.map(r=>[r.id,r]));
  const ancestorBlocked=row=>{const visited=new Set();while(row?.parent_task_id){if(visited.has(row.id))return true;visited.add(row.id);row=byId.get(row.parent_task_id);if(row&&row.lifecycle&&row.lifecycle!=='active')return true;}return false;};
  const unfinished=rows.filter(r=>r.state!=='completed'&&(!r.lifecycle||r.lifecycle==='active')&&!ancestorBlocked(r));
  return {counts:groups(db,'tasks','state'),unfinished:unfinished.map(r=>({id:r.id,title:r.title,state:r.state,owner:r.owner,
   leaseExpired:!!r.lease_until&&Date.parse(r.lease_until)<=Date.now(),thread_id:r.thread_id,branch_ref:r.branch_ref,
   goal:r.goal,ledger_ref:r.ledger_ref,next_step:r.next_step,authorization_ref:r.authorization_ref})),
   policy:'Existing task windows retain ownership. No automatic claim, takeover or native chat wakeup.'};
 },errors);
 const dispatch=database(dispatchDb||_publicDataPath('运行中心/event-dispatch-data/queue.sqlite'),db=>{
  const now=Date.now(),pending=db.prepare("SELECT * FROM dispatch_jobs WHERE state!='completed' ORDER BY created_at,id").all();
  return {counts:groups(db,'dispatch_jobs','state'),unfinished:pending.map(jobSummary),
   due:pending.filter(r=>['ready','retry','waiting_capability'].includes(r.state)&&r.available_at<=now).length,
   expired:pending.filter(r=>r.state==='running'&&r.lease_until<=now).length,
   reportsPending:db.prepare('SELECT COUNT(*) AS n FROM dispatch_outbox WHERE delivered_at IS NULL').get().n};
 },errors);
 const ingest=database(ingestDb||_publicDataPath('运行中心/event-ingest.sqlite'),db=>{
  const table=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('event_ingest_events','events','event_inbox')").get()?.name;
  if(!table)return {schema:'unknown',policy:'No routing or dispatch mutation performed.'};
  const columns=db.prepare(`PRAGMA table_info("${table}")`).all().map(r=>r.name);
  const stateKey=columns.includes('dispatch_state')?'dispatch_state':columns.includes('state')?'state':null;
  return {rows:db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n,counts:stateKey?groups(db,table,stateKey):{},
   policy:'Unrouted inbox events need an explicit current authorized route; startup does not invent one.'};
 },errors);
 const information=database(_publicDataPath("信息中心/data/information.sqlite"),db=>{
  const state={};for(const key of ['daily_run_date','last_recovery']){const row=db.prepare('SELECT value FROM state WHERE key=?').get(key);if(row)state[key]=parse(row.value);}
  return {dailyRunDate:state.daily_run_date,lastRecovery:state.last_recovery?{status:state.last_recovery.status,ended_at:state.last_recovery.ended_at}:null,
   modelPending:hasTable(db,'item_queue')?db.prepare("SELECT COUNT(*) AS n FROM items WHERE analyzed_at IS NULL AND id IN (SELECT item_id FROM item_queue WHERE route='model')").get().n:null,
   research:groups(db,'events','research_state'),actions:groups(db,'actions','state'),
   policy:'The existing daily task owns this backlog and daily gate; startup does not replay historical batches.'};
 },errors);
 const storageRoot=_publicDataPath('存储接入'),latest=read(path.join(storageRoot,'latest.json'),errors);
 const manifest=latest?.manifest?read(latest.manifest,errors):null;
 const startupFiles=['boot.ps1','state.ps1','install-startup.ps1','boot-recovery.ps1','boot-recovery.mjs'];
 const normalize=file=>path.resolve(file).toLowerCase();
 const covered=new Set((manifest?.items||[]).map(item=>normalize(item.source||path.join(project,'missing'))));
 const startupNotArchived=startupFiles.filter(file=>!covered.has(normalize(path.join(runtimeRoot,file))));
 const startupChangedAfterSnapshot=manifest?.created_at?startupFiles.filter(file=>fs.existsSync(path.join(runtimeRoot,file))&&fs.statSync(path.join(runtimeRoot,file)).mtimeMs>Date.parse(manifest.created_at)):startupFiles;
 const outbox=path.join(storageRoot,'outbox'),pendingUploads=[];
 if(fs.existsSync(outbox))for(const file of fs.readdirSync(outbox).filter(n=>n.endsWith('.json'))){const row=read(path.join(outbox,file),errors);if(row?.cloud_state==='pending_upload')pendingUploads.push({snapshot_id:row.snapshot_id,archive:row.archive,archiveExists:fs.existsSync(row.archive),record:path.join(outbox,file)});}
 const storage={latest:latest?{snapshot_id:latest.snapshot_id,local_date:latest.local_date,archive:latest.archive,
  archiveExists:typeof latest.archive==='string'&&fs.existsSync(latest.archive),manifestExists:typeof latest.manifest==='string'&&fs.existsSync(latest.manifest),
  files:latest.files,cloud_state:latest.cloud_state,download_verified:latest.download_verified===true||latest.cloud_state==='uploaded_readback_verified',drive_url:latest.drive_url}:null,
  pendingUploads,startupCoverage:{notArchived:startupNotArchived,changedAfterSnapshot:startupChangedAfterSnapshot,
   current:startupNotArchived.length===0&&startupChangedAfterSnapshot.length===0},
  policy:'Recovery never overwrites live databases. Archives restore into a new directory; connected Drive and unattended OAuth are separate capabilities.'};
 return {checkedAt:new Date().toISOString(),runtimeRoot,bridge,dispatch,ingest,information,storage,errors,
  boundary:'Inventory preserves unfinished tasks and evidence; inventory alone does not resume a native chat or prove end-to-end recovery.'};
}
export async function resumeDispatch(options={}){
 const runtimeRoot=path.resolve(options.runtimeRoot||here),before=inventory(options);
 if(before.dispatch.error)throw Error(before.dispatch.error);
 if(!before.dispatch.present)return {status:'not_configured',before:before.dispatch};
 if(!before.dispatch.due&&!before.dispatch.expired&&!before.dispatch.reportsPending)return {status:'idle',executed:0,providersProbed:false,unfinished:before.dispatch.unfinished};
 const {EventDispatcher,projectEvidenceProvider,fileReportSink}=await import(pathToFileURL(path.join(runtimeRoot,'event-dispatch.mjs')).href);
 const providers=[projectEvidenceProvider()];
 if(before.dispatch.due||before.dispatch.expired){const providerFile=options.providers||path.join(runtimeRoot,'providers/gemini.mjs');if(fs.existsSync(providerFile)){const extra=await import(pathToFileURL(providerFile).href);providers.push(...await extra.createProviders());}}
 const queue=new EventDispatcher({databasePath:options.dispatchDb||before.dispatch.file,artifactRoot:options.artifactRoot,providers});
 try{
  const recovered=queue.recover();
  const execution=before.dispatch.due||recovered.some(r=>r.state==='retry')?await queue.drain({concurrency:1,maxJobs:options.maxJobs||8}):{started:0,results:[]};
  const reports=await queue.flushReports(await fileReportSink({sourceThreadId:options.sourceThreadId||'db8ec5d5-a867-2a42-52e7-7207f13c985c'}));
  const after=inventory(options).dispatch;
  return {status:execution.results?.some(r=>r.state==='failed')?'partial':after.unfinished?.length?'pending':'completed',
   recovered:recovered.map(r=>({id:r.id,state:r.state})),execution,reports,after,
   boundary:'One-shot persisted authorized event jobs only; no inbox routing, native chat wakeup or model heartbeat.'};
 }finally{queue.close();}
}
export async function bootRecoveryCli(argv=process.argv.slice(2)){
 const arg=name=>{const i=argv.indexOf(name);return i<0?undefined:argv[i+1];};
 const options={runtimeRoot:arg('--runtime-root'),dispatchDb:arg('--dispatch-db'),taskDb:arg('--task-db'),ingestDb:arg('--ingest-db'),
  artifactRoot:arg('--artifacts'),providers:arg('--providers'),sourceThreadId:arg('--source-thread'),maxJobs:Number(arg('--max-jobs')||8)};
 if(!Number.isInteger(options.maxJobs)||options.maxJobs<1||options.maxJobs>100)throw Error('max-jobs must be 1..100');
 const command=argv[0]||'inventory';
 if(command==='inventory')return inventory(options);
 if(command==='resume')return resumeDispatch(options);
 if(['help','--help'].includes(command))return {usage:'inventory | resume [--runtime-root ABS_DIR] [--dispatch-db ABS_SQLITE] [--providers ABS_MJS] [--artifacts ABS_DIR] [--max-jobs 1..100]',policy:'No new tasks, no native wakeups; idle performs no provider/model call.'};
 throw Error('Unknown startup recovery command');
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{const result=await bootRecoveryCli();console.log(JSON.stringify(result,null,2));if(result.status==='partial'||result.errors?.length)process.exitCode=2;}catch(e){console.error(JSON.stringify({status:'failed',error:e.message}));process.exitCode=1;}}

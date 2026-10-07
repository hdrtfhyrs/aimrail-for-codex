import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {handleRegistry} from '../资料中心/handler.mjs';
import {moduleInventory,runModule} from './module-registry.mjs';

const home=path.dirname(fileURLToPath(import.meta.url));
const project=path.dirname(home);
const pwsh=process.env.AI_PWSH_PATH || 'pwsh';
const settingsFile=_publicDataPath("信息中心/config/settings.json");
const stateFile=_publicDataPath("运行中心/运行状态.json");
fs.mkdirSync(path.dirname(stateFile), {recursive:true});
const read=(file,fallback={})=>{try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{return fallback;}};
function execute(executable,args,timeout=30000){return new Promise(resolve=>{
  const child=spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1'}});
  let output='',error='',finished=false;
  const timer=setTimeout(()=>{child.kill();},timeout);
  child.stdout?.setEncoding('utf8');child.stderr?.setEncoding('utf8');
  child.stdout?.on('data',s=>{if(output.length<500000)output+=s;});child.stderr?.on('data',s=>{if(error.length<4000)error+=s;});
  const finish=(code,message)=>{if(finished)return;finished=true;clearTimeout(timer);let data;try{data=JSON.parse(output.trim().replace(/^\uFEFF/,''));}catch{}resolve({code,data,error:message||error.trim(),raw:data?undefined:output.slice(0,1000)});};
  child.on('error',e=>finish(-1,e.message));child.on('close',code=>finish(code));
});}
const control=mode=>execute(pwsh,['-NoProfile','-NonInteractive','-File',path.join(project,'信息中心/control.ps1'),'-Mode',mode]);
const store=command=>execute((process.env.AI_PYTHON_PATH || read(settingsFile).python_path || 'python'),[path.join(project,'存储接入/storage.py'),command],120000);
const storageHealth=command=>execute(process.execPath,[path.join(project,'存储接入/storage-health.mjs'),command]);
// Status evidence helpers: observe registrations; never enable or start schedules.
function automation(root=path.join(process.env.CODEX_HOME||_publicPath("$codex"),'automations')){
  const result={source:root,status:'observed',items:[],errors:[]};
  let entries;try{entries=fs.readdirSync(root,{withFileTypes:true});}catch(e){return {...result,status:'unknown',errors:[{code:e.code||'read_failed'}]};}
  for(const entry of entries.filter(e=>e.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name))){
    const source=path.join(root,entry.name,'automation.toml');
    let text;try{text=fs.readFileSync(source,'utf8').replace(/^\uFEFF/,'');}catch(e){
      // A directory without a TOML is not a registered automation.
      if(e.code!=='ENOENT')result.errors.push({id:entry.name,source,code:e.code||'read_failed'});
      continue;
    }
    const item={id:entry.name,source};
    for(const key of ['name','status','kind','rrule','target_thread_id','project_id']){
      const literal=text.match(new RegExp('^'+key+'\\s*=\\s*("(?:\\\\.|[^"\\n])*"|\'[^\'\\n]*\')','m'))?.[1];
      try{item[key]=literal?.startsWith('"')?JSON.parse(literal):literal?.slice(1,-1)||null;}catch{item[key]=null;}
    }
    // Only explicit subject or information entrypoints establish the association.
    // Prompts are inspected in memory and are never returned in status output.
    const byName=/AI信息|信息日更|信息中心|信息采集|持续信息/.test(item.name||'');
    const byEntrypoint=/信息中心[\\/]+(?:app[\\/]+(?:main|launch|operations)\.py|control\.ps1)/.test(text);
    item.relatedInformation=byName||byEntrypoint;
    item.associationEvidence=byName?'registered_name':byEntrypoint?'information_entrypoint':'no_information_association';
    item.purpose=item.relatedInformation?'information':/归档|清理/.test(item.name||'')?'file_maintenance':/调用|经验接续/.test(item.name||'')?'invocation_repair':/拆书/.test(item.name||'')?'book_analysis':'other';
    item.execution='desktop_automation';
    item.observation=item.name&&item.status?'registered':'metadata_incomplete';
    result.items.push(item);
  }
  if(result.errors.length)result.status='partial';
  return result;
}
function informationEvidence(info,windows,projectRoot=project){
  const task=windows?.tasks?.find(t=>t.name==='Codex-InformationCenter');
  const schedule={execution:'windows_task',name:'Codex-InformationCenter',observation:task?'observed':'unknown',...(task||{}),requires:'本机开机及可用登录环境'};
  const root=path.join(projectRoot,'信息中心/logs/scheduled'),logs=[],errors=[];
  try{
    for(const name of fs.readdirSync(root).filter(n=>n.endsWith('.log')).sort().reverse().slice(0,20)){
      const source=path.join(root,name),data=read(source,null);
      if(!data){errors.push({source,code:'unreadable_json'});continue;}
      const collection=data.stages?.collect,continuation=data.late_cloud_continuation;
      if(!collection&&!continuation)continue;
      logs.push({source,status:data.status,date:data.date||data.started_at?.slice(0,10),startedAt:data.started_at,endedAt:data.ended_at||continuation?.ended_at,
        kind:collection?'collection_pipeline':'continuation',
        collection:collection?{sourcesAttempted:collection.sources_attempted,sourcesOk:collection.sources_ok,sourcesFailed:collection.sources_failed,itemsNew:collection.items_new,itemsUpdated:collection.items_updated}:undefined,
        analysis:data.stages?.analyze?{itemsAnalyzed:data.stages.analyze.items_analyzed,batchesCompleted:data.stages.analyze.batches_completed}:undefined,
        continuation:continuation?{status:continuation.status,collectCalls:continuation.collect_calls,researchFailed:continuation.stages?.research?.events_failed,
          issueKinds:[...(JSON.stringify(continuation.errors||[]).includes('request timed out')?['model_request_timeout']:[]),...(JSON.stringify(continuation.errors||[]).includes('Transport channel closed')?['mcp_transport_closed']:[])]}:undefined});
    }
  }catch(e){errors.push({source:root,code:e.code||'read_failed'});}
  const daily=logs.find(l=>l.kind==='collection_pipeline'&&l.date===info?.dailyRunDate);
  const latest=logs[0]||null;
  return {schedule,dailyRunDate:info?.dailyRunDate||null,dailyCollection:daily||null,latestRun:latest,observation:logs.length?'observed':'unknown',errors,
    interpretation:daily&&latest?.kind==='continuation'?'当天已有采集产出；最新记录为后续接续，错误沿阶段处理':daily?'当天采集已有运行记录；partial保留未完成来源或阶段':'当前未取得当天采集日志，不能由自动化文件缺失推定没有运行'};
}
function cloudEvidence(cfg,projectRoot=project){
  const outcome=path.join(projectRoot,'成果/2026-10-02_自动信息迭代');
  const source=path.join(outcome,'重新部署/cloud-full-production-receipt.json'),receipt=read(source,null);
  const marker=receipt?.batch_marker,origin=marker?.origin?.execution;
  const received=receipt?.status==='success'&&origin==='codex_cloud'&&marker?.records>0&&receipt?.production_receive?.status==='success';
  const document=path.join(outcome,'Codex云端重新部署.md');
  let text='';try{text=fs.readFileSync(document,'utf8');}catch{}
  const notConnected=text.includes('每天北京时间 9 点、电脑关机也自动采集这一项仍未接通');
  return {provider:cfg?.provider||'codex_cloud_new',execution:'external_codex_cloud',
    collection:{status:received?'verified':'unverified',source:received?source:null,batchId:received?receipt.batch_id:null,records:received?marker.records:null,cloudStatus:received?receipt.cloud_status:null},
    nativeReceive:{status:received?'verified':'unverified',source:received?source:null,itemsNew:received?marker.items_new:null,itemsUpdated:received?marker.items_updated:null},
    hostedSchedule:{status:notConnected?'not_connected':'unverified',requestedTime:'09:00 Asia/Shanghai',powerOffVerified:false,source:notConnected?document:null,
      note:'真实每日托管需日程编号与服务器执行回执；桌面TOML缺失不证明外部Cloud日程不存在'},
    daily_cloud_schedule_verified:false,
    configObservation:{source:settingsFile,legacyStage:cfg?.stage||null,dailyAutomationId:cfg?.daily_automation_id||null,note:'配置为历史登记；不作为当前Cloud采集、回流或托管验证'},
    note:'单次云运行、原生回流与真实托管分别报告；既有文件提供实跑证据，不执行或修改日程'};
}
function statusAssessment(information,storage,windows,diskHealth,infoEvidence,discovery){
  const reasons=[];
  for(const [name,value] of Object.entries({information,storage,windows,diskHealth}))if(value.code!==0||!value.data)reasons.push({scope:name,reason:'status_read_failed'});
  if(['warning','critical','unknown'].includes(diskHealth.data?.status))reasons.push({scope:'diskHealth',reason:diskHealth.data.status});
  if(windows.data?.health==='needs_attention')reasons.push({scope:'windows',reason:'runtime_needs_attention'});
  const info=information.data,task=infoEvidence.schedule;
  if(task.observation==='observed'&&(!task.enabled||task.owned===false||task.state==='missing'))reasons.push({scope:'information.windows_task',reason:task.state==='missing'?'registered_task_missing':!task.enabled?'disabled':'different_owner'});
  if(!info?.running&&Number.isInteger(info?.lastExit)&&info.lastExit!==0&&!['ready','running','disabled','never_run'].includes(task.resultMeaning))reasons.push({scope:'information.windows_task',reason:'last_run_nonzero',result:info.lastExit,resultHex:task.resultHex,causalMeaning:'退出码本身不能定位中断来源'});
  const latest=infoEvidence.latestRun;
  if(!info?.running&&latest&&['partial','failed','error'].includes(latest.status))reasons.push({scope:'information.'+latest.kind,reason:latest.status,source:latest.source});
  for(const a of discovery.items)if(a.relatedInformation&&a.status==='PAUSED')reasons.push({scope:'information.desktop_automation',reason:'registered_pause',id:a.id,source:a.source,note:'仅报告原暂停；不自动恢复'});
  return {health:reasons.length?'needs_attention':info?.running?'working':'scheduled',reasons};
}
let inFlight;

async function inspect(){
  if(inFlight)return inFlight;
  inFlight=(async()=>{
    const [information,storage,windows,diskHealth,taskCollection]=await Promise.all([
      control('status'),store('status'),execute(pwsh,['-NoProfile','-NonInteractive','-File',path.join(home,'state.ps1')]),storageHealth('status'),
      execute((process.env.AI_PYTHON_PATH || read(settingsFile).python_path || 'python'),[path.join(project,'信息中心/app/task_collection.py'),'status','--limit','12'])
    ]);
    const cfg=read(settingsFile), links=read(_publicDataPath("运行中心/connections.json"));
    const info=information.data,discovery=automation(),evidence=informationEvidence(info,windows.data),cloud=cloudEvidence(cfg.cloud);
    const assessment=statusAssessment(information,storage,windows,diskHealth,evidence,discovery);
    const result={checkedAt:new Date().toISOString(),project,
      health:assessment.health,attentionReasons:assessment.reasons,
      information:info||information,taskCollection:taskCollection.data||taskCollection,storage:storage.data||storage,windows:windows.data||windows,
      informationEvidence:evidence,
      diskHealth:diskHealth.data||diskHealth,
      automations:discovery.items,automationDiscovery:{source:discovery.source,status:discovery.status,errors:discovery.errors},
      cloud,
      models:{triage:cfg.triage_model,research:cfg.research_model,policy:'采集、备份、健康检查用普通程序；Luna初筛，Sol查证/判断，复杂问题按需请Astra'},
      connections:links,latestPulse:read(_publicDataPath("运行中心/pulse.json")),
      integration:moduleInventory(),
      navigation:{outcomes:_publicPath("$projects/成果总览.md"),projectOutcomes:path.join(project,'成果/INDEX.md'),information:cfg.output_paths},
      boundaries:['历史partial保留；pending不是已完成','本机任务需开机登录；桌面接续需应用运行','Drive后台传输使用已连接的Codex工具，不冒充独立OAuth守护进程']};
    const tmp=stateFile+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(result,null,2)+'\n');fs.renameSync(tmp,stateFile);
    return result;
  })();
  try{return await inFlight;}finally{inFlight=null;}
}
async function pulse(){
  const lock=_publicDataPath("运行中心/pulse.lock");let fd;
  try{fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:new Date().toISOString()}));}
  catch(e){if(e.code==='EEXIST')return {status:'already_running',lock};throw e;}
  try{
    const disk=await storageHealth('sample');
    const backup=await store('snapshot');
    const result={at:new Date().toISOString(),status:backup.code===0&&disk.code===0?'completed':'partial',diskHealth:disk.data||disk,backup:backup.data||backup,error:backup.error};
    const state=await inspect();
    if(state.health==='needs_attention')result.status='partial';

    fs.writeFileSync(_publicDataPath("运行中心/pulse.json"),JSON.stringify(result,null,2)+'\n');
    return result;
  }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
async function start(){
  const recovery=await recoverQueues();
  const before=await control('status');
  const information=before.data?.running?{status:'already_running'}:await control('start');
  const backup=await pulse();return {information,recovery,backup,state:await inspect()};
}
async function recoverQueues(){
  const entry=path.join(home,'event-dispatch.mjs');
  if(!fs.existsSync(entry))return {status:'entry_missing',path:entry};
  const result=await execute(process.execPath,[entry,'recover']);
  return {status:result.code===0?'recovered':'partial',code:result.code,recovered:result.data,error:result.code===0?undefined:result.error,diagnostics:result.code===0?result.error:undefined,
    next:'显式任务路由通过 events process --routes FILE 接续；恢复租约不等于业务执行完成'};
}
async function serve(){
  const server=http.createServer(async(req,res)=>{
    try{
      if(await handleRegistry(req,res))return;
      const route=new URL(req.url,'http://127.0.0.1:8765').pathname;
      if(req.method!=='GET'){res.writeHead(405);res.end();return;}
      if(route==='/api/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({service:'ai-work-system-runtime-v1',pid:process.pid}));}
      else if(route==='/api/modules'){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(moduleInventory()));}
      else if(route==='/api/status'){const data=await inspect();res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
      else if(route==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(fs.readFileSync(path.join(home,'index.html')));}
      else{res.writeHead(404);res.end();}
    }catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}
  });
  const port=process.env.AI_SYSTEM_PORT===undefined?8765:Number(process.env.AI_SYSTEM_PORT);
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid AI_SYSTEM_PORT');
  server.listen(port,'127.0.0.1',()=>{console.log('AI runtime dashboard: http://127.0.0.1:'+server.address().port+'/');});
}
const command=process.argv[2]||'status';
const brief=s=>({checkedAt:s.checkedAt,health:s.health,attentionReasons:s.attentionReasons,information:s.information?.enabled!==undefined?{enabled:s.information.enabled,running:s.information.running,lastExit:s.information.lastExit,queue:s.information.queue,failedSources:s.information.failedSources}:s.information,informationEvidence:s.informationEvidence,diskHealth:s.diskHealth,backup:s.storage?.latest?{snapshot:s.storage.latest.snapshot_id,cloudState:s.storage.latest.cloud_state,pending:s.storage.pending_uploads?.length}:s.storage,automationDiscovery:s.automationDiscovery,automations:s.automations.map(a=>({id:a.id,name:a.name,status:a.status,purpose:a.purpose,target_thread_id:a.target_thread_id,relatedInformation:a.relatedInformation,associationEvidence:a.associationEvidence,source:a.source})),models:s.models,cloud:s.cloud,cloudDailyVerified:s.cloud?.daily_cloud_schedule_verified});
try{
  const forward={collection:'task-collection',reports:'task-reports',tasks:'task-observations',handoff:'goal-handoff',context:'context-manager',resources:'resource-mount',knowledge:'knowledge-mount',objects:'object-knowledge',gemini:'gemini-executor',codex:'codex-executor',drive:'drive-storage',boss:'boss-access',map:'project-map',cloud:'cloud-recovery',workspace:'local-workspace',chats:'conversation-records',env:'runtime-inventory'};
  if(command==='module')process.exitCode=await runModule(process.argv[3],process.argv.slice(4));
  else if(command==='info'){
    const argv=process.argv.slice(3);
    if(!['status','inbox','item','search','request','iterate','iteration-status','iteration-feedback','ack','publish','queue','feedback','task-collect'].includes(argv[0]))throw Error('info status|inbox|item|search|request|iterate|iteration-status|iteration-feedback|ack|publish|queue|feedback|task-collect <arguments>');
    const result=await execute((process.env.AI_PYTHON_PATH || read(settingsFile).python_path || 'python'),[path.join(project,'信息中心/app/main.py'),...argv],1200000);
    console.log(result.data?JSON.stringify(result.data,null,2):JSON.stringify(result));process.exitCode=result.code===null?1:result.code;
  }
  else if(command==='local'){const {localCli}=await import(_publicURL("$codex/context/local-navigation.mjs"));const result=localCli(process.argv.slice(3));console.log(typeof result==='string'?result:JSON.stringify(result,null,2));}
  else if(forward[command])process.exitCode=await runModule(forward[command],process.argv.slice(3));
  else if(command==='search'){
    const sources={github:'github-search',domestic:'domestic-search',international:'international-search',public:'public-search',bilibili:'bilibili-collection'};
    if(!sources[process.argv[3]])throw new Error('search github|domestic|international|public|bilibili <module arguments>');
    process.exitCode=await runModule(sources[process.argv[3]],process.argv.slice(4));
  }
  else if(command==='events'){
    if(process.argv[3]==='process'){
      const options={};const argv=process.argv.slice(4);
      for(let i=0;i<argv.length;i+=2){if(!argv[i]?.startsWith('--')||!argv[i+1]||argv[i+1].startsWith('--'))throw Error('events process uses --option value');options[argv[i].slice(2)]=argv[i+1];}
      const {processEvents}=await import('./event-pipeline.mjs');
      const result=await processEvents(options);console.log(JSON.stringify(result,null,2));
      if(result.intake.failed.length||result.jobs.some(j=>['failed','retry','waiting_capability'].includes(j.state)))process.exitCode=2;
    }else{
    const sources={ingest:'event-ingest',dispatch:'event-dispatch'};
    if(!sources[process.argv[3]])throw new Error('events ingest|dispatch <module arguments>');
    process.exitCode=await runModule(sources[process.argv[3]],process.argv.slice(4));
    }
  }
  else if(command==='modules')console.log(JSON.stringify(moduleInventory(),null,2));
  else if(command==='resume'){const result=await recoverQueues();console.log(JSON.stringify(result,null,2));if(result.status==='partial')process.exitCode=2;}
  else if(['help','--help','-h'].includes(command))console.log('system.mjs status [--brief]|pulse|start|resume|serve|modules\ninfo iterate|iteration-status|iteration-feedback|status|inbox|item|search|request|ack|publish|queue|feedback <arguments>\ncollection request|run|status|show|search|host-requests|host-result|candidate|adopt <arguments>\nmodule KEY <owner CLI arguments>\nmodule context-manager <arguments>；context 为其别名\ncontext prepare|validate|apply|context|read <arguments>；context help 查完整参数\nsearch github|domestic|international|public <arguments>\nevents ingest|dispatch <arguments>\nevents process --routes ABS_JSON [--ingest-db FILE] [--dispatch-db FILE] [--source-thread ID] [--target-thread ID] [--providers ABS_MJS]\nreports|tasks|handoff|resources|knowledge|objects|gemini|drive|boss|map|cloud|workspace|chats|env <arguments>\nmodules只报告入口文件存在；实际调用、认证和长期运行查各模块原证。');
  else if(command==='serve')await serve();
  else if(command==='status'){const s=await inspect();console.log(JSON.stringify(process.argv.includes('--brief')?brief(s):s,null,2));if(s.health==='needs_attention')process.exitCode=2;}
  else if(command==='pulse'){const s=await pulse();console.log(JSON.stringify(s,null,2));if(s.status==='partial')process.exitCode=2;}
  else if(command==='start'){const s=await start();console.log(JSON.stringify(s,null,2));if(s.state.health==='needs_attention'||(s.information.code!==undefined&&s.information.code!==0))process.exitCode=2;}
  else throw new Error('用法: node system.mjs help');
}catch(e){console.error(e.message);process.exitCode=1;}

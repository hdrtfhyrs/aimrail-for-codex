import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
// Central adapter between the existing durable inbox, dispatcher and reports.
// No third queue, polling daemon, model monitor or automatic native message.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const home=path.dirname(fileURLToPath(import.meta.url));
const json=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
export async function processEvents(options={}){
  if(!options.routes)throw Error('events process requires --routes ABS_JSON with explicit full authorized task routes');
  const routes=json(path.resolve(options.routes)).routes;
  if(!Array.isArray(routes)||!routes.length)throw Error('routes must be a nonempty array');
  for(const route of routes)if(typeof route.source!=='string'||!route.source||typeof route.type!=='string'||!route.type||!route.task)throw Error('Each route requires exact source, type and a full task');
  const [{EventStore},{EventDispatcher,projectEvidenceProvider,importPendingEvents}]=await Promise.all([
    import(pathToFileURL(path.join(home,'event-ingest.mjs')).href),import(pathToFileURL(path.join(home,'event-dispatch.mjs')).href)]);
  const providers=[projectEvidenceProvider()];
  const providerFiles=options.providers?[options.providers]:['providers/gemini.mjs','providers/codex.mjs'].map(f=>path.join(home,f)).filter(f=>fs.existsSync(f));
  for(const providerFile of providerFiles){const extra=await import(pathToFileURL(path.resolve(providerFile)).href);providers.push(...await extra.createProviders());}
  const store=new EventStore({dbPath:options['ingest-db']});
  let queue;
  try{
    queue=new EventDispatcher({databasePath:options['dispatch-db'],artifactRoot:options.artifacts,providers});
    const recovered=queue.recover();
    const intake=await importPendingEvents({store,dispatcher:queue,limit:Number(options.limit||50),resolveTasks(event){
      const matches=routes.filter(r=>r.source===event.source&&r.type===event.type&&(!r.event_id||r.event_id===event.event_id));
      if(!matches.length)throw Error('No explicit authorized task route for '+event.source+'/'+event.type);
      return matches.map(r=>({...r.task,event_data:event.data,event_context:event.context,event_origin_kind:event.origin_kind}));
    }});
    const execution=await queue.drain({concurrency:Number(options.concurrency||1),maxJobs:Number(options.limit||50)});
    let reports={skipped:'--source-thread absent; durable outbox retained'};
    if(options['source-thread']){
      const {saveTaskReport}=await import(_publicURL("$codex/context/task-reports.mjs"));
      // Explicit stable ID works with the current inbox; no dedupe_key mismatch.
      reports=await queue.flushReports(async(report,job)=>saveTaskReport({source_thread_id:options['source-thread'],
        target_thread_id:options['target-thread']||job.task.report_to,project_ref:job.task.project_ref,branch_ref:job.task.branch_ref,
        kind:report.kind==='failure'?'coordination':report.kind,summary:report.summary||`${job.task.goal}: ${report.error}`,
        artifacts:report.artifacts||[],evidence:[report.result_ref||'',job.task.user_source].filter(Boolean),
        uncertainties:report.kind==='outcome'?[]:[report.next||''],authorization_ref:job.task.authorization_ref,event_id:report.id}));
    }
    return {at:new Date().toISOString(),recovered,intake,execution,reports,jobs:queue.list(),
      boundary:'Local explicit task routing and saved results; no vendor authentication or native window wakeup implied.'};
  }finally{queue?.close();store.close();}
}

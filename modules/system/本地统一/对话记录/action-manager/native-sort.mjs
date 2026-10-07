import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {AppServerClient} from './app-server-client.mjs';
const {AppClient,jsonContent} = await import(_publicURL("$system/本地统一/对话记录/original-manager/app-client.mjs"));
import {nativeSections,normalizeNativeSectionKeys} from './native-sections.mjs';
const project=_publicPath("$system");
const configFile=project+'/本地统一/对话记录/action-manager/native-routing-config.json';
const dbFile=_publicPath("$codex/state_5.sqlite");
const stateFile=_publicPath("$codex/.codex-global-state.json");
function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
function uiSections(){let data=readJson(stateFile)['electron-persisted-atom-state']['sidebar-custom-sections-v3'];if(typeof data==='string')data=JSON.parse(data);return Object.values(data).flatMap(scope=>scope.sections||[]);}
function members(sectionId){const db=new DatabaseSync(dbFile,{readOnly:true});try{return db.prepare('SELECT id,updated_at,section_position,archived FROM threads WHERE thread_section_id=? ORDER BY section_position,id').all(sectionId);}finally{db.close();}}
const desiredOrder=rows=>rows.slice().sort((a,b)=>b.updated_at-a.updated_at||a.id.localeCompare(b.id)).map(r=>r.id);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export async function sortNativeSections({projectPath=null,sectionId=null,client=null,receiptFile=null}={}){
 const config=readJson(configFile);if(!config.enabled)return {status:'disabled'};
 let appClient=client,ownedApp=false,server=null;
 const started=performance.now(),results=[];
 try{
  const mapped=projectPath?config.systems.find(s=>s.projectPath.replaceAll('\\','/').toLowerCase()===projectPath.replaceAll('\\','/').toLowerCase())?.sectionId:null;
  const groups=nativeSections().filter(s=>(!sectionId||s.sectionId===sectionId)&&(!projectPath||s.sectionId===mapped));
  const ui=uiSections();
  const plans=groups.map(g=>{const section=ui.find(s=>s.id===g.sectionId);if(!section)throw Error('Original UI section absent: '+g.name);const hostSectionId=section.hostSectionIds?.local;if(!hostSectionId)throw Error('Native host section mapping absent: '+g.name);const rows=members(hostSectionId);return {...g,hostSectionId,rows,desired:desiredOrder(rows),before:rows.map(r=>r.id),uiBefore:section.itemKeys.map(k=>k.split(':').at(-1))};});
  const changed=plans.filter(p=>!equal(p.desired,p.before)||!equal(p.desired,p.uiBefore));
  if(changed.length){
   if(!appClient){appClient=new AppClient();ownedApp=true;await appClient.initialize();}
   const owner=readJson(project+'/本地统一/对话记录/original-manager/current-original-process.json');
   const executable=path.join(path.dirname(owner.executablePath),'resources','codex.exe');
   if(!owner.originalPackage||!fs.existsSync(executable))throw Error('Verified current official app-server unavailable');
   server=new AppServerClient(executable);await server.initialize();
   const list=await server.request('threadSection/list',{});
   for(const plan of changed){
    if(!list.data.some(s=>s.id===plan.hostSectionId&&s.name===plan.name))throw Error('Server section identity mismatch');
    // First align native UI. Its bulk operation may schedule host moves in a
    // different order, so the supported host operation is applied afterward.
    await appClient.call('reorder_section',{sectionId:plan.sectionId,threadIds:plan.desired});
    let current=members(plan.hostSectionId).map(r=>r.id),beforeThreadId=null,moves=0;
    for(const id of plan.desired.slice().reverse()){
     const index=current.indexOf(id);
     if(index<0)throw Error('Membership changed during sorting; preserve concurrent work');
     const correct=beforeThreadId===null?index===current.length-1:current[index+1]===beforeThreadId;
     if(!correct){await server.request('thread/section/move',{threadId:id,sectionId:plan.hostSectionId,beforeThreadId});moves++;current.splice(index,1);current.splice(beforeThreadId===null?current.length:current.indexOf(beforeThreadId),0,id);}
     beforeThreadId=id;
    }
    const afterRows=members(plan.hostSectionId),after=afterRows.map(r=>r.id);
    if(!equal(after,plan.desired))throw Error('Saved native order does not match requested order');
    if(!equal([...after].sort(),[...plan.before].sort()))throw Error('Membership changed; no member removal was attempted');
    const timestampsChanged=afterRows.filter(r=>plan.rows.find(old=>old.id===r.id)?.updated_at!==r.updated_at).map(r=>r.id);
    results.push({name:plan.name,sectionId:plan.sectionId,hostSectionId:plan.hostSectionId,count:after.length,moves,changed:true,persistedOrderMatches:true,timestampsChanged,firstThreadIds:after.slice(0,5),beforeThreadIds:plan.before,orderedThreadIds:after});
   }
  }
  for(const plan of plans.filter(p=>!changed.includes(p)))results.push({name:plan.name,sectionId:plan.sectionId,count:plan.desired.length,changed:false,persistedOrderMatches:true,firstThreadIds:plan.desired.slice(0,5)});
  // The state file can contain canonical IDs while the running UI still
  // exposes client-new-thread aliases. Verify both, never only the file.
  const finalUi=uiSections();
  if(!appClient){appClient=new AppClient();ownedApp=true;await appClient.initialize();}
  const live=jsonContent(await appClient.call('list_threads',{limit:1}));
  for(const result of results){const plan=plans.find(p=>p.sectionId===result.sectionId);const saved=finalUi.find(s=>s.id===plan.sectionId);const displayed=live.sections?.find(s=>s.sectionId===plan.sectionId);result.savedUiOrderMatches=equal(saved.itemKeys.map(k=>k.split(':').at(-1)),plan.desired);result.uiOrderMatches=equal(normalizeNativeSectionKeys(displayed,saved),plan.desired.map(id=>'codex:thread:local:'+id));result.screenRenderingVerified=false;}
  const result={at:new Date().toISOString(),status:results.every(r=>r.uiOrderMatches)?'sorted':'saved-ui-unverified',sortBy:'original threads.updated_at DESC',milliseconds:Math.round(performance.now()-started),sections:results,appPackageChanged:false,appRestarted:false,periodicListener:false};
  if(receiptFile)fs.writeFileSync(receiptFile,JSON.stringify(result,null,2));return result;
 }finally{server?.close();if(ownedApp)appClient?.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=path.resolve('outputs/原生时间排序');fs.mkdirSync(root,{recursive:true});
 fs.copyFileSync(stateFile,root+'/排序前原生配置.json');
 const result=await sortNativeSections({receiptFile:root+'/时间排序回执.json'});
 console.log(JSON.stringify({...result,sections:result.sections.map(({beforeThreadIds,orderedThreadIds,...s})=>s)}));
}

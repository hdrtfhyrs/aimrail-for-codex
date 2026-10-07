import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sortNativeSections} from './native-sort.mjs';
import {AppClient,jsonContent} from '../original-manager/app-client.mjs';
import {nativeSections,currentNativeSection,resolveNativeTarget,normalizeNativeSectionKeys} from './native-sections.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const configFile=_publicDataPath("本地统一/对话记录/action-manager/native-routing-config.json");
const movesFile=_publicDataPath("本地统一/对话记录/action-manager/native-routing-receipts.json");
const read=(p,fallback)=>{try{return JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const norm=p=>String(p||'').replaceAll('\\','/').replace(/\/$/,'').toLowerCase();
export function verifyLiveMembership(live,threadId,sectionId,savedSections=[]){
 const key='codex:thread:local:'+threadId;
 const section=live.sections?.find(s=>s.sectionId===sectionId);
 const actual=live.sections?.find(s=>s.itemKeys?.includes(key));
 const temporaryKeys=section?.itemKeys?.filter(k=>k.startsWith('codex:thread:local:client-new-thread:'))||[];
 if(section?.itemKeys?.includes(key))return {confirmed:true,sectionId,observedSectionId:sectionId,identityEvidence:'canonical-api-key',temporaryKeys,screenRenderingVerified:false};
 // The native renderer deliberately converts canonical saved keys to stable
 // client keys without changing their positions (h4r/U2r in this release).
 // Correlate only a whole, otherwise identical section; never guess from
 // title, recency, count alone, or a lone temporary key.
 const saved=savedSections.find(s=>s.sectionId===sectionId);
 const raw=saved?.itemKeys||[],shown=section?.itemKeys||[];
 const compatible=normalizeNativeSectionKeys(section,saved)!==null;
 const index=raw.indexOf(key);
 if(compatible&&index>=0)return {confirmed:true,sectionId,observedSectionId:sectionId,identityEvidence:'canonical-saved-key-and-ordered-native-api-alias',displayKey:shown[index],temporaryKeys,screenRenderingVerified:false};
 return {confirmed:false,sectionId,observedSectionId:actual?.sectionId||null,identityEvidence:'unresolved-api-identity',temporaryKeys,screenRenderingVerified:false};
}
function mutate(file,fn){let fd;const lock=file+'.lock';try{fd=fs.openSync(lock,'wx');const value=fn(read(file,{moves:{}}));const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n');fs.renameSync(temp,file);return value;}finally{if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}}}
export async function syncNativeDecision(decision,{client,force=false,sort=false}={}){
 const config=read(configFile,null);
 if(!config?.enabled||(!decision?.project&&!decision?.sectionId)||decision.status==='unassigned')return {status:'not-applicable'};
 const prior=read(movesFile,{moves:{}}).moves[decision.threadId];
 const sections=nativeSections(),current=currentNativeSection(decision.threadId,sections);
 const resolved=resolveNativeTarget({decision,sections,systems:config.systems,prior,currentSectionId:current?.sectionId||null});
 if(resolved.status!=='target')return {...resolved,threadId:decision.threadId};
 const system=resolved.section;
 const pipe=process.env.CODEX_APP_TOOLS_PIPE_PATH;
 const already=!force&&current?.sectionId===system.sectionId;
 let owned=false,c=client;
 try{
  if(!c){c=new AppClient(decision.threadId,{timeoutMs:5000});owned=true;await c.initialize();}
  const live=jsonContent(await c.call('list_threads',{limit:50}));
  if(!live.sections?.some(s=>s.sectionId===system.sectionId))return {status:'target-section-unavailable',threadId:decision.threadId};
  if(already){
   const observed=verifyLiveMembership(live,decision.threadId,system.sectionId,nativeSections());
   if(!observed.confirmed)return {status:'saved-ui-unverified',threadId:decision.threadId,sectionId:system.sectionId,verification:observed};
   const sorting=sort&&config.sorting?.mode==='updated_at'?await sortNativeSections({sectionId:system.sectionId,client:c,receiptFile:_publicDataPath("本地统一/对话记录/action-manager/native-sort-last.json")}):null;
   const verification=verifyLiveMembership(jsonContent(await c.call('list_threads',{limit:50})),decision.threadId,system.sectionId,nativeSections());
   return {status:verification.confirmed?'already-applied':'saved-ui-unverified',threadId:decision.threadId,sectionId:system.sectionId,verification,sorting};
  }
  const fresh=currentNativeSection(decision.threadId);
  if((fresh?.sectionId||null)!==(current?.sectionId||null))return {status:'preserved-concurrent-section-change',threadId:decision.threadId};
  const result=jsonContent(await c.call('move_thread_to_sidebar_section',{source:'codex',hostId:'local',threadId:decision.threadId,sectionId:system.sectionId}));
  const receipt={at:new Date().toISOString(),threadId:decision.threadId,project:norm(decision.project),sectionId:system.sectionId,pipe,result};
  mutate(movesFile,state=>({...state,moves:{...state.moves,[decision.threadId]:receipt}}));
  const sorting=sort&&config.sorting?.mode==='updated_at'?await sortNativeSections({sectionId:system.sectionId,client:c,receiptFile:_publicDataPath("本地统一/对话记录/action-manager/native-sort-last.json")}):null;
  const verification=verifyLiveMembership(jsonContent(await c.call('list_threads',{limit:50})),decision.threadId,system.sectionId,nativeSections());
  return {status:verification.confirmed?'applied':'saved-ui-unverified',threadId:decision.threadId,sectionId:system.sectionId,result,verification,sorting};
 }catch(error){return {status:'failed',threadId:decision.threadId,error:error.message};}
 finally{if(owned)c.close();}
}
export async function applyNativeBatch(items,{receiptFile}={}){
 const c=new AppClient(),results=[];const start=performance.now();
 try{await c.initialize();for(const item of items){results.push(await syncNativeDecision({...item,explicitNativeTarget:item.nativeAction==='move'&&!!String(item.userDirective||'').trim()&&!!String(item.directiveSource||'').trim()},{client:c,force:true,sort:false}));if(results.length%30===0)process.stderr.write(JSON.stringify({completed:results.length,total:items.length})+'\n');}
  const sorting=null;
  const proof=jsonContent(await c.call('list_threads',{limit:50}));
  const unverified=results.filter(r=>r.status==='saved-ui-unverified');
  const summary={at:new Date().toISOString(),status:unverified.length?'saved-ui-unverified':'processed',requested:items.length,applied:results.filter(r=>r.status==='applied').length,unverified,failed:results.filter(r=>r.status==='failed'),milliseconds:Math.round(performance.now()-start),sections:proof.sections,preferences:proof.sidebarPreferences,results,periodicWorker:false};
  if(receiptFile)fs.writeFileSync(receiptFile,JSON.stringify(summary,null,2));
  return summary;
 }finally{c.close();}
}

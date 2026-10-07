import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../../public-paths.mjs";
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const stateFile=_publicPath("$codex/.codex-global-state.json");
const dbFile=_publicPath("$codex/state_5.sqlite");
const norm=p=>String(p||'').replaceAll('\\','/').replace(/\/$/,'').toLowerCase();

// Read the original app's current groups on every operation, including groups
// created in the UI. A sidebar group does not require a project/core file.
export function nativeSections(){
 const state=JSON.parse(fs.readFileSync(stateFile,'utf8').replace(/^\uFEFF/,''));
 return sectionsFromState(state);
}
export function sectionsFromState(state){
 let scopes=state['electron-persisted-atom-state']?.['sidebar-custom-sections-v3'];
 if(typeof scopes==='string')scopes=JSON.parse(scopes);
 const sections=Object.values(scopes||{}).flatMap(s=>s.sections||[]);
 return sections.filter(s=>s.hostSectionIds?.local).map(s=>({sectionId:s.id,name:s.name,hostSectionId:s.hostSectionIds.local,itemKeys:s.itemKeys||[]}));
}
export function currentNativeSection(threadId,sections=nativeSections()){
 const db=new DatabaseSync(dbFile,{readOnly:true});
 try{const row=db.prepare('SELECT thread_section_id FROM threads WHERE id=?').get(threadId);
  if(!row)throw Error('Original thread membership unavailable');
  if(!row.thread_section_id)return null;
  const section=sections.find(s=>s.hostSectionId===row.thread_section_id);
  if(!section)throw Error('Current group is not yet in original UI catalog; preserve membership');
  return section;
 }finally{db.close();}
}
export const catalogVersion=sections=>JSON.stringify(sections.map(s=>[s.sectionId,s.name]).sort((a,b)=>a[0].localeCompare(b[0])));
export function normalizeNativeSectionKeys(displayed,saved){
 const raw=saved?.itemKeys||[],shown=displayed?.itemKeys||[];
 if(!raw.length||raw.length!==shown.length||new Set(raw).size!==raw.length||new Set(shown).size!==shown.length)return null;
 return raw.every((item,i)=>item===shown[i]||(/^codex:thread:local:[0-9a-f-]{36}$/i.test(item)&&/^codex:thread:local:client-new-thread:[0-9a-f-]{36}$/i.test(shown[i])))?raw:null;
}
export function resolveNativeTarget({decision,sections,systems=[],prior,currentSectionId=null}){
 // Only a fresh semantic commit can override an observed user move. Force is
 // a retry flag, never permission to overwrite the user's current grouping.
 if(!decision.explicitNativeTarget){
  if(prior&&currentSectionId!==prior.sectionId)return {status:'preserved-user-section',sectionId:currentSectionId};
  if(!prior&&currentSectionId)return {status:'preserved-existing-section',sectionId:currentSectionId};
 }
 if(decision.sectionId){
  if(!decision.explicitNativeTarget&&currentSectionId&&decision.sectionId!==currentSectionId)return {status:'preserved-existing-section',sectionId:currentSectionId};
  const section=sections.find(s=>s.sectionId===decision.sectionId);
  return section?{status:'target',section}:{status:'target-section-unavailable'};
 }
 const mapped=systems.find(s=>norm(s.projectPath)===norm(decision.project));
 const section=sections.find(s=>s.sectionId===mapped?.sectionId);
 if(!decision.explicitNativeTarget&&currentSectionId&&section?.sectionId!==currentSectionId)return {status:'preserved-existing-section',sectionId:currentSectionId};
 return section?{status:'target',section}:{status:'semantic-required'};
}

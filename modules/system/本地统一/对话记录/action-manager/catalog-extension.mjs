import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {nativeSections,catalogVersion} from './native-sections.mjs';
import {projectDirectory} from './project-registry.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const records=path.dirname(here);
const layoutFile=path.join(records,'organization.json');
const stateFile=_publicDataPath("本地统一/对话记录/action-manager/decisions.json");
const projectRoot=_publicPath("$projects");
const norm=p=>String(p||'').replaceAll('\\','/').replace(/\/$/,'').toLowerCase();
const read=(p,d)=>{try{return JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));}catch(e){if(e.code==='ENOENT')return d;throw e;}};
export const groupProject=g=>g.projectPath||projectRoot+'/'+g.project;
function transaction(file,edit){
 const lock=file+'.lock';let fd;
 try{fd=fs.openSync(lock,'wx');const prior=read(file,{schemaVersion:1,decisions:{},groups:[]});const result=edit(structuredClone(prior));
  const stamp=new Date().toISOString().replaceAll(':','-');const recovery=path.join(here,'recovery');fs.mkdirSync(recovery,{recursive:true});
  if(fs.existsSync(file))fs.copyFileSync(file,path.join(recovery,path.basename(file)+'.'+stamp+'.json'));
  const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(result.value,null,2)+'\n');fs.renameSync(tmp,file);return result.receipt;
 }finally{if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}}
}
export function catalog(){const directory=projectDirectory();return {nativeSections:nativeSections().map(({itemKeys,...s})=>({...s,memberCount:itemKeys.length})),systems:directory.projects,errors:directory.errors,roots:directory.roots,createRoot:directory.createRoot,source:directory.source,legacyDutiesSource:layoutFile};}
export function addSystem(input){
 const name=String(input.name||'').trim(),p=input.projectPath||projectRoot+'/'+name;
 if(!name||/[\\/\x00-\x1f]/.test(name)||!path.isAbsolute(p))throw Error('Provide a system name and absolute projectPath');
 const groups=input.groups||[];if(!groups.length)throw Error('Provide at least one responsibility group');
 for(const g of groups)if(!/^[a-z][a-z0-9-]{1,79}$/.test(g.key||'')||!String(g.name||'').trim()||!String(g.description||'').trim())throw Error('Each group needs unique key, name and responsibility description');
 if(new Set(groups.map(g=>g.key)).size!==groups.length)throw Error('Duplicate group keys');
 return transaction(layoutFile,l=>{
  const conflict=l.groups.find(g=>groups.some(n=>n.key===g.key&&(norm(groupProject(g))!==norm(p)||n.name!==g.name||n.description!==g.description)));
  if(conflict)throw Error('Existing responsibility key conflicts: '+conflict.key);
  const systems=l.systems||catalog().systems.map(({name,projectPath})=>({name,projectPath}));
  const existing=systems.find(s=>norm(s.projectPath)===norm(p));if(existing&&existing.name!==name)throw Error('Existing system has another display name');
  if(!existing)systems.push({name,projectPath:p});
  let added=0;for(const g of groups)if(!l.groups.some(x=>x.key===g.key)){l.groups.push({...g,project:name,projectPath:p,branches:g.branches||[],threads:[]});added++;}
  return {value:{...l,systems,updatedAt:new Date().toISOString()},receipt:{status:'saved',system:name,projectPath:p,addedGroups:added,goalsCreated:false,refresh:'Next actual sidebar operation; no polling or application restart required'}};
 });
}
export function batchArchive(input){
 const entries=input.decisions;if(!Array.isArray(entries)||!entries.length)throw Error('decisions array required');
 if(new Set(entries.map(d=>d.threadId)).size!==entries.length)throw Error('Duplicate thread decisions');
 const groups=read(layoutFile,{groups:[]}).groups;
 const sections=nativeSections();
 const db=new DatabaseSync(_publicPath("$codex/state_5.sqlite"),{readOnly:true});let rows;
 try{rows=new Map(db.prepare("SELECT id,archived,source,agent_path,thread_source FROM threads").all().map(r=>[r.id,r]));}finally{db.close();}
 const prepared=entries.map(d=>{
  const r=rows.get(d.threadId),g=groups.find(g=>g.key===d.groupKey);
  if(!r||r.archived||!['desktop','vscode'].includes(r.source)||r.agent_path||/subagent/i.test(r.thread_source||''))throw Error('Not an active local root chat: '+d.threadId);
  const section=d.sectionId?sections.find(s=>s.sectionId===d.sectionId):null;
  if((d.sectionId&&!section)||(!section&&(!g||norm(d.project)!==norm(groupProject(g))))||!String(d.reason||'').trim())throw Error('Invalid evidence-based target: '+d.threadId);
  const b=read(_publicPath("$codex/context/bindings/codex/")+d.threadId+'.json',null);
  if(b&&d.project&&norm(b.project)!==norm(d.project))throw Error('Explicit binding conflict: '+d.threadId);
  return {threadId:d.threadId,status:'classified',project:b?.project||d.project||null,groupKey:g?.key||null,groupName:section?.name||g.name,sectionId:section?.sectionId||null,nativeCatalogVersion:catalogVersion(sections),branchId:b?.branchId||null,reason:d.reason,source:'reviewed-semantic-batch',at:new Date().toISOString(),viewOnly:true,semanticPending:!!d.semanticPending,nativeMoveApplied:false};
 });
 if(input.dryRun)return {status:'validated',count:prepared.length,mutated:false};
 return transaction(stateFile,s=>{let changed=0;for(const d of prepared){const prior=s.decisions[d.threadId];if(JSON.stringify({...prior,at:null})!==JSON.stringify({...d,at:null})){s.decisions[d.threadId]=d;changed++;}}
  return {value:{...s,updatedAt:new Date().toISOString()},receipt:{status:'archived',count:prepared.length,changed,writeOperations:1,executionBindingsChanged:0,chatContentsChanged:0,chatTimestampsChanged:0,source:stateFile}};
 });
}

import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../../public-paths.mjs";
// Persistent file-project directory. Semantic decisions belong to the current
// task AI; this module performs deterministic storage and native presentation.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {AppClient,jsonContent} from '../original-manager/app-client.mjs';
import {nativeSections} from './native-sections.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY=_publicPath("$codex/context/projects.json");
const CONFIG=_publicDataPath("本地统一/对话记录/action-manager/native-routing-config.json");
const LAYOUT=_publicDataPath("本地统一/对话记录/organization.json");
const NATIVE_CREATIONS=_publicDataPath("本地统一/对话记录/action-manager/project-native-creations.json");
export const norm=p=>String(p||'').replaceAll('\\','/').replace(/\/$/,'').toLowerCase();
const label=p=>String(p||'').normalize('NFKC').trim().toLowerCase();
const read=(p,d)=>{try{return JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));}catch(e){if(e.code==='ENOENT')return d;throw e;}};
const defaults=()=>({schemaVersion:1,roots:[_publicPath("$projects"),_publicPath("$projects")],createRoot:_publicPath("$projects"),projects:[]});
export function projectRegistry(){return {...defaults(),...read(REGISTRY,{})};}
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n');fs.renameSync(temp,file);}
function lock(file){fs.mkdirSync(path.dirname(file),{recursive:true});const fd=fs.openSync(file+'.lock','wx');return ()=>{fs.closeSync(fd);fs.unlinkSync(file+'.lock');};}
export function projectDirectory({roots}={}){
 const registry=projectRegistry(),layout=read(LAYOUT,{groups:[],systems:[]}),mapping=read(CONFIG,{systems:[]});
 const entries=new Map(),errors=[];
 function add(p,s={}){if(!p||!path.isAbsolute(p))return;const key=norm(p),prior=entries.get(key);entries.set(key,{name:path.basename(p),projectPath:p,aliases:[],...prior,...s,projectPath:p});}
 for(const s of layout.systems||[])add(s.projectPath,s);
 for(const g of layout.groups||[])add(g.projectPath||_publicPath("$projects/")+g.project,{name:g.project});
 for(const root of roots||registry.roots){if(!fs.existsSync(root))continue;for(const e of fs.readdirSync(root,{withFileTypes:true})){if(e.isDirectory()&&fs.existsSync(path.join(root,e.name,'核心.md')))add(path.join(root,e.name));}}
 for(const s of registry.projects)add(s.projectPath,s);
 const retired=new Set(registry.projects.flatMap(s=>s.supersedesPaths||[]).map(norm));
 const projects=[];
 for(const p of entries.values()){
  if(retired.has(norm(p.projectPath)))continue;
  const core=path.join(p.projectPath,'核心.md');if(!fs.existsSync(core)){errors.push({project:p.projectPath,reason:'核心原件不存在'});continue;}
  try{const text=fs.readFileSync(core,'utf8').replace(/^\uFEFF/,''),goal=text.match(/^#{1,6}\s+最终要做出什么[^\S\r\n]*\r?\n([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/m)?.[1]||text;
   projects.push({...p,core,goal:goal.split(/\r?\n\s*\r?\n/).map(s=>s.trim()).find(s=>s&&!/^(#|>|<!--)/.test(s))||'',sectionId:p.sectionId||mapping.systems.find(s=>norm(s.projectPath)===norm(p.projectPath))?.sectionId||null,groups:(layout.groups||[]).filter(g=>norm(g.projectPath||_publicPath("$projects/")+g.project)===norm(p.projectPath))});
  }catch(e){errors.push({project:p.projectPath,reason:e.message});}
 }
 return {projects:projects.sort((a,b)=>a.name.localeCompare(b.name)),errors,roots:roots||registry.roots,source:REGISTRY,createRoot:registry.createRoot};
}
function identity(input,directory){const names=[input.name,...(input.aliases||[])].map(label);return directory.projects.filter(p=>norm(p.projectPath)===norm(input.projectPath)||[p.name,...(p.aliases||[])].some(n=>names.includes(label(n))));}
function valid(input){if(!input||typeof input!=='object')throw Error('Project JSON required');if(!String(input.name||'').trim()||/[\\/<>:"|?*\x00-\x1f]/.test(input.name)||/[. ]$/.test(input.name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(input.name))throw Error('Valid project name required');if(input.aliases!==undefined&&(!Array.isArray(input.aliases)||input.aliases.some(a=>!String(a).trim())))throw Error('aliases must contain nonempty names');if(!String(input.reason||'').trim())throw Error('Purpose-based relationship reason required');}
async function sectionFor(input,p){
 if(input.native===false)return null;
 const sections=nativeSections();
 if(input.sectionId){const s=sections.find(s=>s.sectionId===input.sectionId);if(!s)throw Error('sectionId must be a current native section');return s;}
 if(p.sectionId){const s=sections.find(s=>s.sectionId===p.sectionId);if(!s)throw Error('Mapped section has been deleted; specify a current section or native:false');return s;}
 const names=[p.name,...(p.aliases||[])].map(label),matches=sections.filter(s=>names.includes(label(s.name)));
 if(matches.length>1)throw Error('Multiple existing sections match this project; provide exact sectionId');
 if(matches.length)return matches[0];
 if(!/^[0-9a-f-]{36}$/i.test(input.threadId||''))throw Error('Caller threadId required for native section creation');
 const c=new AppClient(input.threadId),key=norm(p.projectPath);try{
  await c.initialize();
  const live=jsonContent(await c.call('list_threads',{limit:1})),liveMatches=(live.sections||[]).filter(s=>names.includes(label(s.name)));
  if(liveMatches.length>1)throw Error('Multiple live native sections match; specify sectionId');
  if(liveMatches.length===1)return liveMatches[0];
  const journal=read(NATIVE_CREATIONS,{creations:{}}),prior=journal.creations[key];
  if(prior?.sectionId)return {sectionId:prior.sectionId,name:p.name};
  if(prior)throw Error('Prior native creation outcome is unknown and no matching live section is visible; preserve pending journal and recover before another creation');
  journal.creations[key]={name:p.name,status:'requested',at:new Date().toISOString()};write(NATIVE_CREATIONS,journal);
  const created=jsonContent(await c.call('create_sidebar_section',{name:p.name}));const id=created.sectionId||created.id||created.section?.sectionId||created.section?.id;
  if(!id)throw Error('Native creation outcome needs recovery: '+JSON.stringify(created));
  journal.creations[key]={...journal.creations[key],status:'created',sectionId:id};write(NATIVE_CREATIONS,journal);
  return {sectionId:id,name:p.name};
 }finally{c.close();}
}
async function registerLocked(input,registry,directory){
 const matches=identity(input,directory);if(matches.length>1)throw Error('Project identity is ambiguous; reuse a precise existing project');
 const matched=matches[0];if(matched&&input.projectPath&&norm(matched.projectPath)!==norm(input.projectPath))throw Error('Name/alias already belongs to '+matched.projectPath+'; reuse it or perform an explicit migration');
 const p=input.projectPath||matched?.projectPath;if(!p||!path.isAbsolute(p)||!fs.existsSync(path.join(p,'核心.md'))||!fs.existsSync(path.join(p,'共享状态.md')))throw Error('Existing project requires absolute projectPath, core and shared-state originals');
 const old=registry.projects.find(s=>norm(s.projectPath)===norm(p))||matched||{};
 const project={id:old.id||'project-'+createHash('sha256').update(norm(p)).digest('hex').slice(0,16),name:old.name||input.name,projectPath:p,aliases:[...new Set([...(old.aliases||[]),...(input.aliases||[]),...(old.name&&old.name!==input.name?[input.name]:[])])],purpose:input.purpose||old.purpose||matched?.goal||'',reason:input.reason,relations:input.relations||old.relations||[],supersedesPaths:input.supersedesPaths||old.supersedesPaths||[],registeredAt:old.registeredAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
 const section=await sectionFor(input,{...old,...project});project.sectionId=section?.sectionId||old.sectionId||null;
 if(section){const release=lock(CONFIG);try{const config=read(CONFIG,{schemaVersion:1,enabled:true,systems:[]}),systems=config.systems||[];const keep=systems.filter(s=>norm(s.projectPath)!==norm(p));write(CONFIG,{...config,systems:[...keep,{name:project.name,projectPath:p,sectionId:section.sectionId}]});}finally{release();}}
 registry.projects=registry.projects.filter(s=>norm(s.projectPath)!==norm(p));registry.projects.push(project);registry.updatedAt=project.updatedAt;write(REGISTRY,registry);
 return {status:matched?'registered-existing-project':'registered-project',project,registry:REGISTRY,nativeMapping:section?CONFIG:null,filesOverwritten:false,nativeMoved:false};
}
export async function registerProject(input){valid(input);const release=lock(REGISTRY);try{return await registerLocked(input,projectRegistry(),projectDirectory());}finally{release();}}
export async function createProject(input){
 valid(input);if(input.disposition!=='independent'||!String(input.independentReason||'').trim()||!String(input.reuseAssessment||'').trim())throw Error('Independent project requires disposition, independentReason and existing-project reuseAssessment');
 const release=lock(REGISTRY);try{
  const registry=projectRegistry(),directory=projectDirectory(),matches=identity(input,directory);
  if(matches.length>1)throw Error('Ambiguous existing project; specify identity');
  if(matches.length)return {...await registerLocked({...input,projectPath:matches[0].projectPath},registry,directory),reused:true};
  const root=registry.createRoot,p=input.projectPath||path.join(root,input.name);if(!path.isAbsolute(p))throw Error('Absolute projectPath required');
  const relation=path.relative(root,p);if(!relation||relation.startsWith('..')||path.isAbsolute(relation))throw Error('New project must be inside configured createRoot '+root);
  const docs=input.documents||{};for(const k of ['core','state','overview'])if(!String(docs[k]||'').trim())throw Error('Full '+k+' original required, generated from the actual authorized task');
  if(!/<!--\s*shared-state revision:\d+\s*-->/.test(docs.state))throw Error('state requires the shared-state revision header');
  for(const title of ['共同条件','当前分支','已完成里程碑'])if([...docs.state.matchAll(new RegExp('^##\\s+'+title+'\\s*$','gm'))].length!==1)throw Error('state requires exactly one '+title+' section');
  const active=docs.state.match(/^##\s+当前分支\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m)?.[1]||'';
  const markers=[...active.matchAll(/^###\s+.+?\s*<!--\s*branch:([A-Za-z0-9_-]+)\s*-->\s*$/gm)];
  if(!markers.length||new Set(markers.map(m=>m[1])).size!==markers.length)throw Error('state requires unique real active branch IDs');
  for(let i=0;i<markers.length;i++){
   const chunk=active.slice(markers[i].index,markers[i+1]?.index||active.length),fields=[...chunk.matchAll(/^[-*]\s+([^：:\n]+)[：:]\s*(.+)$/gm)];
   for(const key of ['阶段','负责人','已做','下一步','有效条件','主线','依据','本轮目标','完成标准'])if(fields.filter(m=>m[1].trim()===key).length!==1)throw Error('Active branch '+markers[i][1]+' requires complete unique '+key+' field');
  }
  if(fs.existsSync(p))throw Error('Unregistered existing directory; inspect it and use register-project, never overwrite it');
  fs.mkdirSync(p,{recursive:true});fs.mkdirSync(path.join(p,'主线'));fs.mkdirSync(path.join(p,'成果'));
  for(const [file,body]of [['核心.md',docs.core],['共享状态.md',docs.state],['项目概况.md',docs.overview],['进展.md',docs.progress||'# 进展\n\n独立项目已建立，实际业务进度沿共享状态原件。'],['成果/INDEX.md',docs.deliverablesIndex||'# 成果\n\n尚无登记成果。']])fs.writeFileSync(path.join(p,file),body+'\n',{flag:'wx'});
  const seed={...input,projectPath:p,reason:input.reason+'；独立理由：'+input.independentReason+'；复用判断：'+input.reuseAssessment};
  // Save a recoverable identity before native I/O. If the native tool fails,
  // register-project retries these same originals without re-creating them.
  registry.projects.push({id:'project-'+createHash('sha256').update(norm(p)).digest('hex').slice(0,16),name:input.name,projectPath:p,aliases:input.aliases||[],purpose:input.purpose||'',reason:seed.reason,nativePending:input.native!==false});write(REGISTRY,registry);
  try{return {...await registerLocked(seed,registry,projectDirectory()),created:true,files:path.join(p,'核心.md')};}
  catch(e){throw Error('Project originals saved at '+p+'; native registration incomplete, retry register-project. '+e.message);}
 }finally{release();}
}

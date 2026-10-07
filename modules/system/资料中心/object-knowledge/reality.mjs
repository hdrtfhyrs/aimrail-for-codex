import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../public-paths.mjs";
// Observable facts and resource federation. Never writes human object claims or the registry.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
export const REALITY_FILE=path.join(_publicDataPath("资料中心/object-knowledge/data"),'reality.json');
export const REGISTRY_FILE=_publicDataPath("资料中心/data/资料登记.json");
export const REALITY_TTL_MS=60000;
const json=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean=value=>String(value??'').replace(/https?:\/\/[^\s"'<>]+/gi,url=>{try{const u=new URL(url);u.username='';u.password='';for(const k of [...u.searchParams.keys()])if(/token|key|secret|password|auth|signature|cookie|session|code/i.test(k))u.searchParams.set(k,'[已隐藏]');if(/token|secret|password|auth|signature/i.test(u.hash))u.hash='[已隐藏]';return u.href;}catch{return '[链接不可解析]';}}).replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,}|github_pat_[\w]{12,}|AIza[\w-]{20,})\b/g,'[凭据已隐藏]').replace(/\bBearer\s+[\w.~+\/-]+=*/gi,'Bearer [已隐藏]').replace(/((?:password|secret|token|cookie|authorization|密码|密钥|凭据)\s*[:：=]\s*)[^\n,;]+/gi,'$1[已隐藏]');
function files(options={}){return {cache:options.realityFile||(options.file?path.join(path.dirname(options.file),'reality.json'):REALITY_FILE),registry:options.registryFile||(options.file?null:REGISTRY_FILE)};}
export function readReality(options={}){try{if(options.file&&!options.realityFile)throw Error('isolated');const c=json(files(options).cache);if(c.format!=='object-reality-v1'||!Array.isArray(c.models))throw Error('现实观察缓存格式无效');return c;}catch(error){return {format:'object-reality-v1',lastAttemptAt:null,lastSuccessAt:null,status:fs.existsSync(files(options).cache)&&!(options.file&&!options.realityFile)?'observation-file-unavailable':'unobserved',error:clean(error.message),models:[]};}}
export function realityStatus(options={}){
 const c=readReality(options),at=Date.parse(options.asOf||new Date().toISOString()),age=c.lastSuccessAt?Math.max(0,at-Date.parse(c.lastSuccessAt)):null;
 return {status:c.status,lastAttemptAt:c.lastAttemptAt,lastSuccessAt:c.lastSuccessAt,ageMs:age,stale:c.status!=='ok'||age===null||age>REALITY_TTL_MS,error:c.error||null,ttlMs:REALITY_TTL_MS,coverage:'查询前按需刷新Ollama列表；无查询时不持续采集；运行列表不证明生成质量',lastChanges:c.lastChanges||[]};
}
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n');fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}}
export async function refreshReality(options={}){
 const {cache}=files(options),prior=readReality(options),at=new Date().toISOString(),ttl=Number(options.ttlMs??REALITY_TTL_MS);
 if(!options.force&&prior.lastAttemptAt&&Date.now()-Date.parse(prior.lastAttemptAt)<ttl)return {...realityStatus(options),trigger:'cached'};
 fs.mkdirSync(path.dirname(cache),{recursive:true});const lock=cache+'.lock';let fd;
 try{fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at}));}
 catch(error){if(error.code!=='EEXIST')return {...realityStatus(options),trigger:'unavailable',error:error.message};
  try{const owner=json(lock);try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH'){fs.unlinkSync(lock);return refreshReality(options);}}}catch{}
  return {...realityStatus(options),trigger:'another-refresh-in-progress'};
 }
 try{
  const timeoutMs=Math.max(50,Math.min(5000,Number(options.timeoutMs)||1200));
  const response=await (options.fetch||fetch)((options.endpoint||'http://127.0.0.1:11434')+'/api/tags',{signal:AbortSignal.timeout(timeoutMs)});
  if(!response.ok)throw Error('Ollama HTTP '+response.status);
  const body=await response.json();if(!Array.isArray(body.models)||body.models.some(m=>typeof m.name!=='string'||!m.name||typeof m.digest!=='string'))throw Error('Ollama模型列表格式无效');
  const models=body.models.map(m=>({name:m.name,model:m.model||m.name,digest:m.digest,size:m.size,modified_at:m.modified_at,details:m.details||{},capabilities:m.capabilities||[]}));
  const previous=new Map((prior.models||[]).map(m=>[m.name,m])),current=new Map(models.map(m=>[m.name,m])),changes=[];
  for(const m of models){const old=previous.get(m.name);if(!old)changes.push({name:m.name,change:'appeared'});else if(hash(old)!==hash(m))changes.push({name:m.name,change:'changed'});}
  for(const name of previous.keys())if(!current.has(name))changes.push({name,change:'not-listed'});
  let snapshot=prior.snapshot;
  if(changes.length||!snapshot){snapshot=path.join(path.dirname(cache),'reality-evidence','ollama-'+at.replace(/[:.]/g,'-')+'-'+crypto.randomUUID()+'.json');atomic(snapshot,{observedAt:at,endpoint:options.endpoint||'http://127.0.0.1:11434',models,changes});}
  const absent=[...new Map([...(prior.absent||[]).map(m=>[m.name,m]),...(prior.models||[]).filter(m=>!current.has(m.name)).map(m=>[m.name,{...m,lastSeenAt:prior.lastSuccessAt,lastSeenSnapshot:prior.snapshot,lastSeenSnapshotSha:prior.snapshotSha}])]).values()].filter(m=>!current.has(m.name));
  const snapshotSha=snapshot===prior.snapshot&&prior.snapshotSha?prior.snapshotSha:crypto.createHash('sha256').update(fs.readFileSync(snapshot)).digest('hex');
  atomic(cache,{format:'object-reality-v1',status:'ok',lastAttemptAt:at,lastSuccessAt:at,snapshot,snapshotSha,models,absent,lastChanges:changes,history:[...(prior.history||[]),...(changes.length?[{at,snapshot,changes}]:[])]});
  return {...realityStatus(options),trigger:'refreshed'};
 }catch(error){atomic(cache,{...prior,format:'object-reality-v1',status:'observation-failed',lastAttemptAt:at,error:clean(error.message)});return {...realityStatus(options),trigger:'failed-preserved'};}
 finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
export function resourceFederationStatus(options={}){const file=files(options).registry;if(!file||options.federation===false)return {status:'disabled'};try{const db=json(file);if(db.format!=='ai-resource-registry-v1'||!Array.isArray(db.resources))throw Error('资料登记格式无效');return {status:'read-current-registry',file,revision:db.revision,resourceCount:db.resources.length,boundary:'只读resources投影；不复制账号凭据，不证明登记属性当前有效'};}catch(error){return {status:'registry-unavailable',file,error:clean(error.message),boundary:'正式对象与现实观察仍可读；原登记缺失不表示资源已删除'};}}
function registryRecords(options){const file=files(options).registry;if(!file)return [];try{
 const db=json(file);if(db.format!=='ai-resource-registry-v1'||!Array.isArray(db.resources))return [];
 return db.resources.map(r=>({id:r.id,kind:'object',name:clean(r.name||r.id),summary:clean(r.purpose||r.category||'已有资源登记；需读条件与原证').slice(0,1800),aliases:[],categories:[],sourceRefs:[r.id],unknowns:['登记层级不证明当前可调用或适合本任务'],origin:'resource-registry',version:r.version||1,
 sources:[{id:'linked-registry',kind:'registry',path:file,ref:r.id,registryRevision:db.revision,checkedAt:r.lastCheckedAt||r.observedAt,note:'联合读取原登记；未另存第二份资源事实',sha256:hash(r)}],
 claims:[{id:'registry-description',kind:'fact',predicate:'已有资源登记',value:Object.fromEntries(['category','location','purpose','accessMethod','scope','notes','limitation','limit','status','observedAt','evidence','nextAction'].filter(k=>r[k]!==undefined).map(k=>[k,clean(r[k])])),status:'unverified',sourceIds:['linked-registry'],scope:{conditions:['登记原件内容，使用前核实际条件；不自动采纳']},observedAt:r.observedAt}],relations:[]}));
 }catch{return [];}}
export function effectiveRecords(records,options={}){
 if(options.federation===false)return records;
 const byId=new Map(records.map(r=>[r.id,structuredClone(r)]));
 for(const resource of registryRecords(options)){
  const existing=byId.get(resource.id)||[...byId.values()].find(r=>r.sourceRefs?.includes(resource.id));
  if(existing){existing.linkedResources=[...(existing.linkedResources||[]),resource];}else byId.set(resource.id,resource);
 }
 const reality=readReality(options);
 for(const model of [...(reality.models||[]),...(reality.absent||[])]){
  const existing=[...byId.values()].find(r=>r.id==='object:'+model.name||r.name===model.name||r.aliases.includes(model.name));
  const record=existing||{id:'object:'+model.name,kind:'object',name:model.name,summary:'Ollama实际发现的本机模型；用途和效果待按任务核证',aliases:[],categories:[],sourceRefs:[],sources:[],claims:[],relations:[],unknowns:['训练来源、用途与效果未由列表证明'],origin:'ollama-observation',version:0};
  const present=(reality.models||[]).some(m=>m.name===model.name),snap=present?reality.snapshot:model.lastSeenSnapshot;
  let sid='reality-ollama-'+hash(model.name).slice(0,12);while(record.sources.some(s=>s.id===sid))sid+='-auto';
  const observation={listed:present,model:present?model:{...model,lastSeenAt:model.lastSeenAt},lastSuccessAt:reality.lastSuccessAt,observationStatus:reality.status};
  record.sources.push({id:sid,kind:'local',path:snap||files(options).cache,checkedAt:reality.lastSuccessAt,note:'自动观察，只证明API列表；服务故障保留上次成功结果'});
  record.sources.at(-1).sha256=present?reality.snapshotSha:model.lastSeenSnapshotSha;
  let cid='reality-ollama-observation';while(record.claims.some(c=>c.id===cid))cid+='-auto';
  record.claims.push({id:cid,kind:'state',predicate:'Ollama列表观察',value:observation,status:'verified',sourceIds:[sid],scope:{conditions:['API列表层级；未测试当前生成，不判断Base或Instruct身份',present?'最近成功列表含此模型':'最近成功列表未含此模型，不表示本地GGUF删除']},observedAt:reality.lastSuccessAt,reviewAfter:new Date(Date.parse(reality.lastSuccessAt)+REALITY_TTL_MS).toISOString()});
  byId.set(record.id,record);
 }
 return [...byId.values()];
}

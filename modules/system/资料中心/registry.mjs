import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const CENTER=path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FILE=path.join(_publicDataPath("资料中心/data"),'资料登记.json');
export const KINDS=['accounts','benefits','resources','sources'];
const field=(key,label,type='text',more={})=>({key,label,type,...more});
const common=[field('name','名称','text',{required:true}),field('purpose','用途','textarea'),field('status','记录状态','select',{options:['待核实','已记录','已验证','停用']}),field('observedAt','证据中的观察日期','date'),field('evidence','依据与原件','textarea'),field('notes','补充说明','textarea'),field('nextAction','系统下一步','textarea'),field('lastCheckedAt','系统最近核对日期','date'),field('checkAfter','下次核对日期','date'),field('blockedBy','接续条件','select',{options:['','待系统查证','缺接入能力','需要本人验证身份']})];
export const SCHEMAS={
 accounts:{label:'账号',description:'账号身份、使用入口、用途与已观察的接入状态。',fields:[...common.slice(0,1),field('platform','平台'),field('category','类别'),field('identifier','账号标识或别名'),field('entryUrl','官网或账号入口','url'),field('accessMethod','系统接入方式'),field('accessState','实际接入情况','textarea'),field('scope','已明确的使用条件','textarea'),field('credentialRef','登录或凭据引用'),...common.slice(1)]},
 benefits:{label:'权益',description:'一个账号可以关联多项权益，发放量、剩余量、期限分别记录。',fields:[...common.slice(0,1),field('accountId','所属账号','account',{required:true}),field('product','套餐或产品'),field('amount','总量或历史发放量'),field('remaining','实际剩余量'),field('expiresOn','期限或到期日','date'),field('renewal','续费或额度重置说明','textarea'),field('usage','实际用途及可用边界','textarea'),...common.slice(1)]},
 resources:{label:'工具与资源',description:'设备、程序、环境、存储和可复用资产，引用原有位置。',fields:[...common.slice(0,1),field('category','类别'),field('location','原件或安装位置'),field('accessMethod','接入方式'),field('scope','适用条件','textarea'),...common.slice(1)]},
 sources:{label:'信息来源',description:'可主动发现资料的渠道、使用范围和实际采集条件。',fields:[...common.slice(0,1),field('category','类别'),field('entryUrl','来源入口','url'),field('cadence','采集或检查频率'),field('scope','已明确的使用条件','textarea'),...common.slice(1)]}
};
function fail(message,statusCode=400){const e=new Error(message);e.statusCode=statusCode;throw e;}
function checkKind(kind){if(!KINDS.includes(kind))fail('资料类别无效');}
export function readRegistry(file=DEFAULT_FILE){
 const value=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
 if(value.format!=='ai-resource-registry-v1'||!Number.isInteger(value.revision)||KINDS.some(k=>!Array.isArray(value[k])))fail('登记原件格式无效，保留文件待恢复',500);
 return value;
}
function locked(file,action){
 fs.mkdirSync(path.dirname(file),{recursive:true});
 const lock=file+'.lock',until=Date.now()+2000;let fd;
 while(fd===undefined){
  try{fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:new Date().toISOString()}));}
  catch(e){if(e.code!=='EEXIST')throw e;
   try{const item=JSON.parse(fs.readFileSync(lock,'utf8'));try{process.kill(item.pid,0);}catch(p){if(p.code==='ESRCH'){fs.unlinkSync(lock);continue;}}}catch{}
   if(Date.now()>until)fail('另一项资料更新正在进行，请稍后重读',409);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30);
  }
 }
 try{return action();}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
function commit(file,db){
 const backupDir=path.join(path.dirname(file),'backups');fs.mkdirSync(backupDir,{recursive:true});
 let backup=null;
 if(fs.existsSync(file)){backup=path.join(backupDir,`资料登记-r${readRegistry(file).revision}-${Date.now()}-${crypto.randomUUID().slice(0,6)}.json`);fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);}
 const tmp=file+`.${process.pid}.${crypto.randomUUID()}.tmp`;
 fs.writeFileSync(tmp,JSON.stringify(db,null,2)+'\n',{encoding:'utf8',flag:'wx'});fs.renameSync(tmp,file);return backup;
}
function normalize(kind,input,existing){
 const row={id:existing?.id||input.id||`${kind.slice(0,-1)}-${crypto.randomUUID().slice(0,12)}`};
 if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(row.id))fail('标识格式无效');
 for(const f of SCHEMAS[kind].fields){
  const value=input[f.key]??existing?.[f.key]??(f.key==='status'?'待核实':'');
  if(typeof value!=='string'||value.length>12000)fail(`${f.label}格式无效或过长`);
  row[f.key]=value.trim();
  if(f.required&&!row[f.key])fail(`请保留${f.label}`);
  if(f.type==='date'&&row[f.key]&&!/^\d{4}-\d{2}-\d{2}$/.test(row[f.key]))fail(`${f.label}使用YYYY-MM-DD`);
  if(f.type==='select'&&row[f.key]&&!f.options.includes(row[f.key]))fail(`${f.label}选项无效`);
 }
 if(row.status==='已验证'&&(!row.evidence||!row.observedAt))fail('已验证记录需要实际依据和观察日期');
 row.version=(existing?.version||0)+1;row.createdAt=existing?.createdAt||new Date().toISOString();row.updatedAt=new Date().toISOString();row.maintainer='AI工作系统';return row;
}
export function initializeRegistry(seed,file=DEFAULT_FILE){return locked(file,()=>{
 if(fs.existsSync(file))fail('登记原件已经存在，请更新具体记录',409);
 const db={format:'ai-resource-registry-v1',revision:1,updatedAt:new Date().toISOString()};
 for(const k of KINDS){db[k]=(seed[k]||[]).map(r=>normalize(k,r));if(new Set(db[k].map(r=>r.id)).size!==db[k].length)fail('种子包含重复标识');}
 for(const r of db.benefits)if(!db.accounts.some(a=>a.id===r.accountId))fail(`权益${r.name}缺少所属账号`);
 commit(file,db);return {file,revision:db.revision,counts:Object.fromEntries(KINDS.map(k=>[k,db[k].length]))};
});}
export function saveRecord(kind,input,file=DEFAULT_FILE){checkKind(kind);return locked(file,()=>{
 const db=readRegistry(file),i=input.id?db[kind].findIndex(r=>r.id===input.id):-1,existing=i>=0?db[kind][i]:null;
 if(existing&&input.version!==existing.version)fail('这条记录已被更新，请重读再保存',409);
 if(!existing&&input.version)fail('原记录不在当前原件中，请重读',409);
 const row=normalize(kind,input,existing);
 if(kind==='benefits'&&!db.accounts.some(a=>a.id===row.accountId))fail('所属账号不存在，先登记账号');
 if(i<0)db[kind].push(row);else db[kind][i]=row;
 db.revision++;db.updatedAt=new Date().toISOString();const backup=commit(file,db);return {record:row,revision:db.revision,backup};
});}
function aliases(query){return String(query||'').toLowerCase().replace(/谷歌/g,'google').split(/\s+/).filter(Boolean);}
export function searchResources(query='',options={}){
 const db=readRegistry(options.file),terms=aliases(query),kinds=options.kind?[options.kind]:KINDS;
 for(const k of kinds)checkKind(k);
 const items=[];
 for(const kind of kinds)for(const r of db[kind]){
  const searchable=Object.values(r).join(' ').toLowerCase().replace(/谷歌/g,'google');
  if(terms.every(t=>searchable.includes(t)))items.push({kind,...r,accountName:r.accountId?db.accounts.find(a=>a.id===r.accountId)?.name:undefined});
 }
 return {revision:db.revision,updatedAt:db.updatedAt,total:items.length,items:items.slice(0,options.limit||100)};
}
export function readResource(id,file=DEFAULT_FILE){const db=readRegistry(file);for(const kind of KINDS){const record=db[kind].find(r=>r.id===id);if(record)return {kind,...record};}fail('记录不存在',404);}
export function maintenanceWork(file=DEFAULT_FILE){
 const db=readRegistry(file),today=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}),items=[];
 for(const kind of KINDS)for(const r of db[kind]){
  if(r.status==='停用')continue;
  const reasons=[];
  if(r.status==='待核实')reasons.push('资料待查证');
  if(r.checkAfter&&r.checkAfter<=today)reasons.push('已到核对日期');
  if(kind==='benefits'&&r.expiresOn&&r.expiresOn<=today)reasons.push('期限已到，需核账号实际状态');
  if(kind==='benefits'&&r.expiresOn&&r.expiresOn>today&&r.expiresOn<=new Date(Date.now()+30*86400000).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}))reasons.push('30天内期限');
  if(r.nextAction||reasons.length)items.push({kind,id:r.id,name:r.name,reason:reasons.join('；'),nextAction:r.nextAction||'由系统沿已有依据核对身份、权益或可用入口，更新真实结果',blockedBy:r.blockedBy||'待系统查证',owner:'AI工作系统',evidence:r.evidence});
 }
 return {date:today,revision:db.revision,count:items.length,items};
}
export function registrySummary(file=DEFAULT_FILE){const db=readRegistry(file);return {file,revision:db.revision,updatedAt:db.updatedAt,counts:Object.fromEntries(KINDS.map(k=>[k,db[k].length])),pending:maintenanceWork(file).count,maintainer:'AI工作系统'};}
export function failureFollowups(){
 const file=_publicPath("$codex/context/failure-inbox/failures.json");
 if(!fs.existsSync(file))return {count:0,items:[],source:file};
 const data=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
 const values=Array.isArray(data)?data:Array.isArray(data.items)?data.items:Array.isArray(data.failures)?data.failures:Object.values(data.failures||{});
 const norm=v=>String(v||'').replace(/\\/g,'/').toLowerCase(),project=norm(path.dirname(CENTER));
 const relevant=values.filter(r=>[r.project,...(r.projects||[])].some(p=>norm(p)===project));
 const items=relevant.filter(r=>['open','needs-review','note-only'].includes(r.status)).sort((a,b)=>String(b.lastSeen||'').localeCompare(String(a.lastSeen||''))).map(r=>({id:r.id,status:r.status,tool:r.tool_name,diagnostic:r.diagnostic||r.title||r.summary||'',count:r.count||null,uniqueSessions:r.uniqueSessions,lastSeen:r.lastSeen,project:r.project,evidence:r.evidence||[],resolutionEvidence:r.resolution?.evidence,owner:'AI工作系统',nextAction:r.status==='note-only'?'已有处理说明；由系统在下一次相同条件的真实任务核做法和结果':'系统沿原证查原因，采用修法后保留真实结果。'}));
 return {source:file,count:items.length,otherProjectCount:values.length-relevant.length,items};
}
export function restoreRegistry(backup,file=DEFAULT_FILE){return locked(file,()=>{const db=readRegistry(backup),current=readRegistry(file);db.revision=current.revision+1;db.updatedAt=new Date().toISOString();const saved=commit(file,db);return {file,revision:db.revision,previous:saved};});}
function cli(){
 const [command='summary',...args]=process.argv.slice(2),opts={};for(let i=0;i<args.length;i+=2)opts[args[i].replace(/^--/,'')]=args[i+1];
 const file=opts.file||DEFAULT_FILE;let result;
 if(command==='summary')result=registrySummary(file);
 else if(command==='search')result=searchResources(opts.query||'',{file,kind:opts.kind,limit:Number(opts.limit)||20});
 else if(command==='read')result=readResource(opts.id,file);
 else if(command==='work')result=maintenanceWork(file);
 else if(command==='save')result=saveRecord(opts.kind,JSON.parse(fs.readFileSync(opts.input,'utf8').replace(/^\uFEFF/,'')),file);
 else if(command==='init')result=initializeRegistry(JSON.parse(fs.readFileSync(opts.input,'utf8').replace(/^\uFEFF/,'')),file);
 else if(command==='restore')result=restoreRegistry(opts.from,file);
 else if(command==='--help'||command==='help')result='summary | search --query TEXT [--kind accounts|benefits|resources|sources] | read --id ID | work | save --kind KIND --input ABS_JSON | init --input ABS_JSON | restore --from BACKUP_JSON';
 else fail('未知命令');console.log(typeof result==='string'?result:JSON.stringify(result,null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{cli();}catch(e){console.error(e.message);process.exitCode=1;}}

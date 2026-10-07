import {integrationPath} from '../paths.mjs';
// 系统资料：短导航/未排序目录 -> 任务查询 -> 单条详情。登记JSON是唯一事实源。
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {objectNavigation,objectCli,OBJECT_COMMAND} from './object-access.mjs';
const moduleUrl=new URL('../../modules/system/资料中心/registry.mjs',import.meta.url).href;
export const RESOURCE_FILE=integrationPath('modules/system/资料中心/data/资料登记.json');
const INDEX_FILE=integrationPath('modules/system/资料中心/data/系统索引.json');
const COMMAND='node integrations/context/resources.mjs';
const KINDS=['accounts','benefits','resources','sources'];
const names={accounts:'账号',benefits:'权益',resources:'资源',sources:'来源'};
// Equivalent names are bounded to an entity. Relationships (Google -> Gemini)
// are not synonyms: storage tasks should not pull in every Google AI product.
const aliases=[
 ['google',['google','谷歌']],['openai',['openai','chatgpt','codex']],['claude',['claude','克劳德']],
 ['gmail',['gmail','邮件','邮箱']],['drive',['drive','云盘','云端硬盘','云端硬碟','网盘']],
 ['gemini',['gemini','双子座']],['cli',['gemini cli','code assist']],
['boss',['boss直聘','boss','直聘','zhipin']],
 ['zhihu',['知乎','zhihu']],['tieba',['贴吧','tieba']],['twitter',['twitter','推特','x/twitter','x平台']],
 ['github',['github','git hub']],['huggingface',['hugging face','huggingface','抱抱脸']],
 ['tokenbay',['tokenbay']],['gamma',['gamma']],['openrouter',['openrouter']],['exa',['exa']],
 ['poe',['poe']],['prezi',['prezi']],['heygen',['heygen']],['beautiful',['beautiful.ai']],
 ['you',['you.com']],['apple',['apple','icloud']],['docker',['docker']],['broadcom',['broadcom']],
 ['hn',['hacker news','hackernews','黑客新闻','hn']],['v2ex',['v2ex','v站']],
 ['bilibili',['bilibili','哔哩哔哩','b站']],['xiaohongshu',['小红书','xiaohongshu']],
 ['ruanyifeng',['阮一峰','ruanyifeng']],['sspai',['少数派','sspai']],['infoq',['infoq']],
 ['deepseek',['deepseek','深度求索']],['qbitai',['量子位','qbitai']],
 ['producthunt',['product hunt','producthunt']],['arxiv',['arxiv']],['nasa',['nasa']],['bbc',['bbc']],
 ['backup',['备份','快照','恢复档案','恢复','还原','snapshot','backup','restore']],
 ['storage',['存储','磁盘','硬盘','d盘','sqlite','资料库','数据库','storage']],
 ['information',['信息中心','日更','采集来源']],['python',['python','解释器']],
 ['credits',['credits','额度','赠额','余额','用量','重置']],
 ['benefits',['权益','会员','套餐','订阅']],['presentation',['ppt','幻灯片','演示文稿']],
 ['search',['搜索','检索','原帖','开源','公共仓库','公开仓库','来源渠道']],
 ['cloud',['云环境','云执行','云端回流','批次回流']],['forum',['论坛','社区']],
 ['runtime',['运行时','运行环境','解释器','依赖','bundled','bundle']],
 ['model',['本地模型','模型权重','gguf','lora','ollama']],
 ['material',['素材','素材库','语料','训练数据']],
 ['configuration',['配置','hook','角色配置']],
 ['native',['原生控制','电脑控制','sky','桌面控制']],
 ['browser',['浏览器控制','cua_repl','iab']],
 ['artifact',['成果','成品','源码导航','文件归属']]
];
const facets=new Set(['backup','storage','information','python','credits','benefits','presentation','search','cloud','forum','runtime','model','material','configuration','native','browser','artifact']);
const stopWords=new Set(['本人','账号','线索','候选','权益','当前','实际','系统','工具','资源','资料','信息','官方','公开','公共','历史','套餐','会员','订阅','通知','确认','中文','教程','资讯','开发','来源','工作','整理','运行','存储','备份','恢复','云端','代码','传输','研究','经营','招聘','论坛','创作','执行','稳定','中心','本机','网络','数据库','管理','程序','开发者','计划','容量','ai','pro','main','source','sources','accounts','resources','benefits','candidate','blog','news','credit','credits']);
const normalize=value=>String(value||'').normalize('NFKC').toLowerCase();
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function has(text,term){term=normalize(term);if(!term)return false;if(/[\u3400-\u9fff]/.test(term))return text.includes(term);return new RegExp('(?:^|[^a-z0-9])'+escape(term)+'(?:$|[^a-z0-9])','i').test(text);}
function signals(value){const text=normalize(value);return aliases.filter(([,terms])=>terms.some(t=>has(text,t))).map(([key])=>key);}
const segmenter=new Intl.Segmenter('zh-CN',{granularity:'word'});
function nameTerms(value){return [...new Set([...segmenter.segment(normalize(value))].filter(s=>s.isWordLike).map(s=>s.segment).filter(s=>s.length>=2&&!stopWords.has(s)&&!/^\d+$/.test(s)))];}

// Whitelisted output fields below never include credentialRef or identifier.
// Redact recognizable credentials accidentally placed in free text/URLs too.
export function redactResourceOutput(value){
 if(Array.isArray(value))return value.map(redactResourceOutput);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/(?:password|passwd|secret|token|cookie|authorization|credential|identifier|密码|密钥|凭据)/i.test(k)).map(([k,v])=>[k,redactResourceOutput(v)]));
 if(typeof value!=='string')return value;
 return value.replace(/https?:\/\/[^\s"'<>]+/gi,url=>{
  try{const u=new URL(url);u.username='';u.password='';for(const k of [...u.searchParams.keys()])if(/token|key|secret|password|auth|signature|cookie|session|code/i.test(k))u.searchParams.set(k,'[已隐藏]');if(/token|secret|password|auth|signature/i.test(u.hash))u.hash='[已隐藏]';return u.href;}catch{return '[链接不可解析]';}
 }).replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{12,}|github_pat_[a-zA-Z0-9_]{12,}|AIza[a-zA-Z0-9_-]{20,})\b/g,'[凭据已隐藏]')
 .replace(/\bBearer\s+[a-zA-Z0-9._~+\/-]+=*/gi,'Bearer [已隐藏]')
 .replace(/((?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|\btoken\b|secret|authorization|密码|密钥|令牌|凭据)\s*[:：=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,，;；\n]+)/gi,'$1[已隐藏]')
 .replace(/(\bcookie\s*[:=]\s*)[^\n]+/gi,'$1[已隐藏]');
}
function readMaster(options={}){
 const file=options.file||RESOURCE_FILE;let d;
 try{d=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{throw Error('资料原件不可读或JSON无效');}
 if(d.format!=='ai-resource-registry-v1'||KINDS.some(k=>!Array.isArray(d[k])))throw Error('资料原件格式无效');return {file,d};
}
function indexFromMaster({file,d},options){
 const accounts=new Map(d.accounts.map(r=>[r.id,r])),items=[];
 for(const kind of KINDS)for(const r of d[kind]){
  const fields=redactResourceOutput([r.platform,r.product,r.name,r.category,r.id].filter(Boolean)),tags=signals(fields.join(' '));
  if(kind==='benefits'){tags.push('benefits');const parent=accounts.get(r.accountId);if(parent)tags.push(...signals(parent.platform));}
  if(/gamma|prezi|beautiful/i.test(r.id))tags.push('presentation');
  // Purpose/access add task-use facets, never unrelated product names.
  tags.push(...signals(redactResourceOutput([r.purpose,r.accessMethod].filter(Boolean).join(' '))).filter(s=>facets.has(s)));
  const terms=nameTerms(redactResourceOutput([r.name,r.platform,r.product,r.id].filter(Boolean)).join(' ').replace(/[-_/]/g,' '));
  items.push({id:r.id,kind,name:redactResourceOutput(r.name),tags:[...new Set(tags)],terms,state:r.status,date:r.observedAt||'',v:r.version||1});
 }
 const result={format:'system-resource-index-v1',from:file,revision:d.revision,items};
 if(options.persist!==false){const target=options.indexFile||(options.file?path.join(path.dirname(file),'系统索引.json'):INDEX_FILE),body=JSON.stringify(result);let prior='';try{prior=fs.readFileSync(target,'utf8');}catch{}
  if(body!==prior){fs.mkdirSync(path.dirname(target),{recursive:true});const temp=target+'.'+process.pid+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,body);fs.renameSync(temp,target);}}
 return result;
}
export function buildResourceIndex(options={}){return indexFromMaster(readMaster(options),options);}
export function resourceNavigation(options={}){
 try{const index=buildResourceIndex(options),counts=options.includeCounts===false?'账号、权益、资源与来源':KINDS.map(k=>names[k]+index.items.filter(r=>r.kind===k).length).join('/');return `系统资料：${counts}。${COMMAND} list --kind resources列本地环境/工具/素材；search --query "用途"定位，read --id ID读详情与原证。完整参数沿help。`;}
 catch{return `系统资料暂不可读；保留登记原件，沿 ${COMMAND} 续查。`;}
}
const today=options=>options.today||new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
export function resourceFreshness(r,kind,options={}){
 const date=today(options),observed=r.observedAt||'',checked=r.lastCheckedAt||observed,flags=[];
 if(r.status==='停用')flags.push('停用记录');
 if(kind==='benefits'&&r.expiresOn&&r.expiresOn<date)flags.push('记录期限已过，核当前权益');else if(kind==='benefits'&&r.expiresOn===date)flags.push('记录今日到期，核实际截止时间');
 if(r.checkAfter&&r.checkAfter<=date)flags.push('已到核对日期');
 if(!checked)flags.push('缺核对日期');else if(checked>date)flags.push('核对日期在未来，核原证');else{const age=Math.floor((Date.parse(date)-Date.parse(checked))/86400000),threshold=options.staleDays?.[kind]??({accounts:30,benefits:14,resources:90,sources:180}[kind]);if(age>threshold)flags.push(`距上次记录${age}天，使用前核当前状态`);}
 if(r.status==='待核实')flags.push('待核实');return {asOf:date,observedAt:observed,lastCheckedAt:r.lastCheckedAt||'',checkAfter:r.checkAfter||'',flags};
}
function conciseItem(r,kind,options={}){
 const item={id:r.id,kind:names[kind],name:redactResourceOutput(r.name),state:r.status,date:r.observedAt||'未核日期'};
 if(kind==='benefits'){if(r.remaining)item.remaining=redactResourceOutput(r.remaining);else if(r.amount)item.amount=redactResourceOutput(r.amount);if(r.expiresOn)item.expires=r.expiresOn;}
 const flags=resourceFreshness(r,kind,options).flags.filter(f=>f!=='待核实');if(flags.length)item.check=flags.join('；');return item;
}
export function candidateResources(query,options={}){
 if(options.kind&&!KINDS.includes(options.kind))throw Error('资料类别无效');
 // One registry snapshot. Automatic reads need not rewrite a derived file.
 const master=readMaster(options),index=indexFromMaster(master,{...options,persist:options.persist===true});
 const q=normalize(redactResourceOutput(String(query||'').replace(/(?:[A-Z]:[\\/]|https?:\/\/)[^\s"'<>]*/gi,' '))).trim(),intent=signals(q);
 const entities=intent.filter(s=>!facets.has(s)),terms=[...new Set(index.items.flatMap(r=>r.terms))].filter(t=>has(q,t));
 const records=new Map(KINDS.flatMap(k=>master.d[k].map(r=>[r.id,r]))),scored=[];
 for(const row of index.items){
  if(options.kind&&row.kind!==options.kind||row.state==='停用'&&!options.includeInactive)continue;
  const exactId=has(q,row.id),exactName=has(q,row.name),hits=intent.filter(s=>row.tags.includes(s)),lexical=terms.filter(t=>row.terms.includes(t));
  if(!hits.length&&!lexical.length&&!exactId&&!exactName)continue;
  if(entities.length&&!entities.some(s=>row.tags.includes(s))&&!exactId&&!exactName&&!lexical.length)continue;
  const record=records.get(row.id),nameText=normalize([row.name,record.product,record.platform].filter(Boolean).join(' ')),nameHits=signals(nameText).filter(s=>intent.includes(s));
  let score=(exactId?120:0)+(exactName?80:0)+hits.reduce((n,s)=>n+(facets.has(s)?4:14),0)+nameHits.length*10+lexical.reduce((n,t)=>n+Math.min(22,4+t.length*2),0);
  // Requested use ranks the right kind without filtering other facts away.
  if(intent.includes('search'))score+=row.kind==='sources'?22:row.kind==='accounts'?-8:0;
  if(intent.includes('benefits')||intent.includes('credits'))score+=row.kind==='benefits'?18:0;
  if(intent.includes('credits')&&record.remaining)score+=8;
  if(intent.some(s=>['backup','storage','cloud','python','information'].includes(s))&&row.kind==='resources')score+=18;
  if(!intent.includes('search')&&!intent.includes('benefits')&&!intent.includes('credits')&&row.kind==='accounts')score+=4;
  for(const token of q.match(/[a-z][a-z0-9._-]{2,}/g)||[])if(!stopWords.has(token)&&has(nameText,token))score+=8;
  for(const token of ['重置','存储','备份','云环境','回流','闪烁'])if(q.includes(token)&&nameText.includes(token))score+=10;
  const flags=resourceFreshness(record,row.kind,options).flags;
  if(flags.some(s=>/期限已过|未来/.test(s)))score-=25;else if(flags.some(s=>/距上次记录|核对日期/.test(s)))score-=5;
  if(row.state==='已验证')score+=2;
  scored.push({score,id:row.id,row:conciseItem(record,row.kind,options),v:row.v,entities:hits.filter(s=>entities.includes(s)),matched:[...new Set([...nameHits,...lexical])]});
 }
 scored.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
 // Give multiple named subjects a first slot before duplicate-topic rows.
 if(entities.length>1){const first=[],used=new Set();for(const entity of entities){const best=scored.find(r=>r.entities.includes(entity)&&!used.has(r.id));if(best){first.push(best);used.add(best.id);}}first.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));scored.splice(0,scored.length,...first,...scored.filter(r=>!used.has(r.id)));}
 const limit=Math.max(1,Math.min(Number(options.limit)||2,20)),offset=Math.max(0,Math.floor(Number(options.offset)||0)),end=offset+limit;
 const result={revision:index.revision,query:q,total:scored.length,offset,items:scored.slice(offset,end).map(({row,v,matched})=>({...row,v,...(options.explain?{matched}: {})})),more:Math.max(0,scored.length-end)};
 if(result.more)result.nextOffset=end;if(!result.total)result.hint='没有词面候选；可按平台别称、具体产品/用途换查询。无命中不表示没有可用资源。';return result;
}
export function formatResourceCandidates(found,options={}){
 const budget=Number(options.maxChars)||600,head='本任务资料索引（线索；使用前read核条件）：',tail=`详情：${COMMAND} read --id ID`,parts=[],more=found.more?`另有${found.more}条匹配，必要时 search --query 具体用途 --offset ${found.nextOffset}。`:'';
 for(const r of found.items||[]){const {v,matched,...row}=r;let body=JSON.stringify(row);if([head,...parts,body,more,tail].filter(Boolean).join('\n').length>budget)body=JSON.stringify({id:row.id,kind:row.kind,name:String(row.name).slice(0,64),state:row.state,date:row.date,...(row.check?{check:String(row.check).slice(0,90)}:{})});if([head,...parts,body,more,tail].filter(Boolean).join('\n').length<=budget)parts.push(body);}
 return parts.length?[head,...parts,more,tail].filter(Boolean).join('\n'):'';
}
export async function searchResources(query,options={}){return candidateResources(query,options);}
// Safe discovery without ranking or loading full records/credentials. The master
// remains the same registry; this is a view, not another asset database.
export function listResources(options={}){
 if(options.kind&&!KINDS.includes(options.kind))throw Error('资料类别无效');
 const {d}=readMaster(options),items=KINDS.filter(k=>!options.kind||k===options.kind).flatMap(kind=>d[kind].map(r=>({...conciseItem(r,kind,options),category:redactResourceOutput(r.category||''),version:r.version})));
 return {revision:d.revision,selection:'unranked',total:items.length,items,boundary:'登记目录；沿read取位置/入口/原证。文件存在、版本可查、实际调用及持续运行分别判断，未登录不推为全局不可用。'};
}
export async function readResource(id,options={}){
 if(typeof options==='string')options={file:options};const {file,d}=readMaster(options);
 for(const kind of KINDS){const r=d[kind].find(r=>r.id===id);if(!r)continue;
  const result={...conciseItem(r,kind,options),kind,version:r.version,source:{file,collection:kind,id:r.id},freshness:resourceFreshness(r,kind,options)};
  const keys=kind==='accounts'?['platform','category','entryUrl','accessMethod','accessState','scope']:kind==='benefits'?['accountId','product','amount','remaining','expiresOn','renewal','usage']:kind==='resources'?['category','location','accessMethod','scope']:['category','entryUrl','cadence','scope'];
  result.facts=Object.fromEntries(keys.filter(k=>r[k]).map(k=>[k,r[k]]));if(r.purpose)result.purpose=r.purpose;if(r.notes)result.limit=r.notes;if(r.nextAction)result.next=r.nextAction;if(r.blockedBy)result.blockedBy=r.blockedBy;if(r.evidence)result.evidence=r.evidence;
  result.objectKnowledge={resolve:`${OBJECT_COMMAND} resolve --query "${r.id}"`,boundary:'对象档案若已整理可沿同ID/原登记关系查；登记存在不表示档案齐备或服务可用。'};
  return redactResourceOutput(result);
 }throw Error('资料ID不存在');
}
export async function maintenanceWork(...args){return redactResourceOutput((await import(moduleUrl)).maintenanceWork(...args));}
async function cli(){
 if(process.argv[2]==='objects'){const result=objectCli(process.argv.slice(3));console.log(typeof result==='string'?result:JSON.stringify(result,null,2));return;}
 const [cmd='navigation',...args]=process.argv.slice(2),opts={};for(let i=0;i<args.length;i++){const key=args[i].replace(/^--/,'');opts[key]=args[i+1]&&!args[i+1].startsWith('--')?args[++i]:true;}
 for(const key of ['persist','explain','includeInactive'])if(opts[key]!==undefined)opts[key]=opts[key]===true||opts[key]==='true';
 let value;if(cmd==='navigation')value=resourceNavigation(opts)+'\n'+objectNavigation();else if(cmd==='index')value=buildResourceIndex(opts);else if(cmd==='list')value=listResources(opts);else if(cmd==='search'||cmd==='candidates')value=candidateResources(opts.query||'',opts);else if(cmd==='read')value=await readResource(opts.id,opts);else if(cmd==='work')value=await maintenanceWork(opts.file);else if(cmd==='--help'||cmd==='help')value='navigation | list [--kind accounts|benefits|resources|sources]（未排序安全目录） | index | search --query TEXT [--kind accounts|benefits|resources|sources] [--limit 1..20] [--offset N] [--explain] [--includeInactive] | read --id ID | work | objects list|resolve|read|expand|search|audit|help <原参数>；候选及详情不输出账号标识/凭据；事实写回仍用 registry.mjs save（锁内id/version合并），索引由登记原件生成';else throw Error('无效命令');
 console.log(typeof value==='string'?value:JSON.stringify(redactResourceOutput(value),null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)cli().catch(e=>{console.error(redactResourceOutput(e.message));process.exitCode=1;});

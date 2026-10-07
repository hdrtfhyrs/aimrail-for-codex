import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {readSharedState} = await import(_publicURL("$codex/context/shared-state.mjs"));
const {listDeliverables} = await import(_publicURL("$codex/context/deliverables.mjs"));
export const DEFAULT_PROJECT=_publicPath("$system");
export const DEFAULT_ROSTER=_publicPath("$data/host-workspaces/2026-10-02/hook/work/system-review-20261002/并行窗口登记.json");
const groups=[
 ['goals','共同目标与接续','把补充放回完整目标，接续同一结果'],
 ['research','搜索、资料与已有资产','找到成熟做法、来源、经验和可复用成果'],
 ['runtime','持续信息、运行与恢复','每日收集，云端回流，开机接续与存储恢复'],
 ['accounts','账号与业务接入','把已有账号和权益转为实际能力，保留业务边界'],
 ['events','业务事件与执行能力','接收具体事件，交可用执行器，保存产物和失败'],
 ['team','协作、统筹与项目图','独立窗口负责完整结果，重要成果回到总协调'],
 ['unassigned','待定位分支','沿完整目标判断用途，未登记归属不自动视为协作任务']
];
const groupByBranch={};
const moduleGroups={'fresh-context':'team','goal-handoff':'goals','task-reports':'team','task-observations':'team','event-ingest':'events','event-dispatch':'events','github-search':'research','domestic-search':'research','international-search':'research','resource-mount':'research','knowledge-mount':'research','gemini-executor':'events','drive-storage':'runtime','boss-access':'accounts','cloud-recovery':'runtime','startup-recovery':'runtime','project-map':'team','parallel-integration':'team'};
// Assignment relationships inferred from the complete assignment. They
// are navigational suggestions, never confirmed runtime wiring or goal state.
const moduleDeps={'event-dispatch':['event-ingest','gemini-executor','goal-handoff','task-reports'],'parallel-integration':['goal-handoff','task-reports','task-observations','event-ingest','event-dispatch','github-search','domestic-search','international-search','resource-mount','knowledge-mount','gemini-executor','drive-storage','boss-access','cloud-recovery','startup-recovery','project-map'],'project-map':['task-reports'],'cloud-recovery':['drive-storage'],'startup-recovery':['cloud-recovery'],'task-observations':['goal-handoff']};

const slash=p=>p.replaceAll('\\','/');
const text=(file)=>{try{return fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');}catch{return null;}};
const json=file=>{try{return JSON.parse(text(file));}catch{return null;}};
const short=(v,n)=>{const s=String(v||'').replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n)+'…':s;};
const redact=v=>String(v??'').replace(/\b(?:sk-[A-Za-z0-9_-]{18,}|AIza[A-Za-z0-9_-]{25,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g,'[凭据已遮盖]');
const marks=value=>[...String(value||'').matchAll(/\[([ xX])\]\s*([^\n]+)/g)].map(m=>({recorded_checked:Boolean(m[1].trim()),text:m[2]}));
export function buildProjectMap({project=DEFAULT_PROJECT,roster=DEFAULT_ROSTER}={}){
 project=path.resolve(project);const state=readSharedState(project);if(!state)throw Error('共享状态原件缺失');
 const core=path.join(project,'核心.md'),coreText=text(core);if(!coreText)throw Error('核心原件缺失');
 const refs=new Map();
 const ref=(id,file,line=1)=>{const item={id,path:slash(path.resolve(file)),line,exists:fs.existsSync(file)};refs.set(id,item);return id;};
 const coordination=path.join(project,'协作总览.md');
 const relationPointer=text(coordination)?.match(/^全项目关系原件：(.+)$/m)?.[1]?.trim();
 const relationRelative=relationPointer&&path.isAbsolute(relationPointer)?path.relative(project,path.resolve(relationPointer)):null;
 const relationSource=relationRelative!==null&&!relationRelative.startsWith('..')&&!path.isAbsolute(relationRelative)?relationPointer:coordination;
 ref('core',core);ref('state',state.file);ref('relationships',relationSource);ref('coordination',coordination);ref('deliverables',path.join(project,'成果/INDEX.md'));ref('assignment',path.join(path.dirname(roster),'并行开发完整委托.md'));ref('current_dispatch',path.join(path.dirname(roster),'当前执行任务.md'));
 const rosterData=json(roster)||{},planned=rosterData.planned||rosterData.modules||[],registry=json(_publicPath("$system/运行中心/modules.json"))?.modules||[];
 const moduleByBranch=new Map(planned.map(m=>['parallel-'+m.key+'-20261002',m]));
 const branches=state.branches.map(b=>{
  const f=b.fields,m=moduleByBranch.get(b.id),criteria=marks(f['完成标准']);
  const id='branch:'+b.id;ref(id,b.source || state.file,b.archived?1:b.start+1);
  if(b.ledger)ref('ledger:'+b.id,b.ledger);
  return {id:b.id,name:b.name,archived:Boolean(b.archived),group:groupByBranch[b.id]||moduleGroups[m?.key]||'unassigned',
   goal:short(f['本轮目标'],200)||null,goal_source:f['本轮目标']?'explicit_shared_branch':'missing_explicit_goal',
   phase_record:short(f['阶段'],130),progress_record:short(f['已做'],160),next_record:short(f['下一步'],180),
   criteria:{recorded_checked:criteria.filter(x=>x.recorded_checked).length,recorded_pending:criteria.filter(x=>!x.recorded_checked).length},
   refs:[id,...(b.ledger?['ledger:'+b.id]:[])]};
 });
 const artifacts=listDeliverables({project}).map(e=>{const id=e.ref||e.id,file=path.join(project,'成果',e.entry);ref('artifact:'+id,file);return {id,title:short(e.title,90),branch:e.branch||null,recorded_status:short(e.status,100),boundary:short(e.boundary,180),refs:['artifact:'+id]};});
 const capabilities=registry.map(m=>{const p=path.isAbsolute(m.path)?m.path:path.join(project,m.path);ref('module:'+m.id,p);return {id:m.id,title:m.title,group:moduleGroups[m.id]||'research',entry_exists:fs.existsSync(p),layer:'central_cli_path_registration',refs:['module:'+m.id],verification:'入口存在不推定认证、业务调用或持续运行'};});
 const dependencies=Object.entries(moduleDeps).flatMap(([target,from])=>from.map(source=>({from:source,to:target,basis:'assignment_relationship',verification:'委托职责关系；非实际接通断言',refs:['assignment']})));
 const missingBranches=planned.filter(m=>!branches.some(b=>b.id==='parallel-'+m.key+'-20261002')).map(m=>({module:m.key,branch:'parallel-'+m.key+'-20261002',gap:'委托登记存在，共享分支尚未登记',refs:['assignment']}));
 return {consumer:'ai',project:slash(project),generated_at:new Date().toISOString(),
  goal:short(coreText.match(/## 最终要做出什么\s+([\s\S]*?)(?=\n## )/)?.[1]||'',600),
  groups:groups.map(([id,name,purpose])=>({id,name,purpose,branches:branches.filter(b=>b.group===id).map(b=>b.id)})),
  capabilities,branches,artifacts,dependencies,sources:[...refs.values()],
  gaps:[...missingBranches,...branches.filter(b=>!b.goal).map(b=>({branch:b.id,gap:'原共享分支缺显式目标；沿主线核原话，不从下一步猜',refs:b.refs})),...capabilities.filter(m=>!m.entry_exists).map(m=>({module:m.id,gap:'中央注册路径尚无文件',refs:m.refs}))],
  boundary:'派生结构索引；目标/状态唯一沿核心与共享分支。recorded_checked只是原件勾选，recorded_status/phase_record只是记录；不推断整体完成、理解或平台能力。长原件仅按ID展开，不嵌入sources。'};
}
export function selectProjectMap({query='',branchId,limit=4,...options}={}){
 const index=buildProjectMap(options),terms=String(query).toLowerCase().split(/[\s,，;；/]+/).filter(Boolean);
 if(!Number.isInteger(limit)||limit<1||limit>20)throw Error('limit须1..20');
 const rows=[...index.branches.map(b=>({kind:'branch',...b})),...index.capabilities.map(m=>({kind:'capability',...m})),...index.artifacts.map(a=>({kind:'artifact',...a}))];
 const matches=rows.filter(r=>branchId&&r.id===branchId||terms.length&&terms.some(t=>JSON.stringify(r).toLowerCase().includes(t)));
 const relevance=r=>terms.reduce((n,t)=>n+((r.name||r.title||'')+' '+r.id).toLowerCase().includes(t)*5+String(r.goal||'').toLowerCase().includes(t)*2+String(r.next_record||'').toLowerCase().includes(t),0);
 matches.sort((a,b)=>(a.id===branchId?-1:b.id===branchId?1:relevance(b)-relevance(a)));
 const selected=matches.slice(0,limit),ids=new Set(selected.flatMap(r=>r.refs||[]));
 return {consumer:'ai',query,total:matches.length,items:selected,sources:index.sources.filter(s=>ids.has(s.id)),next:'按branch/ref ID展开原件；词面候选不表示已采用或理解'};
}
export function expandProjectMap({id,project=DEFAULT_PROJECT,offset=0,maxChars=12000,...options}={}){
 const index=buildProjectMap({project,...options}),source=index.sources.find(s=>s.id===id);if(!source)throw Error('未知原件ID，先用map index/query定位');
 if(!Number.isInteger(offset)||offset<0||!Number.isInteger(maxChars)||maxChars<1||maxChars>50000)throw Error('offset须非负，maxChars须1..50000');
 let content;
 if(id.startsWith('branch:')){const state=readSharedState(project);content=state.branches.find(b=>b.id===id.slice(7))?.text;}
 else{if(!source.exists)throw Error('原件不存在：'+source.path);if(fs.statSync(source.path).isDirectory())content=fs.readdirSync(source.path).join('\n');else content=text(source.path);}
 if(typeof content!=='string')throw Error('原件不可读');content=redact(content);
 if(offset>content.length)throw Error('offset超出原件');const end=Math.min(offset+maxChars,content.length);
 return {id,source,content:content.slice(offset,end),offset,end,total_chars:content.length,complete:end===content.length,next:end<content.length?{id,offset:end,maxChars}:null};
}
export function projectMapNavigation({project=DEFAULT_PROJECT,branchId,maxChars=1100,includeCounts=true,index:providedIndex}={}){
 const index=providedIndex||buildProjectMap({project}),current=index.branches.find(b=>b.id===branchId);
 const parts=['系统结构：'+index.groups.map(g=>g.name+(includeCounts?'('+g.branches.length+')':'')).join('；')+'。',
  includeCounts?'登记：'+index.branches.length+'分支、'+index.capabilities.length+'入口、'+index.artifacts.length+'成果。':null,
  current?'本项：'+current.name+(includeCounts?'；待覆盖'+current.criteria.recorded_pending+'项':'')+'；原件ID branch:'+current.id+'。':null,
  '结构目录：node "'+path.join(project,'运行中心/system.mjs')+'" map index；query --query "问题"定位，expand --id branch:ID或--id core读原件。'];
 return parts.filter(Boolean).join('\n').slice(0,maxChars);
}
function parse(argv){const out={command:argv[0]||'help'};for(let i=1;i<argv.length;i+=2){if(!argv[i].startsWith('--')||argv[i+1]===undefined)throw Error('参数须 --名称 值');out[argv[i].slice(2)]=argv[i+1];}return out;}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{const a=parse(process.argv.slice(2)),opts={...(a.project?{project:a.project}:{}),...(a.roster?{roster:a.roster}:{})};let result;
 if(['index','data'].includes(a.command))result=buildProjectMap(opts);
 else if(a.command==='query')result=selectProjectMap({...opts,query:a.query||'',branchId:a.branch,limit:Number(a.limit||4)});
 else if(a.command==='expand')result=expandProjectMap({...opts,id:a.id,offset:Number(a.offset||0),maxChars:Number(a.chars||12000)});
 else if(a.command==='navigation')result=projectMapNavigation({...opts,branchId:a.branch});
 else if(['build','serve'].includes(a.command))throw Error('用户网页入口已退役；AI索引用index/query/expand/navigation');
 else result='AI用结构索引：index | query --query TEXT [--limit 4] [--branch ID] | expand --id core|branch:ID|module:KEY|artifact:REF [--offset 0 --chars 12000] | navigation [--branch ID]。按原件读取，无网站/关键词完成分类/另造目标库。';
 const output=typeof result==='string'?result:JSON.stringify(result,null,2);if(a.out){fs.mkdirSync(path.dirname(path.resolve(a.out)),{recursive:true});fs.writeFileSync(path.resolve(a.out),output+'\n');}console.log(output);
 }catch(e){console.error(e.message);process.exitCode=1;}}

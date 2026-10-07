import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const {readSharedState,selectSharedBranch} = await import(_publicURL("$codex/context/shared-state.mjs"));

const DIR=path.dirname(fileURLToPath(import.meta.url));
const readJSON=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''))}catch{return fallback}};
const normalized=s=>String(s||'').replaceAll('\\','/').replace(/\/$/,'').toLowerCase();
const atom=(file,text)=>{const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,text,'utf8');fs.renameSync(temp,file)};
export function taskView(row,cache=new Map()){
 const a=row.association||{};if(!a.project)return null;
 let state;if(cache.has(a.project))state=cache.get(a.project);else{try{state=readSharedState(a.project)}catch{state=null}cache.set(a.project,state)}
 const route=selectSharedBranch(state,{branchId:a.branch||undefined,ledger:a.ledger||undefined});
 const selected=route.selected;
 return {core:path.join(a.project,'核心.md'),stateFile:state?.file||null,ledger:a.ledger||null,ledgerExists:!!a.ledger&&fs.existsSync(a.ledger),selection:route.selection,branch:selected?.id||null,name:selected?.name||null,fields:selected?.fields||null};
}
export function managementView(){
 const index=readJSON(_publicDataPath("本地统一/对话记录/index.json"),null);if(!index)throw Error('No conversation index; run chats refresh');
 const layout=readJSON(_publicDataPath("本地统一/对话记录/organization.json"),{groups:[],assignments:[]});
 const assignment=new Map(layout.assignments.map(a=>[a.id,a]));
 const decisions={...(readJSON(_publicDataPath("本地统一/对话记录/routing-state.json"),{decisions:{}}).decisions||{}),...(readJSON(_publicDataPath("本地统一/对话记录/original-routing-state.json"),{decisions:{}}).decisions||{}),...(readJSON(_publicDataPath("本地统一/对话记录/action-manager/decisions.json"),{decisions:{}}).decisions||{})};
 const snapshot=readJSON(_publicDataPath("本地统一/对话记录/desktop-snapshot.json"),{}).sidebar||{};
 const atoms=readJSON(_publicPath("$codex/.codex-global-state.json"),{})['electron-persisted-atom-state']||{};
 const inverse=atoms['client-thread-bindings-v1']||{};
 const resolveKey=k=>{const value=k.split(':').slice(k.startsWith('chatgpt:')?2:3).join(':');if(!value.startsWith('client-new-thread:'))return value;return inverse[value]||Object.entries(atoms).find(([key,v])=>key.startsWith('thread-client-id-v1:')&&v===value)?.[0]?.slice('thread-client-id-v1:'.length)?.replace(/^local%3A/,'')||null};
 const shown=new Set((snapshot.sections||[]).flatMap(s=>s.itemKeys||[]).map(resolveKey).filter(Boolean));
 const cache=new Map();
 const rows=index.items.map(r=>{
  const liveBinding=r.platform==='codex'&&r.nativeId?readJSON(path.join(_publicPath("$codex/context/bindings/codex"),r.nativeId+'.json'),null):null;
  if(liveBinding)r={...r,association:{...r.association,project:liveBinding.project,branch:liveBinding.branchId||null,ledger:liveBinding.ledger||null,evidence:'current same-source binding'}};
  const a=assignment.get(r.nativeId),decision=decisions[r.nativeId];const project=r.association?.project||decision?.project||null;
  const group=layout.groups.find(g=>decision?.status==='classified'&&g.key===decision.groupKey)||layout.groups.find(g=>g.key===a?.group)||layout.groups.find(g=>normalized(project).split('/').at(-1)===g.project.toLowerCase()&&r.association?.branch&&g.branches.includes(r.association.branch));
  const task=project?taskView(r,cache):null;
  return {id:r.id,nativeId:r.nativeId,platform:r.platform,title:r.title,updatedAt:r.updatedAt||null,updatedAtSource:r.updatedAtSource||r.metadataEvidence||null,kind:r.kind,archived:!!r.archived,project:project?project.replaceAll('\\','/').replace(/\/$/,'').split('/').at(-1):'未归属',group:group?.key||null,groupName:group?.name||'待细分',path:r.path||null,associationEvidence:r.association?.evidence||null,task,content:r.path?'原始日志':r.historyMessages?'本机消息投影':r.apiContentAvailable?'接口已取回正文':r.apiContentState||'仅目录',activeCandidate:r.kind==='human'||!!a||shown.has(r.nativeId)};
 });
 return {generatedAt:new Date().toISOString(),refreshedAt:index.refreshedAt,coverage:index.coverage,groups:layout.groups,rows,pendingSidebarItems:(snapshot.sections||[]).flatMap(s=>(s.itemKeys||[]).filter(k=>k.includes('client-new-thread:')).map(k=>({section:s.name,key:k,nativeId:resolveKey(k)}))),boundary:index.scope};
}
export async function resumeConversation(id,args,reader){
 const view=managementView(),r=view.rows.find(r=>r.id===id||r.nativeId===id);if(!r)throw Error('Unknown conversation ID');
 const first=await reader(r.id,{offset:0,limit:1,chars:1});
 const history=first.contentAvailable?await reader(r.id,{offset:Math.max(0,first.total-8),limit:8,chars:args.chars||2500}):first;
 return {conversation:{id:r.id,title:r.title,kind:r.kind,project:r.project,group:r.groupName,archived:r.archived},currentTask:r.task,associationEvidence:r.associationEvidence,history,commands:{read:`node _publicPath("$codex/context/workspace.mjs") chats read --id ${r.id} --offset 0 --limit 10`,current:r.task?.branch?`node _publicPath("$codex/context/project-context.mjs") read --project "${path.dirname(r.task.core)}" --branch ${r.task.branch} --compact`:null},boundary:'Reads current binding/shared-state and actual visible conversation text. Does not send messages or start work. No branch is guessed from title, group, idle status or recency.'};
}
export function generateNavigation(){
 const v=managementView();const json=JSON.stringify(v).replaceAll('<','\\u003c').replaceAll('>','\\u003e');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>对话与项目导航</title><style>
 :root{font-family:system-ui,"Microsoft YaHei",sans-serif;color:#24334a;background:#eef2f7}body{margin:0}header{padding:30px 6vw;background:#182d47;color:white}h1{margin:0 0 8px;font-size:28px}header p{color:#c8d5e7;margin:5px 0}main{max-width:1150px;margin:auto;padding:24px}nav{display:flex;gap:12px;flex-wrap:wrap}input,select,button{font:inherit;border:1px solid #becbdb;border-radius:8px;padding:10px;background:white;color:#24334a}input{flex:1;min-width:220px}button{cursor:pointer;padding:6px 10px}.note{font-size:13px;color:#66758a;margin:18px 0;line-height:1.7}details.project{background:white;border-radius:13px;margin:14px 0;padding:16px;border:1px solid #d9e2ef}summary{cursor:pointer;line-height:1.6}summary.project-title{font-size:20px;font-weight:650}details.group{margin:12px 0 0 10px;padding:10px 12px;border-left:3px solid #8eaacb;background:#f8faff}.group-title{font-weight:600}.description{font-size:13px;color:#60758e;margin:4px 0 10px}.chat{padding:10px 0;border-top:1px solid #e2e8f2}.chat summary{font-weight:550}.badge{font-weight:normal;font-size:12px;color:#526984;margin-left:9px}.meta{font-size:13px;color:#65748a;line-height:1.7}.goal{white-space:pre-wrap;font-size:14px;line-height:1.8;margin:10px 0}.links{display:flex;gap:12px;align-items:center;flex-wrap:wrap}a{color:#205fa7}.count{color:#8dabc9;margin-left:8px;font-size:14px}.empty{padding:25px;color:#65748a}footer{font-size:12px;color:#6b788b;margin-top:25px}</style>
 <header><h1>对话与项目导航</h1><p>先选项目，再看负责板块；展开聊天可读当前目标与未完成项。</p><p id="time"></p></header><main><nav><input id="query" placeholder="搜索聊天、任务目标或分支"><select id="mode"><option value="tasks">用户任务与已整理聊天</option><option value="human">真人任务候选</option><option value="unknown">未知身份记录</option><option value="internal-agent">内部代理记录</option><option value="test">测试记录</option><option value="all">全部已取得记录</option></select><select id="archive"><option value="active">未归档</option><option value="all">含已归档</option></select></nav>
 <p class="note">应用侧栏按职责板块分组；这里保留项目 → 板块 → 聊天层级。分组只是整理方式，当前目标和条件来自现有绑定、共享分支与原聊天。需要接续时复制命令交给本机 AI。更早云端历史及缺正文记录仍按实际覆盖保留。</p><div id="content"></div><p id="counts" class="note"></p><footer>本页是已有目录的生成视图；chats refresh 或 chats navigation 可更新。原始记录与项目状态仍在原处。</footer></main>
 <script>const data=${json};const $=id=>document.getElementById(id);const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const file=p=>'file:///'+p.replaceAll('\\\\','/');
 function link(p,label){return p?'<a href="'+escape(file(p))+'">'+label+'</a>':''}
 function row(r){const t=r.task,f=t?.fields||{};let status=f['阶段']||'任务阶段未定位';const body='<div class="meta">'+escape(r.platform+' · '+r.content+' · '+r.id)+(r.archived?' · 已归档':'')+'</div>'+'<div class="goal">'+escape(f['本轮目标']||t?.selection||'暂无明确项目/分支归属；原记录保留。')+'</div>'+(f['完成标准']?'<div class="goal">'+escape(f['完成标准'])+'</div>':'')+'<div class="links">'+link(t?.core,'项目核心')+link(t?.stateFile,'当前共享状态')+link(t?.ledgerExists?t.ledger:null,'主线')+link(r.path,'原始记录')+'<button data-id="'+escape(r.id)+'">复制接续命令</button></div>';return '<details class="chat"><summary>'+escape(r.title)+'<span class="badge">'+escape(status)+'</span></summary>'+body+'</details>'}
 function render(){const q=$('query').value.trim().toLowerCase(),mode=$('mode').value,all=$('archive').value==='all';const rows=data.rows.filter(r=>(all||!r.archived)&&(mode==='all'||mode==='tasks'?mode==='all'||r.activeCandidate:r.kind===mode)&&(!q||JSON.stringify([r.title,r.id,r.project,r.groupName,r.task?.fields]).toLowerCase().includes(q)));const projects=[...new Set(rows.map(r=>r.project))].sort((a,b)=>a==='AI工作系统'?-1:b==='AI工作系统'?1:a.localeCompare(b,'zh'));$('content').innerHTML=projects.map(p=>{const rs=rows.filter(r=>r.project===p);const keys=[...new Set(rs.map(r=>r.group||'unassigned'))].sort((a,b)=>data.groups.findIndex(g=>g.key===a)-data.groups.findIndex(g=>g.key===b));return '<details class="project"><summary class="project-title">'+escape(p)+'<span class="count">'+rs.length+' 个记录</span></summary>'+keys.map(k=>{const g=data.groups.find(g=>g.key===k),gs=rs.filter(r=>(r.group||'unassigned')===k);return '<details class="group"><summary class="group-title">'+escape(g?.name||'待核与零散')+'<span class="count">'+gs.length+'</span></summary>'+(g?'<div class="description">'+escape(g.description)+'</div>':'')+gs.map(row).join('')+'</details>'}).join('')+'</details>'}).join('')||'<div class="empty">没有匹配记录。</div>';$('counts').textContent='当前显示 '+rows.length+' / '+data.rows.length+' 个来源记录。全部来源：'+JSON.stringify(data.coverage.kinds)+'；侧栏另有 '+data.pendingSidebarItems.length+' 个客户端别名，按原生双向映射解析（未解项保留）。';document.querySelectorAll('button[data-id]').forEach(b=>b.onclick=async()=>{const cmd='node "$codex/context/workspace.mjs" chats resume --id '+b.dataset.id;try{await navigator.clipboard.writeText(cmd);b.textContent='已复制'}catch{prompt('复制接续命令',cmd)}})}
 $('time').textContent='目录刷新：'+data.refreshedAt+'；状态读取：'+data.generatedAt;['query','mode','archive'].forEach(id=>$(id).addEventListener(id==='query'?'input':'change',render));render();</script></html>`;
 const file=path.join(DIR,'对话导航.html');atom(file,html);return {generated:true,path:file,url:pathToFileURL(file).href,refreshedAt:v.refreshedAt,generatedAt:v.generatedAt,coverage:v.coverage,groups:v.groups.map(g=>({name:g.name,count:v.rows.filter(r=>r.group===g.key).length})),pendingSidebarItems:v.pendingSidebarItems.length};
}

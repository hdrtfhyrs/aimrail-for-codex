import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
// File handoffs are generated views of current project originals, never a goal store.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const {readProjectFrame,readBranchTask} = await import(_publicURL("$codex/context/project-context.mjs"));

const FORMAT='project-file-handoff/1';
const TYPES=new Set(['user','observation']);
function absolute(value,label) {
  if(typeof value!=='string'||!path.isAbsolute(value)) throw Error(`${label}须为绝对路径。`);
  return path.resolve(value);
}
function array(value,label) {
  if(value===undefined) return [];
  if(!Array.isArray(value)) throw Error(`${label}须为数组。`);
  return value;
}
function text(value,label) {
  if(typeof value!=='string'||!value.trim()) throw Error(`${label}须为非空文本。`);
  return value;
}
function sourceRef(value,label='原件') {
  const ref=typeof value==='string'?{path:value}:value;
  if(!ref||typeof ref!=='object'||Array.isArray(ref)) throw Error(`${label}须为路径或来源对象。`);
  const location=text(ref.path||ref.source,`${label}位置`);
  if(/^https?:\/\//i.test(location)) return {...ref,path:location,available:null,access:'web_read_required'};
  if(!path.isAbsolute(location)) return {...ref,source:location,available:null,access:'source_locator_only'};
  const file=path.resolve(location);
  try { const stat=fs.statSync(file); return {...ref,path:file,available:stat.isFile(),bytes:stat.isFile()?stat.size:null,access:stat.isFile()?'file':'not_file'}; }
  catch(error){return {...ref,path:file,available:false,access:'unavailable',error:error.message};}
}
function supplements(value) {
  return array(value,'补充').map(item=>{
    if(!item||!TYPES.has(item.kind)) throw Error('补充 kind 须为 user 或 observation；不推定来源身份。');
    return {kind:item.kind,text:text(item.text,'补充正文'),source:sourceRef(item.source,'补充来源'),
      ...(item.evidence_refs?{evidence_refs:array(item.evidence_refs,'观察原证').map(v=>sourceRef(v))}:{}),
      ...(item.relation?{relation:item.relation}:{}),...(item.suggestion?{suggestion:item.suggestion}:{}),
      ...(item.uncertainties?{uncertainties:array(item.uncertainties,'未确定项')}:{}),
      handling:item.kind==='user'?'结合核心、当前完整任务、有效条件及成果由负责人理解；真实影响结果时重写并替换共享分支当前表述，原话留出处。纯状态追问沿现有任务回应，不重造目标。':'协作材料，由负责人研究影响；不自动成为用户命令或修改目标。'};
  });
}

// Legacy prose stays at its source. A generated task carries only source pointers;
// it cannot decide which earlier message the responsible AI has absorbed.
function historyReferences(metadata={}) {
  const refs=[...array(metadata.history_refs,'历史出处'),...array(metadata.user?.sources,'用户出处')];
  for(const item of array(metadata.supplements,'补充')) {
    if(item?.source) refs.push(item.source);
    refs.push(...array(item?.evidence_refs,'观察原证'));
  }
  const seen=new Set();
  return refs.map(v=>sourceRef(v,'历史出处')).filter(ref=>{
    const key=ref.path||ref.source;
    if(seen.has(key)) return false;
    seen.add(key);return true;
  });
}
function currentMetadata(metadata={}) {
  const {request,...user}=metadata.user||{};
  if(request!==undefined) text(request,'用户要求正文');
  return {...metadata,user:{...user,sources:array(user.sources,'用户出处').map(v=>sourceRef(v,'用户出处'))},
    supplements:[],history_refs:historyReferences(metadata)};
}
function currentPacket(packet) {
  const metadata=currentMetadata({...packet.metadata,
    user:packet.user||packet.metadata?.user,
    supplements:packet.supplements?.length?packet.supplements:packet.metadata?.supplements,
    history_refs:[...array(packet.history_refs,'历史出处'),...array(packet.metadata?.history_refs,'历史出处')]});
  return {...packet,core:{source:packet.core.source,common:packet.core.common},
    user:metadata.user,supplements:[],history_refs:metadata.history_refs,metadata};
}

// Only explicit dependencies are expanded. No keyword routing or parent-history import.
export function buildHandoff({project,branchId,metadata={}}={}) {
  const projectRef=absolute(project,'项目');
  const projectPath=path.basename(projectRef).toLowerCase()==='核心.md'?path.dirname(projectRef):projectRef;
  const task=readBranchTask(projectPath,branchId);
  const frame=readProjectFrame(projectPath);
  if(!frame.available) throw Error(`项目核心读取失败：${frame.reason}`);
  const warnings=[...task.gaps,...frame.errors.map(e=>`${e.source}：${e.reason}`)];
  const dependencies=array(metadata.dependencies,'依赖').map(item=>{
    const dep=typeof item==='string'?(/^[A-Za-z0-9_-]+$/.test(item)?{branch:item}:{source:item}):item;
    if(!dep||typeof dep!=='object') throw Error('依赖须为分支 ID 或对象。');
    if(dep.branch) {
      const depProject=dep.project?absolute(dep.project,'依赖项目'):projectPath;
      try { return {...dep,project:depProject,current:readBranchTask(depProject,dep.branch),material_only:true}; }
      catch(error) {warnings.push(`依赖 ${dep.branch} 未展开：${error.message}`);return {...dep,project:depProject,available:false,error:error.message,material_only:true};}
    }
    if(!dep.source&&!dep.path) throw Error('外部依赖须明确 branch 或 source/path。');
    return {...dep,reference:sourceRef(dep),material_only:true};
  });
  const references=[
    {role:'core',path:frame.core_source},
    {role:'state',path:task.source},
    {role:'relationships',path:frame.relationship_source},
    {role:'coordination',path:frame.coordination_source},
    {role:'deliverables',path:frame.deliverables_source},
    ...(task.ledger?[{role:'branch_evidence',path:task.ledger}]:[]),
    ...array(metadata.necessary_files,'必要文件'),
    ...array(metadata.artifacts,'已有成果').map(v=>typeof v==='string'?{path:v,role:'artifact'}:{...v,role:v.role||'artifact'})
  ].map(v=>sourceRef(v));
  for(const ref of references) if(ref.available===false) warnings.push(`原件缺口 ${ref.path}：${ref.error||ref.access}`);
  const handoffMetadata=currentMetadata(metadata);
  const user=handoffMetadata.user;
  const userSources=array(user.sources,'用户出处').map(v=>sourceRef(v,'用户出处'));
  if(!userSources.length) warnings.push('未额外提供用户原话出处；共享分支依据保留，沿其定位核原话。未复制原话正文，调用方需保留原输入。');
  const packet={format:FORMAT,generated_at:new Date().toISOString(),project:projectPath,branch_id:task.id,
    nature:'generated_snapshot_not_state_or_authorization',
    // The confirmed core remains readable at its original. Its historical
    // quotations are not copied into every default dispatch/refresh.
    core:{source:frame.core_source,common:frame.common},
    project_frame:{branch_source:frame.branch_source,branches:frame.branches.map(b=>({id:b.id,name:b.name})),
      relationship_source:frame.relationship_source,relationships:frame.relationships,
      coordination_source:frame.coordination_source,deliverables_source:frame.deliverables_source},
    task,user:{...user,sources:userSources},
    file_ownership:array(metadata.file_ownership,'文件归属'),dependencies,
    artifacts:references.filter(v=>v.role==='artifact'),necessary_files:references,
    execution:metadata.execution||null,
    continuation_material:{decisions:array(metadata.decisions,'当前做法与原因'),unresolved:array(metadata.unresolved,'未解决项'),running_actions:array(metadata.running_actions,'外部在途动作'),
      suggestions:array(metadata.suggestions,'协作建议'),suggestion_notice:'主控建议是帮助解决问题的材料。执行者先理解完整用户意图及建议针对的问题，再自主研究采用、调整或放弃；建议不自动成为用户条件。',
      notice:'这是显式交接材料；空列表仅表示调用方未另列，不能推出没有外部在途工作。共享分支当前任务与实际成果优先；历史窗口不作为恢复能力的前提。'},
    supplements:[],history_refs:handoffMetadata.history_refs,
    report_to:metadata.report_to||'',report_method:metadata.report_method||'普通进度留本任务；可用成果/重要发现/真实协调卡点先保存文件，原生消息按真实用户授权与工具能力办理。',
    warnings,
    continuation:'当前目标、标准及条件只沿负责人整理后的共享分支。新材料结合核心、当前任务、条件及成果由AI理解；真实影响当前结果时替换共享分支表述，纯状态追问沿现有任务回应。原话与观察沿历史出处按需读取，不累加为当前派工正文。文件是生成时快照；接续从 project/branch_id 重新 buildHandoff，当前共享原件和最新用户指示优先。缺失目标不从下一步猜；程序存取不证明理解。',
    metadata:handoffMetadata // No historical prose replay through refresh/live.
  };
  return packet;
}

export function renderHandoff(packet) {
  if(packet.format!==FORMAT) throw Error('文件交接格式不匹配。');
  const list=values=>values.map(v=>`- ${typeof v==='string'?v:JSON.stringify(v)}`).join('\n')||'未另列。';
  return [
    `# 完整任务文件交接：${packet.task.name}`,
    `生成时间：${packet.generated_at}\n项目：${packet.project}\n稳定分支：${packet.branch_id}\n${packet.continuation}`,
    `## 项目目的与共同条件\n完整确认核心原件：${packet.core.source}\n完整核心及历史原话按需沿原件展开；以下当前共同目的/条件来自共享状态。\n\n${packet.core.common}`,
    `## 全项目关系\n原件：${packet.project_frame.relationship_source}\n\n${packet.project_frame.relationships||'未提取到关系节；沿协作总览及关系原件读取。'}`,
    `## 全项目分支导航\n原件：${packet.project_frame.branch_source}\n用途与影响沿全项目关系理解；相关分支完整目标、条件和成果按ID展开。\n\n${list(packet.project_frame.branches.map(b=>`${b.name} [${b.id}]`))}`,
    `## 本分支当前完整任务\n原件：${packet.task.source}\n\n${packet.task.text}`,
    `## 执行交接与接续材料\n${JSON.stringify(packet.execution||{},null,2)}\n\n${JSON.stringify(packet.continuation_material||{},null,2)}`,
    `## 要求与历史出处\n当前有效要求见本分支完整任务；原话及已收观察仅沿出处按需展开。\n\n${list(historyReferences({...packet.metadata,user:packet.user,supplements:packet.supplements,history_refs:packet.history_refs}))}`,
    `## 文件归属\n${list(packet.file_ownership)}`,
    `## 依赖与已有成果\n依赖是协作材料，不是接手授权。\n\n${list(packet.dependencies)}\n\n${list(packet.artifacts)}`,
    `## 必要原件\n${list(packet.necessary_files)}`,
    `## 回报\n对象：${packet.report_to||'未另指定'}\n${packet.report_method}`,
    `## 当前缺口\n${list(packet.warnings)}`
  ].join('\n\n')+'\n';
}

// Explicit file expansion with visible continuation; never clips task goals/conditions.
export function readOriginal({file,offset=0,chars=12000}={}) {
  const source=absolute(file,'展开原件');
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(chars)||chars<1) throw Error('offset 须为非负整数，chars 须为正整数。');
  if(!/\.(?:md|txt|json|jsonl|mjs|js|py|ps1|yaml|yml|toml|csv)$/i.test(source)) throw Error('这里只展开文本原件；其他格式沿专用读取工具。');
  const body=fs.readFileSync(source,'utf8').replace(/^\uFEFF/,'');
  if(offset>body.length) throw Error('offset 超出原件长度。');
  const end=Math.min(body.length,offset+chars);
  return {source,content:body.slice(offset,end),offset,end,total_chars:body.length,complete:end===body.length,
    next:end<body.length?{file:source,offset:end,chars}:null};
}

// New material is returned once alongside the live task. Persisted handoff
// metadata keeps its source, never the accumulating message body. This does not
// change shared state; semantic interpretation belongs to the responsible AI.
export function prepareSupplement({project,branchId,metadata={},supplement}={}) {
  const incoming=supplements([supplement])[0];
  const current=buildHandoff({project,branchId,metadata});
  return {current,incoming,action:incoming.handling,
    merged_metadata:currentMetadata({...current.metadata,
      history_refs:[...current.history_refs,incoming.source,...(incoming.evidence_refs||[])]})};
}

export function writeHandoff(input,{directory}={}) {
  const packet=buildHandoff(input);
  const root=absolute(directory,'输出目录');
  fs.mkdirSync(root,{recursive:true});
  const bundle=path.join(root,`${packet.branch_id}-${Date.now()}-${randomUUID().slice(0,8)}`);
  const temporary=`${bundle}.tmp`;
  fs.mkdirSync(temporary); // Unique bundle: no overwrite of concurrent output.
  try {
    fs.writeFileSync(path.join(temporary,'handoff.json'),JSON.stringify(packet,null,2)+'\n');
    fs.writeFileSync(path.join(temporary,'handoff.md'),renderHandoff(packet));
    fs.renameSync(temporary,bundle);
  }catch(error){
    // Only our two exact staging files; no recursive removal.
    for(const name of ['handoff.json','handoff.md']){const file=path.join(temporary,name);if(fs.existsSync(file))fs.unlinkSync(file);}
    fs.rmdirSync(temporary);throw error;
  }
  return {directory:bundle,json:path.join(bundle,'handoff.json'),markdown:path.join(bundle,'handoff.md'),
    project:packet.project,branch_id:packet.branch_id,warnings:packet.warnings,generated_only:true};
}

export function readHandoff(file,{live=false}={}) {
  const packet=JSON.parse(fs.readFileSync(absolute(file,'交接文件'),'utf8').replace(/^\uFEFF/,''));
  if(packet.format!==FORMAT) throw Error('文件交接格式不匹配。');
  if(live) return buildHandoff({project:packet.project,branchId:packet.branch_id,metadata:packet.metadata});
  return {...currentPacket(packet),snapshot_notice:'生成时快照；不能替代当前共享原件。read --live / refresh 可重读。历史正文只在原文件按需展开，不重播为当前任务。'};
}

// Adapter for existing task-bridge records. The bridge remains its owner's file.
export function metadataFromTask(task) {
  return {user:{sources:[task.user_source,task.authorization_ref].filter(Boolean)},
    necessary_files:task.necessary_files||[],file_ownership:task.file_ownership||[],
    dependencies:task.dependencies||[],artifacts:task.artifact?[task.artifact]:[],report_to:task.report_to||'',
    execution:{task_id:task.id,previous_window:task.thread_id?{thread_id:task.thread_id,host_id:task.host_id}:null,
      progress:{state:task.state,stage:task.stage,next_step:task.next_step,artifact:task.artifact,evidence:task.evidence},
      ownership:{owner:task.owner||null,lease_until:task.lease_until||null},window_history:task.window_history||[],
      notice:'任务ID与目标沿原件继续；窗口可以替换。仍有效的owner租约先交接，不能靠新聊天抢写。'},
    supplements:[],history_refs:[...(task.window_history||[]).map(e=>({kind:'previous_window',source:`task-bridge events ${task.id}`,at:e.at,window:e.detail})),...(task.observations||[]).flatMap(o=>[o.source_ref||o.source||`task ${task.id||'record'} observation ${o.id}`,...(o.evidence_refs||[])])]};
}

export function buildTaskHandoff(task) {
  return buildHandoff({project:task.project_ref,branchId:task.branch_ref,metadata:metadataFromTask(task)});
}

async function cli() {
  const [command='help',...args]=process.argv.slice(2);
  if(['help','--help'].includes(command)){console.log('create --project ABS_PROJECT --branch ID [--input METADATA_JSON] --out ABS_DIR\nread --file HANDOFF_JSON [--live]\nrefresh --file HANDOFF_JSON --out ABS_DIR\noriginal --file ABS_TEXT [--offset N] [--chars N]\nsupplement --project ABS_PROJECT --branch ID [--input METADATA_JSON] --supplement SUPPLEMENT_JSON\n文件是原件生成视图；create/refresh不改目标、不绑定/创建聊天。supplement当次给完整任务与incoming，不自动改共享分支；merged_metadata只保留历史出处，负责人整理后重新生成完整任务。历史正文不进入默认派工。');return;}
  const flags={'--project':'project','--branch':'branchId','--input':'input','--out':'directory','--file':'file','--offset':'offset','--chars':'chars','--supplement':'supplement'};
  const options={};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--live'){options.live=true;continue;}
    const key=flags[args[i]];if(!key||args[i+1]===undefined||args[i+1].startsWith('--'))throw Error(`无效参数：${args[i]}`);
    options[key]=args[++i];
  }
  const load=file=>JSON.parse(fs.readFileSync(absolute(file,'输入文件'),'utf8').replace(/^\uFEFF/,''));
  const metadata=options.input?load(options.input):{};
  let result;
  if(command==='create')result=writeHandoff({project:options.project,branchId:options.branchId,metadata},options);
  else if(command==='read')result=readHandoff(options.file,options);
  else if(command==='refresh'){
    const p=readHandoff(options.file);result=writeHandoff({project:p.project,branchId:p.branch_id,metadata:p.metadata},options);
  }else if(command==='original')result=readOriginal({file:options.file,offset:options.offset===undefined?0:Number(options.offset),chars:options.chars===undefined?12000:Number(options.chars)});
  else if(command==='supplement')result=prepareSupplement({project:options.project,branchId:options.branchId,metadata,supplement:load(options.supplement)});
  else throw Error(`未知命令：${command}`);
  console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)cli().catch(error=>{console.error(`文件交接错误：${error.message}`);process.exitCode=1;});

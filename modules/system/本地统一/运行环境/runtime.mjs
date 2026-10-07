import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../public-paths.mjs";
// Derived environment navigation; assets remain owned by registry/resources.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {syncCurrentEvidence,applyAvailability,recordProof} from './current-evidence.mjs';
import {desktopEntries} from './desktop-navigation.mjs';
const home=path.dirname(fileURLToPath(import.meta.url));
const project=path.resolve(home,'../..');
const user=_publicPath("$user");
const bundle=_publicPath('$runtime');
const pwsh=process.env.AI_PWSH_PATH || 'pwsh';
const resourceModule=_publicPath('$codex/context/resources.mjs');
const modulesFile=_publicPath("$system/运行中心/modules.json");
const registryFile=_publicDataPath("资料中心/data/资料登记.json");
const inventoryFile=_publicDataPath("本地统一/运行环境/inventory.json");
const coverageFile=_publicDataPath("本地统一/运行环境/coverage.json");
const stateFile=_publicDataPath("本地统一/运行环境/verification.json");
const skip=new Set(['node_modules','.git','.cache','__pycache__','.venv','venv','env','models','model','blobs','data','logs','backups','_backups','runs','run','chunks','parts','.catalog-backups','修改前原件','原件备份','out','dist','vendor','upstream','assets','public','reports','evidence','screenshots']);
const extensions=new Set(['.mjs','.cjs','.js','.ts','.py','.ps1','.cmd','.bat','.sh']);
const normalize=p=>path.resolve(p).replaceAll('\\','/');
const id=(kind,p)=>kind+':'+createHash('sha256').update(normalize(p).toLowerCase()).digest('hex').slice(0,16);
const json=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const redact=s=>String(s).replace(/\b(?:sk-|AIza|ghp_|github_pat_|ya29\.)[A-Za-z0-9_\-.]+/g,'[REDACTED]').replace(/(authorization|api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi,'$1=[REDACTED]').replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g,'$1[REDACTED]@').replace(/(https?:\/\/[^\s?]+)\?[^\s]+/g,'$1?[REDACTED]');
const output=v=>console.log(JSON.stringify(v,null,2));
function writeJson(file,value){fs.mkdirSync(path.dirname(file), {recursive:true});const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n','utf8');fs.renameSync(tmp,file);}
function safeRun(executable,args,timeout=12000){
 const r=spawnSync(executable,args,{encoding:'utf8',windowsHide:true,shell:false,timeout,maxBuffer:8*1024*1024,env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}});
 return {exitCode:r.status,error:r.error?.code||undefined,stdout:redact(r.stdout||'').slice(0,2000000),stderr:redact(r.stderr||'').slice(0,2000)};
}
function psCommand(code,timeout=12000){return safeRun(pwsh,['-NoProfile','-NonInteractive','-Command',`[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; ${code}`],timeout);}
function readSafeText(file,max=150000){try{const st=fs.statSync(file);if(st.size>max)return null;return fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');}catch{return null;}}
function scriptDetail(file){
 const text=readSafeText(file), ext=path.extname(file).toLowerCase();
 const markers=[];
 if(text)for(const [i,line] of text.split(/\r?\n/).entries()){
  if(/ArgumentParser|add_parser\(|add_argument\(|cmd\s*===\s*['"](?:help|--help)|command\s*===\s*['"](?:help|--help)|case ['"]help['"]|param\(/i.test(line))markers.push(i+1);
 }
 return {runtime:ext==='.ts'?'typescript_host':ext==='.py'?'python':ext==='.ps1'?'powershell':['.mjs','.cjs','.js'].includes(ext)?'node':'shell',sourceInspected:text!==null,parameterEvidenceLines:markers.slice(0,40),parameters:markers.length?'参数定义见原件列出行；未推定任意--help安全':'未取得参数定义；只提供原件路径',bytes:fs.statSync(file).size};
}
function scanRoots(roots){
 const files=[],environments=[],coverage=[],globalCap=22000;let count=0;
 for(const root of roots){const stat={path:normalize(root.path),depth:root.depth,exists:fs.existsSync(root.path),visited:0,scripts:0,environmentMarkers:0,depthLimited:0,skippedDirectories:0,truncated:false,errors:[]};coverage.push(stat);if(!stat.exists)continue;
  function walk(dir,depth){let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch(e){stat.errors.push({path:normalize(dir),code:e.code});return;}
   for(const entry of entries){if(++count>globalCap){stat.truncated=true;return;}stat.visited++;const p=path.join(dir,entry.name);
    if(entry.isSymbolicLink())continue;
    if(entry.isDirectory()){
      // Capture environments as an environment, never traverse their packages.
      const cfg=path.join(p,'pyvenv.cfg'), conda=path.join(p,'conda-meta/history');
      if(fs.existsSync(cfg)||fs.existsSync(conda)){environments.push({path:normalize(p),marker:normalize(fs.existsSync(cfg)?cfg:conda),python:normalize(path.join(p,fs.existsSync(path.join(p,'Scripts/python.exe'))?'Scripts/python.exe':'python.exe')),provider:fs.existsSync(cfg)?'venv':'conda'});stat.environmentMarkers++;continue;}
      if(skip.has(entry.name.toLowerCase())||entry.name.startsWith('.next')){stat.skippedDirectories++;continue;}
      if(depth<root.depth)walk(p,depth+1);else stat.depthLimited++;
    }else if(entry.isFile()&&extensions.has(path.extname(entry.name).toLowerCase())){files.push({path:normalize(p),project:root.project||null,scanRoot:stat.path});stat.scripts++;}
   }
  }walk(root.path,0);
 }
 return {files,environments,coverage,visited:count,cap:globalCap};
}
async function refresh(){
 let lock;try{lock=fs.openSync(_publicDataPath("本地统一/运行环境/refresh.lock"),'wx');}catch(e){if(e.code==='EEXIST')throw Error('另一个refresh正在执行；等待其结束后重试。');throw e;}
 try{
 const now=new Date().toISOString(),rows=[],sources=[resourceModule,registryFile,modulesFile,path.join(home,'observe.ps1')],gaps=[];
 const resources=await import(pathToFileURL(resourceModule).href);
 const registered=resources.listResources({kind:'resources'});
 const resourceIds=registered.items.map(r=>r.id);
 const facts=new Map();for(const rid of resourceIds){try{const r=await resources.readResource(rid);facts.set(rid,r);rows.push({id:'resource:'+rid,kind:'resource',name:r.name,resourceId:rid,locationReference:r.facts?.location||null,category:r.facts?.category||null,source:resourceModule,readCommand:['node',resourceModule,'read','--id',rid],verification:'检索位置从登记派生；详细事实/条件在read时实时读取，不建立第二份资产事实库'});}catch{gaps.push('资料原件ID未取得：'+rid);}}
 const observed=safeRun(pwsh,['-NoProfile','-NonInteractive','-File',path.join(home,'observe.ps1')],30000);
 let observation={commands:[],processes:[],tcp:[],udp:[],errors:[]};try{if(observed.exitCode!==0)throw Error();observation=JSON.parse(observed.stdout);}catch{gaps.push('系统观察失败：'+(observed.error||observed.exitCode));}
 writeJson(_publicDataPath("本地统一/运行环境/observations.json"),observation);
 const commands=new Map();
 function addRuntime(p,name,source,resourceId){if(!p)return;const key=normalize(p).toLowerCase();if(commands.has(key))return;const present=fs.existsSync(p),alias=/WindowsApps\/python/.test(normalize(p));const row={id:id('runtime',p),kind:'runtime',name,path:normalize(p),source,resourceId:resourceId||null,pathExists:present,verification:alias?'windows_app_alias_not_interpreter_proof':!present?'declared_path_missing':'path_present_only'};commands.set(key,row);rows.push(row);if(!present&&!alias)gaps.push('声明路径当前不存在：'+normalize(p));}
 for(const c of observation.commands)addRuntime(c.path,c.name,path.join(home,'observe.ps1'),'local-command-tools');
 addRuntime(facts.get('stable-python')?.facts?.location,'python',registryFile,'stable-python');
 for(const [relative,name] of [['node/bin/node.exe','node'],['native/git/cmd/git.exe','git'],['bin/fallback/pnpm.cmd','pnpm'],['native/powershell/pwsh.exe','pwsh']])addRuntime(path.join(bundle,relative),name,registryFile,'codex-bundled-node');
 const projectRoot=path.dirname(project), roots=[{path:user+'/.codex/context',depth:0},{path:user+'/.codex/tools',depth:3},{path:user+'/.pi/agent/bin',depth:0},{path:user+'/.pi/agent/extensions',depth:1},{path:_publicPath("$data/external/pi/workbench"),depth:2},{path:user+'/scripts',depth:3},{path:user+'/Documents/scripts',depth:3}];
 // These are exact directories declared in current resource originals. Heavy
 // databases/model weights are referenced only; code roots are bounded.

 for(const e of fs.readdirSync(projectRoot,{withFileTypes:true}))if(e.isDirectory()&&!e.name.startsWith('.'))roots.push({path:path.join(projectRoot,e.name),depth:5,project:path.join(projectRoot,e.name)});
 const scan=scanRoots(roots), scriptMap=new Map(scan.files.map(f=>[f.path.toLowerCase(),f]));
 const piBase=user+'/AppData/Local/Pi Agent/resources/server-intent-delivery-20260926/node_modules/@earendil-works/pi-coding-agent';
 const piPackage=path.join(piBase,'package.json');
 if(fs.existsSync(piPackage)){
  const pkg=json(piPackage),bin=typeof pkg.bin==='string'?pkg.bin:pkg.bin?.pi;
  if(bin)addRuntime(path.join(piBase,bin),'pi-cli',piPackage);
  const piSources=['dist/core/resource-loader.js','dist/core/system-prompt.js','dist/config.js'].map(p=>normalize(path.join(piBase,p))).filter(p=>fs.existsSync(p));
  for(const p of piSources)scriptMap.set(p.toLowerCase(),{path:p,project:null,source:piPackage,title:'Pi原件 '+path.basename(p),scope:'installed_sdk_source_not_business_call'});
  sources.push(piPackage,...piSources);
  writeJson(_publicDataPath("本地统一/运行环境/pi-core-navigation.json"),{package:piPackage,name:pkg.name,version:pkg.version,cli:bin?normalize(path.join(piBase,bin)):null,sources:piSources,scope:'安装目录原件与声明；未验证本机运行的Pi服务使用哪份SDK，未调用模型'});
 }
 const modules=json(modulesFile).modules||[];
 for(const m of modules){const p=normalize(path.isAbsolute(m.path)?m.path:path.join(project,m.path));if(m.kind==='document'){rows.push({id:'module-document:'+m.id,kind:'command',name:m.title,moduleId:m.id,path:p,operation:'read_document',sources:[modulesFile,p],verification:'document reference; no executable invocation'});continue;}if(!extensions.has(path.extname(m.path)))continue;if(fs.existsSync(p)){const before=scriptMap.get(p.toLowerCase());const helpArgs=m.kind==='python'?['--help']:m.kind==='powershell'?['-Brief']:['help'];scriptMap.set(p.toLowerCase(),{...before,path:p,project,source:modulesFile,moduleId:m.id,title:m.title,centralDiscoveryTemplate:{executable:process.execPath,args:[normalize(path.join(project,'运行中心/system.mjs')),'module',m.id,...helpArgs],purpose:m.kind==='powershell'?'源码已核-Brief只读状态':'帮助入口模板；参数支持与副作用沿模块原件核查，未声称全部实跑'}});}}
 for(const f of scriptMap.values()){const detail=scriptDetail(f.path),exe=detail.runtime==='python'?facts.get('stable-python')?.facts?.location:detail.runtime==='powershell'?pwsh:detail.runtime==='node'?process.execPath:null;
 const template=exe?{executable:normalize(exe),args:[...(detail.runtime==='python'?['-X','utf8']:detail.runtime==='powershell'?['-NoProfile','-NonInteractive','-File']:[]),f.path],parametersFrom:f.path,parameterEvidenceLines:detail.parameterEvidenceLines,usage:'基础运行模板；后续参数从原件取得。本目录未自动执行此脚本。'}:null;
 const row={id:id('script',f.path),kind:'script',name:f.title||path.basename(f.path),...f,...detail,commandTemplate:template,verification:'source/path inspection only; no arbitrary execution',sources:[f.source||f.scanRoot,f.path].filter(Boolean)};rows.push(row);}
 const condaFile=user+'/.conda/environments.txt';
 const condaText=readSafeText(condaFile);if(condaText){sources.push(condaFile);for(const p of condaText.split(/\r?\n/).filter(Boolean))scan.environments.push({path:normalize(p),marker:condaFile,python:normalize(path.join(p,'python.exe')),provider:'conda'});}
 for(const p of [user+'/miniconda3',user+'/anaconda3',user+'/AppData/Local/miniconda3',user+'/AppData/Local/anaconda3',user+'/.local/bin']){if(fs.existsSync(path.join(p,'python.exe')))addRuntime(path.join(p,'python.exe'),'python','known_user_install_path');if(fs.existsSync(path.join(p,'Scripts/conda.exe')))addRuntime(path.join(p,'Scripts/conda.exe'),'conda','known_user_install_path');if(fs.existsSync(path.join(p,'uv.exe')))addRuntime(path.join(p,'uv.exe'),'uv','known_user_install_path');}
 const launcher=[...commands.values()].find(r=>r.name==='py');let pythonLauncher=null;
 if(launcher){pythonLauncher=safeRun(launcher.path,['-0p']);writeJson(_publicDataPath("本地统一/运行环境/python-launcher.json"),pythonLauncher);for(const line of pythonLauncher.stdout.split(/\r?\n/)){const match=line.match(/([A-Za-z]:[\\/].*python(?:w)?\.exe)\s*$/i);if(match)addRuntime(match[1],'python',_publicDataPath("本地统一/运行环境/python-launcher.json"));}}
 const envMap=new Map(scan.environments.map(e=>[e.path.toLowerCase(),e]));for(const e of envMap.values()){rows.push({id:id('environment',e.path),kind:'environment',name:path.basename(e.path),...e,pathExists:fs.existsSync(e.path),pythonExists:fs.existsSync(e.python),verification:'marker/path only; dependencies untested'});addRuntime(e.python,'python',e.marker);}
 const procMap=new Map((observation.processes||[]).map(p=>[p.pid,p]));
 for(const [protocol,key] of [['tcp','tcp'],['udp','udp']])for(const s of observation[key]||[]){const p=procMap.get(s.pid), endpointId=`endpoint:${protocol}:${s.address}:${s.port}:${s.pid}`;rows.push({id:endpointId,kind:'endpoint',name:`${protocol.toUpperCase()} ${s.address}:${s.port}`,protocol,address:s.address,port:s.port,pid:s.pid,process:p||null,observedAt:observation.at,verification:protocol==='tcp'?'listening_socket_observed':'udp_binding_observed',source:_publicDataPath("本地统一/运行环境/observations.json"),scope:s.address==='127.0.0.1'||s.address==='::1'?'loopback':s.address==='0.0.0.0'||s.address==='::'?'all_interfaces':'specific_interface'});}
 const modulesById=new Map(modules.map(m=>[m.id,m]));
 for(const [name,moduleId,args] of [['资料中心帮助','resource-mount',['help']],['云端恢复帮助','cloud-recovery',['--help']],['启动恢复只读状态','startup-recovery',['-Brief']]]){const m=modulesById.get(moduleId);if(!m)continue;const p=normalize(path.isAbsolute(m.path)?m.path:path.join(project,m.path));const exe=m.kind==='python'?facts.get('stable-python')?.facts?.location:m.kind==='powershell'?pwsh:process.execPath;const cmdArgs=m.kind==='python'?['-X','utf8',p,...args]:m.kind==='powershell'?['-NoProfile','-NonInteractive','-File',p,...args]:[p,...args];rows.push({id:'command:'+moduleId,kind:'command',name,moduleId,path:p,executable:exe,args:cmdArgs,sources:[p,modulesFile],verification:'explicit reviewed read-only recipe; invoke verify to prove current run'});}
 rows.push({id:'command:python-utf8',kind:'command',name:'稳定Python读取UTF8中文样本',executable:facts.get('stable-python')?.facts?.location,args:['-X','utf8',path.join(home,'utf8_sample.py')],sources:[registryFile,path.join(home,'utf8_sample.py')],verification:'explicit reviewed read-only recipe'});
 rows.push({id:'command:background-utf8',kind:'command',name:'Node→PowerShell→Python中文管道',sources:[path.join(home,'utf8_sample.py'),path.join(home,'runtime.mjs')],verification:'explicit reviewed read-only recipe'});
 const currentState=fs.existsSync(stateFile)?json(stateFile):{items:{}};
 const current=syncCurrentEvidence(rows,{id,addRuntime,state:currentState,writeState:v=>writeJson(stateFile,v)});sources.push(...current.sources);gaps.push(...current.gaps);
 const desktop=desktopEntries(id);rows.push(...desktop.entries);sources.push(...desktop.sources);
 const counts={};for(const r of rows)counts[r.kind]=(counts[r.kind]||0)+1;
 gaps.push('未知目录/外接盘/非登记云端环境未全盘遍历；扫描深度和跳过目录见roots，不声明所有本机脚本均已取得。','脚本目录包含历史成果与测试代码；project/moduleId标示归属，路径存在不表示现用生产入口。','除明确recipe外未执行脚本；未运行模型、登录或验证业务认证；监听端口不等于HTTP健康或长期运行。','未枚举虚拟环境全部包；未遍历模型权重/缓存、浏览器认证或凭据。');
 if(![...commands.values()].some(r=>r.name==='uv'))gaps.push('uv未在当前PATH和已检查用户安装位置发现；不推为整机未安装。');
 if(!envMap.size)gaps.push('有限根目录未发现venv/conda环境标记；.conda目录本身不证明存在环境。');
 const coverage={generatedAt:now,registryRevision:registered.revision,registryResourceCount:registered.total,resourceReferenceSelection:'全部当前resources未排序引用；位置为派生查询索引，详细事实read实时读取',counts,roots:scan.coverage,visitedEntries:scan.visited,entryCap:scan.cap,skipDirectoryNames:[...skip],sources:[...new Set(sources)],observedCommandNames:observation.requestedCommands||[],processObservation:{count:observation.processes?.length||0,errors:observation.errors||[],commandLinesRead:false},pythonLauncherAttempted:!!launcher,gaps};
 writeJson(inventoryFile,{schemaVersion:1,generatedAt:now,registryRevision:registered.revision,derived:true,assetTruth:'资料中心；read resource条目实时返回原件',items:rows});writeJson(coverageFile,coverage);writeJson(_publicDataPath("本地统一/运行环境/sources.json"),{sources:coverage.sources,rule:'脚本/环境/端口逐项sources/source/marker指向来源；不复制凭据或原正文。'});
 return {status:'refreshed',inventory:inventoryFile,coverage:coverageFile,generatedAt:now,counts,gaps};
 }finally{fs.closeSync(lock);fs.unlinkSync(_publicDataPath("本地统一/运行环境/refresh.lock"));}
}
function load(){if(!fs.existsSync(inventoryFile))throw Error('尚无目录，请先运行refresh');return json(inventoryFile);}
const summary=r=>({id:r.id,kind:r.kind,name:r.name,...(r.path?{path:r.path}:{}),...(r.moduleId?{moduleId:r.moduleId}:{}),...(r.resourceId?{resourceId:r.resourceId}:{}),...(r.kind==='desktop-entry'?{originalPath:r.originalPath,category:r.category,compatibility:r.compatibility,pathExists:r.pathExists}:{}),verification:r.verification,availability:r.availability,defaultCallable:r.defaultCallable,usageContext:r.usageContext,currentIssue:r.currentIssue,aliases:r.aliases});
function page(items,o,extra={}){const offset=number(o.offset,0,0,Number.MAX_SAFE_INTEGER),limit=number(o.limit,30,1,500),part=items.slice(offset,offset+limit);return {...extra,total:items.length,offset,limit,items:part.map(summary),more:Math.max(0,items.length-offset-limit),...(offset+limit<items.length?{nextOffset:offset+limit}:{})};}
function number(v,d,min,max){if(v===undefined)return d;const n=Number(v);if(!Number.isSafeInteger(n)||n<min||n>max)throw Error(`分页值必须是${min}..${max}整数`);return n;}
async function readEntry(entry){const state=fs.existsSync(stateFile)?json(stateFile):{items:{}};if(entry.kind==='resource'){const r=await import(pathToFileURL(resourceModule).href);return {navigation:entry,liveResource:await r.readResource(entry.resourceId)};}const proof=entry.kind==='environment'?state.items?.[id('runtime',entry.python)]:state.items?.[entry.id];return {...applyAvailability({...entry},proof),actualVerification:proof||null,verificationHistory:state.history?.[entry.id]||[],historyBoundary:'旧版本成功仅证明当时版本输出；当前代码启动以最新boot/实际用途层为准。'};}
async function verify(entry){
 const at=new Date().toISOString();let proof;
 if(entry.kind==='runtime'){
  if(/WindowsApps\/python/.test(entry.path)){proof={status:'not_executed',layer:'app_alias_path_only',reason:'WindowsApps启动占位不是解释器；使用resource:stable-python。'};}
  else if(!fs.existsSync(entry.path)){proof={status:'not_executed',layer:'declared_path_missing',reason:'声明路径当前不存在；没有运行该入口。'};}
  else if(entry.name==='python'){
   const code="import sys,json,encodings; print(json.dumps({'executable':sys.executable,'version':sys.version.split()[0],'encodings':encodings.__file__,'utf8_mode':sys.flags.utf8_mode,'text':'中文启动成功'},ensure_ascii=False))";
   const r=safeRun(entry.path,['-I','-B','-X','utf8','-c',code]);let data;try{data=JSON.parse(r.stdout);}catch{}proof={status:r.exitCode===0&&data?'verified':'failed',layer:'python_isolated_boot',...r,data,reason:r.exitCode===0?null:'Python隔离初始化/标准库导入失败；版本号不证明可执行代码，成因沿实际原证。'};
  }
  else if(['node','git','rg','uv','conda','ollama','docker','codex','ssh','pnpm','npm','py'].includes(entry.name)){
   const arg=entry.name==='py'?'-0p':entry.name==='ssh'?'-V':'--version';let r;
   if(/\.(cmd|ps1)$/i.test(entry.path))r=psCommand(`& '${entry.path.replaceAll("'","''")}' '${arg}'; exit $LASTEXITCODE`);
   else r=safeRun(entry.path,entry.name==='python'?['-X','utf8',arg]:[arg]);
   proof={status:r.exitCode===0?'verified':'failed',layer:'version_or_launcher_readonly',...r};
  }else if(['pwsh','powershell'].includes(entry.name)){const r=safeRun(entry.path,['-NoProfile','-NonInteractive','-Command','[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $PSVersionTable.PSVersion.ToString()']);proof={status:r.exitCode===0?'verified':'failed',layer:'powershell_version',...r};}
  else proof={status:'not_executed',layer:'path_only',pathExists:fs.existsSync(entry.path),reason:'没有已审阅的安全运行recipe。'};
 }else if(entry.kind==='command'){
  if(entry.id==='command:background-utf8'){const python=load().items.find(r=>r.kind==='runtime'&&r.resourceId==='stable-python')?.path;if(!python)throw Error('未取得稳定Python');const code=`$env:PYTHONUTF8='1'; $env:PYTHONIOENCODING='utf-8'; & '${python.replaceAll("'","''")}' -X utf8 '${path.join(home,'utf8_sample.py').replaceAll("'","''")}'; exit $LASTEXITCODE`;const r=psCommand(code);let data;try{data=JSON.parse(r.stdout);}catch{}proof={status:r.exitCode===0&&data?.chinese_equal?'verified':'failed',layer:'node_powershell_python_utf8',...r,data};}
  else if(['command:python-utf8','command:resource-mount','command:cloud-recovery','command:startup-recovery'].includes(entry.id)){const r=safeRun(entry.executable,entry.args,entry.id==='command:startup-recovery'?45000:12000);let data;try{data=JSON.parse(r.stdout);}catch{}proof={status:r.exitCode===0?'verified':'failed',layer:entry.id==='command:python-utf8'?'python_utf8_readonly':entry.id==='command:startup-recovery'?'startup_state_readonly':'script_help_only',...r,...(data?{data}:{})};}
  else proof={status:'not_executed',reason:'命令ID无允许的只读recipe'};
 }else if(entry.kind==='endpoint'){
  const r=safeRun(pwsh,['-NoProfile','-NonInteractive','-File',path.join(home,'observe.ps1')],30000);let o;try{o=JSON.parse(r.stdout);}catch{}const matched=o?.[entry.protocol]?.find(s=>s.address===entry.address&&s.port===entry.port&&s.pid===entry.pid);proof={status:matched?'verified':'not_observed_now',layer:'current_socket_owner',currentSocket:matched||null};
  if(matched&&entry.protocol==='tcp'&&entry.port===8765&&['127.0.0.1','0.0.0.0'].includes(entry.address)){try{const response=await fetch('http://127.0.0.1:8765/api/health',{signal:AbortSignal.timeout(5000),redirect:'error'});const text=await response.text();if(text.length>4096)throw Error('response_too_large');const data=JSON.parse(text);proof.http={status:response.status,service:data.service,pid:data.pid,healthMatchesOwner:data.pid===entry.pid};}catch(e){proof.http={error:e.name};}}
 }else proof={status:'not_executed',layer:'path_present_only',pathExists:entry.path?fs.existsSync(entry.path):undefined,reason:'仅观察原件/路径；此条目未提供运行recipe。'};
 // Keep only verification data under this module. No central registry writes.
 const state=fs.existsSync(stateFile)?json(stateFile):{items:{}};recordProof(state,entry.id,{at,...proof});writeJson(stateFile,state);return {id:entry.id,at,...proof};
}
function opts(args){const result={};for(let i=0;i<args.length;i++){if(!args[i].startsWith('--')||!['id','kind','query','offset','limit'].includes(args[i].slice(2)))throw Error('未知参数：'+args[i]);const key=args[i].slice(2);if(!args[i+1]||args[i+1].startsWith('--'))throw Error('参数缺值：'+args[i]);result[key]=args[++i];}return result;}
export async function runtimeCli(args=process.argv.slice(2)){
 const [cmd='help',...rest]=args,o=opts(rest);
 if(['help','--help'].includes(cmd))return {entry:normalize(path.join(home,'runtime.mjs')),commands:['refresh','coverage','list [--kind runtime|script|command|endpoint|environment|resource|software|cache|desktop-entry] [--offset N] [--limit 1..500]','search --query TEXT [--kind KIND] [--offset N] [--limit N]','read --id ID','verify --id ID'],boundary:'查询为有限范围派生导航；resource读实时沿登记原件。Python verify执行只读隔离启动/encodings/中文代码，版本输出不能充当启动证明；其他verify沿已审阅版本/样本/help/状态/健康探测，不启动停止业务。refresh派生最新原证状态，保留旧回执历史。',coverage:normalize(coverageFile)};
 if(cmd==='refresh')return refresh();
 if(cmd==='coverage')return json(coverageFile);
 const inv=load();if(o.kind&&!['runtime','script','command','endpoint','environment','resource','software','cache','desktop-entry'].includes(o.kind))throw Error('未知kind');
 if(cmd==='list')return page(inv.items.filter(r=>!o.kind||r.kind===o.kind),o,{generatedAt:inv.generatedAt,registryRevision:inv.registryRevision,selection:'unranked'});
 if(cmd==='search'){if(!o.query?.trim())throw Error('search需要--query');const terms=o.query.toLowerCase().trim().split(/\s+/);return page(inv.items.filter(r=>(!o.kind||r.kind===o.kind)&&terms.every(t=>JSON.stringify(r).toLowerCase().includes(t))),o,{query:o.query,generatedAt:inv.generatedAt});}
 if(['read','verify'].includes(cmd)){const entry=inv.items.find(r=>r.id===o.id||r.aliases?.includes(o.id));if(!entry)throw Error('ID未取得；先list/search或refresh');return cmd==='read'?readEntry(entry):verify(entry);}
 throw Error('未知命令；运行help');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)runtimeCli().then(output).catch(e=>{output({status:'error',error:redact(e.message)});process.exitCode=1;});

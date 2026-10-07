import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
// Fixed, owner-maintained paths. No module is imported or executed during discovery.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const home=path.dirname(fileURLToPath(import.meta.url));
export const project=path.dirname(home);
export const manifestFile=path.join(home,'modules.json');
const bundled=_publicPath("$runtime");
const json=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
export function moduleInventory(){
  return {checked_at:new Date().toISOString(),manifest:manifestFile,note:json(manifestFile).note,
    modules:json(manifestFile).modules.map(m=>({...m,path:m.path.startsWith('$')?_publicPath(m.path):path.isAbsolute(m.path)?m.path:path.resolve(project,m.path),
      state:fs.existsSync(m.path.startsWith('$')?_publicPath(m.path):path.isAbsolute(m.path)?m.path:path.resolve(project,m.path))?'entry_present':'entry_missing',
      verification:'未由路径存在推定平台认证、实际调用或持续运行'}))};
}
export function moduleCommand(id,args=[]){
  args=[...args];
  const m=moduleInventory().modules.find(x=>x.id===id);
  if(!m)throw new Error(`Unknown module ${id}; use system.mjs modules`);
  if(m.state==='entry_missing')return {error:'module_entry_missing',module:id,path:m.path};
  if(m.kind==='document')return {document:m.path,module:id};
  if(!Array.isArray(args)||args.some(x=>typeof x!=='string'))throw new Error('Module arguments must be strings');
  if(id==='parallel-integration'&&args[0]==='module'&&args[1]===id)throw new Error('Recursive central forwarding is not a module operation');
  if(id==='event-dispatch'&&(!args.length||['status','drain'].includes(args[0]))&&!args.includes('--providers')){
    const provider=path.join(home,'providers/gemini.mjs');
    if(fs.existsSync(provider)){if(!args.length)args.push('status');args.push('--providers',provider);}
  }
  if(m.kind==='node')return {module:id,executable:process.execPath,args:[m.path,...args]};
  if(m.kind==='python'){
    let configured;try{configured=json(_publicDataPath("信息中心/config/settings.json")).python_path;}catch{}
    return {module:id,executable:process.env.AI_PYTHON_PATH||configured||'python',args:[m.path,...args]};
  }
  if(m.kind==='powershell')return {module:id,executable:process.env.AI_PWSH_PATH||'pwsh',args:['-NoProfile','-NonInteractive','-File',m.path,...args]};
  throw new Error('Unknown module runtime '+m.kind);
}
// Inherit stdout/stderr and preserve the owner's exit code/JSON/text. Discovery
// never authenticates, invokes a model, starts a queue, or sends a native message.
export async function runModule(id,args=[]){
  const command=moduleCommand(id,args);
  if(command.error||command.document){console.log(JSON.stringify(command,null,2));return command.error?2:0;}
  return new Promise(resolve=>{
    let child;
    try{child=spawn(command.executable,command.args,{shell:false,windowsHide:true,stdio:'inherit',
      env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}});}catch(e){console.error(e.message);resolve(1);return;}
    const signals=['SIGINT','SIGTERM'];
    const stop=()=>child.kill();signals.forEach(s=>process.once(s,stop));
    let finished=false;
    const end=code=>{if(finished)return;finished=true;signals.forEach(s=>process.removeListener(s,stop));resolve(code??1);};
    child.once('error',e=>{console.error(e.message);end(1);});child.once('close',end);
  });
}

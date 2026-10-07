import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const home=path.dirname(fileURLToPath(import.meta.url));
const begin='<!-- local-workspace-pointer:start -->',end='<!-- local-workspace-pointer:end -->';
export const pointer=`${begin}
本地环境与跨宿主对话入口：node "${_publicPath("$system/本地统一/workspace.mjs")}" help；共同声明：${_publicPath("$system/本地统一/共同声明.md")}。按需读取原件，目录存在不证明长期运行。
${end}`;
const files={codex:_publicPath("$codex/AGENTS.md"),claude:_publicPath("$user/.claude/CLAUDE.md"),pi:_publicPath("$user/.pi/agent/AGENTS.md")};
export function modelLinksStatus(){return {declaration:path.join(home,'共同声明.md'),models:Object.entries(files).map(([host,file])=>({host,file,pointerPresent:fs.existsSync(file)&&fs.readFileSync(file,'utf8').includes(pointer),verification:'指针文件读取；模型热采用须看真实投递/调用',overridePresent:host==='codex'?fs.existsSync(_publicPath("$codex/AGENTS.override.md")):undefined})),gemini:{file:path.join(path.dirname(home),'运行中心/providers/gemini.mjs'),mode:'执行适配器自动附上共同声明全文；本机查询由调用者供给，Gemini没有本机shell权限'}};}
export function installPointers(){const installed=[];for(const [host,file] of Object.entries(files)){
 const old=fs.readFileSync(file,'utf8'),start=old.indexOf(begin),finish=old.indexOf(end);
 if((start>=0)!==(finish>=0)||finish>=0&&finish<start)throw Error('标记块不完整，保留原件: '+file);
 const next=start>=0?old.slice(0,start)+pointer+old.slice(finish+end.length):old.trimEnd()+'\n\n'+pointer+'\n';
 if(next!==old){const backupDir=path.join(home,'恢复材料/model-pointers');fs.mkdirSync(backupDir,{recursive:true});const backup=path.join(backupDir,`${host}-${Date.now()}.md`);fs.writeFileSync(backup,old,{flag:'wx'});fs.writeFileSync(file,next,'utf8');installed.push({host,file,backup});}
 }return {installed,status:modelLinksStatus(),restore:'仅按标记块定点恢复，备份整文件供比较；不覆盖后来他人修改。'};}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{const cmd=process.argv[2]||'status';if(!['status','install','help','--help'].includes(cmd))throw Error('status|install');console.log(JSON.stringify(cmd==='install'?installPointers():cmd==='status'?modelLinksStatus():{usage:'status|install，幂等补写同一指针标记块'},null,2));}catch(e){console.error(e.message);process.exitCode=1;}}

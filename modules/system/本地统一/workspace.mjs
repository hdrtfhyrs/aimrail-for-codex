import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {modelLinksStatus} from './model-links.mjs';

const home=path.dirname(fileURLToPath(import.meta.url));
export const declarationFile=path.join(home,'共同声明.md');
const targets={chats:path.join(home,'对话记录/conversations.mjs'),env:path.join(home,'运行环境/runtime.mjs')};
export function declaration(){return fs.readFileSync(declarationFile,'utf8').trim();}
export function navigation(){return {declaration:declarationFile,entry:path.join(path.dirname(home),'运行中心/system.mjs'),commands:['workspace help','workspace status','workspace refresh','chats navigation','chats resume --id ID','chats list --limit 20','chats search --query TEXT','chats read --id ID --offset 0 --limit 10','env search --query TEXT','env search --kind desktop-entry --query TEXT','env read --id ID'],boundary:'按需读取目录与原件；未取得云端历史、宿主文件权限和模型采用分别以实际结果为准。'};}
function run(domain,args,capture=false){
 const file=targets[domain];if(!file||!fs.existsSync(file))throw Error(`入口尚未可用: ${domain}`);
 return new Promise(resolve=>{const child=spawn(process.execPath,[file,...args],{shell:false,windowsHide:true,stdio:capture?['ignore','pipe','pipe']:'inherit',env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}});let stdout='',stderr='';
 if(capture){child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);}
 let finished=false;const finish=(code,error)=>{if(finished)return;finished=true;let result;try{result=JSON.parse(stdout.replace(/^\uFEFF/,''));}catch{}const diagnostic=error||stderr.trim()||undefined;resolve(capture?{domain,code,result,error:code===0?undefined:diagnostic,diagnostics:code===0?diagnostic:undefined,raw:result?undefined:stdout.trim()}:code);};
 child.once('error',e=>finish(1,e.message));child.once('close',code=>finish(code??1));});
}
export async function workspaceCli(args=process.argv.slice(2)){
 const [command='navigation',...rest]=args;
 if(['help','--help','-h'].includes(command)){console.log('workspace navigation|declaration|status|refresh\nworkspace chats <conversations arguments>\nworkspace env <runtime arguments>\n中央别名: system.mjs chats <args> / env <args>\nrefresh更新索引，不移动日志/环境、不启动停止业务。');return 0;}
 if(targets[command])return run(command,rest);
 if(command==='declaration'){console.log(declaration());return 0;}
 if(command==='navigation'){console.log(JSON.stringify(navigation(),null,2));return 0;}
 if(command==='status'){const results=await Promise.all([run('chats',['coverage'],true),run('env',['coverage'],true)]);console.log(JSON.stringify({checkedAt:new Date().toISOString(),navigation:navigation(),modelDeclarations:modelLinksStatus(),domains:results},null,2));return results.some(r=>r.code!==0)?2:0;}
 if(command==='refresh'){const results=[];for(const domain of ['chats','env'])results.push(await run(domain,['refresh'],true));console.log(JSON.stringify({updatedAt:new Date().toISOString(),domains:results},null,2));return results.some(r=>r.code!==0)?2:0;}
 throw Error('未知workspace命令；使用workspace help');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{process.exitCode=await workspaceCli();}catch(e){console.error(e.message);process.exitCode=1;}}

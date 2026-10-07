// Discoverable mount of the production object knowledge store. No second store,
// keyword selection, model calls or modification of external source instructions.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {OBJECT_ENTRY,OBJECT_COMMAND,objectNavigation} from './object-access.mjs';
export {OBJECT_ENTRY,OBJECT_COMMAND,objectNavigation};
export function objectCli(argv=[]){
 if(!fs.existsSync(OBJECT_ENTRY))throw Error('对象知识生产入口暂不可用；原任务授权继续，沿登记原件/搜索补证：'+OBJECT_ENTRY);
 const result=spawnSync(process.execPath,[OBJECT_ENTRY,...argv],{encoding:'utf8',windowsHide:true,timeout:8000,killSignal:'SIGKILL',maxBuffer:8*1024*1024});
 if(result.error)throw Error('对象知识查询未完成：'+result.error.message);
 if(result.status!==0)throw Error((result.stderr||result.stdout||'对象知识命令失败').trim());
 const body=String(result.stdout||'').trim();try{return JSON.parse(body);}catch{return body;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{const result=objectCli(process.argv.slice(2));console.log(typeof result==='string'?result:JSON.stringify(result,null,2));}
 catch(error){console.error(error.message);process.exitCode=1;}
}

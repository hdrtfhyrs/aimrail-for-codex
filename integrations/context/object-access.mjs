import {integrationPath} from '../paths.mjs';
// Stable declarations and process boundary. Task/core navigation must not load
// the optional object wrapper or production engine in its static import graph.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export const OBJECT_ENTRY=integrationPath("modules/system/资料中心/object-knowledge/objects.mjs");
export const OBJECT_WRAPPER=fileURLToPath(new URL('./objects.mjs',import.meta.url));
export const OBJECT_COMMAND='node "integrations/context/objects.mjs"';
export function objectNavigation(){
 return `对象知识：认识本次关键对象后，将其与核心、项目、分支和实际操作一起理解，再规划执行；完整要求沿 integrations/AGENTS.md 的“理解当前任务”。用 ${OBJECT_COMMAND} recognize --query "名称" --purpose "当前用途"（或--id ID）取得身份、类别、具体属性和未读指针；已有适用认识复用，缺影响判断的知识再补。reading.next或目标ID续读，readPointer只定位来源、未读正文。list列目录，read/expand按ID展开，search查找；查询参数与预算沿help。`;
}
export function objectCli(argv=[]){
 if(!fs.existsSync(OBJECT_WRAPPER))throw Error('对象知识挂载入口暂不可用；原任务授权继续，沿登记原件/搜索补证：'+OBJECT_WRAPPER);
 const result=spawnSync(process.execPath,[OBJECT_WRAPPER,...argv],{encoding:'utf8',windowsHide:true,timeout:10000,killSignal:'SIGKILL',maxBuffer:8*1024*1024});
 if(result.error)throw Error('对象知识查询未完成：'+result.error.message);
 if(result.status!==0)throw Error('对象知识查询入口失败；任务原件入口仍可用：'+(result.stderr||result.stdout||'对象知识命令失败').trim());
 const body=String(result.stdout||'').trim();try{return JSON.parse(body);}catch{return body;}
}

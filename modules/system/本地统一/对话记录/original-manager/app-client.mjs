import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
const HERE=path.dirname(fileURLToPath(import.meta.url));
export class AppClient {
 constructor(threadId=process.env.CODEX_THREAD_ID,{timeoutMs=30000}={}){
  if(!threadId)throw Error('Original caller thread ID required; pass the operation session_id explicitly');
  let pipe=process.env.CODEX_APP_TOOLS_PIPE_PATH;
  let owner;try{owner=JSON.parse(fs.readFileSync(_publicDataPath("本地统一/对话记录/original-manager/current-original-process.json"),'utf8'));}catch{}
  if(!pipe||!owner?.originalPackage||owner.pipe!==pipe||!fs.existsSync(owner.executablePath)){
   const probe=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(HERE,'inspect-original.ps1'),...(!pipe?['-Discover']:[])],{encoding:'utf8',windowsHide:true,timeout:4000});
   if(probe.status!==0)throw Error('Current original package verification failed: '+(probe.stderr||probe.stdout));
   owner=JSON.parse(fs.readFileSync(_publicDataPath("本地统一/对话记录/original-manager/current-original-process.json"),'utf8'));
   pipe=owner.pipe;
  }
  if(!owner.originalPackage)throw Error('Original package pipe ownership has not been verified');
  const official=path.join(path.dirname(owner.executablePath),'resources/plugins/openai-bundled/plugins/codex-app-tools/server.mjs');if(!fs.existsSync(official))throw Error('Current original bundled MCP entry unavailable');
  this.timeoutMs=timeoutMs;this.threadId=threadId;this.pending=new Map();this.seq=0;this.buffer='';
  this.child=spawn(process.execPath,[official],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,CODEX_THREAD_ID:threadId,CODEX_APP_TOOLS_PIPE_PATH:pipe}});
  this.child.stdout.setEncoding('utf8');this.child.stdout.on('data',s=>{this.buffer+=s;while(this.buffer.includes('\n')){const pos=this.buffer.indexOf('\n'),line=this.buffer.slice(0,pos);this.buffer=this.buffer.slice(pos+1);try{const m=JSON.parse(line),p=this.pending.get(m.id);if(p){this.pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}}catch{}}});
  this.child.stderr.on('data',()=>{});this.child.on('exit',()=>{for(const p of this.pending.values())p.reject(Error('Official MCP stopped'));this.pending.clear();});
 }
 request(method,params){return new Promise((resolve,reject)=>{const id=++this.seq,t=setTimeout(()=>{this.pending.delete(id);reject(Error('MCP timeout: '+method));},this.timeoutMs);this.pending.set(id,{resolve:v=>{clearTimeout(t);resolve(v);},reject:e=>{clearTimeout(t);reject(e);}});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
 async initialize(){await this.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'original-chat-management',version:'1.0'}});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');const result=await this.request('tools/list',{});this.tools=new Map(result.tools.map(t=>[t.name,t]));return result;}
 async call(name,args){if(!this.tools?.has(name))throw Error('Tool is not in original app catalog: '+name);const result=await this.request('tools/call',{name,arguments:args,_meta:{'openai/threadId':this.threadId,'openai/toolCallId':'routing-'+randomUUID()}});if(result.isError)throw Error(result.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')||'App tool failed');return result;}
 close(){this.child.stdin.end();this.child.kill();}
}
export function jsonContent(result){const parts=result.content?.filter(c=>c.type==='text').map(c=>c.text)||[];for(const p of parts){try{return JSON.parse(p);}catch{}}return {text:parts.join('\n')};}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){const client=new AppClient();try{const catalog=await client.initialize();fs.writeFileSync(new URL('./app-catalog.json',import.meta.url),JSON.stringify(catalog,null,2));const result=await client.call('list_threads',{limit:5});fs.writeFileSync(new URL('./original-live-list.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify({ok:true,toolNames:catalog.tools.map(t=>t.name),live:jsonContent(result)}));}finally{client.close();}}

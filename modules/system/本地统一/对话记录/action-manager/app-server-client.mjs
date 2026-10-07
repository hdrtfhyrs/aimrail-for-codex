import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../../public-paths.mjs";
import {spawn} from 'node:child_process';
export class AppServerClient{
 constructor(executable){this.nextId=1;this.pending=new Map();this.buffer='';this.notifications=[];
  this.process=spawn(executable,['app-server','--stdio'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:process.env});
  this.process.stdout.setEncoding('utf8');this.process.stdout.on('data',chunk=>{this.buffer+=chunk;while(this.buffer.includes('\n')){const p=this.buffer.indexOf('\n'),line=this.buffer.slice(0,p);this.buffer=this.buffer.slice(p+1);let msg;try{msg=JSON.parse(line);}catch{continue;}const wait=this.pending.get(msg.id);if(wait){this.pending.delete(msg.id);clearTimeout(wait.timeout);msg.error?wait.reject(Error(JSON.stringify(msg.error))):wait.resolve(msg.result);}else if(msg.method)this.notifications.push(msg.method);}});
  this.process.stderr.on('data',()=>{});this.process.on('error',e=>this.fail(e));this.process.on('exit',()=>this.fail(Error('Short-lived app-server exited')));
 }
 fail(error){for(const p of this.pending.values()){clearTimeout(p.timeout);p.reject(error);}this.pending.clear();}
 request(method,params){return new Promise((resolve,reject)=>{const id=this.nextId++;const timeout=setTimeout(()=>{this.pending.delete(id);reject(Error('App-server request timeout: '+method));},10000);this.pending.set(id,{resolve,reject,timeout});this.process.stdin.write(JSON.stringify({id,method,params})+'\n');});}
 async initialize(){const result=await this.request('initialize',{clientInfo:{name:'native-sidebar-sort',version:'1.0'},capabilities:{experimentalApi:true}});this.process.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');return result;}
 close(){this.process.stdin.end();this.process.kill();}
}

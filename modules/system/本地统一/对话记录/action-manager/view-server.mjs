import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../../public-paths.mjs";
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {recent,open} from './action-manager.mjs';
import {managementView} from '../management.mjs';
import {search} from '../conversations.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),nonce=randomUUID();
const html=fs.readFileSync(path.join(HERE,'管理页.html'),'utf8').replace('__NONCE__',nonce);
let origin;
function catalog(){const v=managementView(),byId=new Map(v.rows.filter(r=>r.platform==='codex').map(r=>[r.nativeId,r]));return {items:recent({limit:500}).items.map(r=>({...r,kind:byId.get(r.threadId)?.kind||'unknown',goal:byId.get(r.threadId)?.task?.fields?.['本轮目标']||null})),groups:v.groups,current:process.env.CODEX_THREAD_ID||null,readAt:new Date().toISOString()};}
function send(res,code,obj){res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(obj));}
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,origin);if(req.headers.host!==new URL(origin).host)return send(res,403,{error:'Host rejected'});if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'"});res.end(html);return;}if(req.method==='GET'&&url.pathname==='/api/catalog')return send(res,200,catalog());if(req.method==='POST'&&url.pathname==='/api/open'){if(req.headers.origin!==origin||req.headers['x-action-key']!==nonce)return send(res,403,{error:'Same-origin user action required'});let text='';for await(const c of req){text+=c;if(text.length>2000)return send(res,413,{error:'Request too large'});}const id=JSON.parse(text).threadId;return send(res,200,await open(id));}if(req.method==='GET'&&url.pathname==='/api/search'){const q=url.searchParams.get('q')||'';if(!q.trim()||q.length>300)return send(res,400,{error:'Search text required'});return send(res,200,await search(q,{platform:'codex',limit:100}));}return send(res,404,{error:'Not found'});}catch(e){send(res,500,{error:e.message});}});
server.listen(0,'127.0.0.1',()=>{origin='http://127.0.0.1:'+server.address().port;const info={pid:process.pid,url:origin,current:process.env.CODEX_THREAD_ID||null,mode:'Only responds to page requests/clicks; no chat scanning or AI',startedAt:new Date().toISOString(),expiresInHours:2};fs.writeFileSync(_publicDataPath("本地统一/对话记录/action-manager/view-running.json"),JSON.stringify(info,null,2));console.log(JSON.stringify(info));});
const expiry=setTimeout(()=>server.close(),2*60*60*1000);expiry.unref();
process.on('SIGTERM',()=>server.close());

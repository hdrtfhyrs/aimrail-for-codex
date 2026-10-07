import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {CENTER,SCHEMAS,readRegistry,searchResources,saveRecord,registrySummary,maintenanceWork,failureFollowups} from './registry.mjs';
import {listCards,readCard,saveCard} from './knowledge-service.mjs';

const token=crypto.randomBytes(24).toString('hex');
function json(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){let text='';for await(const b of req){text+=b.toString('utf8');if(Buffer.byteLength(text)>100000){const e=Error('记录内容过长');e.statusCode=413;throw e;}}return JSON.parse(text);}
export async function handleRegistry(req,res){
 const url=new URL(req.url,'http://127.0.0.1:8765'),route=url.pathname;
 if(!route.startsWith('/registry'))return false;
 try{
  if(!['127.0.0.1:8765','localhost:8765'].includes(req.headers.host))return json(res,{error:'请使用本机资料入口'},403),true;
  if(req.method==='POST'){
   const origin=req.headers.origin;
   if(req.headers['x-registry-token']!==token||(origin&&!['http://127.0.0.1:8765','http://localhost:8765'].includes(origin)))return json(res,{error:'资料入口已更新，请刷新页面再保存'},403),true;
  }
  if(req.method==='GET'&&(route==='/registry'||route==='/registry/')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(CENTER,'index.html')));}
  else if(req.method==='GET'&&route==='/registry/api/init')json(res,{token,schemas:SCHEMAS,summary:registrySummary(),accounts:readRegistry().accounts.map(a=>({id:a.id,name:a.name}))});
  else if(req.method==='GET'&&route==='/registry/api/records')json(res,searchResources(url.searchParams.get('query')||'',{kind:url.searchParams.get('kind')||undefined,limit:250}));
  else if(req.method==='POST'&&route==='/registry/api/records'){const p=await body(req);json(res,saveRecord(p.kind,p.record));}
  else if(req.method==='GET'&&route==='/registry/api/work')json(res,{resources:maintenanceWork(),failures:failureFollowups()});
  else if(req.method==='GET'&&route==='/registry/api/knowledge')json(res,listCards({query:url.searchParams.get('query')||'',type:url.searchParams.get('type')||'all',limit:250}));
  else if(req.method==='GET'&&route==='/registry/api/card')json(res,readCard(url.searchParams.get('ref')));
  else if(req.method==='POST'&&route==='/registry/api/card')json(res,saveCard(await body(req)));
  else if(req.method==='GET'&&route==='/registry/api/export'){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="resource-registry.json"','Cache-Control':'no-store'});res.end(JSON.stringify(readRegistry(),null,2));}
  else json(res,{error:'资料入口不存在'},404);
 }catch(e){json(res,{error:e.message},e.statusCode||(/不存在|unknown ref/i.test(e.message)?404:/版本|已被更新|conflict/i.test(e.message)?409:400));}
 return true;
}

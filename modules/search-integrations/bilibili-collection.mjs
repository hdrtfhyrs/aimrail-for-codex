/** Low-volume public Bilibili adapter. No authentication export or publishing. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL, fileURLToPath} from 'node:url';
const core=await import(pathToFileURL(path.resolve(process.env.DOMESTIC_SEARCH_CORE||fileURLToPath(new URL('../../plugins/search-tools/core.mjs', import.meta.url)))).href);
const stamp=()=>new Date().toISOString();
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,24);
const bounded=(x,d,min,max)=>Number.isFinite(Number(x))?Math.max(min,Math.min(max,Math.floor(Number(x)))):d;
const date=x=>Number(x)>0?new Date(Number(x)*1000).toISOString():null;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function videoIdentity(value){
 if(/^BV[0-9A-Za-z]{10}$/.test(value))return value;
 const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||!['www.bilibili.com','bilibili.com','m.bilibili.com'].includes(u.hostname))throw Error('Expected a Bilibili HTTPS video URL or BV ID');
 const id=u.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/)?.[1];if(!id)throw Error('Expected a BV video URL');return id;
}
const videoUrl=id=>`https://www.bilibili.com/video/${id}/`;
export function classifyApi(r){
 let data;try{data=JSON.parse(r.body);}catch{}
 if(r.http_status===429)return {status:'rate_limited',json:data};
 if(r.http_status===412||[ -352,-412 ].includes(data?.code))return {status:'verification_required',json:data};
 if(r.http_status===401||data?.code===-101)return {status:'login_required',json:data};
 if(r.http_status>=400)return {status:'access_restricted',json:data};
 if(!data)return {status:'unexpected_non_json',json:null};
 if(data.code!==0)return {status:data.code===-404?'not_found':'api_error',json:data};
 return {status:'ok',json:data};
}
export function extractVideoHtml(html,id){
 const m=html.match(/window\.__INITIAL_STATE__\s*=\s*(\{.*?\});\s*\(function/s)||html.match(/window\.__INITIAL_STATE__\s*=\s*(\{.*?\});/s);
 let d;try{d=JSON.parse(m?.[1]).videoData;}catch{}
 return d?.bvid===id?d:null;
}
export function extractComments(data,{limit=20,page=1}={}){
 const roots=[...(data?.top_replies||[]),...Object.values(data?.upper?.top||{}).filter(x=>x&&typeof x==='object'&&x.rpid),...(data?.replies||[])];
 if(data?.upper?.top?.rpid)roots.unshift(data.upper.top);
 const seen=new Set(),comments=[];let truncated=false;
 function add(r,level){const id=String(r.rpid_str||r.rpid||'');if(!id||seen.has(id))return;seen.add(id);if(comments.length>=limit){truncated=true;return;}comments.push({id,parent_id:String(r.parent_str||r.parent||0),root_id:String(r.root_str||r.root||0),level,text:r.content?.message||'',created_at:date(r.ctime),like_count:r.like??null,child_count:r.rcount??r.count??null});}
 for(const r of roots){add(r,1);for(const child of r.replies||[])add(child,2);}
 return {status:'ok',comments,page,total_top_level:data?.page?.count??null,total_including_children:data?.page?.acount??null,
  complete:false,scope:'one comment page, pinned and returned child previews; further child pages not fetched',truncated,
  next_page:Number.isInteger(data?.page?.count)&&page*(data?.page?.size||20)<data.page.count?page+1:null};
}
function recovery(result){const pending=[];if(!result.video)pending.push('metadata');if(result.comments.status!=='ok'&&result.comments.status!=='not_requested')pending.push('comments');if(result.subtitles.status!=='no_subtitles_reported'&&(result.subtitles.status!=='ok'||result.subtitles.parts?.some(p=>!['ok','no_subtitles_reported'].includes(p.status))))pending.push('subtitles');return {pending_sections:pending,next_comment_page:result.comments.next_page||null,
 routes:pending.length?[{route:'existing_browser',url:result.url,checked:false,reason:'first reuse the existing authenticated host browser session and return matching source evidence; ask for personal login only if that host session itself is unauthenticated'}, {route:'resume_cli',command:'resume --from saved-result.json --host-file actual-host-source.json --host-only true --output new-result.json',reason:'host-only continuation fills actual missing source evidence and preserves successful public-request data'}]:[],
 notice:'Public API login_required describes the independent request session, not whether the user is logged in to their browser. Reuse the existing host session first; keep the failed anonymous receipt. No cookie export, publishing, automatic verification solving or inferred video viewing.'};}
export function acceptHost(host,id){
 if(videoIdentity(host.source_url)!==id)throw Error('Host source mismatch');
 const v=host.html?extractVideoHtml(host.html,id):host.video;
 if(v&&v.bvid!==id)throw Error('Host video mismatch');
 if(host.evidence_level==='search_snippet')throw Error('Search snippet is not source body');
 if(host.video&&!['source_text','page_html','video_metadata'].includes(host.evidence_level))throw Error('Host metadata needs a source evidence level');
 if(host.subtitles){if(!['subtitle_json','subtitle_text','page_text'].includes(host.subtitle_evidence_level))throw Error('Host subtitles need explicit subtitle evidence');if(!Array.isArray(host.subtitles.parts)||host.subtitles.status==='ok'&&!host.subtitles.parts.some(p=>p.tracks?.some(t=>t.segments?.some(s=>typeof s.text==='string'&&s.text.trim()))))throw Error('Host subtitle payload has no actual subtitle segments');}
 if(host.comments&&(!['comment_text','page_text','comment_json'].includes(host.comment_evidence_level)||!Array.isArray(host.comments.comments)))throw Error('Host comments need actual comment evidence');
 return {video:v||null,subtitles:host.subtitles||null,comments:host.comments||null,source_retrieved_at:host.retrieved_at||null};
}
export async function readBilibili({url,comment_limit=20,comment_page=1,max_parts=1,download=core.download,delay_ms=1000,previous,host,host_only=false}={}){
 const id=videoIdentity(url),canonical=videoUrl(id);if(previous&&previous.id!==id)throw Error('Resume source mismatch');
 const result=previous?structuredClone(previous):{schema:'bilibili-readonly/v1',platform:'bilibili',id,url:canonical,video:null,comments:{status:'not_requested',comments:[],complete:false},subtitles:{status:'not_requested',parts:[],complete:false},attempts:[],evidence:[]};
 result.observed_at=stamp();result.readonly=true;result.authentication_scope={public_request_uses_host_browser_session:false,host_source_supplied:!!host,user_browser_login:'not_observed_by_this_cli',notice:'login_required applies to this independent API request; existing authenticated browser may supply matching source evidence without exporting credentials'};const limit=bounded(comment_limit,20,0,100),page=bounded(comment_page,1,1,1000),partLimit=bounded(max_parts,1,1,5);
 async function req(endpoint,section){
  if(result.attempts.length)await sleep(bounded(delay_ms,1000,0,10000));
  try{const r=await download(endpoint);const gate=classifyApi(r);const payload=gate.json;
   if(payload?.data?.ip_info)delete payload.data.ip_info;
   result.attempts.push({section,url:endpoint,http_status:r.http_status,status:gate.status,api_code:payload?.code??null,retrieved_at:r.retrieved_at||stamp()});
   result.evidence.push({section,url:endpoint,retrieved_at:r.retrieved_at||stamp(),http_status:r.http_status,body:payload||r.body});
   return {status:gate.status,data:payload?.data,response:r};
  }catch(e){const status=e.name==='AbortError'?'timeout':'network_error';result.attempts.push({section,url:endpoint,status,error:e.name,retrieved_at:stamp()});return {status};}
 }
 if(!host_only&&!result.video){const r=await req(`https://api.bilibili.com/x/web-interface/view?bvid=${id}`,'metadata');
  if(r.status==='ok'&&r.data?.bvid===id)result.video=r.data;
  else {const r=await req(canonical,'metadata_html');if(r.response?.http_status===200){result.video=extractVideoHtml(r.response.body,id);result.attempts.at(-1).status=result.video?'metadata_extracted':core.inspectPage(r.response.body,canonical,r.response.http_status).status;}}
 }
 if(host){const h=acceptHost(host,id);if(!result.video&&h.video)result.video=h.video;if(h.subtitles)result.subtitles=h.subtitles;if(h.comments)result.comments=h.comments;result.attempts.push({section:'host',status:'accepted',source_retrieved_at:h.source_retrieved_at,retrieved_at:stamp()});result.evidence.push({section:'host',source_url:canonical,body:host});}
 if(!host_only&&result.video&&limit>0&&(result.comments.status!=='ok'||page!==(result.comments.page||1))){
  let r=await req(`https://api.bilibili.com/x/v2/reply?type=1&oid=${result.video.aid}&pn=${page}&ps=20&sort=2`,'comments');
  if(r.status!=='ok'&&page===1)r=await req(`https://api.bilibili.com/x/v2/reply/wbi/main?oid=${result.video.aid}&type=1&mode=3&next=0&ps=20`,'comments_alternate');
  result.comments=r.status==='ok'?extractComments(r.data,{limit,page}):{status:r.status,comments:[],complete:false,page};
 }
 if(!host_only&&result.video&&(result.subtitles.status!=='ok'&&result.subtitles.status!=='no_subtitles_reported'||result.subtitles.parts?.some(p=>!['ok','no_subtitles_reported'].includes(p.status)))){
  const priorParts=result.subtitles.parts||[],parts=(result.video.pages||[{cid:result.video.cid,page:1}]).slice(0,Math.max(partLimit,priorParts.length)),collected=[];let needsLogin=false,failed=false;
  for(const part of parts){const saved=priorParts.find(p=>p.cid===part.cid);if(saved&&['ok','no_subtitles_reported'].includes(saved.status)){collected.push(saved);continue;}const r=await req(`https://api.bilibili.com/x/player/v2?bvid=${id}&cid=${part.cid}`,'subtitle_index');
   const list=r.data?.subtitle?.subtitles||[];let p={cid:part.cid,page:part.page,status:r.status,tracks:[],chapters:r.data?.view_points?.map(({from,to,content})=>({from,to,text:content}))||[]};
   if(r.status==='ok'){
    if(r.data?.need_login_subtitle&&!list.length){p.status='login_required';needsLogin=true;}
    else if(!list.length)p.status='no_subtitles_reported';
    else {for(const track of list.slice(0,1)){let trackUrl=track.subtitle_url;if(trackUrl?.startsWith('//'))trackUrl='https:'+trackUrl;
      let u;try{u=trackUrl?new URL(trackUrl):null;}catch{}if(!u||u.protocol!=='https:'||u.username||u.password||!(u.hostname==='hdslb.com'||u.hostname.endsWith('.hdslb.com')||u.hostname==='bilibili.com'||u.hostname.endsWith('.bilibili.com'))){p.status='subtitle_url_unavailable';failed=true;continue;}
      // Subtitle payloads are plain JSON without API code wrappers.
      await sleep(bounded(delay_ms,1000,0,10000));try{const sr=await download(u.href);const data=JSON.parse(sr.body);if(sr.http_status===200&&Array.isArray(data.body)){p.status='ok';p.tracks.push({language:track.lan,language_name:track.lan_doc,segments:data.body.map(({from,to,content})=>({from,to,text:content}))});result.evidence.push({section:'subtitle_text',url:u.origin+u.pathname,retrieved_at:sr.retrieved_at||stamp(),body:data});result.attempts.push({section:'subtitle_text',url:u.origin+u.pathname,status:'ok',retrieved_at:sr.retrieved_at||stamp()});}else{p.status='subtitle_fetch_failed';failed=true;}}catch(e){p.status='subtitle_fetch_failed';failed=true;result.attempts.push({section:'subtitle_text',url:u.origin+u.pathname,status:p.status,error:e.name,retrieved_at:stamp()});}
     }}
   }else failed=true;collected.push(p);
  }
  const ok=collected.some(p=>p.status==='ok');result.subtitles={status:ok?'ok':needsLogin?'login_required':failed?'source_unavailable':'no_subtitles_reported',parts:collected,complete:ok&&parts.length===(result.video.pages?.length||1)&&collected.every(p=>p.status==='ok'),scope:'first subtitle track of requested parts; audio/video not watched'};
 }
 result.coverage={description_present:!!result.video?.desc,description_complete:!!result.video,comments_loaded:result.comments.comments?.length||0,comments_complete:result.comments.complete===true,subtitles_status:result.subtitles.status,subtitles_complete:result.subtitles.complete===true,video_watched:false,audio_transcribed:false,parts_total:result.video?.pages?.length??null,parts_inspected:result.subtitles.parts?.length||0};
 result.recovery=recovery(result);result.status=!result.video?'source_unavailable':result.recovery.pending_sections.length?'partial_content':'observed_with_scope';return result;
}
export function toSourcePacket(result,{query}={}){
 const v=result.video,comments=result.comments.comments||[],subtitles=result.subtitles.parts||[];
 const subtitleText=subtitles.flatMap(p=>p.tracks||[]).flatMap(t=>t.segments||[]).map(s=>s.text).join('\n');
 const content=[v?.desc?'视频简介\n'+v.desc:null,comments.length?'已读评论\n'+comments.map(c=>`[评论 ${c.id}, 层级 ${c.level}] ${c.text}`).join('\n'):null,subtitleText?'已取得字幕\n'+subtitleText:null].filter(Boolean).join('\n\n');
 const records=v?[{externalId:result.id,kind:'video',url:result.url,title:v.title,description:v.desc,content,publishedAt:date(v.pubdate),author:v.owner?.name||null,durationSeconds:v.duration,viewCount:v.stat?.view??null,
  coverage:result.coverage,evidenceLevel:comments.length?'video_description_and_comments':'video_description',unknownFields:['video audiovisual content',...(result.subtitles.complete?[]:['full subtitles']),...(result.comments.complete?[]:['all comments'])],
  comments,subtitles,subtitleText,sourceEvidence:result.evidence.map(({body,...e})=>e)}]:[];
 return {schema:'source-packet/v1',source:'bilibili',url:result.url,observedAt:result.observed_at,status:result.status,context:'video_source',query,coverage:result.coverage,records,
  id:hash([result.id,result.observed_at,result.coverage,records]),rawEvidence:result.evidence,attempts:result.attempts,recovery:result.recovery};
}
export async function searchBilibili({query,count=6,search=core.searchPublic}={}){
 if(typeof query!=='string'||!query.trim()||query.length>600)throw Error('query must contain 1-600 characters');
 const r=await search({query,site:'bilibili.com',count:bounded(count,6,1,20),resolve_count:3});
 const seen=new Set();const results=(r.results||[]).filter(item=>{try{const id=videoIdentity(item.url);if(seen.has(id))return false;seen.add(id);return true;}catch{return false;}}).map(item=>({...item,url:videoUrl(videoIdentity(item.url)),externalId:videoIdentity(item.url),evidence_level:'search_snippet'}));
 return {...r,platform:'bilibili',readonly:true,results,status:results.length?'ok':r.status==='ok'?'no_matching_video_links':r.status};
}
async function write(file,data){await fs.mkdir(path.dirname(path.resolve(file)),{recursive:true});const tmp=file+'.'+process.pid+'.tmp';await fs.writeFile(tmp,JSON.stringify(data,null,2)+'\n');await fs.rename(tmp,file);}
async function cli(){const [command='help',...rest]=process.argv.slice(2),o={};for(let i=0;i<rest.length;i+=2){if(!rest[i].startsWith('--')||rest[i+1]===undefined)throw Error('Expected --key value');o[rest[i].slice(2)]=rest[i+1];}
 if(command==='help'){console.log(JSON.stringify({module:'bilibili-collection',commands:['search --query Q --count 6 --output discovery.json','read --url BV-or-URL --comment-limit 20 --max-parts 1 --output result.json --source-output source.json','resume --from result.json --output resumed.json --source-output source.json','convert --from result.json --output source.json'],host:'optional --host-file source.json; matching source evidence only'},null,2));return;}
 let r;if(command==='search')r=await searchBilibili({query:o.query,count:o.count});else if(command==='convert')r=toSourcePacket(JSON.parse(await fs.readFile(o.from,'utf8')),{query:o.query});else if(['read','resume'].includes(command)){const previous=command==='resume'?JSON.parse(await fs.readFile(o.from,'utf8')):undefined;const host=o['host-file']?JSON.parse(await fs.readFile(o['host-file'],'utf8')):undefined;r=await readBilibili({url:o.url||previous?.url,comment_limit:o['comment-limit'],comment_page:o['comment-page'],max_parts:o['max-parts'],previous,host,host_only:o['host-only']==='true'});if(o['source-output'])await write(o['source-output'],toSourcePacket(r,{query:o.query}));}else throw Error('Unknown command');
 if(o.output){await write(o.output,r);console.log(JSON.stringify({status:r.status,output:path.resolve(o.output),source_output:o['source-output']?path.resolve(o['source-output']):undefined,coverage:r.coverage,count:r.results?.length,recovery:r.recovery},null,2));}else console.log(JSON.stringify(r,null,2));
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)cli().catch(e=>{console.error(JSON.stringify({status:'error',error:e.message}));process.exitCode=1;});

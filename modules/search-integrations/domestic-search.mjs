/** Read-only domestic community search. Reuses existing search core, never edits it. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL, fileURLToPath} from 'node:url';

const corePath=process.env.DOMESTIC_SEARCH_CORE || fileURLToPath(new URL('../../plugins/search-tools/core.mjs', import.meta.url));
const core=await import(pathToFileURL(path.resolve(corePath)).href);
const require=createRequire(pathToFileURL(path.resolve(corePath)));
const {load}=require('cheerio');
const stamp=()=>new Date().toISOString();
const clean=x=>String(x ?? '').replace(/\s+/g,' ').trim();
const int=(x,d,min,max)=>Number.isFinite(Number(x))?Math.max(min,Math.min(max,Math.floor(Number(x)))):d;
const SITES=[
 {id:'v2ex',name:'V2EX',domain:'v2ex.com',aliases:['V站'],search:'https://www.sov2ex.com/?q=',read:'HTML主帖/附言/本页回复，失败尝试公开legacy JSON；v2 API需本人PAT。'},
 {id:'linuxdo',name:'LINUX DO',domain:'linux.do',aliases:['linux.do','Linux.do','LinuxDO'],search:'https://linux.do/search?q=',read:'Discourse topic/search JSON及HTML；部署可能要求登录或Cloudflare验证。'},
 {id:'zhihu',name:'知乎',domain:'zhihu.com',aliases:['知乎'],search:'https://www.zhihu.com/search?type=content&q=',read:'公开问题/回答/专栏HTML；403、登录及动态加载需现有web或已登录浏览器。'},
 {id:'tieba',name:'百度贴吧',domain:'tieba.baidu.com',aliases:['贴吧'],search:'https://tieba.baidu.com/f/search/res?isnew=1&qw=',read:'HTML楼层/楼主与本页回复；安全验证需现有web或浏览器。'},
 {id:'csdn',name:'CSDN',domain:'csdn.net',aliases:['CSDN'],search:'https://so.csdn.net/so/search?q=',read:'公开原创博客HTML正文；评论通常动态，本模块不承诺评论完整。'}
];
function siteBy(value){const s=SITES.find(s=>[s.id,s.name,s.domain,...s.aliases].some(a=>a.toLowerCase()===String(value).toLowerCase()));if(!s)throw Error(`Unsupported community: ${value}`);return s;}
export function listSites(){return SITES.map(s=>({...s,aliases:[...s.aliases],readonly:true}));}
export function locateSite(value){try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return null;return SITES.find(s=>u.hostname===s.domain||u.hostname.endsWith('.'+s.domain))?.id||null;}catch{try{return siteBy(value).id;}catch{return null;}}}
function knownUrl(url){const id=locateSite(url);if(!id||!core.publicUrl(url))throw Error('Expected a supported public community HTTP(S) URL without credentials');return {site:siteBy(id),u:new URL(url)};}
function safeUrl(url){const u=new URL(url);for(const k of [...u.searchParams.keys()])if(/token|auth|cookie|key|signature|captcha|verify/i.test(k))u.searchParams.delete(k);u.hash='';return u.href;}
function sourceIdentity(url){const {site,u}=knownUrl(url);const patterns={v2ex:/\/t\/(\d+)/,linuxdo:/\/t\/(?:[^/]+\/)?(\d+)/,csdn:/\/article\/(?:details|detail)\/(\d+)/,tieba:/\/p\/(\d+)/};const id=u.pathname.match(patterns[site.id]||/$^/)?.[1];return id?`${site.id}:${id}`:`${site.id}:${u.hostname}${u.pathname.replace(/\/$/,'')}`;}
function textHtml(html){const $=load(html||'');$('script,style,noscript,template').remove();$('br').replaceWith('\n');$('p,div,li,h1,h2,h3,h4,pre,blockquote,tr').append('\n');return $.root().text().split('\n').map(clean).filter(Boolean).join('\n');}
function json(html){try{return JSON.parse(html);}catch{return null;}}
function dateUnix(x){return Number.isFinite(Number(x))&&Number(x)>0?new Date(Number(x)*1000).toISOString():null;}
export function classifyResponse(response){
 const {body='',final_url,http_status=200,content_type=''}=response;
 const data=/json/i.test(content_type)?json(body):null;
 if(data&& !Array.isArray(data)&& (data.error_type||data.errors||data.success===false)){
  const msg=clean(JSON.stringify(data.errors||data.message||data.error_type));
  return {status:/login|not_logged_in|unauth/i.test(msg)?'login_required':http_status===429?'rate_limited':http_status>=400?'access_restricted':'api_error'};
 }
 const page=core.inspectPage(body,final_url,http_status);
 if(http_status===429)return {...page,status:'rate_limited'};
 if(page.status!=='public_page')return page;
 const $=load(body);const visible=textHtml($('body').html());
 if(/访问异常|请求异常|访问受限|人机验证|验证后继续|检测到异常请求/.test(page.title)||visible.length<1200&&/请完成验证|请先登录后|登录后可查看|登录后查看全文/.test(visible))return {...page,status:/登录/.test(visible)?'login_required':'verification_required'};
 return page;
}
function recovery(site,{url,query,status}){
 const q=query||new URL(url).pathname.split('/').filter(Boolean).pop()||site.name;
 return [
  {route:'host_web',availability:'requires_host_callback',checked:false,action:query?'search_query':'open',query:`${q} site:${site.domain}`,url:url||null,reason:status},
  {route:'site_search',availability:'must_check',checked:false,url:site.search+encodeURIComponent(q),reason:'站内入口可能仍需登录/验证'},
  {route:'existing_browser',availability:'requires_host_callback',checked:false,url:url||site.search+encodeURIComponent(q),action:'use an independent task tab; read main post and relevant replies once',reason:'动态页/登录页由当前宿主浏览器读取；不循环刷新或自动解验证码'}
 ];
}
/** Serializable bridge: a Node process asks the current host; it cannot invoke chat tools itself. */
export function hostRequest({action='read',url,query,sites,count=6,reason='host_requested'}={}){
 if(!['read','search'].includes(action))throw Error('host action must be read or search');
 const selected=action==='read'?[knownUrl(url).site]:(sites||['v2ex','linuxdo','csdn','zhihu','tieba']).map(siteBy);
 if(action==='search'&&(typeof query!=='string'||!query.trim()||query.length>600))throw Error('query must contain 1-600 characters');
 return {module:'domestic-search',action,status:'host_pending',readonly:true,reason,url:url?safeUrl(url):undefined,query,
  routes:selected.flatMap(site=>recovery(site,{url,query,status:reason})),
  expected_result:action==='read'?{source_url:'exact requested post URL',evidence_level:'source_text (not search_snippet)',text:'actual source body',coverage:{main_post_present:null,main_post_complete:false,all_replies_loaded:false,scope:'state actually read portion'}}:{status:'ok|no_results|verification_required|login_required|access_restricted',results:[{title:'source title',url:'actual post URL',snippet:'discovery only'}],count:int(count,6,1,20)},
  continuation:'Use a separate existing authorized browser tab or host web once; return --fallback-file with --host-only true. Do not export cookies/tokens or automatically solve verification.'};
}
function pageLinks($,base,selector){const links=[];$(selector).each((i,e)=>{const u=core.publicUrl($(e).attr('href'),base);if(u&&locateSite(u)===locateSite(base)&&u!==base&&!links.includes(u))links.push(u);});return links.slice(0,12);}
/** Pure parser also accepts browser-returned HTML, preserving the same coverage checks. */
export function extractCommunityHtml({url,html,http_status=200}){
 const {site,u}=knownUrl(url),gate=classifyResponse({body:html,final_url:url,http_status,content_type:'text/html'});
 if(gate.status!=='public_page')return {site:site.id,...gate,evidence_level:'none',text:null};
 const $=load(html);const title=clean($('h1').first().text()||$('title').text());
 const metaDate=$('meta[property="article:published_time"],meta[itemprop="datePublished"],meta[name="pubdate"]').first().attr('content')||null;
 let main='',author=null,date=metaDate,date_source=metaDate?'page_meta':null,replies=[],supplements=[],expected=null,pages=[];
 if(site.id==='v2ex'){
  main=textHtml($('.topic_content').first().html());
  author=clean($('.header .gray a[href^="/member/"]').first().text())||null;
  $('.subtle').each((i,e)=>{const t=textHtml($(e).find('.topic_content').html()||$(e).html());if(t)supplements.push(t);});
  $('[id^="r_"]').each((i,e)=>{const row=$(e),content=textHtml(row.find('.reply_content').html());if(content)replies.push({id:row.attr('id'),author:clean(row.find('strong a[href^="/member/"]').first().text())||null,date:clean(row.find('.ago').attr('title')||row.find('.ago').text())||null,text:content});});
  expected=Number(clean($('.box .gray').text()).match(/(\d+)\s*(?:条回复|replies)/i)?.[1]??NaN);if(!Number.isFinite(expected))expected=null;
  pages=pageLinks($,url,'a.page_normal');
 }else if(site.id==='linuxdo'){
  const posts=$('.topic-body,article[data-post-id]');
  posts.each((i,e)=>{const row=$(e),content=textHtml(row.find('.cooked,.post').first().html()),n=Number(row.attr('data-post-number')||row.attr('data-post-id'));if(!content)return;if(n===1||row.attr('id')==='post_1'){main=content;date=row.find('time').attr('datetime')||date;date_source=date?'post_time':null;author=clean(row.find('.creator,.username').first().text())||null;}else replies.push({post_number:n||null,text:content});});
  // Discourse public crawler view labels first post with id=post_1 on wrapper.
  if(!main){const op=$('#post_1 .post,#post_1 .cooked').first();main=textHtml(op.html());}
  pages=pageLinks($,url,'a[rel="next"],.crawler-post-footer a');
 }else if(site.id==='csdn'){
  main=textHtml($('#content_views').first().html());author=clean($('#uid,.profile-intro-name-box .profile-intro-name-boxTop a').first().text())||null;
  if(!date){date=clean($('.time').first().text())||null;date_source=date?'page_time_label':null;}
 }else if(site.id==='tieba'){
  $('.l_post').each((i,e)=>{const row=$(e),f=json(row.attr('data-field'))||{},content=textHtml(row.find('.d_post_content').html());if(!content)return;const n=Number(f.content?.post_no);const p={id:f.content?.post_id||null,post_number:n||null,author:f.author?.user_name||null,date:f.content?.date||null,text:content};if(n===1){main=content;author=p.author;date=p.date;date_source=date?'post_data_field':null;}else replies.push(p);});
  pages=pageLinks($,url,'.pb_list_pager a');
  // Current Vue desktop view observed in the real host browser; keep legacy extraction above.
  if(!main&&$('.pb-content-wrap').length){
   main=textHtml($('.pb-content-wrap').first().html());
   author=clean($('.image-text > .user-info .head-name').first().text())||author;
   date=clean($('.image-text > .user-info .post-num').first().text())||date;date_source=date?'page_time_label':null;
   $('.pb-comment-item').each((i,e)=>{const row=$(e),content=textHtml(row.find('> .comment-content > .pb-rich-text').first().html()),meta=clean(row.find('> .comment-content > .pc-pb-comments-desc .comment-desc-left').first().text());if(content)replies.push({post_number:Number(meta.match(/第(\d+)楼/)?.[1])||null,author:clean(row.find('> .user-info .head-name').first().text())||null,date:meta.match(/\d{4}-\d{2}-\d{2}/)?.[0]||null,text:content});});
   expected=Number(clean($('.card-tab .tab-item').first().text()).match(/全部回复\s*\((\d+)\)/)?.[1]??NaN);if(!Number.isFinite(expected))expected=null;
  }
 }else if(site.id==='zhihu'){
  if(u.hostname==='zhuanlan.zhihu.com'){main=textHtml($('.Post-RichText').first().html());author=clean($('.AuthorInfo-name').first().text())||null;}
  else{
   main=textHtml($('.QuestionRichText').first().html());
   $('.AnswerItem').each((i,e)=>{const row=$(e),content=textHtml(row.find('.RichContent-inner,.RichText').first().html());if(!content)return;const p={author:clean(row.find('.AuthorInfo-name').first().text())||null,text:content};if(/\/answer\/\d+/.test(u.pathname)&&!main){main=content;author=p.author;}else replies.push(p);});
   // A question without description may still have its actual question title.
   if(!main&&!/\/answer\//.test(u.pathname)&&$('.QuestionHeader-title').length)main=clean($('.QuestionHeader-title').text());
  }
 }
 const text=[main,...supplements.map(t=>'附言\n'+t),...replies.map(r=>`回复 ${r.author||r.post_number||r.id||''}\n${r.text}`)].filter(Boolean).join('\n\n');
 const main_present=Boolean(main),loaded=replies.length;
 return {site:site.id,title,author,published_date:date,date_source,date_verified:false,status:main_present?'ok':text?'partial_content':'parse_failed_or_dynamic_page',evidence_level:main_present?'community_main_text':text?'community_reply_text':'none',extraction_method:`${site.id}_html_selectors`,text:text||null,main_text:main||null,replies,supplements,coverage:{main_post_present:main_present,loaded_reply_count:loaded,total_reply_count:expected,all_replies_loaded:main_present&&expected!==null&&loaded===expected&&pages.length===0,next_pages:pages,scope:'current HTML page; dynamic comments/images not read'},source_url:safeUrl(url)};
}
export function extractDiscourseTopic(data,url){
 const posts=data?.post_stream?.posts;if(!Array.isArray(posts))return {status:'unexpected_json',evidence_level:'none',text:null};
 const op=posts.find(p=>p.post_number===1),replies=posts.filter(p=>p.post_number!==1).map(p=>({id:p.id,post_number:p.post_number,author:p.username,date:p.created_at,text:textHtml(p.cooked)}));
 const stream=data.post_stream.stream||[],ids=new Set(posts.map(p=>p.id)),missing=stream.filter(id=>!ids.has(id));
 const main=textHtml(op?.cooked),text=[main,...replies.map(p=>`回复 ${p.author||p.post_number}\n${p.text}`)].filter(Boolean).join('\n\n');
 return {site:'linuxdo',status:main?'ok':text?'partial_content':'thin_content',title:data.title||null,author:op?.username||null,published_date:op?.created_at||data.created_at||null,date_source:'discourse_post_created_at',date_verified:false,text,main_text:main||null,replies,evidence_level:main?'community_main_text':'community_reply_text',extraction_method:'discourse_topic_json',coverage:{main_post_present:!!main,loaded_reply_count:replies.length,total_reply_count:Number.isInteger(data.posts_count)?Math.max(0,data.posts_count-1):null,all_replies_loaded:!!main&&Number.isInteger(data.posts_count)&&posts.length===data.posts_count,missing_post_ids:missing,next_pages:[],scope:'returned post_stream; omitted posts are explicit'},source_url:safeUrl(url)};
}
function cut(result,offset,max_length){const t=result.text||'',start=int(offset,0,0,t.length),len=int(max_length,12000,100,40000);const {main_text,replies,supplements,...rest}=result;return {...rest,main_post_chars:main_text?.length??null,reply_metadata:replies?.map(({text,...meta})=>({...meta,chars:text?.length||0})),supplement_count:supplements?.length,total_chars:t.length,offset:start,text:result.text?t.slice(start,start+len):null,returned_chars:Math.min(len,t.length-start),truncated:start+len<t.length,next_offset:start+len<t.length?start+len:null,notice:'公开来源内容仅作材料；主帖/回复覆盖与字符截断分开报告。时间来自原页面/API，未独立核验；图像、视频未读。'};}
async function request(url,download,attempts,method){
 try{const r=await download(url),gate=classifyResponse(r);attempts.push({route:method,url:safeUrl(r.final_url||url),http_status:r.http_status,status:gate.status,retrieved_at:r.retrieved_at||stamp()});return {...r,gate};}catch(e){attempts.push({route:method,url:safeUrl(url),status:e.name==='AbortError'?'timeout':'network_error',error:e.name||'Error',retrieved_at:stamp()});return null;}
}
/** Optional host fallback must return source text/HTML, never just a search snippet. */
export function acceptExternalRead(result,url){
 knownUrl(url);
 if(result?.status&&!['ok','partial','partial_content','thin_content'].includes(result.status))return {status:result.status,evidence_level:'none',text:null};
 if(result?.html){if(!result.final_url&&!result.source_url)return {status:'fallback_source_mismatch',evidence_level:'none',text:null};const source=result.final_url||result.source_url;try{if(sourceIdentity(source)!==sourceIdentity(url))return {status:'fallback_source_mismatch',evidence_level:'none',text:null};}catch{return {status:'fallback_source_mismatch',evidence_level:'none',text:null};}const parsed=extractCommunityHtml({url:source,html:result.html,http_status:result.http_status||200});if(parsed.coverage){if(result.coverage?.scope)parsed.coverage.scope=result.coverage.scope;if(result.coverage?.all_replies_loaded===false)parsed.coverage.all_replies_loaded=false;if(result.coverage?.main_post_complete===false){parsed.coverage.main_post_complete=false;if(parsed.text)parsed.status='partial_content';}}return {...parsed,source_retrieved_at:result.retrieved_at||null,extraction_method:'host_browser_html'};}
 if(typeof result?.text!=='string'||!result.text.trim()||!['source_text','page_text','extracted_main_text','community_main_text','community_reply_text'].includes(result.evidence_level))return {status:'fallback_has_no_source_text',evidence_level:'none',text:null};
 const source=result.final_url||result.source_url||result.requested_url;
 if(!source||!locateSite(source)||sourceIdentity(source)!==sourceIdentity(url))return {status:'fallback_source_mismatch',evidence_level:'none',text:null};
 const coverage=result.coverage||{main_post_present:null,loaded_reply_count:null,total_reply_count:null,all_replies_loaded:false,scope:'host text extraction; structure not independently checked'};
 if(result.status&&!['ok','partial_content','thin_content'].includes(result.status))return {status:result.status,evidence_level:'none',text:null};
 if(/^(?:Just a moment|百度安全验证|登录|Sign in|Access denied)/i.test(clean(result.title))&&result.text.length<2000)return {status:'verification_or_login_page',evidence_level:'none',text:null};
 return {site:locateSite(url),status:coverage.main_post_present===true&&coverage.main_post_complete!==false?'ok':'partial_content',title:result.title||null,text:result.text,coverage,published_date:result.published_date||null,date_source:result.date_source||null,date_verified:false,evidence_level:result.evidence_level,source_url:safeUrl(source),source_retrieved_at:result.retrieved_at||null,extraction_method:result.extraction_method||'host_fallback_text'};
}
export async function readDomestic({url,offset=0,max_length=12000,readFallback,download=core.download,host_only=false}={}){
 const {site,u}=knownUrl(url),attempts=[];let found=null;
 if(host_only){
  if(typeof readFallback==='function'){try{found=acceptExternalRead(await readFallback({url,site:site.id,reason:'host_only'}),url);attempts.push({route:'host_read_fallback',status:found.status,retrieved_at:stamp()});}catch(e){found={status:'fallback_error',evidence_level:'none',text:null};attempts.push({route:'host_read_fallback',status:'fallback_error',error:e.name||'Error',retrieved_at:stamp()});}}
  else found={status:'host_pending',evidence_level:'none',text:null};
  return cut({...found,site:site.id,requested_url:safeUrl(url),retrieved_at:stamp(),attempts,host_request:found.text?undefined:hostRequest({url,reason:found.status}),recovery_routes:found.coverage?.main_post_present?[]:recovery(site,{url,status:found.status})},offset,max_length);
 }
 if(site.id==='linuxdo'){
  const id=u.pathname.match(/\/t\/(?:[^/]+\/)?(\d+)/)?.[1];
  if(id){const r=await request(`https://linux.do/t/${id}.json`,download,attempts,'discourse_json');if(r?.gate.status==='public_page'){const data=json(r.body);found=extractDiscourseTopic(data,url);}}
 }
 if(!found?.coverage?.main_post_present){const r=await request(url,download,attempts,'community_html');if(r?.gate.status==='public_page'){const parsed=extractCommunityHtml({url:r.final_url,html:r.body,http_status:r.http_status});if(parsed.text||!found?.text)found=parsed;}else if(!found?.text)found={status:r?.gate.status||attempts.at(-1)?.status,evidence_level:'none',text:null};}
 // Author-documented legacy endpoints are a bounded V2EX fallback, not a full-site crawler.
 if(site.id==='v2ex'&&!found?.coverage?.main_post_present){
  const id=u.pathname.match(/\/t\/(\d+)/)?.[1];
  if(id){const r=await request(`https://www.v2ex.com/api/topics/show.json?id=${id}`,download,attempts,'v2ex_legacy_topic');const data=r?.gate.status==='public_page'?json(r.body):null;const op=Array.isArray(data)?data.find(t=>String(t.id)===id):null;
   if(op){const main=op.content||textHtml(op.content_rendered);found={site:'v2ex',status:main?'ok':'thin_content',title:op.title,author:op.member?.username||null,published_date:dateUnix(op.created),date_source:'v2ex_created_unix',date_verified:false,text:main,main_text:main,replies:[],evidence_level:'community_main_text',extraction_method:'v2ex_legacy_topic_json',source_url:safeUrl(url),coverage:{main_post_present:!!main,loaded_reply_count:0,total_reply_count:op.replies??null,all_replies_loaded:op.replies===0,next_pages:[],scope:'topic JSON; supplements/replies not requested'}};}
  }
 }
 if(!found?.coverage?.main_post_present&&typeof readFallback==='function'){
  try{const other=acceptExternalRead(await readFallback({url,site:site.id,reason:found?.status||'unavailable'}),url);attempts.push({route:'host_read_fallback',status:other.status,retrieved_at:stamp()});if(other.text)found=other;}catch(e){attempts.push({route:'host_read_fallback',status:'fallback_error',error:e.name||'Error',retrieved_at:stamp()});}
 }
 found||={status:'unavailable',evidence_level:'none',text:null};
 return cut({...found,site:site.id,requested_url:safeUrl(url),retrieved_at:stamp(),attempts,host_request:found.coverage?.main_post_present?undefined:hostRequest({url,reason:found.status}),recovery_routes:found.coverage?.main_post_present?[]:recovery(site,{url,status:found.status})},offset,max_length);
}
function filterResults(rows,site){const out=[],rejected=[];for(const r of rows||[]){if(!r?.url||!core.publicUrl(r.url))continue;const id=locateSite(r.url);if(id!==site.id){rejected.push({title:r.title,url:safeUrl(r.url),reason:id?'other_community':'unverified_domain_or_engine_redirect'});continue;}const u=new URL(r.url),contentPath={v2ex:/^\/t\/\d+/,linuxdo:/^\/t\//,zhihu:/^\/(?:p|question)\//,tieba:/^\/p\/\d+/,csdn:/\/(?:article|\w{16,}\.html)/}[site.id];if(!contentPath.test(u.pathname)){rejected.push({title:r.title,url:safeUrl(r.url),reason:'non_content_page'});continue;}const url=safeUrl(r.url);if(out.some(x=>x.url===url))continue;out.push({...r,url,site:site.id,site_scope:'verified_url_domain',evidence_level:'search_snippet'});}return {results:out,rejected};}
async function searchOne(site,query,options){
 const attempts=[];let results=[],rejected=[],nativeEmpty=false,suspicious=false;
 if(options.host_only){
  let raw={status:'host_pending',results:[]};try{if(typeof options.searchFallback==='function')raw=await options.searchFallback({query,site:site.domain,site_id:site.id,count:options.count,reason:'host_only'});}catch{raw={status:'fallback_error',results:[]};}
  const filtered=filterResults(['ok','partial','possibly_unrelated','no_results'].includes(raw.status)?raw.results:[],site);
  const status=filtered.results.length?raw.status==='possibly_unrelated'?'possibly_unrelated':'ok':raw.status==='no_results'&&!(raw.results?.length)?'no_results':raw.status==='ok'?'search_unavailable':raw.status;
  return {site:site.id,query,status,results:filtered.results.slice(0,options.count),rejected_candidates:filtered.rejected,attempts:[{route:'host_search_fallback',status:raw.status,retrieved_at:stamp()}],evidence_level:'search_snippets_only',host_request:status==='ok'?undefined:hostRequest({action:'search',query,sites:[site.id],reason:status})};
 }
 if(site.id==='v2ex'&&options.native_search!==false){
  const r=await request(`https://www.sov2ex.com/api/search?q=${encodeURIComponent(query)}&size=${options.count}&from=0&sort=created&operator=and`,options.download||core.download,attempts,'sov2ex_author_api');const data=r?.gate.status==='public_page'?json(r.body):null;
  if(Array.isArray(data?.hits)&&data.timed_out!==true){nativeEmpty=data.hits.length===0;results=data.hits.map(h=>h._source).filter(t=>/^\d+$/.test(String(t?.id))).map(t=>({title:t.title,url:`https://www.v2ex.com/t/${t.id}`,snippet:clean(t.content).slice(0,600),author:t.member||null,date_text:t.created||null,date_kind:'third_party_index_snapshot',evidence_level:'search_snippet',site:site.id,site_scope:'verified_url_domain',engine:'sov2ex'}));attempts.at(-1).status=results.length?'ok':nativeEmpty?'no_results':'unexpected_json';}
  else if(r?.gate.status==='public_page')attempts.at(-1).status=data?.timed_out===true?'timeout':'unexpected_json';
 }
 if(site.id==='linuxdo'&&options.native_search!==false){
  const r=await request(`https://linux.do/search.json?q=${encodeURIComponent(query)}`,options.download||core.download,attempts,'discourse_search_json');const data=r?.gate.status==='public_page'?json(r.body):null;
  if(Array.isArray(data?.topics)) {nativeEmpty=data.topics.length===0;const posts=new Map((data.posts||[]).map(p=>[p.topic_id,p]));results=data.topics.filter(t=>/^\d+$/.test(String(t.id))).map(t=>({title:t.title,url:`https://linux.do/t/topic/${t.id}`,snippet:posts.get(t.id)?.blurb||'',date_text:t.created_at||null,evidence_level:'search_snippet',site:site.id,site_scope:'verified_url_domain',engine:'discourse'}));attempts.at(-1).status=results.length?'ok':nativeEmpty?'no_results':'unexpected_json';}
  else if(r?.gate.status==='public_page')attempts.at(-1).status='unexpected_json';
 }
 if(!results.length){
  try{const raw=await (options.searchProvider||core.searchPublic)({query,site:site.domain,count:options.count,engine:options.engine||'auto',resolve_count:3});suspicious=raw.status==='possibly_unrelated';attempts.push(...(raw.attempts||[{route:'public_search',status:raw.status}]).map(a=>({...a,route:a.route||'public_search'})));({results,rejected}=filterResults(raw.results,site));}catch(e){attempts.push({route:'public_search',status:'search_error',error:e.name||'Error'});}
 }
 if((!results.length||suspicious)&&typeof options.searchFallback==='function'){
  try{const raw=await options.searchFallback({query,site:site.domain,site_id:site.id,count:options.count,reason:attempts.at(-1)?.status||'no_verified_site_results'});attempts.push({route:'host_search_fallback',status:raw.status||'returned',retrieved_at:stamp()});const filtered=filterResults(raw.results,site);if(filtered.results.length){results=filtered.results;suspicious=raw.status==='possibly_unrelated';}rejected.push(...filtered.rejected);}catch(e){attempts.push({route:'host_search_fallback',status:'fallback_error',error:e.name||'Error'});}
 }
 const status=results.length?suspicious?'possibly_unrelated':'ok':(nativeEmpty||attempts.length>0)&&attempts.every(a=>['public_page','no_results'].includes(a.status))?'no_results':'search_unavailable';
 return {site:site.id,query,effective_query:`${query} site:${site.domain}`,status,results:results.slice(0,options.count),rejected_candidates:rejected,attempts,evidence_level:'search_snippets_only',recovery_routes:status==='ok'?[]:recovery(site,{query,status})};
}
export async function searchDomestic({query,sites=['v2ex','linuxdo','csdn','zhihu','tieba'],...options}={}){
 if(typeof query!=='string'||!query.trim()||query.length>600)throw Error('query must contain 1-600 characters');
 if(typeof sites==='string')sites=sites.split(',');if(!Array.isArray(sites)||!sites.length||sites.length>5)throw Error('sites must contain 1-5 communities');
 const selected=[...new Set(sites.map(s=>siteBy(s).id))].map(siteBy),rows=[];const count=int(options.count,6,1,20);
 // Two independent sites at a time; requests within a site remain sequential.
 for(let i=0;i<selected.length;i+=2)rows.push(...await Promise.all(selected.slice(i,i+2).map(s=>searchOne(s,query.trim(),{...options,count}))));
 const results=rows.flatMap(r=>r.results),status=rows.every(r=>r.status==='ok')?'ok':results.length?'partial':rows.every(r=>r.status==='no_results')?'no_results':rows.every(r=>r.status==='host_pending')?'host_pending':'search_unavailable';
 return {query:query.trim(),status,retrieved_at:stamp(),results,sites:rows,evidence_level:'search_snippets_only',next_step:'候选只用于定位；对相关来源调用readDomestic，查看主帖覆盖、日期和未读回复。站点限制不代表没有相关信息。'};
}
export const search=searchDomestic;
export const read=readDomestic;
export const capabilities=Object.freeze({id:'domestic-search',readonly:true,actions:['sites','search','read','host-request'],host_callbacks:['searchFallback','readFallback'],host_only:true,requires_search_core:true});

async function cli(){
 const args=process.argv.slice(2),action=args.shift(),params={};
 while(args.length){const flag=args.shift();if(!flag.startsWith('--')||!args.length)throw Error('Expected --option value');params[flag.slice(2)]=args.shift();}
 let result;
 if(action==='sites')result=listSites();
 else if(action==='host-request')result=hostRequest({action:params.action||'read',url:params.url,query:params.query,sites:params.sites?.split(','),count:params.count});
 else if(action==='search'){
  const fallback=params['fallback-file']?JSON.parse(await fs.readFile(params['fallback-file'],'utf8')):null;
  result=await searchDomestic({query:params.query,sites:params.sites?.split(',')||undefined,count:params.count,engine:params.engine,host_only:params['host-only']==='true',searchFallback:fallback?async()=>fallback:undefined});
 }else if(action==='read'){
  const fallback=params['fallback-file']?JSON.parse(await fs.readFile(params['fallback-file'],'utf8')):null;
  result=await readDomestic({url:params.url,offset:params.offset,max_length:params['max-length'],host_only:params['host-only']==='true',readFallback:fallback?async()=>fallback:undefined});
 }else throw Error('Usage: domestic-search.mjs sites | search --query Q [--sites v2ex,linuxdo] [--engine auto|so] | read --url URL [--offset N] [--max-length N] [--fallback-file source.json] [--host-only true] [--output FILE] | host-request --action read|search --url URL|--query Q');
 if(params.output){await fs.mkdir(path.dirname(path.resolve(params.output)),{recursive:true});await fs.writeFile(params.output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({saved:path.resolve(params.output),status:result.status||'ok'}));}else console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)cli().catch(e=>{console.error(e.message);process.exitCode=1;});

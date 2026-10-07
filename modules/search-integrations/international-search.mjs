/** Read-only forum adapters. Search evidence is never promoted to original-post evidence. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const CORE = process.env.INTERNATIONAL_SEARCH_CORE || fileURLToPath(new URL('../../plugins/search-tools/core.mjs', import.meta.url));
const HN = 'https://hacker-news.firebaseio.com/v0';
const ALGOLIA = 'https://hn.algolia.com/api/v1';
export const DISCOURSE_SITES = Object.freeze({discourse:'https://meta.discourse.org', python:'https://discuss.python.org', huggingface:'https://discuss.huggingface.co', rust:'https://users.rust-lang.org', julia:'https://discourse.julialang.org'});
const now = () => new Date().toISOString();
const int = (v,d,min,max) => v == null ? d : Number.isFinite(Number(v)) ? Math.max(min,Math.min(max,Math.floor(Number(v)))) : d;
const date = value => { if(value == null) return null; const n=typeof value==='number'?value*1000:Date.parse(value); return Number.isFinite(n)?new Date(n).toISOString():null; };
let htmlParser;
try { htmlParser=createRequire(pathToFileURL(CORE))('cheerio'); } catch { /* HTML is preserved even if optional formatter is unavailable. */ }
export function plainText(html='') {
  if(htmlParser) {const $=htmlParser.load(String(html)); $('script,style').remove(); $('br').replaceWith('\n'); $('p,div,pre,li,blockquote').append('\n'); return $.root().text().replace(/\n{3,}/g,'\n\n').trim();}
  return String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<(?:br|\/p|\/div|\/pre|\/li|\/blockquote)\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&#(x[\da-f]+|\d+);/gi,(_,n)=>{const cp=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return cp>0&&cp<=0x10ffff?String.fromCodePoint(cp):'�';}).replace(/&(amp|lt|gt|quot|apos|nbsp);/g,(_,n)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[n]).trim();
}
function publicOrigin(value) {
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||!u.hostname.includes('.')||/^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(u.hostname)||u.hostname.includes(':'))throw Error('A public HTTPS forum origin is required');
  return u.origin;
}
function range(options) {
  const out={};
  for(const key of ['after','before']) if(options[key]) {out[key]=date(options[key]);if(!out[key])throw Error('Invalid '+key+' date');}
  if(out.after&&out.before&&out.after>=out.before)throw Error('after must precede before');
  return out;
}
const inRange=(value,r)=>!value||(!r.after||value>=r.after)&&(!r.before||value<r.before);
function fault(status,extra={}) {return {status,...extra};}
function sourceIdentity(value) {
 const u=new URL(value);publicOrigin(u.origin);if(u.username||u.password)throw Error('No credentials in source URL');
 if(u.hostname==='news.ycombinator.com'&&/^\d+$/.test(u.searchParams.get('id')||''))return `hn:${u.searchParams.get('id')}`;
 if(['reddit.com','www.reddit.com','old.reddit.com','oauth.reddit.com'].includes(u.hostname)){
  const m=u.pathname.match(/(?:\/r\/[^/]+)?\/comments\/([a-z0-9]+)(?:\/[^/]+)?(?:\/([a-z0-9]+))?/i);if(m)return `reddit:${m[1].toLowerCase()}:${(m[2]||'').toLowerCase()}`;
 }
 const parts=u.pathname.replace(/\.json\/?$/,'').replace(/\/$/,'').split('/').slice(2);if(u.pathname.startsWith('/t/')){if(!/^\d+$/.test(parts[0]||''))parts.shift();if(parts.length>=1&&parts.length<=2&&parts.every(p=>/^\d+$/.test(p)))return `${u.origin}:topic:${parts[0]}:post:${parts[1]||1}`;}
 return `${u.origin}${u.pathname.replace(/\/$/,'')}`;
}
function sourceUrl(value){const u=new URL(value);u.username='';u.password='';for(const k of [...u.searchParams.keys()])if(/token|auth|cookie|key|signature|captcha|verify/i.test(k))u.searchParams.delete(k);u.hash='';return u.href;}
/** Host source text remains page evidence; it never becomes an official API read. */
export function acceptExternalRead(result,url) {
 const none=status=>({status,original_post_read:false,evidence_level:'not_read',posts:[],text:null});
 if(result?.status&&!['ok','partial','partial_content','thin_content'].includes(result.status))return none(result.status);
 if(typeof result?.text!=='string'||!result.text.trim()||!['source_text','page_text','extracted_main_text','community_main_text','community_reply_text'].includes(result.evidence_level))return none('fallback_has_no_source_text');
 const source=result.final_url||result.source_url||result.requested_url;
 try{if(!source||sourceIdentity(source)!==sourceIdentity(url))return none('fallback_source_mismatch');}catch{return none('fallback_source_mismatch');}
 if(/^(?:Just a moment|Prove your humanity|Sign in|Log in|Access denied)/i.test(result.title||'')||/verify you are human|complete the challenge below/i.test(result.text.slice(0,700)))return none('verification_or_login_page');
 return {status:'partial',title:result.title||null,text:result.text,source_url:sourceUrl(source),source_retrieved_at:result.retrieved_at||null,posts:[],original_post_read:false,evidence_level:result.evidence_level,
  coverage:{...(result.coverage||{}),complete:false,main_post_present:result.coverage?.main_post_present??null,reason:'host text read; official API and full discussion coverage are unverified'},extraction_method:result.extraction_method||'host_source_text'};
}
function guidance(source,url,query) {
  const domain=source==='hn'?'news.ycombinator.com':source==='reddit'?'reddit.com':new URL(url).hostname;
  return [
    {method:'web_search',query:`site:${domain} ${query||url}`,evidence_level:'discovery_only'},
    {method:'browser',url:source==='reddit'?'https://www.reddit.com'+new URL(url).pathname:url,requires:'read public original or an already authorized logged-in page; verify main post and replies',evidence_level:'not_read'},
    ...(source==='reddit'?[{method:'oauth',url:'https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki',requires:'approved registered client; REDDIT_ACCESS_TOKEN and honest REDDIT_USER_AGENT; no credentials in arguments or output'}]:[])
  ];
}
export function capabilities() {
  return {module:'international-search',read_only:true,runtime:'Node.js >=22',actions:['search','read','capabilities','host-request'],host_callbacks:['host_search','host_read'],host_only:true,sites:{hn:{search:'Algolia index',read:'official Firebase item tree',authentication:'none'},reddit:{search:'OAuth /search',read:'OAuth /comments; returned tree only, more placeholders recorded',authentication:'REDDIT_ACCESS_TOKEN + REDDIT_USER_AGENT'},discourse:{origins:DISCOURSE_SITES,search:'/search.json',read:'/t/id.json + /t/id/posts.json',authentication:'public topics; private topics unavailable'}},default_limits:{max_posts:60,max_depth:8,deadline_ms:45000,request_timeout_ms:12000,max_bytes:3145728},fallback:'existing search-tools core or injected search_public/read_source, then host_search/host_read or explicit host-request + --fallback-file --host-only true; no automatic browser takeover',evidence:'posts are API originals; search hits/index snapshots/page_text are separately labeled',persistence:'none unless CLI --out; respect site deletion/retention requirements; do not archive Reddit user content indefinitely'};
}
export function hostRequest({action='read',source,url,query,site,count=8,reason='host_requested'}={}){
 if(!['search','read'].includes(action))throw Error('host action must be read or search');
 if(action==='read'){if(!url)throw Error('url is required');sourceIdentity(url);source=source||(new URL(url).hostname==='news.ycombinator.com'?'hn':/^(?:www\.|old\.|oauth\.)?reddit\.com$/.test(new URL(url).hostname)?'reddit':'discourse');}
 else{if(typeof query!=='string'||!query.trim()||query.length>600)throw Error('query must contain 1-600 characters');if(!['hn','reddit','discourse'].includes(source))throw Error('source must be hn, reddit or discourse');url=source==='hn'?'https://news.ycombinator.com/':source==='reddit'?'https://www.reddit.com/search/':DISCOURSE_SITES[site||'discourse']||publicOrigin(site);}
 return {module:'international-search',action,status:'host_pending',source,readonly:true,reason,url:sourceUrl(url),query,routes:guidance(source,url,query),
  expected_result:action==='read'?{source_url:'exact requested topic/comment URL',evidence_level:'source_text (not search_snippet)',text:'actual source body',coverage:{main_post_present:null,main_post_complete:false,complete:false,scope:'actually read portion'}}:{status:'ok|no_results|verification_required|login_required|access_restricted',results:[{title:'source title',url:'actual post URL',snippet:'discovery only'}],count:int(count,8,1,30)},
  continuation:'Current host uses web/open or an independent authorized browser tab once, then returns --fallback-file with --host-only true. Never import cookies/tokens or bypass verification.'};
}

export function createInternationalClient(config={}) {
  const fetchImpl=config.fetch||globalThis.fetch;
  const origins=new Set([...Object.values(DISCOURSE_SITES),...(config.discourse_origins||[]).map(publicOrigin)]);
  const ua=config.user_agent||'AIWorkSystemForumReader/1.0 (read-only personal technical search)';
  const redditToken=config.reddit_access_token??process.env.REDDIT_ACCESS_TOKEN;
  const redditUA=config.reddit_user_agent??process.env.REDDIT_USER_AGENT;
  const cacheCore=()=>import(pathToFileURL(config.core_path||CORE).href);
  async function coreCall(kind,input) {
    if(config.fallback===false)return fault('fallback_disabled');
    try {const fn=config[kind]||(await cacheCore())[kind==='search_public'?'searchPublic':'readSource'];return await fn(input);}catch{return fault('fallback_unavailable');}
  }
  function run(options={}) {return {attempts:[],deadline:Date.now()+int(options.deadline_ms??config.deadline_ms,45000,1000,120000),requests:0,max_requests:int(options.max_requests,160,1,500),cooldowns:new Map()};}
  async function json(url,ctx,headers={}) {
    const origin=new URL(url).origin;
    const cooling=ctx.cooldowns.get(origin);
    if(cooling) return fault('rate_limited',{next_retry_at:cooling});
    if(Date.now()>=ctx.deadline)return fault('deadline_exceeded');
    if(ctx.requests>=ctx.max_requests)return fault('request_limit');
    const initial=url;
    for(let attempt=0;attempt<2;attempt++) {
      ctx.requests++;
      if(ctx.requests>ctx.max_requests)return fault('request_limit');
      const timeout=Math.min(int(config.request_timeout_ms,12000,500,30000),ctx.deadline-Date.now());
      if(timeout<=0)return fault('deadline_exceeded');
      const log={url:initial,method:'GET',at:now()};
      ctx.attempts.push(log);
      try {
        const signal=AbortSignal.timeout(timeout);
        let response;
        for(let redirects=0;redirects<=3;redirects++) {
          response=await fetchImpl(url,{method:'GET',headers:{Accept:'application/json','User-Agent':ua,...headers},redirect:'manual',signal});
          if(![301,302,303,307,308].includes(response.status))break;
          const next=new URL(response.headers.get('location')||'',url);
          if(next.origin!==origin||redirects===3) {await response.body?.cancel();log.status='redirect_rejected';return fault('redirect_rejected');}
          await response.body?.cancel();url=next.href;
        }
        log.http_status=response.status;
        const retry=response.headers.get('retry-after');
        log.rate_limit={remaining:response.headers.get('x-ratelimit-remaining'),reset:response.headers.get('x-ratelimit-reset')};
        if(response.status===429) {
          const seconds=Number(retry);const target=retry&&!Number.isFinite(seconds)?date(retry):new Date(Date.now()+(Number.isFinite(seconds)&&retry?seconds:60)*1000).toISOString();
          ctx.cooldowns.set(origin,target);await response.body?.cancel();log.status='rate_limited';return fault('rate_limited',{next_retry_at:target});
        }
        if(response.status>=500&&attempt===0) {await response.body?.cancel();log.status='http_error';continue;}
        if(!response.ok) {await response.body?.cancel();log.status=response.status===401?'authentication_required':response.status===403?'access_restricted':response.status===404?'not_found':'http_error';return fault(log.status,{http_status:response.status});}
        const max=int(config.max_bytes,3145728,1024,10485760);
        if(Number(response.headers.get('content-length'))>max) {await response.body?.cancel();log.status='response_too_large';return fault(log.status);}
        let size=0;const chunks=[];
        for await(const chunk of response.body) {size+=chunk.length;if(size>max){log.status='response_too_large';return fault(log.status);}chunks.push(Buffer.from(chunk));}
        const body=Buffer.concat(chunks).toString('utf8');
        let data;try{data=JSON.parse(body);}catch {
          log.status=/<title[^>]*>\s*(?:just a moment|.*captcha|.*verify)/i.test(body)||/checking your browser|verify you are human/i.test(body.slice(0,2000))?'verification_required':/\/login|\/signin/.test(response.url||url)?'login_required':'unexpected_response';
          return fault(log.status);
        }
        // A valid JSON error payload is not a successful topic/listing.
        if(data?.error||data?.errors) {log.status=data.error===429?'rate_limited':data.error===401?'authentication_required':data.error===403?'access_restricted':'api_error';return fault(log.status);}
        log.status='ok';log.bytes=size;return {status:'ok',data};
      }catch(error) {log.status=Date.now()>=ctx.deadline?'deadline_exceeded':error.name==='TimeoutError'||error.name==='AbortError'?'timeout':'network_error';log.error_code=error.cause?.code||error.name;return fault(log.status);}
    }
  }
  const envelope=(action,source,ctx,extra)=>({module:'international-search',action,source,retrieved_at:now(),attempts:ctx.attempts,...extra});
  function discourseOrigin(site) {const origin=DISCOURSE_SITES[site]||publicOrigin(site);if(!origins.has(origin))throw Error('Discourse origin is not registered; pass discourse_origins explicitly');return origin;}
  async function searchFallback(source,origin,query,count,ctx,primary) {
    const domain=source==='hn'?'news.ycombinator.com':source==='reddit'?'reddit.com':new URL(origin).hostname;
    let data;
    try{data=typeof config.host_search==='function'?await config.host_search({query,site:domain,count,source,reason:primary.status}):primary.status==='host_pending'?fault('host_pending'):await coreCall('search_public',{query,site:domain,count});}catch{data=fault('fallback_unavailable');}
    const candidateRows=data.results||data.hits||[];const list=['ok','partial','possibly_unrelated','no_results'].includes(data.status)?candidateRows:[];
    const hits=list.filter(x=>{try{const u=new URL(x.url);publicOrigin(u.origin);if(u.username||u.password)return false;const h=u.hostname;if(!(h===domain||h.endsWith('.'+domain)))return false;return source==='reddit'?/\/comments\/[a-z0-9]+/i.test(u.pathname):source==='hn'?u.pathname==='/item'&&/^\d+$/.test(u.searchParams.get('id')||''):/^\/t\//.test(u.pathname);}catch{return false;}}).slice(0,count).map(x=>({...x,url:sourceUrl(x.url),evidence_level:'search_snippet',published_at:null,date_note:'search date text is unverified; retrieve the source'}));
    return envelope('search',source,ctx,{status:hits.length?'partial':primary.status==='host_pending'&&data.status==='no_results'&&!list.length?'no_results':primary.status,primary_status:primary.status,primary_failure:primary,query,hits,fallback:{method:typeof config.host_search==='function'?'host_search':'existing_public_search',status:data.status},host_request:hits.length?undefined:hostRequest({action:'search',source,query,site:origin,reason:data.status||primary.status}),continuation:guidance(source,origin,query),scope:'fallback engine index only; no original post read; date filter not verified'});
  }
  async function search(options={}) {
    const query=String(options.query||'').trim();if(!query)throw Error('query is required');
    const source=options.source||'hn';const count=int(options.count,8,1,100);const ctx=run(options);const r=range(options);
    if(options.host_only)return searchFallback(source,source==='hn'?'https://news.ycombinator.com/':source==='reddit'?'https://www.reddit.com/search/':discourseOrigin(options.site||'discourse'),query,count,ctx,fault('host_pending'));
    if(source==='hn') {
      const u=new URL(ALGOLIA+(options.sort==='date'?'/search_by_date':'/search'));
      u.searchParams.set('query',query);u.searchParams.set('tags',options.type==='comment'?'comment':'story');u.searchParams.set('hitsPerPage',count);u.searchParams.set('page',int(options.page,0,0,1000));
      const filters=[];if(r.after)filters.push('created_at_i>='+Date.parse(r.after)/1000);if(r.before)filters.push('created_at_i<'+Date.parse(r.before)/1000);if(filters.length)u.searchParams.set('numericFilters',filters.join(','));
      const res=await json(u.href,ctx);
      if(res.status!=='ok'||!Array.isArray(res.data?.hits))return searchFallback(source,'https://news.ycombinator.com/',query,count,ctx,res.status==='ok'?fault('unexpected_response'):res);
      const hits=res.data.hits.map(x=>({id:x.objectID,title:plainText(x.title||x.story_title||''),url:`https://news.ycombinator.com/item?id=${x.objectID}`,story_id:x.story_id||x.objectID,external_url:x.url||x.story_url||null,author:x.author,published_at:date(x.created_at_i),snippet:plainText(x.comment_text||x.story_text||''),score:x.points,comment_count:x.num_comments,evidence_level:'search_index_text',applicability:'indexed discussion; check date and original discussion before using as technical evidence'}));
      return envelope('search',source,ctx,{status:hits.length?'ok':'no_results',query,hits,page:res.data.page,next_page:res.data.page+1<res.data.nbPages?res.data.page+1:null,total_hits:res.data.nbHits,index_exhaustive:res.data.exhaustiveNbHits??null,date_filter:r,scope:'Algolia HN index; not a guarantee of all HN content'});
    }
    if(source==='discourse') {
      const origin=discourseOrigin(options.site||'discourse');let q=query;
      if(r.after)q+=' after:'+r.after.slice(0,10);if(r.before)q+=' before:'+r.before.slice(0,10);
      const u=new URL(origin+'/search.json');u.searchParams.set('q',q);u.searchParams.set('page',int(options.page,1,1,1000));
      const res=await json(u.href,ctx);
      if(res.status!=='ok'||!Array.isArray(res.data?.topics))return searchFallback(source,origin,query,count,ctx,res.status==='ok'?fault('unexpected_response'):res);
      const hits=res.data.topics.slice(0,count).map(x=>{const p=res.data.posts?.find(p=>p.topic_id===x.id);return {id:x.id,title:plainText(x.title),url:`${origin}/t/${x.slug||'-'}/${x.id}`,matched_post_url:p?`${origin}/t/${x.id}/${p.post_number||1}`:null,published_at:date(x.created_at),updated_at:date(x.last_posted_at),matched_post_at:date(p?.created_at),snippet:plainText(p?.blurb||''),post_count:x.posts_count,evidence_level:'search_snippet',applicability:'date search may match replies; original topic and match date are separate'};});
      return envelope('search',source,ctx,{status:hits.length?'ok':'no_results',query,site:origin,hits,page:int(options.page,1,1,1000),more:res.data.grouped_search_result?.more_full_page_results??null,date_filter:r,scope:'public Discourse search; private, hidden and unindexed topics unavailable'});
    }
    if(source==='reddit') {
      if(!redditToken||!redditUA)return searchFallback(source,'https://www.reddit.com/search/',query,count,ctx,fault('authentication_required'));
      const u=new URL('https://oauth.reddit.com/search');u.searchParams.set('q',query);u.searchParams.set('limit',count);u.searchParams.set('sort',options.sort==='date'?'new':'relevance');u.searchParams.set('raw_json','1');if(options.after_cursor)u.searchParams.set('after',options.after_cursor);
      const res=await json(u.href,ctx,{Authorization:'Bearer '+redditToken,'User-Agent':redditUA});
      if(res.status!=='ok'||!Array.isArray(res.data?.data?.children))return searchFallback(source,'https://www.reddit.com/search/',query,count,ctx,res.status==='ok'?fault('unexpected_response'):res);
      const hits=res.data.data.children.filter(x=>x.kind==='t3').map(({data:x})=>({id:x.name,title:x.title,url:'https://www.reddit.com'+x.permalink,external_url:x.url,published_at:date(x.created_utc),author:x.author,snippet:x.selftext,subreddit:x.subreddit,comment_count:x.num_comments,evidence_level:'search_api_text',applicability:'discussion experience; verify version/platform and context'})).filter(x=>inRange(x.published_at,r));
      return envelope('search',source,ctx,{status:hits.length?'ok':'no_results',query,hits,next_cursor:res.data.data.after,date_filter:r,scope:'Reddit search listing; date filtered within this page only; no full-site guarantee'});
    }
    throw Error('source must be hn, reddit or discourse');
  }
  async function readFallback(source,url,ctx,primary,options) {
    if(typeof config.host_read==='function'){
      let received;try{received=acceptExternalRead(await config.host_read({url,source,reason:primary.status}),url);}catch{received={status:'fallback_unavailable',text:null,original_post_read:false,evidence_level:'not_read',posts:[]};}
      const {text,...record}=received;const max=int(options.max_length,12000,100,100000),offset=int(options.offset,0,0,text?.length||0);
      return envelope('read',source,ctx,{...record,url,primary_status:primary.status,primary_failure:primary,page:text?{text:text.slice(offset,offset+max),total_chars:text.length,offset,truncated:offset+max<text.length,next_offset:offset+max<text.length?offset+max:null,final_url:record.source_url,extraction_method:record.extraction_method}:undefined,fallback:{method:'host_read',status:record.status},host_request:text?undefined:hostRequest({source,url,reason:record.status}),continuation:guidance(source,url)});
    }
    if(options.host_only)return envelope('read',source,ctx,{status:'host_pending',url,posts:[],original_post_read:false,evidence_level:'not_read',host_request:hostRequest({source,url}),continuation:guidance(source,url)});
    const res=await coreCall('read_source',{url,max_length:int(options.max_length,12000,1000,100000)});
    const usable=res.status==='ok'&&res.evidence_level!=='search_snippet'&&typeof res.text==='string'&&res.text.trim();
    return envelope('read',source,ctx,{status:usable?'partial':primary.status,primary_status:primary.status,primary_failure:primary,url,posts:[],original_post_read:false,evidence_level:usable?'page_text':'not_read',page:usable?{text:res.text,extraction_method:res.extraction_method,final_url:res.final_url,truncated:res.truncated}:undefined,coverage:{complete:false,reason:'API failed; generic page extraction does not verify main post or discussion coverage'},fallback:{method:'existing_read_source',status:res.status},host_request:hostRequest({source,url,reason:primary.status}),continuation:guidance(source,url)});
  }
  function hnPost(x,depth=0) {return {id:x.id,parent_id:x.parent||null,depth,role:x.type==='comment'?'reply':'original',author:x.by||null,published_at:date(x.time),title:plainText(x.title||''),text:x.deleted?'':plainText(x.text||''),text_html:x.deleted?'':x.text||'',deleted:!!x.deleted,dead:!!x.dead,url:`https://news.ycombinator.com/item?id=${x.id}`,external_url:x.url||null,child_ids:x.kids||[],evidence_level:'original_api'};}
  async function hnRead(id,url,ctx,options) {
    const requestedId=Number(id);let response=await json(`${HN}/item/${requestedId}.json`,ctx);
    if(response.status!=='ok') {
      // Algolia's nested item is a search snapshot, not an official source read.
      const alt=await json(`${ALGOLIA}/items/${requestedId}`,ctx);
      if(alt.status==='ok'&&alt.data?.id) {
        const posts=[];let queue=[{item:alt.data,depth:0}];const max=int(options.max_posts,60,1,500);const depthMax=int(options.max_depth,8,0,30);
        while(queue.length&&posts.length<max) {const {item:x,depth}=queue.shift();posts.push({...hnPost({id:x.id,parent:x.parent_id,by:x.author,time:Date.parse(x.created_at)/1000,title:x.title,text:x.text,url:x.url,type:x.type},depth),evidence_level:'search_index_snapshot'});if(depth<depthMax)queue.push(...(x.children||[]).map(item=>({item,depth:depth+1})));}
        return envelope('read','hn',ctx,{status:'partial',primary_status:response.status,url,requested_id:requestedId,posts,original_post_read:false,evidence_level:'search_index_snapshot',coverage:{complete:false,reason:'official API unavailable; index freshness/deletions/coverage unverified'},continuation:guidance('hn',url)});
      }
      return readFallback('hn',url,ctx,response,options);
    }
    if(!response.data?.id)return envelope('read','hn',ctx,{status:'not_found',url,posts:[],original_post_read:false});
    const ancestors=[];const seen=new Set();let item=response.data;
    while(item.parent&&ancestors.length<20&&!seen.has(item.id)) {seen.add(item.id);ancestors.unshift(hnPost(item));const parent=await json(`${HN}/item/${item.parent}.json`,ctx);if(parent.status!=='ok'||!parent.data?.id)return envelope('read','hn',ctx,{status:'partial',url,requested_id:requestedId,posts:ancestors,original_post_read:false,coverage:{complete:false,reason:'parent context could not be resolved'},continuation:guidance('hn',url)});item=parent.data;}
    if(item.parent)return envelope('read','hn',ctx,{status:'partial',url,posts:[hnPost(item),...ancestors],original_post_read:false,coverage:{complete:false,reason:'ancestor limit or malformed cycle'}});
    const max=int(options.max_posts,60,1,500),depthMax=int(options.max_depth,8,0,30);
    const posts=[hnPost(item)];const visited=new Set([item.id]);const failures=[];const skipped=[];
    // Ensure a directly selected comment and its ancestors remain visible even with a small budget.
    for(const p of ancestors) if(!visited.has(p.id)){posts.push(p);visited.add(p.id);}
    const ancestorDepth=new Map(ancestors.map((p,i)=>[p.id,i+1]));
    for(const p of ancestors)p.depth=ancestorDepth.get(p.id);
    const skippedByDepth=(depthMax===0?item.kids||[]:[]);
    let queue=depthMax===0?[]:(item.kids||[]).map(id=>({id,depth:1}));
    // Ancestors are already fetched; process their replies without fetching them again.
    for(const p of ancestors) {
      if(p.depth<depthMax)queue.push(...p.child_ids.map(id=>({id,depth:p.depth+1})));
      else skippedByDepth.push(...p.child_ids);
    }
    while(queue.length&&posts.length<max&&Date.now()<ctx.deadline&&ctx.requests<ctx.max_requests) {
      const batch=queue.splice(0,Math.min(4,max-posts.length));
      const rows=await Promise.all(batch.map(async row=>({row,res:visited.has(row.id)?{status:'seen'}:await json(`${HN}/item/${row.id}.json`,ctx)})));
      for(const {row,res} of rows) {
        if(res.status==='seen')continue;
        visited.add(row.id);
        if(res.status!=='ok'||!res.data?.id){failures.push({id:row.id,status:res.status==='ok'?'not_found':res.status});continue;}
        const p=hnPost(res.data,row.depth);posts.push(p);
        if(row.depth<depthMax)queue.push(...p.child_ids.map(id=>({id,depth:row.depth+1})));
        else skipped.push(...p.child_ids);
      }
    }
    // Ancestors were already read; add their children to the remaining context if not visited.
    const ancestorChildren=ancestors.flatMap(p=>p.child_ids).filter(id=>!visited.has(id));
    const pending=[...new Set([...queue.map(x=>x.id),...skipped,...skippedByDepth,...ancestorChildren])].filter(id=>!visited.has(id));
    const complete=!pending.length&&!failures.length;
    return envelope('read','hn',ctx,{status:complete?'ok':'partial',url:`https://news.ycombinator.com/item?id=${item.id}`,requested_id:requestedId,title:plainText(item.title),published_at:date(item.time),posts,original_post_read:!item.deleted,coverage:{complete,scope:'reachable official item tree at retrieval time; deleted/dead posts retained as markers',posts_read:posts.length,reported_comment_count:item.descendants??null,pending_ids:pending,failed_items:failures,max_posts:max,max_depth:depthMax},continuation:complete?[]:guidance('hn',url)});
  }
  async function discourseRead(origin,id,requestedPost,ctx,options) {
    const url=`${origin}/t/${id}`;const response=await json(`${url}.json`,ctx);
    if(response.status!=='ok'||!response.data?.post_stream)return readFallback('discourse',url,ctx,response.status==='ok'?fault('unexpected_response'):response,options);
    const topic=response.data;const all=topic.post_stream.stream||[];
    const max=int(options.max_posts,60,1,500);const selected=all.slice(0,max);const found=new Map((topic.post_stream.posts||[]).map(p=>[p.id,p]));
    // If the requested URL points to a reply, fetch that post separately and preserve its parent.
    if(requestedPost>1&&!([...found.values()].some(p=>p.post_number===requestedPost))) {
      const at=await json(`${url}/${requestedPost}.json`,ctx);
      for(const p of at.data?.post_stream?.posts||[])found.set(p.id,p);
    }
    const focus=[...found.values()].find(p=>p.post_number===requestedPost);
    const focusParent=focus?.reply_to_post_number;
    if(focusParent&&!([...found.values()].some(p=>p.post_number===focusParent))) {
      const at=await json(`${url}/${focusParent}.json`,ctx);for(const p of at.data?.post_stream?.posts||[])found.set(p.id,p);
    }
    for(const p of found.values()) if((p.post_number===requestedPost||p.post_number===focusParent)&&!selected.includes(p.id))selected.push(p.id);
    const missing=selected.filter(id=>!found.has(id));const failures=[];
    for(let i=0;i<missing.length&&Date.now()<ctx.deadline;i+=20) {
      const u=new URL(`${url}/posts.json`);missing.slice(i,i+20).forEach(id=>u.searchParams.append('post_ids[]',id));
      const part=await json(u.href,ctx);
      if(part.status!=='ok'||!Array.isArray(part.data?.post_stream?.posts)){failures.push({ids:missing.slice(i,i+20),status:part.status==='ok'?'unexpected_response':part.status});break;}
      for(const p of part.data.post_stream.posts)found.set(p.id,p);
    }
    const posts=selected.filter(id=>found.has(id)).map(id=>found.get(id)).sort((a,b)=>a.post_number-b.post_number).map(p=>({id:p.id,post_number:p.post_number,parent_post_number:p.reply_to_post_number||null,role:p.post_number===1?'original':'reply',author:p.username,published_at:date(p.created_at),updated_at:date(p.updated_at),text:plainText(p.cooked||''),text_html:p.cooked||'',url:`${url}/${p.post_number}`,evidence_level:'original_api'}));
    const pending=all.filter(id=>!posts.some(p=>p.id===id));const complete=all.length>0&&!pending.length&&!failures.length;
    const requestedRead=posts.some(p=>p.post_number===requestedPost);
    return envelope('read','discourse',ctx,{status:complete&&requestedRead?'ok':'partial',site:origin,url,title:plainText(topic.title),published_at:date(topic.created_at),updated_at:date(topic.last_posted_at),requested_post_number:requestedPost,requested_post_read:requestedRead,posts,original_post_read:posts.some(p=>p.role==='original'),coverage:{complete,scope:'public post_stream at retrieval time; deleted/private posts not promised',posts_read:posts.length,visible_stream_count:all.length,reported_posts_count:topic.posts_count,pending_ids:pending,failed_batches:failures,max_posts:max},continuation:complete&&requestedRead?[]:guidance('discourse',url)});
  }
  async function redditRead(u,ctx,options) {
    const match=u.pathname.match(/(?:\/r\/[^/]+)?\/comments\/([a-z0-9]+)(?:\/[^/]+)?(?:\/([a-z0-9]+))?/i);if(!match)throw Error('A Reddit /comments/post-id URL is required');
    const url=`https://www.reddit.com${u.pathname}`;
    if(!redditToken||!redditUA)return readFallback('reddit',url,ctx,fault('authentication_required'),options);
    const api=new URL(`https://oauth.reddit.com/comments/${match[1]}`);api.searchParams.set('raw_json','1');api.searchParams.set('limit',int(options.max_posts,60,1,500));api.searchParams.set('depth',int(options.max_depth,8,1,10));api.searchParams.set('sort','confidence');
    if(match[2]){api.searchParams.set('comment',match[2]);api.searchParams.set('context','8');}
    const response=await json(api.href,ctx,{Authorization:'Bearer '+redditToken,'User-Agent':redditUA});
    if(response.status!=='ok'||!Array.isArray(response.data)||!response.data[0]?.data?.children?.[0])return readFallback('reddit',url,ctx,response.status==='ok'?fault('unexpected_response'):response,options);
    const x=response.data[0].data.children[0].data;
    const removed=x.removed_by_category||x.selftext==='[removed]'||x.selftext==='[deleted]';
    const posts=[{id:x.name,parent_id:null,role:'original',title:removed?'':x.title,author:x.author==='[deleted]'?null:x.author,published_at:date(x.created_utc),text:removed?'':x.selftext||'',deleted:!!removed,url:'https://www.reddit.com'+x.permalink,evidence_level:'original_api'}];
    const more=[];const unread=[];const max=int(options.max_posts,60,1,500);let queue=(response.data[1]?.data?.children||[]).map(item=>({item,depth:1}));
    while(queue.length) {
      const {item,depth}=queue.shift();const p=item.data;
      if(item.kind==='more'){more.push({parent_id:p.parent_id,count:p.count,child_ids:p.children||[]});continue;}
      if(item.kind!=='t1')continue;
      if(posts.length>=max){unread.push(p.name);continue;}
      const deleted=p.body==='[removed]'||p.body==='[deleted]';
      posts.push({id:p.name,parent_id:p.parent_id,depth,role:'reply',author:p.author==='[deleted]'?null:p.author,published_at:date(p.created_utc),text:deleted?'':p.body||'',text_html:deleted?'':p.body_html||'',deleted,url:'https://www.reddit.com'+p.permalink,evidence_level:'original_api'});
      queue.push(...(p.replies?.data?.children||[]).map(item=>({item,depth:depth+1})));
    }
    const commentCount=posts.length-1;
    const complete=!match[2]&&!more.length&&!unread.length&&Number.isFinite(x.num_comments)&&commentCount>=x.num_comments;
    return envelope('read','reddit',ctx,{status:complete?'ok':'partial',url:posts[0].url,requested_comment_id:match[2]?`t1_${match[2]}`:null,requested_comment_read:match[2]?posts.some(p=>p.id===`t1_${match[2]}`):null,title:posts[0].title,published_at:posts[0].published_at,subreddit:x.subreddit,posts,original_post_read:!removed,coverage:{complete,scope:'returned OAuth comment tree only; no morechildren expansion',posts_read:posts.length,reported_comment_count:x.num_comments,more_placeholders:more,pending_ids:unread},retention_note:'No automatic persistence. Remove deleted content; Reddit recommends routinely removing stored user content within 48 hours.',continuation:complete?[]:guidance('reddit',url)});
  }
  async function read(options={}) {
    if(!options.url)throw Error('url is required');const u=new URL(options.url);publicOrigin(u.origin);if(u.username||u.password)throw Error('Credentials in URLs are not supported');
    const ctx=run(options);
    if(options.host_only){const source=u.hostname==='news.ycombinator.com'?'hn':['reddit.com','www.reddit.com','old.reddit.com','oauth.reddit.com'].includes(u.hostname)?'reddit':origins.has(u.origin)?'discourse':null;if(source)return readFallback(source,u.href,ctx,fault('host_pending'),options);}
    if(u.hostname==='news.ycombinator.com') {const id=u.searchParams.get('id');if(!/^\d+$/.test(id||''))throw Error('HN item URL needs numeric id');return hnRead(id,u.href,ctx,options);}
    if(u.hostname==='reddit.com'||['www.reddit.com','old.reddit.com','oauth.reddit.com'].includes(u.hostname))return redditRead(u,ctx,options);
    if(origins.has(u.origin)) {
      const pieces=u.pathname.replace(/\.json\/?$/,'').replace(/\/$/,'').split('/').slice(2);
      if(!u.pathname.startsWith('/t/'))throw Error('A Discourse /t/slug/id[/post] URL is required');
      if(!/^\d+$/.test(pieces[0]||''))pieces.shift();
      if(pieces.length<1||pieces.length>2||pieces.some(x=>!/^\d+$/.test(x)))throw Error('A Discourse /t/slug/id[/post] URL is required');
      return discourseRead(u.origin,pieces[0],Number(pieces[1]||1),ctx,options);
    }
    return envelope('read','unknown',ctx,{status:'unsupported_source',url:u.href,posts:[],original_post_read:false,registered_sites:[...origins,'https://news.ycombinator.com','https://www.reddit.com']});
  }
  return {search,read,capabilities};
}
export async function searchInternational(options,config={}) {return createInternationalClient(config).search(options);}
export async function readInternational(options,config={}) {return createInternationalClient(config).read(options);}

async function main() {
  const [action,...args]=process.argv.slice(2);const options={};let out;
  const keys=new Set(['query','source','site','count','page','sort','type','after','before','after-cursor','url','max-posts','max-depth','max-requests','deadline-ms','max-length','offset','out','action','host-only','fallback-file']);
  for(let i=0;i<args.length;i+=2){const key=args[i]?.replace(/^--/,'');if(!args[i]?.startsWith('--')||!keys.has(key)||args[i+1]==null)throw Error('Expected a supported --key value');if(key==='out')out=args[i+1];else options[key.replaceAll('-','_')]=args[i+1];}
  if(!action||action==='help'||action==='--help') {console.log('international-search.mjs capabilities\ninternational-search.mjs search --source hn|reddit|discourse --query TEXT [--site python|huggingface|discourse|rust|julia] [--count 8] [--sort date] [--after DATE] [--before DATE] [--out PATH]\ninternational-search.mjs read --url URL [--max-posts 60] [--max-depth 8] [--out PATH]\ninternational-search.mjs host-request --action read|search --url URL|--query TEXT --source hn|reddit|discourse\nHost bridge: read/search --host-only true [--fallback-file JSON] [--offset N] [--max-length N]; skips local network and consumes actual host result.\nCredentials: REDDIT_ACCESS_TOKEN and REDDIT_USER_AGENT environment only. Read-only. Search hits are not original-post reads.');return;}
  options.host_only=options.host_only==='true';const external=options.fallback_file?JSON.parse(await fs.readFile(options.fallback_file,'utf8')):null;
  const client=createInternationalClient(external?{host_read:async()=>external,host_search:async()=>external}:{});const result=action==='capabilities'?client.capabilities():action==='host-request'?hostRequest({...options,action:options.action||'read'}):action==='search'?await client.search(options):action==='read'?await client.read(options):null;
  if(!result)throw Error('Unknown action');
  const serialized=JSON.stringify(result,null,2);
  if(out){await fs.mkdir(path.dirname(path.resolve(out)),{recursive:true});await fs.writeFile(out,serialized+'\n','utf8');console.log(JSON.stringify({saved:true,path:path.resolve(out),status:result.status,source:result.source,hits:result.hits?.length,posts:result.posts?.length,original_post_read:result.original_post_read,complete:result.coverage?.complete}));}else console.log(serialized);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(JSON.stringify({status:'invalid_request',message:error.message}));process.exitCode=1;});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createInternationalClient,plainText} from './international-search.mjs';
const response=(data,status=200,headers={})=>new Response(typeof data==='string'?data:JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
const client=fetch=>createInternationalClient({fetch,fallback:false,reddit_access_token:'',reddit_user_agent:''});

test('HN item tree preserves source dates, removed markers and pending IDs',async()=>{
 const items={1:{id:1,type:'story',title:'Ask HN',text:'<p>Main &amp; question</p>',kids:[2,3],time:100,descendants:3},2:{id:2,type:'comment',parent:1,text:'reply',kids:[4],time:101},3:{id:3,deleted:true,parent:1,type:'comment'},4:{id:4,type:'comment',parent:2,text:'nested'}};
 const c=client(async u=>response(items[Number(u.match(/item\/(\d+)/)[1])]));
 const partial=await c.read({url:'https://news.ycombinator.com/item?id=1',max_posts:2});
 assert.equal(partial.status,'partial');assert.equal(partial.original_post_read,true);assert.deepEqual(partial.coverage.pending_ids,[3,4]);assert.equal(partial.posts[0].text,'Main & question');
 const full=await c.read({url:'https://news.ycombinator.com/item?id=1'});
 assert.equal(full.coverage.complete,true);assert.equal(full.posts.find(p=>p.id===3).deleted,true);assert.equal(full.posts.find(p=>p.id===4).parent_id,2);
});
test('HN direct comment resolves root, ancestors and children',async()=>{
 const items={1:{id:1,type:'story',kids:[2]},2:{id:2,type:'comment',parent:1,kids:[3]},3:{id:3,type:'comment',parent:2,kids:[4]},4:{id:4,type:'comment',parent:3}};
 const c=client(async u=>response(items[Number(u.match(/item\/(\d+)/)[1])]));
 const r=await c.read({url:'https://news.ycombinator.com/item?id=3'});
 assert.equal(r.original_post_read,true);assert.equal(r.requested_id,3);assert.equal(r.coverage.complete,true);assert.deepEqual(r.posts.map(p=>p.id),[1,2,3,4]);
});
test('depth zero does not read HN comments and signals pending coverage',async()=>{
 let requests=0;const c=client(async()=>{requests++;return response({id:1,type:'story',kids:[2]});});
 const r=await c.read({url:'https://news.ycombinator.com/item?id=1',max_depth:0});assert.equal(requests,1);assert.equal(r.status,'partial');assert.deepEqual(r.coverage.pending_ids,[2]);
});
test('Discourse expands post_stream in batches and distinguishes visible stream from count',async()=>{
 const all=Array.from({length:25},(_,i)=>i+10);const post=id=>({id,post_number:id-9,cooked:`<p>post ${id}</p>`,created_at:'2026-09-01T00:00:00Z'});const urls=[];
 const c=client(async u=>{urls.push(u);if(u.includes('posts.json'))return response({post_stream:{posts:new URL(u).searchParams.getAll('post_ids[]').map(Number).map(post)}});return response({id:100,title:'Context',posts_count:29,post_stream:{stream:all,posts:all.slice(0,20).map(post)}});});
 const r=await c.read({url:'https://meta.discourse.org/t/context/100'});assert.equal(r.coverage.complete,true);assert.equal(r.posts.length,25);assert.equal(r.coverage.reported_posts_count,29);assert.equal(urls.length,2);assert.equal(r.posts[0].role,'original');
});
test('Discourse reply focus and its parent survive the general post budget',async()=>{
 const post=(id,n,parent)=>({id,post_number:n,reply_to_post_number:parent,cooked:'text'});
 const c=client(async u=>u.includes('/100/50.json')?response({post_stream:{posts:[post(500,50,40)]}}):u.includes('/100/40.json')?response({post_stream:{posts:[post(400,40)]}}):response({title:'T',posts_count:3,post_stream:{stream:[1,400,500],posts:[post(1,1)]}}));
 const r=await c.read({url:'https://meta.discourse.org/t/topic/100/50',max_posts:1});assert.equal(r.requested_post_read,true);assert.equal(r.original_post_read,true);assert.deepEqual(r.posts.map(p=>p.post_number),[1,40,50]);
});
test('Discourse missing batch cannot claim complete coverage',async()=>{
 const c=client(async u=>u.includes('posts.json')?response({},403):response({id:1,title:'T',post_stream:{stream:[10,11],posts:[{id:10,post_number:1,cooked:'Main'}]}}));
 const r=await c.read({url:'https://meta.discourse.org/t/1'});assert.equal(r.status,'partial');assert.deepEqual(r.coverage.pending_ids,[11]);assert.equal(r.coverage.failed_batches[0].status,'access_restricted');
});
test('Reddit missing auth never calls unauthenticated data API',async()=>{
 let requests=0;const c=client(async()=>{requests++;throw Error('must not fetch');});const r=await c.read({url:'https://www.reddit.com/r/redditdev/comments/abc123/hello/'});
 assert.equal(r.status,'authentication_required');assert.equal(r.original_post_read,false);assert.equal(requests,0);assert.ok(r.continuation.some(x=>x.method==='oauth'));
});
test('Reddit comment parent context, more placeholders and secrets are not misreported',async()=>{
 const calls=[];const token='test-secret-token-do-not-print';const c=createInternationalClient({fallback:false,reddit_access_token:token,reddit_user_agent:'test:reader:v1 (by /u/example)',fetch:async(u,o)=>{calls.push({u,o});return response([{data:{children:[{kind:'t3',data:{name:'t3_a',title:'Post',selftext:'Main',num_comments:8,permalink:'/r/x/comments/a/post/',created_utc:100}}]}},{data:{children:[{kind:'t1',data:{name:'t1_c',parent_id:'t3_a',body:'Reply',created_utc:101,permalink:'/r/x/comments/a/post/c/',replies:{data:{children:[{kind:'more',data:{parent_id:'t1_c',count:7,children:['d']}}]}}}}]}}]);}});
 const r=await c.read({url:'https://www.reddit.com/r/x/comments/a/post/c/'});assert.equal(r.status,'partial');assert.equal(r.posts[1].parent_id,'t3_a');assert.equal(r.requested_comment_read,true);assert.equal(r.coverage.more_placeholders.length,1);assert.equal(new URL(calls[0].u).searchParams.get('comment'),'c');assert.equal(calls[0].o.headers.Authorization,'Bearer '+token);assert.ok(!JSON.stringify(r).includes(token));
});
test('429 honors retry-after and does not retry or leak response body',async()=>{
 let requests=0;const c=client(async()=>{requests++;return response({errors:['challenge token secret']},429,{'retry-after':'120'});});const r=await c.search({source:'hn',query:'context'});
 assert.equal(r.primary_status,'rate_limited');assert.equal(requests,1);assert.ok(!JSON.stringify(r).includes('challenge token'));assert.equal(r.attempts[0].status,'rate_limited');
});
test('OAuth cross-host redirects are rejected without sending authorization onward',async()=>{
 let requests=0;const c=createInternationalClient({fallback:false,reddit_access_token:'secret',reddit_user_agent:'test',fetch:async()=>{requests++;return new Response('',{status:302,headers:{location:'https://example.org/collect'}});}});
 const r=await c.search({source:'reddit',query:'memory'});assert.equal(requests,1);assert.equal(r.primary_status,'redirect_rejected');assert.ok(!JSON.stringify(r).includes('secret'));
});
test('fallback snippets and generic page text never become original-post reads',async()=>{
 const c=createInternationalClient({fetch:async()=>response({},403),reddit_access_token:'',reddit_user_agent:'',search_public:async()=>({status:'ok',results:[{url:'https://www.reddit.com/r/x/comments/a',title:'Found',snippet:'Only a snippet'}]}),read_source:async()=>({status:'ok',text:'Navigation and possibly a reply'})});
 const s=await c.search({source:'reddit',query:'memory'});assert.equal(s.hits[0].evidence_level,'search_snippet');const r=await c.read({url:s.hits[0].url});assert.equal(r.evidence_level,'page_text');assert.equal(r.original_post_read,false);assert.equal(r.coverage.complete,false);
});
test('HTML challenge and successful empty search are distinct',async()=>{
 const challenge=await client(async()=>response('<title>Just a moment...</title>')).search({source:'hn',query:'x'});assert.equal(challenge.primary_status,'verification_required');
 const empty=await client(async()=>response({hits:[],page:0,nbPages:0,nbHits:0})).search({source:'hn',query:'x'});assert.equal(empty.status,'no_results');assert.equal(empty.primary_status,undefined);
});
test('HN official failure permits index snapshot without claiming original read',async()=>{
 const c=client(async u=>u.includes('firebaseio.com')?response({},503):response({id:1,type:'story',title:'Snapshot',children:[{id:2,type:'comment',parent_id:1,text:'Cached reply',children:[]}]}));
 const r=await c.read({url:'https://news.ycombinator.com/item?id=1'});assert.equal(r.evidence_level,'search_index_snapshot');assert.equal(r.original_post_read,false);assert.equal(r.coverage.complete,false);assert.equal(r.posts[1].parent_id,1);assert.equal(r.attempts.length,3);
});
test('a missing requested Discourse floor stays partial even if the public stream is covered',async()=>{
 const c=client(async u=>u.includes('/1/99.json')?response({},404):response({id:1,title:'T',post_stream:{stream:[10],posts:[{id:10,post_number:1,cooked:'Main'}]}}));
 const r=await c.read({url:'https://meta.discourse.org/t/1/99'});assert.equal(r.status,'partial');assert.equal(r.requested_post_read,false);assert.equal(r.coverage.complete,true);
});
test('unsupported or private targets are not fetched; dates are validated',async()=>{
 let requests=0;const c=client(async()=>{requests++;throw Error();});await assert.rejects(c.read({url:'https://127.0.0.1/t/1'}));await assert.rejects(c.search({query:'x',after:'garbage'}));const r=await c.read({url:'https://example.org/t/1'});assert.equal(r.status,'unsupported_source');assert.equal(requests,0);assert.match(plainText('<p>x &lt; y</p>'),/x < y/);
});

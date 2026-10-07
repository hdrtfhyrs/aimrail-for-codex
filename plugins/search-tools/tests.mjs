import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { inspectPage, classifySearch, parseSearch, publicUrl, readSource } from './core.mjs';

test('HTTP 200 verification is not an empty result',()=>{
 const x=classifySearch('<title>百度安全验证</title><body>网络不给力</body>','baidu','https://www.baidu.com/s?wd=q',200);
 assert.equal(x.status,'verification_required'); assert.deepEqual(x.results,[]);
});
test('DuckDuckGo and Sogou challenges are detected from visible page or URL',()=>{
 assert.equal(inspectPage('<body>Please complete the following challenge to confirm this search was made by a human</body>','https://html.duckduckgo.com/html/',202).status,'verification_required');
 assert.equal(inspectPage('<title>搜狗搜索</title>','https://www.sogou.com/antispider/',200).status,'verification_required');
});
test('challenge words in scripts do not cause false gates',()=>{
 assert.equal(inspectPage('<title>研究文章</title><body>文章正文<script>captcha</script></body>','https://example.org/').status,'public_page');
});
test('login page is not article text; ordinary login navigation is allowed',()=>{
 assert.equal(inspectPage('<title>知乎</title><body>登录 注册 密码登录 验证码 扫码</body>','https://www.zhihu.com/question/123').status,'login_required');
 assert.equal(inspectPage('<title>研究文章</title><body>登录 <article>'+('实验结果。'.repeat(400))+'</article></body>','https://example.org/').status,'public_page');
});
test('explicit search empty and unexpected HTML have different status',()=>{
 assert.equal(classifySearch('<title>q_百度搜索</title><div id="content_left">没有找到相关结果</div>','baidu','https://www.baidu.com/s').status,'no_results');
 assert.equal(classifySearch('<title>新样式</title><p>broken</p>','baidu','https://www.baidu.com/s').status,'parse_failed_or_unexpected_page');
});
test('source URL, engine URL, snippet and displayed date are preserved separately',()=>{
 const html='<div id="content_left"><div class="result c-container" mu="https://qwenlm.github.io/zh/blog/qwen3/"><h3><a href="http://www.baidu.com/link?url=abc">Qwen3 发布</a></h3><div class="c-abstract">2025年4月29日 思考与非思考</div></div><div class="result c-container" mu="https://example.org/two"><h3><a href="https://example.org/two">第二条</a></h3></div></div>';
 const x=parseSearch(html,'baidu','https://www.baidu.com/s',8);
 assert.equal(x.results.length,2);assert.equal(x.results[0].url,'https://qwenlm.github.io/zh/blog/qwen3/');assert.match(x.results[0].search_url,/baidu.com\/link/);assert.equal(x.results[0].date_text,'2025年4月29日');assert.equal(x.results[0].evidence_level,'search_snippet');
});
test('360 uses data-mdurl without claiming opaque redirect is source',()=>{
 const x=parseSearch('<div id="main"><li class="res-list"><h3><a href="https://www.so.com/link?m=abc" data-mdurl="https://example.org/source">标题</a></h3><p class="res-desc">摘要</p></li></div>','so','https://www.so.com/s',8);
 assert.equal(x.results[0].url,'https://example.org/source');assert.equal(x.results[0].url_kind,'source');
});
test('related/nav links are not promoted into search results',()=>{
 assert.equal(parseSearch('<div id="content_left"><div><a href="https://example.org">推广</a></div></div>','baidu','https://www.baidu.com/s',8).results.length,0);
});
test('missing URLs and embedded credentials are rejected, relative URLs resolve',()=>{
 assert.equal(publicUrl(undefined,'https://example.org'),null);assert.equal(publicUrl('javascript:alert(1)'),null);assert.equal(publicUrl('https://user:password@example.org'),null);assert.equal(publicUrl('/article','https://example.org'),'https://example.org/article');
});

test('source-read failures give concrete routes without claiming they were checked',async()=>{
 const server=createServer((req,res)=>{
  if(req.url==='/paper.pdf'){res.writeHead(200,{'content-type':'application/pdf'});res.end(Buffer.from('%PDF-1.7'));return;}
  res.writeHead(200,{'content-type':'text/html'});res.end('<title>Sign in</title><body>Please sign in</body>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const base=`http://127.0.0.1:${server.address().port}`;
  const gated=await readSource({url:`${base}/answer`});
  assert.equal(gated.status,'login_required');assert.equal(gated.text,null);
  assert.equal(gated.recovery_routes[0].route,'logged_in_browser');assert.equal(gated.recovery_routes[0].checked,false);
  assert.match(gated.recovery_routes[0].action,/authorized/);
  const pdf=await readSource({url:`${base}/paper.pdf`});
  assert.equal(pdf.status,'unsupported_content_type');assert.equal(pdf.recovery_routes[0].route,'dedicated_pdf_reader');
  assert.equal(pdf.recovery_routes[0].checked,false);assert.match(pdf.recovery_routes[1].action,/browser/);
 } finally {await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('restricted redirects redact gate query parameters from final URL and recovery routes',async()=>{
 const server=createServer((req,res)=>{
  if(req.url.startsWith('/start')){res.writeHead(302,{location:'/challenge?nonce=abc123&signature=secret&login_state=private'});res.end();return;}
  res.writeHead(200,{'content-type':'text/html'});res.end('<title>Security verification</title><body>Please complete the following challenge</body>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const base=`http://127.0.0.1:${server.address().port}`;
  const requestedUrl=`${base}/start?caller=keep`;
  const result=await readSource({url:requestedUrl});
  assert.equal(result.status,'verification_required');
  assert.equal(result.requested_url,requestedUrl);
  assert.equal(result.final_url,`${base}/challenge`);
  const routeUrls=result.recovery_routes.filter(x=>x.url).map(x=>x.url);
  assert.ok(routeUrls.length>0);
  assert.deepEqual(routeUrls,[result.final_url,result.final_url]);
  assert.ok(result.recovery_routes.every(x=>!JSON.stringify(x).match(/nonce|signature|login_state|abc123|secret|private/)));
 } finally {await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

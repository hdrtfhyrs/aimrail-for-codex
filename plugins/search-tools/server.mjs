#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { searchPublic, readSource } from './core.mjs';
import {explore,expandSource,readCandidates} from './explore.mjs';

// 发散搜索两件工具；说明本身写清用法，让模型先铺开再收窄。
const exploreTools=[{
  name:'explore_search',description:'任务需要找办法、理解陌生对象或旧做法受质疑时，直接给goal及AI选择的queries/叫法启动广度发现。程序实际执行批量查询，第一次返回标题和链接供AI联想不同办法、联系目标做一轮初判，再自由选择值得读的原文；不在入口按热门/词面/固定前几项挑选，也不要求读完所有目录。完整线索持久保存、窗口可续读；请求诊断按需取得。',
  inputSchema:{type:'object',properties:{goal:{type:'string',minLength:1,description:'结合完整任务说明用途'},terms:{type:'array',items:{type:'string'},description:'名称/别称/目录词；程序仅使用原词，不替AI拼固定后缀'},queries:{type:'array',items:{type:'string'},description:'AI根据目标选出的实际搜索语句；可覆盖不同办法、国内外叫法与实践，没有固定数量'},mode:{type:'string',enum:['tools','topic','obstacle'],default:'tools'},error:{type:'string'},diagnostics:{type:'boolean',default:false,description:'默认先返回紧凑标题；需要时取得完整查询诊断'},max_queries:{type:'integer',minimum:1},dispatch_ms:{type:'integer',minimum:1,default:45000},max_chars:{type:'integer',minimum:1,default:24000},engines:{type:'array',items:{type:'string',enum:['baidu','so','bing','ddg']}},sources:{type:'array',items:{type:'string',enum:['github','npm','mcp-registry','tavily']}},reset:{type:'boolean',default:false}},required:['goal'],anyOf:[{required:['terms']},{required:['queries']}],additionalProperties:false}
},{
  name:'expand_source',description:'抽取并保存来源提到的全部项目、替代品、清单及链接，返回标题窗口与无损续读，不只留前40条。带goal并入同一候选目录，未给goal会返回独立collection goal。相关段落位置留详情供AI判断。',
  inputSchema:{type:'object',properties:{url:{type:'string'},goal:{type:'string'},offset:{type:'integer',minimum:0,default:0},max_chars:{type:'integer',minimum:1,default:24000}},required:['url'],additionalProperties:false}
},{
  name:'read_candidates',description:'按收集顺序浏览已保存的完整标题目录；不搜索网络、不按热度或词面筛选。offset/max_chars仅控制显示窗口，next接续未显示标题。details可读搜索摘要、来源、发现查询；ids展开AI自主选定的项。标题与摘要是线索，采用仍读原文。',
  inputSchema:{type:'object',properties:{goal:{type:'string',minLength:1},offset:{type:'integer',minimum:0,default:0},max_chars:{type:'integer',minimum:1,default:24000},details:{type:'boolean',default:false},ids:{type:'array',items:{type:'string'}}},required:['goal'],additionalProperties:false}
}];

export async function startServer({ legacy=false, defaults={} }={}) {
 const server=new Server({name:legacy?'baidu-search-repaired':'personal-search-tools',version:'1.0.0'},{capabilities:{tools:{}}});
 const searchName=legacy?'baidu_search':'search_public'; const readName=legacy?'fetch_url':'read_source';
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{
  name:searchName,description:'取得公开搜索引擎一页结果，保留解析到的全部标题和线索；count只作供应方页大小提示，不截取前N项。返回来源/日期/实际请求状态和pagination.next_request，可用page_request续页。广度发现可用explore_search多叫法、多来源收集。摘要不能代替原文。',
  inputSchema:{type:'object',properties:{query:{type:'string',minLength:1,maxLength:600},count:{type:'integer',minimum:1,description:'可选页大小提示，不限制已收到候选'},engine:{type:'string',enum:['auto','baidu','so','bing','ddg'],default:'auto'},site:{type:'string'},page_request:{type:'object',properties:{url:{type:'string'},method:{type:'string',enum:['GET','POST']},fields:{type:'object',additionalProperties:{type:'string'}}},required:['url']},resolve_count:{type:'integer',minimum:0,maximum:3,default:0},...(legacy?{fetchCount:{type:'integer',minimum:0,maximum:3,description:'兼容旧显式读取调用；广度收集先不自动读正文'}}:{})},required:['query'],additionalProperties:false}
 },{
  name:readName,description:'读回一个公开 HTTP(S) 来源的正文，使用 Mozilla Readability 并提供最终链接、规范链接、页面日期、抓取时间、提取层级和分页。明确返回登录/验证/权限/动态页/正文过短/网络失败；不会声称读到登录后的内容。可用 offset 续读，PDF 等二进制请用专用读取器或浏览器。',
  inputSchema:{type:'object',properties:{url:{type:'string'},offset:{type:'integer',minimum:0,default:0},max_length:{type:'integer',minimum:100,maximum:40000,default:12000}},required:['url'],additionalProperties:false}
 },...exploreTools]}));
 server.setRequestHandler(CallToolRequestSchema,async({params})=>{
  try {let result;
   if(params.name===searchName){result=await searchPublic({...defaults,...params.arguments});const fetchCount=Math.min(3,Math.max(0,Number(params.arguments?.fetchCount??defaults.fetchCount??0)));if(fetchCount) {result.results=await Promise.all(result.results.map(async(r,i)=>i<fetchCount?{...r,source_read:await readSource({url:r.url,max_length:defaults.max_length??6000})}:r));}}
   else if(params.name===readName) result=await readSource(params.arguments||{});
   else if(params.name==='explore_search') result=await explore(params.arguments||{});
   else if(params.name==='expand_source') result=await expandSource(params.arguments||{});
   else if(params.name==='read_candidates') result=readCandidates(params.arguments||{});
   else throw new Error('Unknown tool');
   return {content:[{type:'text',text:JSON.stringify(result,null,2)}]};
  } catch(e){return{isError:true,content:[{type:'text',text:JSON.stringify({status:'invalid_request',error:e.message})}]};}
 });
 await server.connect(new StdioServerTransport());
 return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) await startServer();

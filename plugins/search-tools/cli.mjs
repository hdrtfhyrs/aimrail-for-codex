#!/usr/bin/env node
import {searchPublic,readSource} from './core.mjs';
import {explore,expandSource,readCandidates} from './explore.mjs';

const usage=`Usage:
  node cli.mjs explore --goal TEXT [--terms "叫法1,叫法2"] [--queries-file JSON] [--mode tools|topic|obstacle] [--error TEXT]
    [--engines baidu,so,bing,ddg] [--sources github,npm,mcp-registry,tavily]
    [--max-queries N] [--dispatch-ms N] [--max-chars N] [--reset] [--diagnostics]
    Save every returned candidate. No fixed query-count cutoff by default.
    Repeat the same goal and terms to continue provider pages; add names as discovered.
  node cli.mjs candidates --goal TEXT [--offset N] [--max-chars N] [--details] [--ids "ID1,ID2"]
    Browse saved titles in collection order; next contains lossless continuation parameters.
  node cli.mjs expand --url URL [--goal TEXT] [--offset N] [--max-chars N]
    Save every discovered link, then return a title window.
  node cli.mjs search --query TEXT [--engine auto|baidu|so|bing|ddg] [--site DOMAIN]
    [--count N] [--page-request-file JSON]
    Keep the full parsed provider page; count is only a provider page-size hint.
  node cli.mjs read --url URL [--offset N] [--max-length N]`;
const fail=message=>{throw new Error(message);};
function parseArgs(argv) {
  const [mode,...rest]=argv;
  if(['help','--help','-h'].includes(mode)) return {mode:'help'};
  const flags={
    explore:['goal','terms','queries-file','mode','error','engines','sources','max-queries','dispatch-ms','max-chars','reset','diagnostics'],
    candidates:['goal','offset','max-chars','details','ids'],
    expand:['url','goal','offset','max-chars'],
    search:['query','engine','site','count','page-request-file'],
    read:['url','offset','max-length']
  }[mode];
  if(!flags) fail(usage);
  const values={};
  for(let i=0;i<rest.length;i++) {
    const flag=rest[i];
    if(!flag.startsWith('--')||!flags.includes(flag.slice(2))) fail(`Unknown option: ${flag}\n${usage}`);
    const key=flag.slice(2);
    if(Object.hasOwn(values,key)) fail(`Repeated option: ${flag}`);
    if(['reset','details','diagnostics'].includes(key)) {values[key]=true;continue;}
    const value=rest[++i];
    if(value===undefined||value.startsWith('--')) fail(`Missing value for ${flag}`);
    values[key]=value;
  }
  const args={};
  for(const [key,value] of Object.entries(values)) {
    const name=key.replaceAll('-','_');
    if(['offset','max-chars','max-queries','dispatch-ms','count','max-length'].includes(key)) {
      const number=Number(value);
      if(!/^\d+$/.test(value)||!Number.isSafeInteger(number)||(key!=='offset'&&number<1)) fail(`${key} needs ${key==='offset'?'a non-negative':'a positive'} integer`);
      args[name]=number;
    } else if(['engines','sources','ids'].includes(key)) args[name]=value.split(',').map(x=>x.trim()).filter(Boolean);
    else args[name]=value;
  }
  if(mode==='explore'&&(!args.goal||!args.terms&&!args.queries_file)) fail('--goal and either --terms or --queries-file are required');
  if(mode==='candidates'&&!args.goal) fail('--goal is required');
  if(mode==='search'&&!args.query) fail('--query is required');
  if(['read','expand'].includes(mode)&&!args.url) fail('--url is required');
  return {mode,args};
}
try {
  const {mode,args}=parseArgs(process.argv.slice(2));
  if(mode==='help') process.stdout.write(usage+'\n');
  else {
    if(args.page_request_file) {const fs=await import('node:fs');args.page_request=JSON.parse(fs.readFileSync(args.page_request_file,'utf8'));delete args.page_request_file;}
    if(args.queries_file) {const fs=await import('node:fs');args.queries=JSON.parse(fs.readFileSync(args.queries_file,'utf8'));delete args.queries_file;}
    const result=await {search:searchPublic,read:readSource,explore,expand:expandSource,candidates:readCandidates}[mode](args);
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  }
} catch(error) {process.stderr.write(error.message+'\n');process.exitCode=2;}

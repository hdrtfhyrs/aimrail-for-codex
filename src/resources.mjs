import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {REGISTRY_FILE} from './paths.mjs';
import {readRegistry,saveRegistryRecord,argumentsOf} from './registry-store.mjs';

const empty={schemaVersion:1,revision:0,accounts:[],benefits:[],resources:[],sources:[]};
const kinds=['accounts','benefits','resources','sources'];
// Display helper only. Credentials belong to the host's credential store.
export function redactResourceOutput(value) {
  return String(value).replace(/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})/g,'[REDACTED]');
}
export function resourceNavigation() {
  return `资源与来源原件：${REGISTRY_FILE}。声明、登录、实际调用和持续运行分别记录；按真实用途读取，不将登记状态当作已可用。凭据由宿主保管。`;
}
function cli() {
  const [command='list',...rest]=process.argv.slice(2), options=argumentsOf(rest);
  const data=readRegistry(REGISTRY_FILE,empty), kind=options.kind||'resources';
  if(!kinds.includes(kind)) throw Error('kind must be accounts/benefits/resources/sources.');
  if(command==='list') return {source:REGISTRY_FILE,kind,items:data[kind].map(({id,name,scope,purpose,status,version})=>({id,name,scope,purpose,status,version}))};
  if(command==='read') {
    const record=data[kind].find(item=>item.id===options.id);
    if(!record) throw Error('Unknown resource id.');
    return {source:REGISTRY_FILE,kind,record};
  }
  if(command==='save') {
    if(!options.input) throw Error('--input JSON is required.');
    const entry=JSON.parse(fs.readFileSync(path.resolve(options.input),'utf8'));
    if(!entry.name) throw Error('Record requires name.');
    const encoded=JSON.stringify(entry);
    if(/"(?:password|secret|accessToken|refreshToken|apiKey|cookie)"\s*:/i.test(encoded)) throw Error('Do not store credentials in the registry.');
    return saveRegistryRecord(REGISTRY_FILE,kind,entry,options['expected-version']===undefined?undefined:Number(options['expected-version']),empty);
  }
  throw Error('resources: list --kind resources | read --kind resources --id ID | save --kind resources --input JSON --expected-version N');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(redactResourceOutput(JSON.stringify(cli(),null,2))); }
  catch(error) { console.error(error.message);process.exitCode=1; }
}

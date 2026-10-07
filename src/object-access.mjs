import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {OBJECTS_FILE} from './paths.mjs';
import {readRegistry,saveRegistryRecord,argumentsOf} from './registry-store.mjs';

export const OBJECT_ENTRY=path.resolve('src/object-access.mjs');
const empty={schemaVersion:1,revision:0,records:[]};
export function objectNavigation() {
  return `对象与类别知识原件：${OBJECTS_FILE}。按用途认识职责、条件、输入输出、事实、判断与未知；list/read取得原件，目录不证明属性当前有效。`;
}
export function readObject(id) {
  const records=readRegistry(OBJECTS_FILE,empty).records;
  const record=records.find(item=>item.id===id);
  if(!record) throw Error('Unknown object id: '+id);
  return record;
}
export function objectCli(argv=process.argv.slice(2)) {
  const [command='list',...rest]=argv, options=argumentsOf(rest);
  if(command==='list') return {source:OBJECTS_FILE,records:readRegistry(OBJECTS_FILE,empty).records.map(({id,kind,name,summary,categories,version})=>({id,kind,name,summary,categories,version}))};
  if(command==='read') return {source:OBJECTS_FILE,record:readObject(options.id)};
  if(command==='save') {
    if(!options.input) throw Error('--input JSON is required.');
    const entry=JSON.parse(fs.readFileSync(path.resolve(options.input),'utf8'));
    if(!entry.name || !['object','category','concept'].includes(entry.kind)) throw Error('Object requires name and kind=object/category/concept.');
    return saveRegistryRecord(OBJECTS_FILE,'records',entry,options['expected-version']===undefined?undefined:Number(options['expected-version']),empty);
  }
  throw Error('objects: list | read --id ID | save --input JSON --expected-version N');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(objectCli(),null,2)); }
  catch(error) { console.error(error.message);process.exitCode=1; }
}

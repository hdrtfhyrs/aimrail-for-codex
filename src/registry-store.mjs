import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function readRegistry(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')); }
  catch(error) { if(error.code==='ENOENT') return structuredClone(fallback); throw error; }
}

export function saveRegistryRecord(file, collection, entry, expectedVersion, fallback) {
  if(!entry || typeof entry!=='object' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(entry.id||'')) {
    throw Error('Record requires a stable id.');
  }
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const lockFile=file+'.lock', token=randomUUID();
  const fd=fs.openSync(lockFile,'wx');
  fs.writeSync(fd,JSON.stringify({pid:process.pid,token}));
  let temporary;
  try {
    const data=readRegistry(file,fallback);
    if(!Array.isArray(data[collection])) throw Error('Unknown registry collection.');
    const index=data[collection].findIndex(item=>item.id===entry.id);
    const prior=index<0?null:data[collection][index];
    if(prior && expectedVersion!==prior.version) throw Error('Version conflict; read current record before updating.');
    if(!prior && expectedVersion!==undefined && expectedVersion!==0) throw Error('New records expect version 0.');
    const next={...entry,version:(prior?.version||0)+1,updatedAt:new Date().toISOString()};
    if(index<0) data[collection].push(next); else data[collection][index]=next;
    data.revision=(data.revision||0)+1;
    const history=path.join(path.dirname(file),'history',path.basename(file));
    if(fs.existsSync(file)) {
      fs.mkdirSync(history,{recursive:true});
      fs.copyFileSync(file,path.join(history,`${data.revision-1}-${randomUUID()}.json`),fs.constants.COPYFILE_EXCL);
    }
    temporary=file+'.'+randomUUID()+'.tmp';
    fs.writeFileSync(temporary,JSON.stringify(data,null,2)+'\n',{flag:'wx'});
    fs.renameSync(temporary,file); temporary=null;
    return {status:prior?'updated':'created',revision:data.revision,record:next};
  } finally {
    if(temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    fs.closeSync(fd);
    if(JSON.parse(fs.readFileSync(lockFile,'utf8')).token===token) fs.unlinkSync(lockFile);
  }
}

export function argumentsOf(argv) {
  const options={};
  for(let i=0;i<argv.length;i++) {
    const flag=argv[i];
    if(!flag.startsWith('--') || !argv[i+1] || argv[i+1].startsWith('--')) throw Error('Expected --key value: '+flag);
    if(Object.hasOwn(options,flag.slice(2))) throw Error('Repeated option: '+flag);
    options[flag.slice(2)]=argv[++i];
  }
  return options;
}

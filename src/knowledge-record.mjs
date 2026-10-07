import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {MEMORY_ROOT} from './paths.mjs';
const root=path.join(MEMORY_ROOT,'experiences');
const required=['slug','caseId','title','symptom','solution','result','boundary'];
export function recordExperience(entry, options={}) {
 const directory=path.resolve(options.directory||root);
 for(const key of required)if(typeof entry[key]!=='string'||!entry[key].trim())throw new Error(`Missing ${key}`);
 if(!/^[a-z0-9][a-z0-9-]{1,63}$/.test(entry.slug))throw new Error('slug must be a short lowercase file name');
 if(entry.verified!==true)throw new Error('Not a verified success; keep a pending note instead');
 if(!Array.isArray(entry.evidence)||!entry.evidence.length)throw new Error('Evidence references required');
 const evidence=entry.evidence.map(reference=>{
  if(typeof reference!=='string'||!path.isAbsolute(reference))throw new Error('Evidence must have an absolute local path');
  const actual=fs.realpathSync(reference);
  if(!fs.statSync(actual).isFile())throw new Error('Evidence is not a readable file');
  return actual.replaceAll('\\','/');
 });
 for(const key of ['symptom','solution','result','boundary'])if(entry[key].length>200||/[\r\n]/.test(entry[key]))throw new Error(`${key} must be one short line (<=200 characters)`);
 const tags=Array.isArray(entry.tags)?entry.tags.filter(tag=>typeof tag==='string'&&tag.length<=80):[];
 const body=['---',`case_id: ${JSON.stringify(entry.caseId)}`,`tags: ${JSON.stringify(tags)}`,`source: ${JSON.stringify(evidence[0])}`,'---','',
  `- **遇到：**${entry.symptom}`,`- **解决：**${entry.solution}`,`- **结果/边界：**${entry.result} ${entry.boundary}`,`- **原证：**${evidence.join('；')}。`,''].join('\n');
 fs.mkdirSync(directory,{recursive:true});
 const file=path.join(directory,entry.slug+'.md');
 let old;try{old=fs.readFileSync(file,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
 if(old===body)return {status:'unchanged',file};
 let backup=null;
 if(old!==undefined){
  const backups=path.join(directory,'_archive','record-backups');fs.mkdirSync(backups,{recursive:true});
  backup=path.join(backups,entry.slug+'-'+Date.now()+'.md');fs.writeFileSync(backup,old,{flag:'wx'});
 }
 const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,body,{flag:'wx'});fs.renameSync(temp,file);
 const index=path.join(directory,'INDEX.md');
 if(fs.existsSync(index)){
  const contents=fs.readFileSync(index,'utf8');
  if(!contents.includes(']('+entry.slug+'.md)'))fs.appendFileSync(index,`\n- ${entry.title}：[${entry.slug}.md](${entry.slug}.md)\n`);
 }
 return {status:old===undefined?'created':'updated',file,backup,bodyCharacters:entry.symptom.length+entry.solution.length+entry.result.length+entry.boundary.length,
  evidenceChecked:evidence.length,scope:'Only formats declared verified facts; evidence existence is not semantic validation'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
  if(process.argv.slice(2).includes('--help')||process.argv.slice(2).includes('help')){
   console.log('Usage: knowledge-record.mjs --input ABS_JSON\nRequired fields: slug/caseId/title/symptom/solution/result/boundary/evidence/verified:true. Same-case updates retain a backup. Evidence existence alone does not prove verification.');
  }else{
  const flag=process.argv.indexOf('--input');if(flag<0||!process.argv[flag+1])throw new Error('Usage: knowledge-record.mjs --input ABS_JSON');
  const input=JSON.parse(fs.readFileSync(process.argv[flag+1],'utf8').replace(/^\uFEFF/,''));
  console.log(JSON.stringify(recordExperience(input),null,2));
  }
 }catch(error){console.error(error.message);process.exitCode=1;}
}

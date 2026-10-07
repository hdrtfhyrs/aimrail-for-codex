#!/usr/bin/env node
import {integrationPath} from '../paths.mjs';
// Personal-system maintenance: explicit files, one cold recovery package,
// no directory removal and no age-based deletion of useful knowledge.
import fs from 'node:fs';
import path from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const settingsFile=integrationPath('workspace/config/maintenance.json');
const settings=fs.existsSync(settingsFile)?JSON.parse(fs.readFileSync(settingsFile,'utf8')):{};
const roots=(settings.roots||[]).map(p=>path.resolve(p));
const workflowRoots=(settings.workflowRoots||[]).map(p=>path.resolve(p));
const obsoleteExperience=path.resolve(settings.obsoleteExperience||integrationPath('workspace/archive/no-selected-experience'));
const obsoleteWorkflowFiles=(settings.obsoleteWorkflowFiles||[]).map(p=>path.resolve(p));
const obsoleteMapWebFiles=(settings.obsoleteMapWebFiles||[]).map(p=>path.resolve(p));
const archiveRoot=integrationPath('workspace/archive/system-maintenance');
const reviewedBatch=path.resolve(settings.reviewedBatch||integrationPath('workspace/config/retirements.json'));
const batchResult=path.join(path.dirname(reviewedBatch),'cleanup-result.json');
const defaultProject=integrationPath('workspace/projects/example');
const slash = value => value.replaceAll('\\','/');
const readJson = (file,fallback) => {try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch(error){if(fallback!==undefined)return fallback;throw error;}};
const reviewedFiles = () => readJson(reviewedBatch,{files:[]}).files.map(item=>path.resolve(item.path));
const normalized = value => path.resolve(value).replaceAll('\\', '/').toLowerCase();
const contains = (root, file) => normalized(file).startsWith(normalized(root) + '/');
const backupName = name => /\.(?:before(?:[-.]|$)|bak(?:[-.]|$))/i.test(name);
const excluded = new Set(['.system', '_archive', 'knowledge-cache', 'injection-seen', 'resource-seen', 'bindings']);

function validate(file, {existing = true, kind} = {}) {
 if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('A full absolute file path is required');
 const absolute = path.resolve(file);
 const allowed = kind === 'retired-workflow' ? workflowRoots : roots;
 const specificallyAllowed = kind === 'obsolete-experience' && normalized(absolute)===normalized(obsoleteExperience)
  || kind === 'retired-workflow' && [...obsoleteWorkflowFiles,...obsoleteMapWebFiles].some(file=>normalized(file)===normalized(absolute))
  || kind === 'retired-project-file' && reviewedFiles().some(file=>normalized(file)===normalized(absolute));
 if(kind==='retired-project-file'&&!specificallyAllowed)throw Error('File is not in the reviewed exact retirement batch');
 if ((!specificallyAllowed && !allowed.some(root => contains(root, absolute))) || normalized(absolute).includes('/.system/'))
  throw Error('Path is outside the maintained personal-system roots');
 if (existing) {
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Only regular files can be retired; directories and links are rejected');
  const real = fs.realpathSync(absolute);
  if ((!specificallyAllowed && !allowed.some(root => contains(root, real)) || specificallyAllowed && normalized(real)!==normalized(absolute)) || normalized(real).includes('/.system/')) throw Error('Resolved path escaped its maintained root');
 } else {
  const parent = fs.realpathSync(path.dirname(absolute));
  if ((!specificallyAllowed && !allowed.some(root => normalized(parent) === normalized(root) || contains(root, parent))) || specificallyAllowed && normalized(parent)!==normalized(path.dirname(absolute))) throw Error('Restore parent escaped its maintained root');
 }
 if (kind === 'backup' && !backupName(path.basename(absolute))) throw Error('A backup entry must name an actual inactive backup file');
 if (kind === 'obsolete-skill' && !roots.slice(3).some(root => contains(root, absolute))) throw Error('Obsolete skills must belong to a personal skill root');
 if (kind && !['backup', 'obsolete-skill', 'retired-workflow','obsolete-experience','retired-project-file'].includes(kind)) throw Error('Supported retirement kinds: backup, obsolete-skill, retired-workflow, obsolete-experience, retired-project-file');
 return absolute;
}

function inventory() {
 const files = [];
 function walk(directory, recursive) {
  if (!fs.existsSync(directory)) return;
  for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
   if (excluded.has(item.name) || item.name.startsWith('.')) continue;
   const file = path.join(directory, item.name);
   if (item.isFile()) files.push(file);
   else if (item.isDirectory() && recursive && !item.isSymbolicLink()) walk(file, true);
  }
 }
 roots.forEach((root, index) => walk(root, index >= 3));
 return files;
}

function callers(files) {
 const taskRoot = integrationPath("modules/system/任务协作");
 const extra = [integrationPath("integrations/config.toml"), integrationPath("integrations/hooks.json"), integrationPath("integrations/AGENTS.md"),
  ...['task-bridge.mjs','task-window.mjs','verify.mjs','说明.md'].map(name => path.join(taskRoot,name))];
 return [...extra, ...files.filter(file => !backupName(path.basename(file)) && /\.(?:mjs|json|toml|yaml|md)$/i.test(file))]
  .flatMap(file => {try {return [{file, text: fs.readFileSync(file, 'utf8').replaceAll('\\', '/').replace(/\/{2,}/g,'/').toLowerCase()}];} catch {return [];}});
}
function references(file, records, exact = false) {
 const absolute = normalized(file), name = path.basename(file).toLowerCase();
 return records.filter(row => {
  if(normalized(row.file) === absolute) return false;
  if(row.text.includes(absolute)) return true;
  if(!exact) return row.text.includes(name);
  const relative = path.relative(path.dirname(row.file),file).replaceAll('\\','/').toLowerCase();
  return row.text.includes(relative.includes('/')?relative:'./'+relative)
   || row.text.includes("'"+relative+"'") || row.text.includes('"'+relative+'"');
 }).map(row => row.file);
}

function currentProjectCallers() {
 const files=[];
 function walk(directory){if(!fs.existsSync(directory))return;for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  if(['成果','work','主线','backups','node_modules','__pycache__','state','drive-state','data','output','outputs','cache','.git'].includes(entry.name)||entry.isSymbolicLink())continue;
  const file=path.join(directory,entry.name);
  if(entry.isDirectory())walk(file);else if(entry.isFile()&&/\.(mjs|js|py|ps1|json|toml|md|yaml)$/i.test(file)&&fs.statSync(file).size<1000000)files.push(file);
 }}
 walk(defaultProject);
 return files.map(file=>({file,text:fs.readFileSync(file,'utf8').replaceAll('\\\\','/').replaceAll('\\','/').toLowerCase()}));
}

// Read existing registries; do not create another ownership database, copy
// account records, modify bindings, or infer obsolescence from names/dates.
export function fileNavigation({project=defaultProject,query='',kind}={}) {
 project=path.resolve(project);
 if(!fs.existsSync(path.join(project,'核心.md')))throw Error('Project must have its original 核心.md');
 const manifest=path.join(project,'运行中心/modules.json');
 const rows=[{kind:'core',path:slash(path.join(project,'核心.md')),source:'项目原件',purpose:'用户确认目标'},
  {kind:'state',path:slash(path.join(project,'共享状态.md')),source:'项目原件',purpose:'分支有效条件与进度'}];
 for(const m of readJson(manifest,{modules:[]}).modules)rows.push({kind:'module',id:m.id,title:m.title,path:slash(path.isAbsolute(m.path)?m.path:path.resolve(project,m.path)),source:slash(manifest),purpose:'现用入口；调用及认证层级沿所属成果',command:`node "${slash(path.join(project,'运行中心/system.mjs'))}" module ${m.id} <模块原参数>`});
 const registry=path.join(project,'成果/成果登记.json');
 for(const e of readJson(registry,{entries:[]}).entries)rows.push({kind:'outcome',id:e.ref,title:e.title,path:slash(path.resolve(project,'成果',e.entry)),source:slash(registry),purpose:e.summary,status:e.status,boundary:e.boundary,branch:e.branch});
 const bindingRoot=integrationPath("integrations/context/bindings");
 const grouped=new Map();
 for(const host of ['codex','claude','shared']){const root=path.join(bindingRoot,host);if(!fs.existsSync(root))continue;for(const e of fs.readdirSync(root,{withFileTypes:true})){
  if(!e.isFile()||!e.name.endsWith('.json'))continue;const file=path.join(root,e.name),b=readJson(file,{});
  if(!b.project||normalized(b.project)!==normalized(project)||!b.ledger)continue;
  const parent=path.dirname(path.dirname(b.ledger));
  const key=normalized(parent);if(!grouped.has(key))grouped.set(key,{kind:'work',path:slash(parent),source:[],branches:[],ledgers:[],purpose:'由已有项目绑定定位的工作目录；绑定及主线用于接续，记录存在不推定任务仍运行'});
  const row=grouped.get(key);row.source.push(slash(file));row.ledgers.push(slash(b.ledger));if(b.branchId&&!row.branches.includes(b.branchId))row.branches.push(b.branchId);
 }}
 rows.push(...grouped.values());
 const clean=readJson(batchResult,{});
 const recovery={manifest:slash(reviewedBatch),package:clean.archive?slash(clean.archive):null,retired:clean.removed?.length||0,scope:'本轮确认替代材料；每个原路径和原因在精确名单，原始字节及内部映射在同一冷包'};
 if(query||kind==='retired')for(const item of readJson(reviewedBatch,{files:[]}).files)if(clean.removed?.some(p=>normalized(p)===normalized(item.path)))rows.push({kind:'retired',path:slash(item.path),source:slash(reviewedBatch),purpose:item.reason,recovery:recovery.package});
 const q=query.toLowerCase();
 const selected=rows.filter(row=>(!kind||row.kind===kind)&&(!q||JSON.stringify(row).toLowerCase().includes(q))).map(row=>({...row,exists:fs.existsSync(row.path)}));
 return {project:slash(project),source_registries:{modules:slash(manifest),outcomes:slash(registry),bindings:bindingRoot},note:'只定位现有原件及归属，程序不判断有用/无用；活动源码、成果证据和临时工作有不同用途，不据相同字节删证据。',recovery,entries:selected};
}

export function scan() {
 const files = inventory(), active = callers(files);
 return {purpose: 'Known inactive backup candidates; this scan does not retire live skills or infer obsolescence from age',
  maintained_roots: roots, candidates: files.filter(file => backupName(path.basename(file))).map(file => {
   const stat = fs.statSync(file);
   return {path: file, kind: 'backup', size: stat.size, mtimeMs: stat.mtimeMs, references: references(file, active)};
  })};
}

export function prune(input) {
 if (!input || !Array.isArray(input.files) || !input.files.length) throw Error('Provide files with exact paths, kinds, and reasons');
 const active = callers(inventory()), distinct = new Set();
 const projectCallers = input.files.some(item=>item.kind==='retired-project-file') ? currentProjectCallers() : [];
 const entries = input.files.map(item => {
  if (typeof item.reason !== 'string' || !item.reason.trim()) throw Error('Each file needs the established reason for retirement');
 if (!['backup', 'obsolete-skill', 'retired-workflow','obsolete-experience','retired-project-file'].includes(item.kind)) throw Error('Each file needs a supported retirement kind');
  const file = validate(item.path, {kind: item.kind});
  if (distinct.has(normalized(file))) throw Error('Duplicate file in retirement input');
  distinct.add(normalized(file));
  const effectiveCallers=item.kind==='obsolete-experience'?active.filter(row=>{
   // This registry keeps historical source provenance, not an active importer.
   if(path.basename(row.file)!=='knowledge-retirements.json')return true;
   try{const registry=JSON.parse(fs.readFileSync(row.file,'utf8'));const matches=registry.entries?.filter(entry=>entry.source&&normalized(entry.source)===normalized(file))||[];
    return !matches.length||matches.some(entry=>entry.status!=='retired');}catch{return true;}
  }):active;
  // The explicit retirement allow-list is provenance, not a live importer.
  // Ignore only this module's own registration for these authorized web files.
  let checkedCallers=obsoleteMapWebFiles.some(p=>normalized(p)===normalized(file))
    ?effectiveCallers.filter(row=>normalized(row.file)!==normalized(fileURLToPath(import.meta.url))):effectiveCallers;
  if(item.kind==='retired-project-file')checkedCallers=[...checkedCallers,...projectCallers].filter(row=>normalized(row.file)!==normalized(fileURLToPath(import.meta.url))&&!input.files.some(p=>normalized(p.path)===normalized(row.file)));
  const refs = references(file, checkedCallers, ['retired-workflow','obsolete-experience','retired-project-file'].includes(item.kind));
  if (refs.length) throw Error('Active caller reference remains: ' + file + ' <- ' + refs.join(', '));
  const stat = fs.statSync(file);
  if (item.size !== undefined && item.size !== stat.size || item.mtimeMs !== undefined && item.mtimeMs !== stat.mtimeMs)
   throw Error('File changed since it was selected: ' + file);
  return {path: file, kind: item.kind, reason: item.reason, size: stat.size, mtimeMs: stat.mtimeMs,
   data: fs.readFileSync(file).toString('base64')};
 });
 fs.mkdirSync(archiveRoot, {recursive: true});
 const archive = path.join(archiveRoot, 'retired-' + new Date().toISOString().replaceAll(/[:.]/g, '-') + '.json.gz');
 fs.writeFileSync(archive, gzipSync(Buffer.from(JSON.stringify({schema: 1, created_at: new Date().toISOString(), entries}))), {flag: 'wx'});
 const recovered = JSON.parse(gunzipSync(fs.readFileSync(archive)).toString('utf8'));
 if (recovered.entries.length !== entries.length || recovered.entries.some((item, index) => item.path !== entries[index].path || item.data !== entries[index].data))
  throw Error('Recovery-package readback failed; no files removed');
 const removed = [], skipped = [];
 for (const entry of entries) {
  const file = validate(entry.path, {kind: entry.kind});
  const stat = fs.statSync(file);
  if (stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs || !fs.readFileSync(file).equals(Buffer.from(entry.data, 'base64'))) {
   skipped.push({path: file, reason: 'changed after recovery snapshot'}); continue;
  }
  fs.unlinkSync(file); // A single validated file, never recursive deletion.
  removed.push(file);
 }
 return {archive, removed, skipped, recovery_readback: true};
}

export function restore(archive) {
 if (!path.isAbsolute(archive) || !contains(archiveRoot, archive) || fs.lstatSync(archive).isSymbolicLink()) throw Error('Use a cold package inside the maintained archive root');
 const recovered = JSON.parse(gunzipSync(fs.readFileSync(archive)).toString('utf8'));
 if (recovered.schema !== 1 || !Array.isArray(recovered.entries)) throw Error('Unsupported recovery package');
 const entries = recovered.entries.map(item => ({...item, path: validate(item.path, {existing: fs.existsSync(item.path), kind: item.kind})}));
 for (const entry of entries) if (fs.existsSync(entry.path) && !fs.readFileSync(entry.path).equals(Buffer.from(entry.data, 'base64')))
  throw Error('An occupied restore path has different content: ' + entry.path);
 const restored = [];
 for (const entry of entries) {
  if (!fs.existsSync(entry.path)) fs.writeFileSync(entry.path, Buffer.from(entry.data, 'base64'), {flag: 'wx'});
  restored.push(entry.path);
 }
 return {restored};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
 try {
  const [command, option, inputFile] = process.argv.slice(2);
  if (command === 'scan') console.log(JSON.stringify(scan(), null, 2));
  else if(command==='verified-clean' && option==='--input' && path.isAbsolute(inputFile||'')){
   const reviewedRoot=path.resolve(integrationPath("modules/system/本地统一/文件归档/reviewed"));
   if(normalized(path.dirname(inputFile))!==normalized(reviewedRoot)||path.extname(inputFile)!=='.json')throw Error('Use an exact reviewed lifecycle file list');
   const runtime=integrationPath("python");
   const script=integrationPath("modules/system/本地统一/文件归档/lifecycle.py");
   const result=spawnSync(runtime,[script,'verified-clean','--input',inputFile,...(process.argv.includes('--execute')?['--execute']:[])],{encoding:'utf8',windowsHide:true});
   process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exitCode=result.status??1;
  }
  else if(command==='files'){
   const args=process.argv.slice(3),get=name=>{const at=args.indexOf('--'+name);return at<0?undefined:args[at+1];};
   console.log(JSON.stringify(fileNavigation({project:get('project'),query:get('query')||'',kind:get('kind')}),null,2));
  }
  else if (command === 'prune' && option === '--input' && path.isAbsolute(inputFile || ''))
   console.log(JSON.stringify(prune(JSON.parse(fs.readFileSync(inputFile, 'utf8').replace(/^\uFEFF/, ''))), null, 2));
  else if (command === 'restore' && option === '--archive') console.log(JSON.stringify(restore(inputFile), null, 2));
  else console.log('files [--project ABS_PROJECT] [--query TEXT] [--kind module|outcome|work|retired]\nscan\nprune --input ABS_JSON  # files:[{path,kind,reason,size?,mtimeMs?}]\nverified-clean --input ABS_REVIEWED_JSON [--execute]  # explicit lifecycle list only\nrestore --archive ABS_JSON_GZ\nretired-project-file accepts only the fixed reviewed exact batch. No recursive deletion or automatic restore. Live references must first be corrected; obsolescence needs evidence, not age.');
 } catch (error) {console.error(JSON.stringify({error: error.message})); process.exitCode = 1;}
}

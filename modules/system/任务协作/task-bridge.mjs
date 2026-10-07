#!/usr/bin/env node
import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { windowDispatch } from './task-window.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const dbPath=process.env.TASK_BRIDGE_DB||_publicDataPath("任务协作/tasks.sqlite");
const sdkRoot=process.env.TASK_BRIDGE_MCP_SDK||_publicPath('$system/node_modules/@modelcontextprotocol/sdk/dist/esm');
const schema=`
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY,title TEXT NOT NULL,project_ref TEXT NOT NULL,ledger_ref TEXT NOT NULL,
 authorization_ref TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('open','claimed','blocked','failed','completed')),
 owner TEXT,lease_until TEXT,token_hash TEXT,next_step TEXT NOT NULL,artifact TEXT,evidence TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,at TEXT NOT NULL,
 actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,FOREIGN KEY(task_id) REFERENCES tasks(id)
);
CREATE TABLE IF NOT EXISTS revisions (
 task_id TEXT NOT NULL,revision INTEGER NOT NULL,user_source TEXT NOT NULL,authorization_ref TEXT NOT NULL,
 snapshot TEXT NOT NULL,created_at TEXT NOT NULL,delivery_ref TEXT,adopted_at TEXT,adopted_by TEXT,
 PRIMARY KEY(task_id,revision),FOREIGN KEY(task_id) REFERENCES tasks(id)
);
CREATE TABLE IF NOT EXISTS revision_reads (
 task_id TEXT NOT NULL,revision INTEGER NOT NULL,token_hash TEXT NOT NULL,read_at TEXT NOT NULL,
 PRIMARY KEY(task_id,revision,token_hash),FOREIGN KEY(task_id) REFERENCES tasks(id)
);`;
const additions={core_relation:"TEXT NOT NULL DEFAULT ''",criteria:"TEXT NOT NULL DEFAULT '[]'",stage:"TEXT NOT NULL DEFAULT ''",file_ownership:"TEXT NOT NULL DEFAULT '[]'",dependencies:"TEXT NOT NULL DEFAULT '[]'",report_to:"TEXT NOT NULL DEFAULT ''",branch_ref:"TEXT NOT NULL DEFAULT ''",user_source:"TEXT NOT NULL DEFAULT ''",user_request:"TEXT NOT NULL DEFAULT ''",goal:"TEXT NOT NULL DEFAULT ''",conditions:"TEXT NOT NULL DEFAULT '[]'",necessary_files:"TEXT NOT NULL DEFAULT '[]'",thread_id:'TEXT',host_id:'TEXT',parent_task_id:'TEXT',parent_revision:'INTEGER NOT NULL DEFAULT 0',ancestor_revisions:"TEXT NOT NULL DEFAULT '[]'",execution_kind:"TEXT NOT NULL DEFAULT 'window'",lifecycle:"TEXT NOT NULL DEFAULT 'active'",revision:'INTEGER NOT NULL DEFAULT 1',adopted_revision:'INTEGER NOT NULL DEFAULT 1'};
// Retire semantic acceptance guards. Versions describe history/concurrency only.
const guards=`
DROP TRIGGER IF EXISTS task_requirements_guard_v1;
DROP TRIGGER IF EXISTS task_claim_guard_v1;
DROP TRIGGER IF EXISTS task_claim_pending_v1;
DROP TRIGGER IF EXISTS task_adoption_guard_v1;
DROP TRIGGER IF EXISTS task_execution_guard_v1;
DROP TRIGGER IF EXISTS task_execution_guard_v2;
CREATE TABLE IF NOT EXISTS observations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,at TEXT NOT NULL,
 observer TEXT NOT NULL,source_kind TEXT NOT NULL,phenomenon TEXT NOT NULL,
 evidence_refs TEXT NOT NULL,core_relation TEXT NOT NULL,suggestion TEXT NOT NULL,
 uncertainties TEXT NOT NULL,user_source_ref TEXT,
 FOREIGN KEY(task_id) REFERENCES tasks(id)
);
CREATE INDEX IF NOT EXISTS observations_by_task ON observations(task_id,id);
CREATE TABLE IF NOT EXISTS task_work (
 task_id TEXT PRIMARY KEY,actor TEXT NOT NULL,source_ref TEXT NOT NULL,
 files TEXT NOT NULL,dependencies TEXT NOT NULL,version INTEGER NOT NULL,
 updated_at TEXT NOT NULL,FOREIGN KEY(task_id) REFERENCES tasks(id)
);
CREATE TRIGGER IF NOT EXISTS task_ownership_claim_guard_v3 BEFORE UPDATE ON tasks
 WHEN NEW.state='claimed' AND NEW.token_hash IS NOT NULL AND NEW.token_hash IS NOT OLD.token_hash
 BEGIN
  SELECT CASE WHEN OLD.lifecycle<>'active' THEN RAISE(ABORT,'task paused/cancelled') END;
  SELECT CASE WHEN NOT (OLD.state='open' OR (OLD.state IN ('claimed','blocked','failed') AND OLD.lease_until IS NOT NULL AND julianday(OLD.lease_until)<=julianday('now'))) THEN RAISE(ABORT,'task ownership cannot be replaced before expiry') END;
 END;`;
function dbOpen() {
 const db=new DatabaseSync(dbPath,{timeout:5000});
 try {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;'); db.exec(schema);
  const columns=new Set(db.prepare('PRAGMA table_info(tasks)').all().map(x=>x.name));
  for(const [name,type] of Object.entries(additions)) if(!columns.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
  if(!db.prepare('PRAGMA table_info(revision_reads)').all().some(x=>x.name==='parent_revision')) db.exec('ALTER TABLE revision_reads ADD COLUMN parent_revision INTEGER NOT NULL DEFAULT 0');
  if(!db.prepare('PRAGMA table_info(revision_reads)').all().some(x=>x.name==='ancestor_revisions')) db.exec("ALTER TABLE revision_reads ADD COLUMN ancestor_revisions TEXT NOT NULL DEFAULT '[]'");
  db.exec(guards);
  const observationColumns=new Set(db.prepare('PRAGMA table_info(observations)').all().map(x=>x.name));
  for(const [name,type] of Object.entries({source_ref:"TEXT NOT NULL DEFAULT ''",event_key:'TEXT',related_task_ids:"TEXT NOT NULL DEFAULT '[]'"}))
   if(!observationColumns.has(name)) db.exec(`ALTER TABLE observations ADD COLUMN ${name} ${type}`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS observations_event_key ON observations(task_id,observer,source_kind,event_key) WHERE event_key IS NOT NULL');
  db.exec('COMMIT'); return db;
 } catch(e) { try {db.exec('ROLLBACK');} catch {} db.close(); throw e; }
}
const now=()=>new Date().toISOString();
const hash=value=>createHash('sha256').update(value).digest('hex');
const required=(o,keys)=>{for(const k of keys) if(typeof o[k]!=='string'||!o[k].trim()) throw Error(`${k} must be a non-empty string`);};
function transaction(db,fn) {db.exec('BEGIN IMMEDIATE');try {const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}
function event(db,id,actor,action,detail='') {db.prepare('INSERT INTO events(task_id,at,actor,action,detail) VALUES(?,?,?,?,?)').run(id,now(),actor,action,detail);}
function publicTask(row) {
 if(!row) return null; const {token_hash,...safe}=row;
 safe.conditions=JSON.parse(safe.conditions);safe.necessary_files=JSON.parse(safe.necessary_files);
 safe.ancestor_revisions=JSON.parse(safe.ancestor_revisions);
 if(safe.lifecycle!=='active'){safe.execution_state=safe.state;safe.state=safe.lifecycle;}
 for(const k of ['criteria','file_ownership','dependencies']) safe[k]=JSON.parse(safe[k]||'[]');
 // Legacy adoption columns remain stored, but do not represent current readiness.
 delete safe.adopted_revision;delete safe.parent_revision;delete safe.ancestor_revisions;return safe;
}
function getRow(db,id) {const row=db.prepare('SELECT * FROM tasks WHERE id=?').get(id);if(!row) throw Error('task not found');return row;}
function ancestorRows(db,row) {
 const ancestors=[],seen=new Set([row.id]);let cursor=row;
 if(cursor.execution_kind==='subagent'&&!cursor.parent_task_id) throw Error(`subagent ${cursor.id} has no parent task`);
 while(cursor.parent_task_id) {
  if(!cursor.parent_task_id) throw Error(`subagent ${cursor.id} has no parent task`);
  const parent=getRow(db,cursor.parent_task_id);
  if(seen.has(parent.id)) throw Error('task ancestor cycle detected');
  seen.add(parent.id);ancestors.unshift(parent);cursor=parent;
 }
 return ancestors;
}
function decodeObservation(row) {return {...row,evidence_refs:JSON.parse(row.evidence_refs),uncertainties:JSON.parse(row.uncertainties),related_task_ids:JSON.parse(row.related_task_ids||'[]')};}
function observationRows(db,ids,includeRelated=false) {
 const placeholders=ids.map(()=>'?').join(',');
 return db.prepare(`SELECT * FROM observations o WHERE o.task_id IN (${placeholders})${includeRelated?` OR EXISTS (SELECT 1 FROM json_each(o.related_task_ids) r WHERE r.value IN (${placeholders}))`:''} ORDER BY o.id`).all(...ids,...(includeRelated?ids:[])).map(decodeObservation);
}
function stringList(value,key) {
 if(!Array.isArray(value)||value.some(x=>typeof x!=='string'||!x.trim())) throw Error(`${key} must be an array of non-empty strings`);
 return [...new Set(value)];
}
// Explicit absolute paths only. Prose/globs in legacy handoffs stay visible as unindexed.
function pathKey(value) {
 if(typeof value!=='string'||!value.trim()||/[\x00-\x1f*?]/.test(value)) throw Error('path must be an explicit absolute file or directory path without globs');
 const windows=/^[a-z]:[\\/]|^[\\/]{2}[^\\/]+[\\/][^\\/]+/i.test(value);
 if(!windows&&!path.posix.isAbsolute(value)) throw Error('path must be absolute');
 return (windows?path.win32.normalize(value).replaceAll('\\','/').toLowerCase():path.posix.normalize(value)).replace(/\/$/,'');
}
function sameProject(left,right) {try{return pathKey(left).replace(/\/(核心|core)\.md$/i,'')===pathKey(right).replace(/\/(核心|core)\.md$/i,'');}catch{return left===right;}}
function workRow(db,id) {
 const row=db.prepare('SELECT * FROM task_work WHERE task_id=?').get(id);
 return row?{...row,files:JSON.parse(row.files),dependencies:JSON.parse(row.dependencies)}:null;
}
function fileSpecs(value) {
 if(!Array.isArray(value)) throw Error('files must be an array');
 const result=[],seen=new Set();
 for(const item of value) {
  if(!item||typeof item!=='object'||Array.isArray(item)) throw Error('files entries must be objects');
  required(item,['path']);const key=pathKey(item.path),kind=item.kind||'file',mode=item.mode||'write';
  if(!['file','directory'].includes(kind)||!['read','write'].includes(mode)) throw Error('file kind must be file/directory and mode must be read/write');
  if(item.reason!==undefined&&typeof item.reason!=='string') throw Error('file reason must be a string');
  const identity=`${key}|${kind}|${mode}`;if(seen.has(identity)) continue;seen.add(identity);
  result.push({path:item.path,key,kind,mode,reason:item.reason||''});
 }return result;
}
function dependencySpecs(value,id) {
 if(!Array.isArray(value)) throw Error('work_dependencies must be an array');
 const result=[],seen=new Set();
 for(const item of value) {
  if(!item||typeof item!=='object'||Array.isArray(item)) throw Error('work_dependencies entries must be objects');
  required(item,['task_id','reason']);const relation=item.relation||'interface';
  if(item.task_id===id) throw Error('task cannot depend on itself');
  if(!['requires','interface','related'].includes(relation)) throw Error('dependency relation must be requires/interface/related');
  if(item.ref!==undefined&&typeof item.ref!=='string') throw Error('dependency ref must be a string');
  const key=`${item.task_id}|${relation}`;if(seen.has(key)) throw Error('duplicate dependency');seen.add(key);
  result.push({task_id:item.task_id,relation,reason:item.reason,ref:item.ref||''});
 }return result;
}
function containsFile(directory,file) {return directory.kind==='directory'&&(file.key===directory.key||file.key.startsWith(directory.key+'/'));}
function overlapFiles(a,b) {return a.key===b.key||containsFile(a,b)||containsFile(b,a);}
function workMap(db,a={}) {
 if(a.project_ref!==undefined) required(a,['project_ref']);if(a.id!==undefined) getRow(db,a.id);
 const targetPath=a.path!==undefined?pathKey(a.path):null;
 const rows=db.prepare('SELECT * FROM tasks ORDER BY created_at,id').all();
 const registrations=new Map(db.prepare('SELECT * FROM task_work').all().map(x=>[x.task_id,{...x,files:JSON.parse(x.files),dependencies:JSON.parse(x.dependencies)}]));
 const all=new Map(rows.map(row=>[row.id,row]));
 const scoped=rows.filter(row=>!a.project_ref||sameProject(row.project_ref,a.project_ref));
 const nodes=scoped.map(row=>{
  const task=publicTask(row),registration=registrations.get(row.id),legacyUnindexed=[];
  const files=registration?.files||task.file_ownership.flatMap(value=>{
   try{return [{path:value,key:pathKey(value),kind:/[\\/]$/.test(value)?'directory':'file',mode:'write',reason:'legacy explicit path'}];}
   catch{legacyUnindexed.push(value);return [];}
  });
  return {id:task.id,title:task.title,project_ref:task.project_ref,branch_ref:task.branch_ref,thread_id:task.thread_id,host_id:task.host_id,state:task.state,owner:task.owner,artifact:task.artifact,
   files,registration:registration?{actor:registration.actor,source_ref:registration.source_ref,version:registration.version,updated_at:registration.updated_at}:null,
   declared_file_ownership:task.file_ownership,unindexed_file_ownership:legacyUnindexed,
   dependencies:registration?.dependencies||[],unindexed_dependencies:registration?[]:task.dependencies};
 });
 const active=node=>!['completed','cancelled','paused'].includes(node.state);
 const conflicts=[];
 for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++) {
  if(!active(nodes[i])||!active(nodes[j])) continue;
  for(const left of nodes[i].files)for(const right of nodes[j].files)
   if(left.mode==='write'&&right.mode==='write'&&overlapFiles(left,right)) conflicts.push({task_ids:[nodes[i].id,nodes[j].id],paths:[left.path,right.path],kind:'overlapping_write_declarations',advisory:true});
 }
 const edges=nodes.flatMap(node=>node.dependencies.map(dep=>{
  const target=all.get(dep.task_id),publicTarget=target?publicTask(target):null;
  return {from:node.id,to:dep.task_id,relation:dep.relation,reason:dep.reason,ref:dep.ref,
   resolution:target?'registered':'not_registered',target:publicTarget?{id:target.id,state:publicTarget.state,thread_id:target.thread_id,host_id:target.host_id,branch_ref:target.branch_ref,artifact:target.artifact}:null};
 }));
 // Cycles concern only declared hard dependencies; they are diagnostics, never lifecycle mutations.
 const visiting=new Set(),visited=new Set(),cycles=[],stack=[];
 const adjacency=new Map(nodes.map(n=>[n.id,edges.filter(e=>e.from===n.id&&e.relation==='requires').map(e=>e.to)]));
 function visit(id) {
  if(visiting.has(id)){cycles.push([...stack.slice(stack.indexOf(id)),id]);return;}
  if(visited.has(id)) return;visiting.add(id);stack.push(id);
  for(const target of adjacency.get(id)||[]) if(adjacency.has(target))visit(target);
  stack.pop();visiting.delete(id);visited.add(id);
 }
 for(const node of nodes)visit(node.id);
 const focus=new Set(a.id?[a.id,...edges.filter(e=>e.from===a.id||e.to===a.id).flatMap(e=>[e.from,e.to])]:nodes.map(n=>n.id));
 const selected=nodes.filter(n=>focus.has(n.id)&&(!targetPath||n.files.some(f=>f.key===targetPath||containsFile(f,{key:targetPath}))));
 const selectedIds=new Set(selected.map(n=>n.id));
 return {advisory:true,project_ref:a.project_ref||null,nodes:selected,
  edges:edges.filter(e=>selectedIds.has(e.from)||selectedIds.has(e.to)),conflicts:conflicts.filter(c=>c.task_ids.some(id=>selectedIds.has(id))),
  cycles:cycles.filter(c=>c.some(id=>selectedIds.has(id))),
  note:'Declarations locate collaborators and possible overlaps; they do not grant file permissions, pause work, change goals, or assess understanding.'};
}
function observationsQuery(db,a) {
 const clauses=[],args=[];
 if(a.id!==undefined){required(a,['id']);getRow(db,a.id);if(a.include_related===true){clauses.push('(o.task_id=? OR EXISTS (SELECT 1 FROM json_each(o.related_task_ids) r WHERE r.value=?))');args.push(a.id,a.id);}else{clauses.push('o.task_id=?');args.push(a.id);}}
 if(a.project_ref!==undefined){required(a,['project_ref']);const ids=db.prepare('SELECT id,project_ref FROM tasks').all().filter(t=>sameProject(t.project_ref,a.project_ref)).map(t=>t.id);if(!ids.length)return [];clauses.push(`o.task_id IN (${ids.map(()=>'?').join(',')})`);args.push(...ids);}
 if(a.id===undefined&&a.project_ref===undefined) throw Error('observations requires id or project_ref to scope evidence');
 if(a.observer!==undefined){required(a,['observer']);clauses.push('o.observer=?');args.push(a.observer);}
 if(a.after_id!==undefined){if(!Number.isSafeInteger(a.after_id)||a.after_id<0)throw Error('after_id must be a non-negative safe integer');clauses.push('o.id>?');args.push(a.after_id);}
 if(a.limit!==undefined&&(!Number.isInteger(a.limit)||a.limit<1||a.limit>1000))throw Error('limit must be 1..1000');
 return db.prepare(`SELECT o.* FROM observations o WHERE ${clauses.join(' AND ')} ORDER BY o.id${a.limit!==undefined?' LIMIT ?':''}`).all(...args,...(a.limit!==undefined?[a.limit]:[])).map(decodeObservation);
}
function activeAncestors(ancestors) {
 for(const row of ancestors) if(row.lifecycle!=='active') throw Error(`ancestor task ${row.id} is ${row.lifecycle}; an actual user resume request is required`);
}
function taskView(db,row) {
 const task=publicTask(row),ancestors=ancestorRows(db,row);
 task.ancestors=ancestors.map(publicTask);
 task.observations=observationRows(db,[...ancestors.map(x=>x.id),row.id],true);
 task.work_registration=workRow(db,row.id);
 task.window_history=db.prepare("SELECT at,action,detail FROM events WHERE task_id=? AND action IN ('window_linked','window_replaced') ORDER BY seq").all(row.id).map(e=>({...e,detail:JSON.parse(e.detail)}));
 task.active_descendant_executors=db.prepare(`WITH RECURSIVE descendants(id) AS (SELECT id FROM tasks WHERE parent_task_id=? AND execution_kind='subagent' UNION SELECT child.id FROM tasks child JOIN descendants d ON child.parent_task_id=d.id WHERE child.execution_kind='subagent') SELECT id,owner,lease_until,state FROM tasks WHERE id IN (SELECT id FROM descendants) AND token_hash IS NOT NULL AND lease_until>?`).all(row.id,now());
 task.blocked_by_ancestor=ancestors.filter(x=>x.lifecycle!=='active').map(x=>({id:x.id,lifecycle:x.lifecycle,revision:x.revision,user_source:x.user_source,authorization_ref:x.authorization_ref}));
 return task;
}
function versionCheck(row,a) {
 if(!Number.isInteger(a.expected_version)) throw Error('expected_version must be the task version returned by get or claim');
 if(row.version!==a.expected_version) throw Error(`stale task version; expected ${row.version}`);
}
function ownerCheck(row,a) {
 required(a,['owner_token']);
 if(!['claimed','blocked','failed'].includes(row.state)||!row.token_hash||hash(a.owner_token)!==row.token_hash) throw Error('owner token rejected');
 if(row.lease_until&&Date.parse(row.lease_until)<=Date.now()) throw Error('lease expired; explicitly take over before updating');
}
const objectiveFields=['title','project_ref','ledger_ref','branch_ref','authorization_ref','user_request','goal','conditions','necessary_files','core_relation','criteria','stage','file_ownership','dependencies','report_to'];
function encodedFields(a,fields) {
 const values={}; for(const k of fields) if(Object.hasOwn(a,k)) {
  if(['conditions','necessary_files','criteria','file_ownership','dependencies'].includes(k)) {
   if(!Array.isArray(a[k])||a[k].some(x=>typeof x!=='string'||!x.trim())) throw Error(`${k} must be an array of non-empty strings`);
   values[k]=JSON.stringify(a[k]);
  } else {required(a,[k]);values[k]=a[k];}
 } return values;
}
function save(db,id,values) {db.prepare(`UPDATE tasks SET ${Object.keys(values).map(k=>`${k}=?`).join(',')},updated_at=?,version=version+1 WHERE id=?`).run(...Object.values(values),now(),id);}
function revisionView(db,row) {
 const ancestors=ancestorRows(db,row);
 return {task:taskView(db,row),parent_task:ancestors.length?publicTask(ancestors.at(-1)):null,ancestors:ancestors.map(publicTask),revisions:db.prepare('SELECT revision,user_source,authorization_ref,created_at,delivery_ref,adopted_at,adopted_by FROM revisions WHERE task_id=? ORDER BY revision').all(row.id)};
}
export function run(action,a={}) {
 if(!a||typeof a!=='object'||Array.isArray(a)) throw Error('arguments must be a JSON object');
 const db=dbOpen();try {
  if(action==='create') {
   required(a,['id','title','project_ref','ledger_ref','authorization_ref','next_step']);
   transaction(db,()=>{
    const t=now(),kind=a.execution_kind||(a.parent_task_id?'subagent':'window');
    if(!['window','subagent'].includes(kind)) throw Error('execution_kind must be window or subagent');
    if(kind==='subagent'&&!a.parent_task_id) throw Error('subagent requires parent_task_id');
    let parent=null;if(a.parent_task_id){required(a,['parent_task_id']);parent=getRow(db,a.parent_task_id);}
    if((a.thread_id&&!a.host_id)||(!a.thread_id&&a.host_id)) throw Error('thread_id and host_id must be supplied together');
    if(a.goal||a.user_request||a.conditions) required(a,['user_source']);
    db.prepare(`INSERT INTO tasks(id,title,project_ref,ledger_ref,authorization_ref,state,next_step,created_at,updated_at) VALUES(?,?,?,?,?,'open',?,?,?)`).run(a.id,a.title,a.project_ref,a.ledger_ref,a.authorization_ref,a.next_step,t,t);
    const values={...encodedFields(a,objectiveFields),execution_kind:kind};
    if(a.user_source){required(a,['user_source']);values.user_source=a.user_source;}if(parent) values.parent_task_id=parent.id;
    if(kind==='subagent'){values.thread_id=parent.thread_id;values.host_id=parent.host_id;values.parent_revision=parent.revision;}
    else if(a.thread_id){required(a,['thread_id','host_id']);values.thread_id=a.thread_id;values.host_id=a.host_id;}
    db.prepare(`UPDATE tasks SET ${Object.keys(values).map(k=>`${k}=?`).join(',')} WHERE id=?`).run(...Object.values(values),a.id);
    const row=getRow(db,a.id);
    db.prepare('INSERT INTO revisions(task_id,revision,user_source,authorization_ref,snapshot,created_at) VALUES(?,?,?,?,?,?)').run(a.id,1,row.user_source,row.authorization_ref,JSON.stringify(publicTask(row)),t);
    event(db,a.id,'system','created',a.title);
   });return taskView(db,getRow(db,a.id));
  }
  if(action==='list'||action==='compact') {
   const rows=db.prepare('SELECT * FROM tasks ORDER BY created_at,id').all().map(row=>taskView(db,row)).filter(x=>!a.state||x.state===a.state);
   if(action==='list') return rows;
   return rows.map(x=>Object.fromEntries(['id','title','project_ref','ledger_ref','branch_ref','authorization_ref','state','owner','lease_until','next_step','artifact','evidence','version','revision','blocked_by_ancestor','thread_id','host_id','parent_task_id','execution_kind'].map(k=>[k,x[k]])));
  }
  if(action==='get') return taskView(db,getRow(db,a.id));
  if(action==='work-map') {
   db.exec('BEGIN');try{const result=workMap(db,a);db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}
  }
  if(action==='work-register') {
   required(a,['id','actor','source_ref']);
   const files=fileSpecs(a.files),dependencies=dependencySpecs(a.work_dependencies||[],a.id);
   transaction(db,()=>{
    getRow(db,a.id);const prior=workRow(db,a.id);
    if(prior&&a.expected_registration_version!==prior.version) throw Error(`stale work registration; expected_registration_version=${prior.version}`);
    if(!prior&&a.expected_registration_version!==undefined&&a.expected_registration_version!==0) throw Error('new work registration expects version 0');
    db.prepare(`INSERT INTO task_work(task_id,actor,source_ref,files,dependencies,version,updated_at) VALUES(?,?,?,?,?,1,?)
     ON CONFLICT(task_id) DO UPDATE SET actor=excluded.actor,source_ref=excluded.source_ref,files=excluded.files,dependencies=excluded.dependencies,version=task_work.version+1,updated_at=excluded.updated_at`).run(a.id,a.actor,a.source_ref,JSON.stringify(files),JSON.stringify(dependencies),now());
    event(db,a.id,a.actor,'work_registered',JSON.stringify({source_ref:a.source_ref,registration_version:(prior?.version||0)+1}));
   });return {registration:workRow(db,a.id),map:workMap(db,{id:a.id})};
  }
  if(action==='events') return db.prepare('SELECT at,actor,action,detail FROM events WHERE task_id=? ORDER BY seq').all(a.id);
  if(action==='dispatch') return windowDispatch(taskView(db,getRow(db,a.id)),a);
  if(action==='link-window') {
   required(a,['id','thread_id','host_id']);transaction(db,()=>{
    const row=getRow(db,a.id);versionCheck(row,a);
    if(row.execution_kind!=='window') throw Error('link the parent window; internal subagents do not create user chats');
    const replacing=!!row.thread_id&&(row.thread_id!==a.thread_id||row.host_id!==a.host_id);
    if(replacing) {
     if(a.replace!==true) throw Error('task already belongs to another window; explicit replace=true and file handoff required');
     required(a,['expected_thread_id','expected_host_id','handoff_ref','replacement_reason']);
     if(a.expected_thread_id!==row.thread_id||a.expected_host_id!==row.host_id) throw Error('previous window changed; read current task before replacement');
     if(row.token_hash&&row.lease_until&&Date.parse(row.lease_until)>Date.now()) throw Error('active executor lease; current owner must save progress and hand off before window replacement');
     const handoff=JSON.parse(readFileSync(a.handoff_ref,'utf8').replace(/^\uFEFF/,''));
     if(handoff.format!=='project-file-handoff/1'||handoff.branch_id!==row.branch_ref||!sameProject(handoff.project,row.project_ref)) throw Error('handoff must reference the same task project and branch');
     if(handoff.execution?.task_id!==row.id) throw Error('handoff must identify this stable task_id');
    }
    const descendants=db.prepare(`WITH RECURSIVE descendants(id) AS (SELECT id FROM tasks WHERE parent_task_id=? AND execution_kind='subagent' UNION SELECT child.id FROM tasks child JOIN descendants d ON child.parent_task_id=d.id WHERE child.execution_kind='subagent') SELECT * FROM tasks WHERE id IN (SELECT id FROM descendants)`).all(a.id);
    if(replacing&&descendants.some(d=>d.token_hash&&d.lease_until&&Date.parse(d.lease_until)>Date.now())) throw Error('active descendant executor lease; hand off affected child work before replacement');
    save(db,a.id,{thread_id:a.thread_id,host_id:a.host_id});
    if(replacing&&row.token_hash) db.prepare('UPDATE tasks SET state=\'open\',owner=NULL,token_hash=NULL,lease_until=NULL WHERE id=?').run(a.id);
    db.prepare(`WITH RECURSIVE descendants(id) AS (
     SELECT id FROM tasks WHERE parent_task_id=? AND execution_kind='subagent'
     UNION SELECT child.id FROM tasks child JOIN descendants d ON child.parent_task_id=d.id WHERE child.execution_kind='subagent'
    ) UPDATE tasks SET thread_id=?,host_id=?,version=version+1,updated_at=? WHERE id IN (SELECT id FROM descendants)`).run(a.id,a.thread_id,a.host_id,now());
    if(replacing) for(const child of descendants) {
     if(child.token_hash) db.prepare("UPDATE tasks SET state='open',owner=NULL,token_hash=NULL,lease_until=NULL WHERE id=?").run(child.id);
     event(db,child.id,'dispatcher','window_replaced',JSON.stringify({previous_thread_id:child.thread_id,previous_host_id:child.host_id,thread_id:a.thread_id,host_id:a.host_id,parent_task_id:a.id,handoff_ref:a.handoff_ref,replacement_reason:a.replacement_reason}));
    }
    event(db,a.id,'dispatcher',replacing?'window_replaced':'window_linked',JSON.stringify({thread_id:a.thread_id,host_id:a.host_id,...(replacing?{previous_thread_id:row.thread_id,previous_host_id:row.host_id,handoff_ref:a.handoff_ref,replacement_reason:a.replacement_reason}:{})}));
   });return taskView(db,getRow(db,a.id));
  }
  if(action==='delivered') {
   required(a,['id','delivery_ref']);transaction(db,()=>{
    const row=getRow(db,a.id);versionCheck(row,a);
    if(!row.thread_id) throw Error('link a real application thread before recording delivery');
    const deliveryRevision=a.revision??row.revision;
    const result=db.prepare('UPDATE revisions SET delivery_ref=? WHERE task_id=? AND revision=?').run(a.delivery_ref,a.id,deliveryRevision);
    if(result.changes!==1) throw Error('revision record not found');
    event(db,a.id,'dispatcher','delivered',JSON.stringify({revision:deliveryRevision,delivery_ref:a.delivery_ref}));
   });return revisionView(db,getRow(db,a.id));
  }
  if(['revise','pause','cancel','resume'].includes(action)) {
   required(a,['id','user_source','authorization_ref','user_request']);transaction(db,()=>{
    const row=getRow(db,a.id);versionCheck(row,a);const values=encodedFields(a,objectiveFields),control=action==='revise'?a.control:action;
    if(control&&!['pause','cancel','resume'].includes(control)) throw Error('control must be pause, cancel or resume');
    if(control==='pause'&&row.lifecycle!=='active') throw Error('only active tasks can be paused');
    if(control==='cancel'&&row.lifecycle==='cancelled') throw Error('task already cancelled');
    if(control==='resume'&&row.lifecycle==='active') throw Error('task is already active');
    if(!control&&!objectiveFields.some(k=>k!=='authorization_ref'&&Object.hasOwn(a,k))&&!Object.hasOwn(a,'next_step')) throw Error('supply a goal/condition change or an explicit user lifecycle request');
    if(a.next_step){required(a,['next_step']);values.next_step=a.next_step;}
    Object.assign(values,{user_source:a.user_source,revision:row.revision+1});
    if(control) values.lifecycle={pause:'paused',cancel:'cancelled',resume:'active'}[control];
    if(control==='cancel'||row.state==='completed') Object.assign(values,{state:'open',owner:null,token_hash:null,lease_until:null});
    // A new outcome must not inherit previous completion evidence.
    Object.assign(values,{artifact:null,evidence:null});save(db,a.id,values);const current=getRow(db,a.id);
    db.prepare('INSERT INTO revisions(task_id,revision,user_source,authorization_ref,snapshot,created_at) VALUES(?,?,?,?,?,?)').run(a.id,current.revision,a.user_source,a.authorization_ref,JSON.stringify(publicTask(current)),now());
    event(db,a.id,'user-source','revised',JSON.stringify({revision:current.revision,user_source:a.user_source,authorization_ref:a.authorization_ref,control:control||null}));
   });return revisionView(db,getRow(db,a.id));
  }
  // Read historical/current requirements without an acknowledgement side effect.
  if(action==='revision') return revisionView(db,getRow(db,a.id));
  if(action==='observations') return observationsQuery(db,a);
  if(action==='observe') {
   required(a,['id','observer','phenomenon','core_relation']);
   const sourceKind=a.source_kind||'collaborator';
   if(!['collaborator','user_source'].includes(sourceKind)) throw Error('source_kind must be collaborator or user_source');
   if(sourceKind==='user_source') required(a,['user_source_ref']);
   for(const key of ['evidence_refs','uncertainties','related_task_ids']) if(a[key]!==undefined) stringList(a[key],key);
   for(const key of ['source_ref','event_key','suggestion','user_source_ref']) if(a[key]!==undefined&&typeof a[key]!=='string') throw Error(`${key} must be a string`);
   if(a.event_key!==undefined) required(a,['event_key','source_ref']);
   const payload={phenomenon:a.phenomenon,evidence_refs:a.evidence_refs||[],core_relation:a.core_relation,suggestion:a.suggestion||'',uncertainties:a.uncertainties||[],user_source_ref:a.user_source_ref||null,source_ref:a.source_ref||'',related_task_ids:stringList(a.related_task_ids||[],'related_task_ids')};
   let stored,deduplicated=false;
   transaction(db,()=>{
    getRow(db,a.id);
    const existing=a.event_key?db.prepare('SELECT * FROM observations WHERE task_id=? AND observer=? AND source_kind=? AND event_key=?').get(a.id,a.observer,sourceKind,a.event_key):null;
    if(existing){
     const decoded=decodeObservation(existing);
     if(Object.keys(payload).some(k=>JSON.stringify(decoded[k])!==JSON.stringify(payload[k]))) throw Error('event_key already records different evidence; use a new key for a new observation');
     stored=decoded;deduplicated=true;return;
    }
    const inserted=db.prepare('INSERT INTO observations(task_id,at,observer,source_kind,phenomenon,evidence_refs,core_relation,suggestion,uncertainties,user_source_ref,source_ref,event_key,related_task_ids) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(a.id,now(),a.observer,sourceKind,payload.phenomenon,JSON.stringify(payload.evidence_refs),payload.core_relation,payload.suggestion,JSON.stringify(payload.uncertainties),payload.user_source_ref,payload.source_ref,a.event_key||null,JSON.stringify(payload.related_task_ids));
    stored=decodeObservation(db.prepare('SELECT * FROM observations WHERE id=?').get(inserted.lastInsertRowid));
   });return {...stored,deduplicated};
  }
  if(action==='claim') {
   required(a,['id','owner']);const nonce=randomBytes(32).toString('base64url'),minutes=Number(a.lease_minutes??30);
   if(!Number.isFinite(minutes)) throw Error('lease_minutes must be a finite number');
   const lease=new Date(Date.now()+Math.max(1,Math.min(minutes,1440))*60000).toISOString();
   transaction(db,()=>{
    const row=getRow(db,a.id);if(row.lifecycle!=='active') throw Error(`cannot claim ${row.lifecycle} task without an actual user resume request`);
    activeAncestors(ancestorRows(db,row));
    const expired=['claimed','blocked','failed'].includes(row.state)&&row.lease_until&&Date.parse(row.lease_until)<=Date.now();
    if(row.state!=='open'&&!(expired&&a.takeover===true)) throw Error(expired?'lease expired; pass takeover=true to explicitly take over':`cannot claim task in state ${row.state}`);
    const ownership={state:'claimed',owner:a.owner,lease_until:lease,token_hash:hash(nonce)};
    save(db,a.id,ownership);event(db,a.id,a.owner,expired?'taken_over':'claimed',`lease_until=${lease}`);
   });return {task:taskView(db,getRow(db,a.id)),owner_token:nonce};
  }
  if(action==='update'||action==='complete') {
   required(a,['id','owner_token']);transaction(db,()=>{
    const row=getRow(db,a.id);ownerCheck(row,a);versionCheck(row,a);
    if(row.lifecycle!=='active') throw Error(`task is ${row.lifecycle}; an actual user resume request is required`);
    const ancestors=ancestorRows(db,row);activeAncestors(ancestors);
    if(objectiveFields.some(k=>k!=='stage'&&Object.hasOwn(a,k))) throw Error('user objective fields require revise with user_source and authorization_ref');
    const values=encodedFields(a,['next_step','stage','artifact','evidence']);
    if(action==='complete') {
     required(a,['artifact','evidence']);const p=path.resolve(a.artifact);
     if(!existsSync(p)||!statSync(p).isFile()||statSync(p).size===0) throw Error('completion requires an existing non-empty artifact file');
     Object.assign(values,{state:'completed',lease_until:null,token_hash:null});
    } else if(a.state!==undefined) {
     if(!['blocked','failed','open','claimed'].includes(a.state)) throw Error('unsupported update state; user lifecycle changes use revise');
     values.state=a.state;if(a.state==='open') Object.assign(values,{lease_until:null,token_hash:null,owner:null});
    }
    if(a.handoff_to){if(action!=='update') throw Error('handoff_to requires update');required(a,['handoff_to']);Object.assign(values,{state:'open',lease_until:null,token_hash:null,owner:null});}
    if(!Object.keys(values).length) throw Error('no fields to update');save(db,a.id,values);
    event(db,a.id,row.owner,action==='complete'?'completed':a.handoff_to?'handed_off':`updated:${values.state||row.state}`,a.handoff_to?`recipient=${a.handoff_to}`:`fields=${Object.keys(values).join(',')};revision=${row.revision}`);
   });return taskView(db,getRow(db,a.id));
  }
  throw Error(`unknown action: ${action}`);
 }finally{db.close();}
}
const help=`task-bridge — independent task windows and collaboration evidence (Node 24+)
node task-bridge.mjs <create|list|compact|get|events|claim|update|complete|revise|revision|observe|observations|work-register|work-map|pause|cancel|resume|link-window|dispatch|delivered> '<JSON object>'
node task-bridge.mjs <action> --input <absolute JSON file>
node task-bridge.mjs mcp
TASK_BRIDGE_DB selects an isolated database; default is tasks.sqlite beside this script.
expected_version prevents concurrent overwrite; owner_token protects ownership. Neither proves understanding or artifact quality.
revision is a read-only history/current-context interface; no adoption step is required.
observe stores evidence separately and never changes user objectives, lifecycle or completion.
observe accepts source_ref/event_key for idempotent retries and related_task_ids for evidence routing; changed evidence needs a new key.
observations accepts id or project_ref, include_related, observer, after_id and limit; no acknowledgement or cursor is written.
work-register stores explicit files and work_dependencies with actor/source_ref; updates use expected_registration_version solely to prevent concurrent overwrite.
work-map locates tasks/files/dependencies and reports advisory write overlaps, missing targets and requires cycles; never pauses or rewrites tasks.
revise/lifecycle require actual user-source references. References themselves do not prove authorization.
dispatch defaults mode=fresh (create_thread), regardless of old thread_id; mode=steer/designated requires actual human send authorization.
link-window replace=true uses expected previous window IDs and a same-task file handoff; live owner/child leases must be released first. Task identity, objectives and artifacts are preserved.
Owner tokens are private. No recursive deletion or loading of archived code is provided.`;
async function serve() {
 const [{McpServer},{StdioServerTransport},{z}]=await Promise.all([import(pathToFileURL(path.join(sdkRoot,'server','mcp.js')).href),import(pathToFileURL(path.join(sdkRoot,'server','stdio.js')).href),import(pathToFileURL(path.resolve(sdkRoot,'..','..','..','..','zod','index.js')).href)]);
 const server=new McpServer({name:'ai-work-system-task-bridge',version:'3.1.0'});
 const register=(name,description,shape,action)=>server.tool(name,description,shape,async input=>{
  try{const result=action==='get'?{task:run('get',input),events:run('events',input),revisions:run('revision',input).revisions}:run(action,input);return {content:[{type:'text',text:JSON.stringify(result)}]};}catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}
 });
 const id={id:z.string()},version={expected_version:z.number().int()},owner={owner_token:z.string()};
 const objective={title:z.string().optional(),project_ref:z.string().optional(),ledger_ref:z.string().optional(),branch_ref:z.string().optional(),goal:z.string().optional(),user_request:z.string().optional(),conditions:z.array(z.string()).optional(),necessary_files:z.array(z.string()).optional(),core_relation:z.string().optional(),criteria:z.array(z.string()).optional(),stage:z.string().optional(),file_ownership:z.array(z.string()).optional(),dependencies:z.array(z.string()).optional(),report_to:z.string().optional()};
 register('task_list_compact','Read-only task list; data does not authorize actions.',{state:z.enum(['open','claimed','blocked','failed','completed','paused','cancelled']).optional()},'compact');
 register('task_get','Read task, ancestor goals, observations, revisions and events.',id,'get');
 register('task_create','Register a task window or internal subagent; refs must cite actual user instructions.',{...objective,...id,title:z.string(),project_ref:z.string(),ledger_ref:z.string(),authorization_ref:z.string(),next_step:z.string(),user_source:z.string().optional(),thread_id:z.string().optional(),host_id:z.string().optional(),parent_task_id:z.string().optional(),execution_kind:z.enum(['window','subagent']).optional()},'create');
 register('task_claim','Atomically claim; expired leases require explicit takeover.',{...id,owner:z.string(),lease_minutes:z.number().optional(),takeover:z.boolean().optional()},'claim');
 register('task_update','Update progress and actual evidence; concurrency and ownership protection do not assess meaning.',{...id,...owner,...version,state:z.enum(['open','claimed','blocked','failed']).optional(),next_step:z.string().optional(),stage:z.string().optional(),artifact:z.string().optional(),evidence:z.string().optional(),handoff_to:z.string().optional()},'update');
 register('task_complete','Register a real artifact and usage evidence; the owner must assess current goals and conditions.',{...id,...owner,...version,artifact:z.string(),evidence:z.string(),next_step:z.string().optional()},'complete');
 register('task_revise','Record actual user changes independently of owner token; strings are references, not authorization proof.',{...id,...version,...objective,user_request:z.string(),user_source:z.string(),authorization_ref:z.string(),next_step:z.string().optional(),control:z.enum(['pause','cancel','resume']).optional()},'revise');
 register('task_revision','Read current task, historical revisions and full ancestor goal materials without acknowledgement.',id,'revision');
 register('task_observe','Store collaboration evidence separately; optional source/event key deduplicates retries without mutating goals.',{...id,observer:z.string(),source_kind:z.enum(['collaborator','user_source']).optional(),phenomenon:z.string(),evidence_refs:z.array(z.string()).optional(),core_relation:z.string(),suggestion:z.string().optional(),uncertainties:z.array(z.string()).optional(),user_source_ref:z.string().optional(),source_ref:z.string().optional(),event_key:z.string().optional(),related_task_ids:z.array(z.string()).optional()},'observe');
 register('task_observations','Read scoped evidence by task/project and cursor; no acknowledgement or objective mutation.',{id:z.string().optional(),project_ref:z.string().optional(),include_related:z.boolean().optional(),observer:z.string().optional(),after_id:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(1000).optional()},'observations');
 register('task_work_register','Declare concrete file responsibilities and dependencies with source attribution; advisory and independent of objectives.',{...id,actor:z.string(),source_ref:z.string(),expected_registration_version:z.number().int().nonnegative().optional(),files:z.array(z.object({path:z.string(),kind:z.enum(['file','directory']).optional(),mode:z.enum(['write','read']).optional(),reason:z.string().optional()})),work_dependencies:z.array(z.object({task_id:z.string(),relation:z.enum(['requires','interface','related']).optional(),reason:z.string(),ref:z.string().optional()})).optional()},'work-register');
 register('task_work_map','Locate task/file owners, dependency endpoints, overlapping writes and hard dependency cycles; read-only diagnostics.',{id:z.string().optional(),project_ref:z.string().optional(),path:z.string().optional()},'work-map');
 register('task_link_window','Associate a real ready application result; explicit replacement retains stable task and prior evidence.',{...id,...version,thread_id:z.string(),host_id:z.string(),replace:z.boolean().optional(),expected_thread_id:z.string().optional(),expected_host_id:z.string().optional(),handoff_ref:z.string().optional(),replacement_reason:z.string().optional()},'link-window');
 register('task_dispatch','Generate fresh create_thread parameters by default; explicit steer/designated preserves human-authorized corrections.',{...id,mode:z.enum(['fresh','steer','designated']).optional(),target:z.object({type:z.enum(['projectless','project']),projectId:z.string().optional(),environment:z.object({type:z.literal('local')}).optional()}).optional(),send_authorization_ref:z.string().optional(),handoff_directory:z.string().optional(),change_point:z.string().optional(),handoff_metadata:z.object({suggestions:z.array(z.unknown()).optional(),decisions:z.array(z.unknown()).optional(),unresolved:z.array(z.unknown()).optional(),running_actions:z.array(z.unknown()).optional(),artifacts:z.array(z.unknown()).optional()}).optional()},'dispatch');
 register('task_delivered','Record an actual application delivery reference; delivery does not prove understanding.',{...id,...version,revision:z.number().int().optional(),delivery_ref:z.string()},'delivered');
 await server.connect(new StdioServerTransport());
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 if(process.argv[2]==='mcp') await serve();
 else if(process.argv[2]==='help'||!process.argv[2]) console.log(help);
 else try {
  const raw=process.argv[3]==='--input'?(required({file:process.argv[4]},['file']),readFileSync(process.argv[4],'utf8').replace(/^\uFEFF/,'')):process.argv[3]||'{}';
  console.log(JSON.stringify(run(process.argv[2],JSON.parse(raw)),null,2));
 }catch(e){console.error(JSON.stringify({error:e.message}));process.exitCode=1;}
}

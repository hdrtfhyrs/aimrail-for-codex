import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
// Drive connector adapter. No OAuth extraction, cloud deletion or live-file replacement.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {spawnSync} from 'node:child_process';

const MODULE = path.dirname(fileURLToPath(import.meta.url));
export const DRIVE_FOLDER = process.env.AI_DRIVE_FOLDER_ID || '';
const PREFIX = 'mcp__codex_apps__google_drive_';
const LIMIT = 100 * 1024 * 1024; // observed connector upload ceiling, not Drive API ceiling
const now = () => new Date().toISOString();
const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
function abs(p) { if (typeof p !== 'string' || !path.isAbsolute(p)) throw Error('Absolute local path required'); return path.resolve(p); }
function safeId(s) { if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) throw Error('Invalid identifier'); return s; }
function canonicalURL(s) {
  const u = new URL(s);
  if (u.protocol !== 'https:' || u.hostname !== 'drive.google.com' || !/^\/file\/d\/[A-Za-z0-9_-]+(?:\/view)?$/.test(u.pathname)) throw Error('Observed canonical Drive file URL required');
  return u.href;
}
function normalized(result) {
  if (result?.isError) throw Error('Drive connector returned an error; operation remains pending');
  const data = result?.structuredContent ?? result;
  return data?.structuredContent && !data.id ? data.structuredContent : data;
}
export function metadata(result) {
  const r = normalized(result);
  const n = Number(r.size ?? r.file_size_bytes);
  return {id:r.id ?? r.file_id, name:r.name ?? r.title ?? r.file_name,
    mimeType:r.mimeType ?? r.mime_type, size:Number.isSafeInteger(n) && n >= 0 && r.size !== null ? n : null,
    parents:r.parents ?? r.parent_ids ?? [], url:r.webViewLink ?? r.url ?? r.display_url};
}
export function digest(file) {
  const h = createHash('sha256'); const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(1024 * 1024); let n; while ((n = fs.readSync(fd, b, 0, b.length, null))) h.update(b.subarray(0,n)); }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
}
function atomicJSON(p, row) {
  fs.mkdirSync(path.dirname(p), {recursive:true});
  const temp = p + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(row,null,2)+'\n', {flag:'wx'}); fs.renameSync(temp,p);
}
function withLock(p, action) {
  fs.mkdirSync(path.dirname(p), {recursive:true});
  let fd;
  try { fd=fs.openSync(p,'wx'); } catch { throw Error('Drive operation locked; inspect lock PID before removing this exact lock'); }
  fs.writeSync(fd,JSON.stringify({pid:process.pid,started_at:now()}));
  const release=()=>{fs.closeSync(fd);fs.unlinkSync(p);};
  try { const value=action(); if(value?.then) return value.finally(release); release(); return value; }
  catch(e){release();throw e;}
}
function mime(file) {
  return ({'.zip':'application/zip','.json':'application/json','.md':'text/markdown','.txt':'text/plain'})[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export class GoogleDriveStorage {
  constructor({stateDir=_publicDataPath("存储接入/drive-state"), callTool}={}) {
    this.stateDir=abs(stateDir); this.callTool=callTool;
  }
  jobPath(id){return path.join(this.stateDir,'jobs',safeId(id)+'.json');}
  job(id){return readJSON(this.jobPath(id));}
  save(row){row.updated_at=now();atomicJSON(this.jobPath(row.id),row);return row;}
  async call(name,args){if(!this.callTool)throw Error('connector_required: inject callTool or execute CLI tool plans in an authenticated Codex turn');return this.callTool(PREFIX+name,args);}
  status() {
    const dir=path.join(this.stateDir,'jobs');
    const jobs=fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.json')).map(n=>readJSON(path.join(dir,n))):[];
    return {provider:'google-drive',folder_id:DRIVE_FOLDER,connector_callable:!!this.callTool,
      local_unattended_authenticated:false,local_unattended_reason:'No local OAuth/rclone transport configured; Codex connector identity is not inherited by CLI',
      upload_limit_bytes:LIMIT,jobs:jobs.map(({id,state,name,size,cloud,restore})=>({id,state,name,size,cloud,restore}))};
  }
  prepareStore({source,folderId=DRIVE_FOLDER,name,id=randomUUID(),snapshotId}={}) {
    source=abs(source);safeId(id);safeId(folderId);
    return withLock(this.jobPath(id)+'.lock',()=>{
      if(fs.existsSync(this.jobPath(id))) {
        const old=this.job(id);
        if(old.source!==source || old.folder_id!==folderId)throw Error('Operation ID already belongs to another source/folder');
        return old;
      }
      if(!fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink())throw Error('Explicit regular file required');
      const size=fs.statSync(source).size;
      if(size>LIMIT)throw Error('connector_upload_limit: use bounded archives or separately authenticated resumable transport');
      const ext=path.extname(source);
      name=name ?? path.basename(source,ext)+'--'+id+ext;
      if(!name || /[\\/\x00]/.test(name))throw Error('Single remote file name required');
      const staged=path.join(this.stateDir,'spool',id, path.basename(source));
      fs.mkdirSync(path.dirname(staged),{recursive:true});fs.copyFileSync(source,staged,fs.constants.COPYFILE_EXCL);
      const stagedSize=fs.statSync(staged).size;
      if(stagedSize!==size || stagedSize>LIMIT)throw Error('Source changed during staging; select a stable completed file');
      return this.save({format:'ai-drive-transfer-v1',id,state:'prepared',created_at:now(),source,staged,
        name,size,sha256:digest(staged),mime_type:mime(source),folder_id:folderId,snapshot_id:snapshotId ?? null});
    });
  }
  uploadPlan(id) {
    const j=this.job(id);
    if(j.state!=='prepared')throw Error('Upload already started or completed; use recovery-plan/readback before retrying');
    if(digest(j.staged)!==j.sha256)throw Error('Staged bytes changed');
    return {operation_id:id,tool:PREFIX+'upload_file',args:{file_uri:j.staged,file_name:j.name,mime_type:j.mime_type,parent_folder_id:j.folder_id}};
  }
  beginUpload(id) {return withLock(this.jobPath(id)+'.lock',()=>{const plan=this.uploadPlan(id);const j=this.job(id);j.state='upload_uncertain';this.save(j);return plan;});}
  recoveryPlan(id) {
    const j=this.job(id); const quote=s=>s.replaceAll('\\','\\\\').replaceAll("'","\\'");
    return {operation_id:id,tool:PREFIX+'search',args:{special_filter_query_str:`trashed = false and name = '${quote(j.name)}' and '${quote(j.folder_id)}' in parents`,topn:100,best_effort_fetch:false},
      rule:'Read metadata for the exact match; multiple matches require resolution. Zero matches after an uncertain upload does not prove the server did not commit. Do not blindly reupload.'};
  }
  completeStore(id,uploadResult,metadataResult) {
    return withLock(this.jobPath(id)+'.lock',()=>{
      const j=this.job(id),u=metadata(uploadResult),m=metadata(metadataResult);
      if(!u.id || m.id!==u.id || m.name!==j.name || m.size!==j.size || !m.parents.includes(j.folder_id))throw Error('Upload metadata mismatch: require same ID, name, size and verified parent');
      if(m.mimeType?.startsWith('application/vnd.google-apps.'))throw Error('Raw backup was converted to a native Workspace file');
      const url=canonicalURL(m.url ?? u.url);
      if(!new URL(url).pathname.includes('/'+m.id))throw Error('Drive URL/file ID mismatch');
      if(j.cloud && j.cloud.id!==m.id)throw Error('Operation already points to another Drive file');
      j.cloud={id:m.id,url,name:m.name,size:m.size,mime_type:m.mimeType,parents:m.parents,metadata_verified_at:now()};
      if(!j.restore)j.state='uploaded_metadata_verified';
      return this.save(j);
    });
  }
  async store(input) {
    const j=this.prepareStore(input);
    if(j.cloud)return j;
    const plan=this.beginUpload(j.id);
    const uploaded=await this.call('upload_file',plan.args);
    const u=metadata(uploaded);safeId(u.id);
    // Keep the observed file ID even if the following readback fails.
    withLock(this.jobPath(j.id)+'.lock',()=>{const row=this.job(j.id);row.observed_upload_id=u.id;this.save(row);});
    const checked=await this.call('get_file_metadata',{fileId:u.id,fields:'id,name,size,mimeType,parents,webViewLink'});
    return this.completeStore(j.id,uploaded,checked);
  }
  registerExisting({id,source,metadataResult,folderId=DRIVE_FOLDER,snapshotId}={}) {
    // Ground an already uploaded snapshot without uploading a second copy.
    const m=metadata(metadataResult);
    const j=this.prepareStore({id,source,name:m.name,folderId,snapshotId});
    return this.completeStore(j.id,metadataResult,metadataResult);
  }
  registerCloud({id=randomUUID(),size,sha256,metadataResult,folderId=DRIVE_FOLDER,snapshotId}={}) {
    // Restore after local source loss: import expected bytes from a retained trusted receipt.
    safeId(id);safeId(folderId);
    if(!Number.isSafeInteger(size) || size<0 || !/^[a-f0-9]{64}$/.test(sha256 ?? ''))throw Error('Trusted receipt requires exact size and SHA256');
    const m=metadata(metadataResult);safeId(m.id);
    if(m.size!==size || !m.parents.includes(folderId) || m.mimeType?.startsWith('application/vnd.google-apps.'))throw Error('Existing raw cloud file does not match retained receipt');
    const url=canonicalURL(m.url);
    if(!new URL(url).pathname.includes('/'+m.id))throw Error('Drive URL/file ID mismatch');
    return withLock(this.jobPath(id)+'.lock',()=>{
      if(fs.existsSync(this.jobPath(id))){const j=this.job(id);if(j.sha256!==sha256 || j.size!==size || j.cloud?.id!==m.id)throw Error('Receipt conflicts with this operation ID');return j;}
      return this.save({format:'ai-drive-transfer-v1',id,state:'uploaded_metadata_verified',created_at:now(),source:null,staged:null,
        name:m.name,size,sha256,mime_type:m.mimeType,folder_id:folderId,snapshot_id:snapshotId ?? null,
        cloud:{...m,metadata_verified_at:now()},imported_from_retained_receipt:true});
    });
  }
  downloadPlan(id) {
    const j=this.job(id);if(!j.cloud)throw Error('Verified cloud record required');
    return {operation_id:id,metadata:{tool:PREFIX+'get_file_metadata',args:{fileId:j.cloud.id,fields:'id,name,size,mimeType,parents,webViewLink'}},
      fetch:{tool:PREFIX+'fetch',args:{url:j.cloud.url,download_raw_file:true,include_base64:false}}};
  }
  async completeGet(id,fetchResult,destination) {
    destination=abs(destination);
    return withLock(this.jobPath(id)+'.lock',async()=>{
      const j=this.job(id),r=normalized(fetchResult);
      if(!j.cloud || r.id!==j.cloud.id)throw Error('Fetch must refer to this verified Drive file');
      if(fs.existsSync(destination))throw Error('Restore destination exists; choose a new path');
      const ref=r.file_uri ?? r.structuredContent?.file_uri;
      const local=ref?.workspace_path ?? r.workspace_path;
      const link=ref?.download_url;
      if(!local && !link)throw Error('No materializable authenticated file reference returned; refetch raw bytes');
      fs.mkdirSync(path.dirname(destination),{recursive:true});
      const temp=destination+'.'+randomUUID()+'.partial';
      try {
        if(local)fs.copyFileSync(abs(local),temp,fs.constants.COPYFILE_EXCL);
        else {
          // Only the runtime-owned reference from this connector response, never a Drive browser URL.
          const u=new URL(link);
          if(u.protocol!=='https:' || !u.hostname.endsWith('.oaiusercontent.com'))throw Error('Unsupported file-reference host; inject a trusted materializer for this runtime');
          const response=await fetch(u,{redirect:'error',signal:AbortSignal.timeout(120000)});
          if(!response.ok || !response.body)throw Error('Reference download failed (HTTP '+response.status+'); refetch to renew expired reference');
          let bytes=0;
          const bound=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;callback(bytes>j.size?Error('Download exceeds expected size'):null,chunk);}});
          await pipeline(Readable.fromWeb(response.body),bound,fs.createWriteStream(temp,{flags:'wx'}));
        }
        if(fs.statSync(temp).size!==j.size || digest(temp)!==j.sha256)throw Error('Recovered bytes differ from staged original');
        // COPYFILE_EXCL prevents a late competing writer from being overwritten.
        fs.copyFileSync(temp,destination,fs.constants.COPYFILE_EXCL);
        j.state='download_verified';j.restore={file:destination,size:j.size,sha256:j.sha256,verified_at:now()};
        return this.save(j);
      } finally {if(fs.existsSync(temp))fs.unlinkSync(temp);}
    });
  }
  async get({id,destination}) {
    const plan=this.downloadPlan(id),j=this.job(id);
    const m=metadata(await this.call('get_file_metadata',plan.metadata.args));
    if(m.id!==j.cloud.id || m.name!==j.name || m.size!==j.size || !m.parents.includes(j.folder_id))throw Error('Remote metadata changed before download');
    return this.completeGet(id,await this.call('fetch',plan.fetch.args),destination);
  }
  restore({id,destination,python=process.env.AI_PYTHON_PATH||'python'}) {
    destination=abs(destination);
    return withLock(this.jobPath(id)+'.lock',()=>{
      const j=this.job(id);
      if(!j.restore || digest(j.restore.file)!==j.sha256)throw Error('Download and verify archive before extraction');
      if(fs.existsSync(destination))throw Error('Snapshot extraction requires a new directory');
      const result=spawnSync(python,[path.join(MODULE,'storage.py'),'verify','--archive',j.restore.file,'--restore-to',destination],{encoding:'utf8',windowsHide:true,shell:false,maxBuffer:4*1024*1024});
      if(result.error || result.status!==0)throw Error('Existing snapshot verifier failed; preserve downloaded archive and inspect destination');
      const verification=JSON.parse(result.stdout);
      if(!verification.verified)throw Error('Snapshot verifier did not confirm recovery');
      j.state='snapshot_restore_verified';j.snapshot_restore=verification;this.save(j);return verification;
    });
  }
  pendingSnapshots() {
    const dir=path.join(MODULE,'outbox');
    return fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.json')).map(n=>readJSON(path.join(dir,n))).filter(r=>r.cloud_state==='pending_upload').map(r=>({snapshot_id:r.snapshot_id,source:r.archive,folderId:r.drive_folder_id,sha256:r.archive_sha256,size:r.archive_bytes})):[];
  }
}

export function createGoogleDriveStorage(options){return new GoogleDriveStorage(options);}
const HELP={usage:'google-drive.mjs COMMAND [--state-dir ABS] [--input ABS_JSON]',
  commands:{status:'Local capability and durable transfer status (does not log in)',pending:'Existing snapshot outbox, read-only',
    'prepare-store':'input {source,folderId?,name?,id?,snapshotId?}; stage immutable bytes',
    'begin-upload':'--id ID; persist uncertain state BEFORE executing returned connector plan',
    'recovery-plan':'--id ID; exact remote search after interrupted upload',
    'complete-store':'input {id,uploadResult,metadataResult}; verified cloud receipt',
    'register-existing':'input {id,source,metadataResult,folderId?,snapshotId?}; reuse an already uploaded archive',
    'register-cloud':'input {id?,size,sha256,metadataResult,folderId?,snapshotId?}; recover from a retained receipt after local source loss',
    'download-plan':'--id ID; metadata + raw fetch plans',
    'complete-get':'input {id,fetchResult,destination}; stream authenticated reference and verify original bytes',
    restore:'input {id,destination,python?}; use existing snapshot archive verifier',
    store:'Requires injected callTool in JS. CLI returns connector_required; use plans.',get:'Same boundary as store.'}};
export async function main(argv=process.argv.slice(2)) {
  const command=argv.shift() ?? 'help',opts={};
  for(let i=0;i<argv.length;i+=2){if(!argv[i]?.startsWith('--') || argv[i+1]===undefined)throw Error('Expected --flag value');opts[argv[i].slice(2)]=argv[i+1];}
  const adapter=new GoogleDriveStorage({stateDir:opts['state-dir'] ?? _publicDataPath("存储接入/drive-state")});
  const input=opts.input?readJSON(abs(opts.input)):{};
  if(command==='help')return HELP;
  if(command==='status')return adapter.status();
  if(command==='pending')return adapter.pendingSnapshots();
  if(command==='prepare-store')return adapter.prepareStore(input);
  if(command==='begin-upload')return adapter.beginUpload(opts.id ?? input.id);
  if(command==='recovery-plan')return adapter.recoveryPlan(opts.id ?? input.id);
  if(command==='complete-store')return adapter.completeStore(input.id,input.uploadResult,input.metadataResult);
  if(command==='register-existing')return adapter.registerExisting(input);
  if(command==='register-cloud')return adapter.registerCloud(input);
  if(command==='download-plan')return adapter.downloadPlan(opts.id ?? input.id);
  if(command==='complete-get')return adapter.completeGet(input.id,input.fetchResult,input.destination);
  if(command==='restore')return adapter.restore(input);
  if(command==='store'||command==='get')throw Error('connector_required: standalone CLI cannot inherit Codex OAuth; use tool plans or inject callTool');
  throw Error('Unknown command: '+command);
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  main().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(JSON.stringify({error:e.message}));process.exitCode=1;});
}

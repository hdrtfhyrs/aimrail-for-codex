"""Explicit-list, credential-free snapshots. Never deletes or overwrites live sources."""
import pathlib as _public_pathlib
import importlib.util as _public_importutil
_public_root = next(p for p in _public_pathlib.Path(__file__).resolve().parents if (p/'public_paths.py').is_file())
_public_spec = _public_importutil.spec_from_file_location('ai_work_public_paths', _public_root/'public_paths.py')
_public_module = _public_importutil.module_from_spec(_public_spec)
_public_spec.loader.exec_module(_public_module)
_public_path = _public_module.public_path
import argparse, contextlib, datetime as dt, hashlib, json, os, pathlib, shutil, sqlite3, stat, sys, uuid, zipfile
sys.dont_write_bytecode = True

MODULE = pathlib.Path(__file__).resolve().parent
PROJECT = MODULE.parent
USER = pathlib.Path(_public_path('$data/user'))
ARCHIVE_ROOT = pathlib.Path(_public_path('$data/backups'))
PYTHON = pathlib.Path(sys.executable)
DRIVE_FOLDER = os.environ.get('AI_DRIVE_FOLDER_ID', '')
RUNNER_FILES = ['system.mjs','module-registry.mjs','modules.json','state.ps1','boot.ps1','install-startup.ps1','index.html','运行说明.md','connections.json']

def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for part in iter(lambda: f.read(1024 * 1024), b''): h.update(part)
    return h.hexdigest()

def files_for_snapshot():
    # Source and explicitly registered public work files only. Credentials and
    # conversation originals are never discovered by this reusable snapshot.
    for source in sorted(PROJECT.rglob('*')):
        if not source.is_file() or source.is_symlink(): continue
        relative = source.relative_to(PROJECT)
        if any(part in {'node_modules','.git','__pycache__','data','logs','reports','runtime'} for part in relative.parts): continue
        if source.suffix not in {'.mjs','.js','.py','.ps1','.css','.html','.md','.json','.txt'}: continue
        yield source, 'source/system/'+relative.as_posix(), 'file'
    work = pathlib.Path(_public_path('$data/system'))
    for relative in ['信息中心/config/settings.json','信息中心/config/sources.json','信息中心/config/collection.json','资料中心/data/资料登记.json','资料中心/object-knowledge/data/objects.json','本地统一/对话记录/organization.json']:
        source = work/relative
        if source.is_file() and not source.is_symlink(): yield source, 'work/system/'+relative, 'file'
    for relative in ['信息中心/data/information.sqlite','任务协作/tasks.sqlite','运行中心/event-ingest.sqlite','运行中心/event-dispatch-data/queue.sqlite']:
        source = work/relative
        if source.is_file() and not source.is_symlink(): yield source, 'work/system/'+relative, 'sqlite-backup'


def database_summary(path):
    # Only closed, transaction-consistent backup/restored copies reach here.
    # immutable avoids creating WAL/SHM merely to inspect a WAL-mode snapshot.
    with contextlib.closing(sqlite3.connect(path.as_uri()+'?mode=ro&immutable=1', uri=True, timeout=20)) as db:
        check = db.execute('PRAGMA quick_check').fetchone()[0]
        if check != 'ok': raise ValueError('SQLite quick_check: '+check)
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        counts = {t:db.execute('SELECT COUNT(*) FROM "'+t.replace('"','""')+'"').fetchone()[0] for t in tables}
        return {'quick_check':check,'table_rows':counts}

def cleanup_known_files(paths, root):
    """Only files registered by this invocation; never discover/delete a tree."""
    root = root.absolute()
    errors = []
    removed = 0
    for path in reversed(paths):
        try:
            path = path.absolute()
            if root not in path.parents: raise ValueError('Cleanup path outside owned root')
            for part in [*reversed(path.parents), path]:
                try: info = part.lstat()
                except FileNotFoundError: continue
                if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 1024:
                    raise ValueError('Cleanup refuses reparse path: '+str(part))
            if path.exists():
                if not path.is_file(): raise ValueError('Cleanup only accepts files')
                path.unlink(); removed += 1
        except (OSError, ValueError) as ex:
            errors.append({'path':str(path), 'error':str(ex)})
    return {'removed_files':removed, 'errors':errors, 'directories':'left in place'}

def archive_budget(payload_bytes, file_count):
    # Deflate can expand incompressible data; also allow long names, headers,
    # per-file allocation and manifest JSON. This is a budget, not a reservation.
    return payload_bytes + payload_bytes // 1000 + file_count * 8192 + 1024**2

def snapshot_space_budget(sources):
    payload = 0
    for source, rel, kind in sources:
        size = source.stat().st_size
        if kind == 'sqlite-backup':
            with contextlib.closing(sqlite3.connect(source.as_uri()+'?mode=ro', uri=True, timeout=20)) as db:
                size = max(size, db.execute('PRAGMA page_count').fetchone()[0] * db.execute('PRAGMA page_size').fetchone()[0])
        payload += size
    staged = payload + payload // 10 + len(sources) * 8192
    # Keep the same default low-water margin as system storage health. Operators
    # can change the reserve explicitly; this is separate from work-file space.
    reserve = int(os.environ.get('AI_SYSTEM_BACKUP_RESERVE_BYTES', 20 * 1024**3))
    if reserve < 0: raise ValueError('AI_SYSTEM_BACKUP_RESERVE_BYTES must be nonnegative')
    return {'estimated_source_bytes':payload, 'staging_budget_bytes':staged,
            'archive_budget_bytes':archive_budget(staged, len(sources)), 'reserve_bytes':reserve,
            'required_free_bytes':staged + archive_budget(staged, len(sources)) + reserve,
            'boundary':'20 GiB default volume reserve (AI_SYSTEM_BACKUP_RESERVE_BYTES override), plus work-file budget and 10% source growth allowance; rechecked after staging. Concurrent disk use and unbounded source growth are not reserved; write failures clean owned files.'}

def verify_archive(archive, manifest=None):
    with zipfile.ZipFile(archive) as z:
        actual = json.loads(z.read('manifest.json'))
        if manifest is not None and actual != manifest: raise ValueError('Archive manifest mismatch')
        if actual.get('format') != 'ai-system-explicit-snapshot-v1': raise ValueError('Unknown snapshot format')
        expected = {'manifest.json'} | {i['path'] for i in actual['items']}
        if len(actual['items']) + 1 != len(expected) or set(z.namelist()) != expected or len(z.namelist()) != len(expected):
            raise ValueError('Archive member mismatch')
        for name in expected:
            p = pathlib.PurePosixPath(name)
            if p.is_absolute() or '..' in p.parts or '\\' in name or ':' in name: raise ValueError('Unsafe archive path')
        for item in actual['items']:
            digest = hashlib.sha256(); size = 0
            with z.open(item['path']) as f:
                for part in iter(lambda:f.read(1024 * 1024), b''): size += len(part); digest.update(part)
            if size != item['bytes'] or digest.hexdigest() != item['sha256']: raise ValueError('Archive content mismatch: '+item['path'])
    return actual

def snapshot(force=False):
    ARCHIVE_ROOT.mkdir(parents=True, exist_ok=True)
    today = dt.datetime.now().astimezone().strftime('%Y-%m-%d')
    status_path = MODULE/'latest.json'
    if status_path.exists() and not force:
        latest = json.loads(status_path.read_text(encoding='utf-8'))
        if latest.get('local_date') == today and pathlib.Path(latest['archive']).is_file():
            return {**latest, 'skipped':'same-day snapshot already exists'}
    stamp = dt.datetime.now().astimezone().strftime('%Y%m%dT%H%M%S')+'-'+uuid.uuid4().hex[:8]
    sources = list(files_for_snapshot())
    budget = snapshot_space_budget(sources)
    budget['free_bytes_before'] = shutil.disk_usage(ARCHIVE_ROOT).free
    if budget['free_bytes_before'] < budget['required_free_bytes']:
        raise RuntimeError('Insufficient snapshot space: '+json.dumps(budget))
    folder = ARCHIVE_ROOT/stamp
    folder.mkdir()
    staging=[]; unpublished=[]; committed=[False]
    try:
        return create_snapshot(sources, folder, stamp, today, status_path, budget, staging, unpublished, committed)
    finally:
        # A published latest record proves the ZIP passed verification. Keep its
        # ZIP/manifest even if a later bookkeeping operation fails.
        cleanup = cleanup_known_files(staging + ([] if committed[0] else unpublished), ARCHIVE_ROOT)
        if cleanup['errors']:
            active = sys.exception()
            message = 'Snapshot cleanup incomplete: '+json.dumps(cleanup)
            if active: active.add_note(message)
            else: raise RuntimeError(message)

def create_snapshot(sources, folder, stamp, today, status_path, budget, staging, unpublished, committed):
    items=[]
    for source, rel, kind in sources:
        target=folder/rel
        target.parent.mkdir(parents=True, exist_ok=True)
        staging.append(target)
        source_mtime = source.stat().st_mtime_ns
        if kind == 'sqlite-backup':
            staging.extend(pathlib.Path(str(target)+suffix) for suffix in ('-wal','-shm','-journal'))
            with contextlib.closing(sqlite3.connect(source.as_uri()+'?mode=ro', uri=True, timeout=30)) as live, contextlib.closing(sqlite3.connect(target)) as backup:
                live.backup(backup, pages=256, sleep=0.05)
            detail=database_summary(target)
        else:
            with source.open('rb') as src, target.open('xb') as dst: shutil.copyfileobj(src, dst, 1024 * 1024)
            shutil.copystat(source, target)
            detail={}
        items.append({'path':rel,'source':str(source),'kind':kind,'bytes':target.stat().st_size,'sha256':sha(target),
                      'mtime_ns':target.stat().st_mtime_ns,'source_mtime_ns':source_mtime,**detail})
    manifest={'format':'ai-system-explicit-snapshot-v1','created_at':dt.datetime.now().astimezone().isoformat(),'snapshot_id':stamp,
              'restore_policy':'extract to a NEW directory; compare then restore selected files while relevant writers are stopped',
              'excluded':['credentials and tokens','Codex/Claude private session transcripts','model weights','live SQLite WAL/SHM','whole .codex/config.toml','Claude configuration','unlisted files'],
              'cross_file_consistency':'Each SQLite backup is transaction-consistent; independent DBs and documents are captured sequentially, not an atomic whole-system transaction.',
              'items':items}
    manifest_path = folder/'manifest.json'
    unpublished.append(manifest_path)
    write_json(manifest_path,manifest)
    archive=ARCHIVE_ROOT/(stamp+'.zip')
    partial=ARCHIVE_ROOT/(stamp+'.zip.partial')
    unpublished.extend([partial, archive])
    budget['actual_staged_bytes'] = sum(i['bytes'] for i in items) + manifest_path.stat().st_size
    budget['free_bytes_before_pack'] = shutil.disk_usage(ARCHIVE_ROOT).free
    budget['required_free_before_pack'] = archive_budget(budget['actual_staged_bytes'], len(items)) + budget['reserve_bytes']
    if budget['free_bytes_before_pack'] < budget['required_free_before_pack']: raise RuntimeError('Insufficient space after staging: '+json.dumps(budget))
    with zipfile.ZipFile(partial,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6,strict_timestamps=False) as z:
        z.write(manifest_path,'manifest.json')
        for item in items: z.write(folder/item['path'],item['path'])
    verify_archive(partial, manifest)
    os.replace(partial, archive)
    cleanup = cleanup_known_files(staging, ARCHIVE_ROOT)
    if cleanup['errors']: raise RuntimeError('Snapshot staging cleanup incomplete: '+json.dumps(cleanup))
    staging.clear()
    result={'snapshot_id':stamp,'local_date':today,'created_at':manifest['created_at'],'archive':str(archive),'manifest':str(folder/'manifest.json'),
            'files':len(items),'source_bytes':sum(i['bytes'] for i in items),'archive_bytes':archive.stat().st_size,'archive_sha256':sha(archive),
            'drive_folder_id':DRIVE_FOLDER,'cloud_state':'pending_upload','d_free_bytes_after':shutil.disk_usage(ARCHIVE_ROOT).free,
            'archive_content_verified':True,'space_budget':budget,'staging_policy':'owned files removed individually after success/failure; directories retained'}
    for old in (MODULE/'outbox').glob('*.json'):
        data=json.loads(old.read_text(encoding='utf-8'))
        if data.get('local_date')==today and data.get('cloud_state')=='pending_upload':
            data.update({'cloud_state':'superseded_before_upload','superseded_by':stamp})
            write_json(old,data)
    write_json(MODULE/'outbox'/f'{stamp}.json',result)
    try:
        write_json(status_path,result)
        committed[0] = True
    except BaseException:
        (MODULE/'outbox'/f'{stamp}.json').unlink(missing_ok=True)
        raise
    return result

def locked_snapshot(force=False):
    lock=MODULE/'snapshot.lock'
    try:
        fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY)
    except FileExistsError:
        raise RuntimeError('Snapshot already running. If persistent, inspect snapshot.lock PID before removing this exact lock file.')
    try:
        os.write(fd,json.dumps({'pid':os.getpid(),'started':dt.datetime.now().astimezone().isoformat()}).encode())
        return snapshot(force)
    finally:
        os.close(fd)
        lock.unlink()

def restore_verify(archive,destination):
    archive=pathlib.Path(archive).resolve()
    destination=pathlib.Path(destination).resolve()
    if destination.exists() and any(destination.iterdir()): raise ValueError('Restore destination must be new or empty')
    if destination == PROJECT or destination == USER or destination == ARCHIVE_ROOT: raise ValueError('Refuse live target')
    destination.mkdir(parents=True,exist_ok=True)
    manifest = verify_archive(archive)
    generated=[]
    try:
        return extract_verified(archive, destination, manifest, generated)
    except BaseException as ex:
        cleanup = cleanup_known_files(generated, destination)
        if cleanup['errors']: ex.add_note('Restore cleanup incomplete: '+json.dumps(cleanup))
        raise

def extract_verified(archive, destination, manifest, generated):
    with zipfile.ZipFile(archive) as z:
        for name in z.namelist():
            target=destination/name
            target.parent.mkdir(parents=True,exist_ok=True)
            # Exclusive creation prevents overwriting a file introduced by a
            # concurrent writer after the initial empty-directory check.
            with target.open('xb') as dst:
                generated.append(target)
                with z.open(name) as src: shutil.copyfileobj(src, dst, 1024 * 1024)
    db_checks={}
    for item in manifest['items']:
        target=destination/item['path']
        if sha(target)!=item['sha256'] or target.stat().st_size!=item['bytes']: raise ValueError('Restore mismatch: '+item['path'])
        if item['kind']=='sqlite-backup':
            check=database_summary(target)
            if check['table_rows']!=item['table_rows']: raise ValueError('Database row mismatch')
            db_checks[item['path']]=check
        if 'mtime_ns' in item:
            os.utime(target, ns=(target.stat().st_atime_ns, item['mtime_ns']))
    return {'verified':True,'archive':str(archive),'restored_to':str(destination),'files':len(manifest['items']),'database_checks':db_checks}

def receipt(snapshot_id,file_id,url,download_verified=False):
    pending=MODULE/'outbox'/f'{snapshot_id}.json'
    data=json.loads(pending.read_text(encoding='utf-8'))
    data.update({'cloud_state':'uploaded_readback_verified' if download_verified else 'uploaded_metadata_verified','drive_file_id':file_id,'drive_url':url,'recorded_at':dt.datetime.now().astimezone().isoformat()})
    write_json(MODULE/'receipts'/f'{snapshot_id}.json',data)
    write_json(pending,data)
    latest=MODULE/'latest.json'
    if latest.exists() and json.loads(latest.read_text(encoding='utf-8')).get('snapshot_id')==snapshot_id: write_json(latest,data)
    return data

def status():
    result={'module':str(MODULE),'archive_root':str(ARCHIVE_ROOT),'drive_folder_id':DRIVE_FOLDER,'independent_cloud_daemon':'not configured; connected Codex Drive tool performs cloud transfer',
            'disks':{d:{'free_bytes':shutil.disk_usage(d).free,'total_bytes':shutil.disk_usage(d).total} for d in [_public_path('C:/'),_public_path('D:/')]}}
    if (MODULE/'latest.json').exists(): result['latest']=json.loads((MODULE/'latest.json').read_text(encoding='utf-8'))
    result['pending_uploads']=[json.loads(p.read_text(encoding='utf-8')) for p in sorted((MODULE/'outbox').glob('*.json')) if json.loads(p.read_text(encoding='utf-8')).get('cloud_state')=='pending_upload']
    return result

def drive(args):
    # The provider owns auth/transfer semantics. Relay exact JSON and exit code;
    # connected Codex Drive and local OAuth/daemon remain distinct capabilities.
    import subprocess
    entry=MODULE/'google-drive.mjs'
    if not entry.is_file():
        print(json.dumps({'error':'module_entry_missing','module':'drive-storage','path':str(entry)},ensure_ascii=False))
        return 2
    node=shutil.which('node.exe') or shutil.which('node')
    if not node: raise FileNotFoundError('Node runtime unavailable for Drive adapter')
    result=subprocess.run([node,str(entry),*args],shell=False,capture_output=True,
                          creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    # Hidden Windows children can lose inherited handles. Relay the captured
    # bytes explicitly, preserving provider JSON, diagnostics and exit status.
    if result.stdout: sys.stdout.buffer.write(result.stdout); sys.stdout.buffer.flush()
    if result.stderr: sys.stderr.buffer.write(result.stderr); sys.stderr.buffer.flush()
    return result.returncode

def main():
    if len(sys.argv)>1 and sys.argv[1]=='drive':
        raise SystemExit(drive(sys.argv[2:]))
    p=argparse.ArgumentParser(); sub=p.add_subparsers(dest='cmd',required=True)
    s=sub.add_parser('snapshot'); s.add_argument('--force',action='store_true')
    v=sub.add_parser('verify'); v.add_argument('--archive',required=True); v.add_argument('--restore-to',required=True)
    sub.add_parser('status')
    r=sub.add_parser('receipt'); r.add_argument('--snapshot-id',required=True); r.add_argument('--file-id',required=True); r.add_argument('--url',required=True); r.add_argument('--download-verified',action='store_true')
    a=p.parse_args()
    if a.cmd=='snapshot': result=locked_snapshot(a.force)
    elif a.cmd=='verify': result=restore_verify(a.archive,a.restore_to)
    elif a.cmd=='receipt': result=receipt(a.snapshot_id,a.file_id,a.url,a.download_verified)
    else: result=status()
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=='__main__':
    if hasattr(sys.stdout,'reconfigure'): sys.stdout.reconfigure(encoding='utf-8')
    main()

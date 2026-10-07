import pathlib as _public_pathlib
import importlib.util as _public_importutil
_public_root = next(p for p in _public_pathlib.Path(__file__).resolve().parents if (p/'public_paths.py').is_file())
_public_spec = _public_importutil.spec_from_file_location('ai_work_public_paths', _public_root/'public_paths.py')
_public_module = _public_importutil.module_from_spec(_public_spec)
_public_spec.loader.exec_module(_public_module)
_public_path = _public_module.public_path
"""Explicit file cold archive. Upload separately, verify a downloaded ZIP, then clean.

plan --selection selection.json --out manifest.json
pack --manifest manifest.json --archive archive.zip --out packed.json
receipt --packed packed.json --download-record transport.json --restore-to NEW --out receipt.json
clean --packed packed.json --receipt receipt.json [--execute] --out clean.json

selection: {items:[{source,reason,reference_state}], scope_roots:[absolute roots]}.
transport: {provider,provider_id,recovery_url,downloaded_archive,
downloaded_from_provider_id,download_completed_at,transport}.
No cloud credentials, upload, recursive deletion or automatic directory selection.
"""
import argparse, contextlib, datetime as dt, hashlib, json, os, pathlib, stat, sys, uuid, zipfile, urllib.parse
sys.dont_write_bytecode = True
from storage import sha, write_json

HOME = pathlib.Path.home()
WORK = pathlib.Path(_public_path('$data/system/存储接入'))
SANDBOX = WORK/'cold-archive/selftest'
ROOTS = [pathlib.Path(p) for p in json.loads(os.environ.get('AI_ARCHIVE_ALLOWED_ROOTS', '[]'))]
SENSITIVE = {'sessions','transcripts','chats','credentials','tokens','secrets','models','weights','snapshots','outbox','receipts'}
FORMAT = 'ai-system-explicit-cold-archive-v1'

def load(path): return json.loads(pathlib.Path(path).read_text(encoding='utf-8-sig'))
def now(): return dt.datetime.now().astimezone().isoformat()
def inside(p, root): return p == root or root in p.parents
def absolute(path):
    p = pathlib.Path(os.path.abspath(path))
    if not pathlib.Path(path).is_absolute(): raise ValueError('Absolute path required')
    return p

def no_links(p, must_exist=True):
    # Check every ancestor BEFORE resolve; Windows junctions are not is_symlink().
    for part in [*reversed(p.parents), p]:
        try: s=part.lstat()
        except FileNotFoundError:
            if part==p and not must_exist: return
            raise
        if stat.S_ISLNK(s.st_mode) or getattr(s,'st_file_attributes',0)&1024:
            raise ValueError('Linked/reparse path refused: '+str(part))

def guard(path, roots, sandbox=False):
    p=absolute(path); no_links(p)
    roots=[absolute(r) for r in roots]
    for r in roots: no_links(r)
    allowed=[SANDBOX] if sandbox else ROOTS
    if not roots or any(not any(inside(r,a) for a in allowed) for r in roots): raise ValueError('Scope root outside authorised roots')
    if not any(inside(p,r) and p!=r for r in roots): raise ValueError('File outside manifest scope')
    if not sandbox:
        if inside(p,WORK): raise ValueError('Current agent work protected')
        if any(x.lower() in SENSITIVE or x.lower().startswith(('sk-','token','auth','credential')) for x in p.parts): raise ValueError('Protected path')
        if p.suffix.lower() in {'.sqlite','.db','.sqlite3','.pem','.key','.safetensors','.gguf','.pt','.pth'} or p.name.lower().endswith(('-wal','-shm')): raise ValueError('Protected data/credential/model')
        if p.name.lower() in {'.env','config.toml','rclone.conf','connections.json'} or '.env.' in p.name.lower(): raise ValueError('Credential/config file protected')
    if not stat.S_ISREG(p.lstat().st_mode): raise ValueError('Only regular files allowed')
    return p

def fingerprint(p):
    before=p.stat(); digest=sha(p); after=p.stat()
    if (before.st_size,before.st_mtime_ns,before.st_ino)!=(after.st_size,after.st_mtime_ns,after.st_ino): raise ValueError('Source changed during read')
    return {'bytes':after.st_size,'mtime_ns':after.st_mtime_ns,'sha256':digest}

def validate_manifest(m):
    if m.get('format')!=FORMAT or not m.get('items'): raise ValueError('Unknown or empty manifest')
    sources=set(); members=set()
    for item in m['items']:
        p=absolute(item['source']); key=os.path.normcase(str(p))
        member=item['path']; rel=pathlib.PurePosixPath(member)
        if key in sources or member in members or rel.is_absolute() or '..' in rel.parts or '\\' in member or ':' in member or not member.startswith('files/'):
            raise ValueError('Duplicate/unsafe manifest path')
        sources.add(key); members.add(member)
    return m

def plan(selection, out):
    selection=load(selection); items=[]; roots=selection['scope_roots']; sandbox=selection.get('sandbox',False)
    for n,row in enumerate(selection['items']):
        p=guard(row['source'],roots,sandbox)
        if not row.get('reason') or not row.get('reference_state'): raise ValueError('Reason and reference state required for each selected file')
        items.append({'source':str(p),'path':f'files/{n:06d}/{p.name}', 'reason':row['reason'],'reference_state':row['reference_state'],**fingerprint(p)})
    m={'format':FORMAT,'archive_id':dt.datetime.now().strftime('%Y%m%dT%H%M%S')+'-'+uuid.uuid4().hex[:8], 'created_at':now(),'scope_roots':roots,'sandbox':sandbox,
       'restore_policy':'Restore to a new directory; original paths are mapping metadata only. Preserve cloud locator after clean.', 'items':items}
    validate_manifest(m); write_json(pathlib.Path(out),m)
    return {'manifest':str(absolute(out)),'files':len(items),'source_bytes':sum(i['bytes'] for i in items)}

def pack(manifest, archive, out):
    m=validate_manifest(load(manifest)); archive=absolute(archive); no_links(archive.parent)
    with zipfile.ZipFile(archive,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        z.writestr('manifest.json',json.dumps(m,ensure_ascii=False,indent=2))
        for item in m['items']:
            p=guard(item['source'],m['scope_roots'],m.get('sandbox',False))
            if fingerprint(p)!={k:item[k] for k in ('bytes','mtime_ns','sha256')}: raise ValueError('Source changed since plan: '+str(p))
            z.write(p,item['path'])
    verify_archive(archive,m)
    result={'archive_id':m['archive_id'],'archive':str(archive),'manifest':str(absolute(manifest)),'archive_bytes':archive.stat().st_size,'archive_sha256':sha(archive),'manifest_sha256':sha(pathlib.Path(manifest)),
            'files':len(m['items']),'source_bytes':sum(i['bytes'] for i in m['items']),'cloud_state':'pending_upload'}
    write_json(pathlib.Path(out),result); return result

def verify_archive(archive,m):
    with zipfile.ZipFile(archive) as z:
        names=z.namelist(); expected={'manifest.json'}|{i['path'] for i in m['items']}
        if len(names)!=len(expected) or set(names)!=expected or json.loads(z.read('manifest.json'))!=m: raise ValueError('Archive manifest/member mismatch')
        for item in m['items']:
            h=hashlib.sha256(); count=0
            with z.open(item['path']) as f:
                for data in iter(lambda:f.read(1024*1024),b''): count+=len(data); h.update(data)
            if count!=item['bytes'] or h.hexdigest()!=item['sha256']: raise ValueError('Archive content mismatch')

def packed_manifest(packed):
    p=load(packed); manifest=absolute(p['manifest']); no_links(manifest)
    if sha(manifest)!=p['manifest_sha256']: raise ValueError('Manifest changed after pack')
    m=validate_manifest(load(manifest))
    if m['archive_id']!=p['archive_id']: raise ValueError('Archive ID mismatch')
    return p,m

def receipt(packed, download_record, restore_to, out):
    p,m=packed_manifest(packed); record=load(download_record)
    for key in ('provider','provider_id','recovery_url','downloaded_archive','downloaded_from_provider_id','download_completed_at','transport'):
        if not record.get(key): raise ValueError('Missing actual download provenance: '+key)
    if record['provider_id']!=record['downloaded_from_provider_id']: raise ValueError('Download provider ID mismatch')
    if not m.get('sandbox',False):
        provider_hosts={'google-drive':{'drive.google.com'},'quark':{'pan.quark.cn','drive.quark.cn'}}
        url=urllib.parse.urlparse(record['recovery_url'])
        if record['provider'] not in provider_hosts or url.scheme!='https' or url.hostname not in provider_hosts[record['provider']]:
            raise ValueError('Production receipt must locate authorised Google/Quark cloud object')
        dt.datetime.fromisoformat(record['download_completed_at'].replace('Z','+00:00'))
    archive=absolute(record['downloaded_archive']); no_links(archive)
    if archive==absolute(p['archive']): raise ValueError('Must use separately downloaded ZIP, not original upload source')
    if sha(archive)!=p['archive_sha256']: raise ValueError('Downloaded ZIP mismatch')
    verify_archive(archive,m)
    target=absolute(restore_to)
    if target.exists(): raise ValueError('Restore directory must be new')
    no_links(target.parent)
    if any(inside(absolute(i['source']),target) for i in m['items']): raise ValueError('Restore directory overlaps live sources')
    target.mkdir()
    with zipfile.ZipFile(archive) as z:
        for item in m['items']:
            dest=target/item['path']; dest.parent.mkdir(parents=True,exist_ok=True)
            with z.open(item['path']) as source, dest.open('xb') as sink:
                for data in iter(lambda:source.read(1024*1024),b''): sink.write(data)
            if sha(dest)!=item['sha256'] or dest.stat().st_size!=item['bytes']: raise ValueError('Restored file mismatch')
    result={**p,**record,'cloud_state':'uploaded_download_restore_verified','download_verified':True,'restore_verified':True,'restored_to':str(target),'recorded_at':now(),'transport_record_sha256':sha(pathlib.Path(download_record))}
    write_json(pathlib.Path(out),result); return result

@contextlib.contextmanager
def windows_locked_file(p):
    # Lock ancestors against rename/reparse replacement and file against writes.
    import ctypes, ctypes.wintypes as w
    k=ctypes.WinDLL('kernel32',use_last_error=True)
    k.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,w.LPVOID,w.DWORD,w.DWORD,w.HANDLE]; k.CreateFileW.restype=w.HANDLE
    k.CloseHandle.argtypes=[w.HANDLE]; k.CloseHandle.restype=w.BOOL
    handles=[]
    def open_handle(path, access, share, flags):
        h=k.CreateFileW(str(path),access,share,None,3,flags,None)
        if h==ctypes.c_void_p(-1).value: raise ctypes.WinError(ctypes.get_last_error())
        handles.append(h); return h
    try:
        for parent in reversed(p.parents): open_handle(parent,0,3,0x02000000|0x00200000)
        no_links(p)
        h=open_handle(p,0x80000000|0x00010000,1,0x00200000)
        yield k,h
    finally:
        for h in reversed(handles): k.CloseHandle(h)

def delete_verified(p,item):
    if os.name!='nt': raise RuntimeError('Execute cleaning only supported with Windows locked-file deletion')
    import ctypes, ctypes.wintypes as w
    with windows_locked_file(p) as (k,h):
        class FILEINFO(ctypes.Structure):
            _fields_=[('attributes',w.DWORD),('created',w.FILETIME),('accessed',w.FILETIME),('modified',w.FILETIME),('volume',w.DWORD),('size_high',w.DWORD),('size_low',w.DWORD),('links',w.DWORD),('index_high',w.DWORD),('index_low',w.DWORD)]
        k.GetFileInformationByHandle.argtypes=[w.HANDLE,ctypes.POINTER(FILEINFO)]; k.GetFileInformationByHandle.restype=w.BOOL
        info=FILEINFO()
        if not k.GetFileInformationByHandle(h,ctypes.byref(info)): raise ctypes.WinError(ctypes.get_last_error())
        if info.attributes&1024: raise ValueError('Reparse file refused')
        size=(info.size_high<<32)|info.size_low
        mtime_ns=(((info.modified.dwHighDateTime<<32)|info.modified.dwLowDateTime)-116444736000000000)*100
        k.ReadFile.argtypes=[w.HANDLE,w.LPVOID,w.DWORD,ctypes.POINTER(w.DWORD),w.LPVOID]; k.ReadFile.restype=w.BOOL
        buffer=ctypes.create_string_buffer(1024*1024); read=w.DWORD(); digest=hashlib.sha256()
        while True:
            if not k.ReadFile(h,buffer,len(buffer),ctypes.byref(read),None): raise ctypes.WinError(ctypes.get_last_error())
            if not read.value: break
            digest.update(buffer.raw[:read.value])
        if {'bytes':size,'mtime_ns':mtime_ns,'sha256':digest.hexdigest()}!={x:item[x] for x in ('bytes','mtime_ns','sha256')}: raise ValueError('Current file changed; preserved')
        class DISPOSITION(ctypes.Structure): _fields_=[('DeleteFile',w.BOOL)]
        k.SetFileInformationByHandle.argtypes=[w.HANDLE,ctypes.c_int,w.LPVOID,w.DWORD]; k.SetFileInformationByHandle.restype=w.BOOL
        info=DISPOSITION(True)
        if not k.SetFileInformationByHandle(h,4,ctypes.byref(info),ctypes.sizeof(info)): raise ctypes.WinError(ctypes.get_last_error())

def clean(packed, receipt_path, execute, out):
    p,m=packed_manifest(packed); r=load(receipt_path)
    if r.get('cloud_state')!='uploaded_download_restore_verified' or r.get('download_verified') is not True or r.get('restore_verified') is not True:
        raise ValueError('Actual cloud download and new-directory restore receipt required')
    if any(r.get(k)!=p.get(k) for k in ('archive_id','archive_sha256','manifest_sha256')) or not r.get('provider_id') or not r.get('recovery_url'):
        raise ValueError('Receipt archive identity/recovery locator mismatch')
    # Check downloaded ZIP still exists and matches; a receipt flag alone cannot authorise deletion.
    downloaded=absolute(r['downloaded_archive']); no_links(downloaded)
    if sha(downloaded)!=p['archive_sha256']: raise ValueError('Downloaded archive absent/changed')
    verify_archive(downloaded,m)
    result={'archive_id':p['archive_id'],'execute':execute,'deleted':[],'eligible':[],'preserved':[],'released_bytes':0,'eligible_bytes':0,'recovery_url':r['recovery_url'],'provider_id':r['provider_id'],'checked_at':now()}
    for item in m['items']:
        try:
            source=guard(item['source'],m['scope_roots'],m.get('sandbox',False))
            if execute:
                delete_verified(source,item); result['deleted'].append(item['source']); result['released_bytes']+=item['bytes']
            else:
                if fingerprint(source)!={k:item[k] for k in ('bytes','mtime_ns','sha256')}: raise ValueError('Current file changed; preserved')
                result['eligible'].append(item['source']); result['eligible_bytes']+=item['bytes']
        except (OSError,ValueError) as ex: result['preserved'].append({'source':item['source'],'reason':str(ex)})
    write_json(pathlib.Path(out),result); return result

def main():
    parser=argparse.ArgumentParser(description=__doc__); sub=parser.add_subparsers(dest='cmd',required=True)
    q=sub.add_parser('plan'); q.add_argument('--selection',required=True); q.add_argument('--out',required=True)
    q=sub.add_parser('pack'); q.add_argument('--manifest',required=True); q.add_argument('--archive',required=True); q.add_argument('--out',required=True)
    q=sub.add_parser('receipt'); q.add_argument('--packed',required=True); q.add_argument('--download-record',required=True); q.add_argument('--restore-to',required=True); q.add_argument('--out',required=True)
    q=sub.add_parser('clean'); q.add_argument('--packed',required=True); q.add_argument('--receipt',required=True); q.add_argument('--execute',action='store_true'); q.add_argument('--out',required=True)
    a=parser.parse_args()
    if a.cmd=='plan': result=plan(a.selection,a.out)
    elif a.cmd=='pack': result=pack(a.manifest,a.archive,a.out)
    elif a.cmd=='receipt': result=receipt(a.packed,a.download_record,a.restore_to,a.out)
    else: result=clean(a.packed,a.receipt,a.execute,a.out)
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=='__main__':
    if hasattr(sys.stdout,'reconfigure'): sys.stdout.reconfigure(encoding='utf-8')
    main()

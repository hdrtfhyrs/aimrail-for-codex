"""Explicit cloud archive lifecycle. No directory deletion or credential transport."""
import pathlib as _public_pathlib
import importlib.util as _public_importutil
_public_root = next(p for p in _public_pathlib.Path(__file__).resolve().parents if (p/'public_paths.py').is_file())
_public_spec = _public_importutil.spec_from_file_location('ai_work_public_paths', _public_root/'public_paths.py')
_public_module = _public_importutil.module_from_spec(_public_spec)
_public_spec.loader.exec_module(_public_module)
_public_path = _public_module.public_path
import argparse, contextlib, datetime, hashlib, importlib.util, json, os, pathlib, sys, zipfile
sys.dont_write_bytecode = True
BASE = pathlib.Path(__file__).resolve().parent
PROJECT = BASE.parents[1]
STATE = pathlib.Path(_public_path('$data/system/本地统一/文件归档/存储接入/冷归档.json'))
REVIEWED = pathlib.Path(_public_path('$data/system/本地统一/文件归档/reviewed'))
PYTHON = pathlib.Path(_public_path('$runtime/python/python.exe'))
spec = importlib.util.spec_from_file_location('existing_cold_archive', PROJECT / '存储接入/cold_archive.py')
sys.path.insert(0, str(PROJECT / '存储接入'))
ca = importlib.util.module_from_spec(spec); spec.loader.exec_module(ca)
# Capture identity/allocation on the SAME locked handle used by the existing
# verified deletion. No mutation of the shared cold_archive.py source.
_original_windows_lock=ca.windows_locked_file
_locked_observations={}
_expected_locked_identities={}
@contextlib.contextmanager
def accounting_windows_lock(p):
    import ctypes, ctypes.wintypes as w
    with _original_windows_lock(p) as (k,h):
        class Info(ctypes.Structure):
            _fields_=[('attributes',w.DWORD),('created',w.FILETIME),('accessed',w.FILETIME),('modified',w.FILETIME),('volume',w.DWORD),('size_high',w.DWORD),('size_low',w.DWORD),('links',w.DWORD),('index_high',w.DWORD),('index_low',w.DWORD)]
        i=Info();k.GetFileInformationByHandle.argtypes=[w.HANDLE,ctypes.POINTER(Info)];k.GetFileInformationByHandle.restype=w.BOOL
        if not k.GetFileInformationByHandle(h,ctypes.byref(i)):raise ctypes.WinError(ctypes.get_last_error())
        class Standard(ctypes.Structure):
            _fields_=[('allocation',ctypes.c_longlong),('end',ctypes.c_longlong),('links',w.DWORD),('delete_pending',ctypes.c_ubyte),('directory',ctypes.c_ubyte)]
        standard=Standard();k.GetFileInformationByHandleEx.argtypes=[w.HANDLE,ctypes.c_int,w.LPVOID,w.DWORD];k.GetFileInformationByHandleEx.restype=w.BOOL
        allocated=standard.allocation if k.GetFileInformationByHandleEx(h,1,ctypes.byref(standard),ctypes.sizeof(standard)) else None
        _locked_observations[os.path.normcase(str(p))]={'file_identity':f'{i.volume}:{i.index_high}:{i.index_low}','links_before':i.links,'allocation_bytes':allocated,'data_bytes':(i.size_high<<32)|i.size_low}
        expected=_expected_locked_identities.get(os.path.normcase(str(p)))
        if expected and expected!=_locked_observations[os.path.normcase(str(p))]['file_identity']:raise ValueError('File identity changed after selection; preserved')
        yield k,h
ca.windows_locked_file=accounting_windows_lock
# Configure exact archive scope before any operation; no personal cleanup list ships.
PROTECTED = [pathlib.Path(p) for p in json.loads(os.environ.get('AI_ARCHIVE_PROTECTED_ROOTS', '[]'))]
ALLOWED = [pathlib.Path(p) for p in json.loads(os.environ.get('AI_ARCHIVE_ALLOWED_ROOTS', '[]'))]
EXACT_COLD_FILE=BASE/'unconfigured-cold-file'
EXACT_INSTALLERS=[]
EXACT_FINISHED_SCAN=BASE/'unconfigured-scan'
PROGRAM_LEAF_LIST=BASE/'reviewed-program-files.json'
_program_leaf_keys=None
def exact_program_file(p):
    global _program_leaf_keys
    if _program_leaf_keys is None:
        _program_leaf_keys=set()
        if PROGRAM_LEAF_LIST.exists():
            ca.no_links(PROGRAM_LEAF_LIST);record=json.loads(PROGRAM_LEAF_LIST.read_text(encoding='utf-8-sig'))
            if record.get('format')!='reviewed-exact-program-leaves-v1':raise ValueError('Unknown exact program leaf registry')
            _program_leaf_keys={os.path.normcase(str(ca.absolute(f))) for f in record['files']}
    return os.path.normcase(str(p)) in _program_leaf_keys
def now(): return datetime.datetime.now().astimezone().isoformat()
def load(p): return json.loads(pathlib.Path(p).read_text(encoding='utf-8-sig'))
def save(p,v):
    p=pathlib.Path(p); p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps(v,ensure_ascii=False,indent=2),encoding='utf-8')
def guard(p):
    p=ca.absolute(p); ca.no_links(p)
    if (p not in [EXACT_COLD_FILE,EXACT_FINISHED_SCAN] and p not in EXACT_INSTALLERS and not any(ca.inside(p,r) and p!=r for r in ALLOWED) and not exact_program_file(p)) or any(ca.inside(p,r) for r in PROTECTED): raise ValueError('Outside archive scope/protected parallel task')
    if not p.is_file(): raise ValueError('Regular files only')
    return p
def scan(roots):
    result=[]
    for root in roots:
        r=ca.absolute(root)
        if not r.exists(): result.append({'root':str(r),'files':0,'bytes':0,'exists':False});continue
        ca.no_links(r); files=[]; skips=[]
        for base,dirs,names in os.walk(r,followlinks=False):
            dirs[:]=[d for d in dirs if not pathlib.Path(base,d).is_symlink() and not pathlib.Path(base,d).is_junction()]
            for name in names:
                p=pathlib.Path(base,name)
                try: ca.no_links(p); s=p.stat(); files.append({'path':str(p),'bytes':s.st_size,'mtime_ns':s.st_mtime_ns})
                except OSError as e: skips.append({'path':str(p),'error':str(e)})
        result.append({'root':str(r),'files':len(files),'bytes':sum(f['bytes'] for f in files),'largest':sorted(files,key=lambda f:f['bytes'],reverse=True)[:20],'skipped':skips})
    return {'scanned_at':now(),'purpose':'Size inventory only; usefulness requires source/owner evidence','roots':result}
def pack(selection,archive,out):
    s=load(selection); items=[]
    for n,row in enumerate(s['items']):
        p=guard(row['source'])
        if not row.get('reason') or not row.get('reference_state'): raise ValueError('Purpose/reference evidence required')
        items.append({**row,'source':str(p),'path':f'files/{n:06d}/{p.name}',**ca.fingerprint(p)})
    m={'format':'ai-system-lifecycle-v1','archive_id':pathlib.Path(archive).stem,'created_at':now(),'items':items,'restore_policy':'Restore into a new directory; original paths are mapping only'}
    archive=ca.absolute(archive); ca.no_links(archive.parent)
    with zipfile.ZipFile(archive,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        z.writestr('manifest.json',json.dumps(m,ensure_ascii=False,indent=2))
        for i in items:
            p=guard(i['source'])
            if ca.fingerprint(p)!={k:i[k] for k in ('bytes','mtime_ns','sha256')}: raise ValueError('Source changed before pack')
            z.write(p,i['path'])
    ca.verify_archive(archive,m)
    r={'archive_id':m['archive_id'],'archive':str(archive),'archive_sha256':ca.sha(archive),'archive_bytes':archive.stat().st_size,'manifest':m,'source_bytes':sum(i['bytes'] for i in items),'files':len(items)}
    save(out,r); return {k:v for k,v in r.items() if k!='manifest'}
def verify(packed,transport,restore,out):
    p=load(packed); t=load(transport); a=ca.absolute(t['downloaded_archive']); ca.no_links(a)
    if a==pathlib.Path(p['archive']) or ca.sha(a)!=p['archive_sha256']: raise ValueError('Separate actual cloud download must match')
    if t['provider_id']!=t['downloaded_from_provider_id'] or not t['recovery_url'].startswith('https://drive.google.com/file/d/') or not t.get('metadata_verified_at'): raise ValueError('Cloud transport provenance missing')
    ca.verify_archive(a,p['manifest']); r=ca.absolute(restore)
    if r.exists(): raise ValueError('Use a new restore directory')
    ca.no_links(r.parent); r.mkdir()
    with zipfile.ZipFile(a) as z:
        for i in p['manifest']['items']:
            d=r/i['path']; d.parent.mkdir(parents=True,exist_ok=True)
            with z.open(i['path']) as src,d.open('xb') as dst:
                while b:=src.read(1024*1024): dst.write(b)
            if ca.sha(d)!=i['sha256']: raise ValueError('Restored content mismatch')
    receipt={**{k:v for k,v in p.items() if k!='manifest'},**t,'restore_verified':True,'restored_to':str(r),'verified_at':now(),'manifest':p['manifest']}
    save(out,receipt); return {k:v for k,v in receipt.items() if k!='manifest'}
def register(receipt):
    r=load(receipt)
    if r.get('restore_verified') is not True: raise ValueError('Actual restore receipt required')
    idx=load(STATE); rows=idx.setdefault('lifecycle_batches',[])
    row={'archive_id':r['archive_id'],'receipt':str(ca.absolute(receipt)),'provider_id':r['provider_id'],'cloud_url':r['recovery_url'],'files':r['files'],'source_bytes':r['source_bytes'],'archive_bytes':r['archive_bytes'],'verified_at':r['verified_at']}
    rows[:]=[x for x in rows if x['archive_id']!=r['archive_id']]; rows.append(row); save(STATE,idx); return row
def queue(selection,out):
    out=ca.absolute(out)
    if out.parent!=REVIEWED or out.suffix!='.json' or out.exists(): raise ValueError('Create a new exact list in lifecycle/reviewed')
    s=load(selection);items=[]
    for row in s['items']:
        p=guard(row['source'])
        if not row.get('reason') or row.get('mode') not in ('cloud-verified','disposable'): raise ValueError('Each selected file needs purpose and mode')
        if row['mode']=='disposable' and not row.get('disposal_evidence'): raise ValueError('Disposable files need explicit evidence')
        if row['mode']=='cloud-verified' and (not row.get('proof') or not row.get('cloud_member')):raise ValueError('Cloud-verified files need receipt and member mapping')
        st=p.stat()
        items.append({**row,'source':str(p),**ca.fingerprint(p),'selected_file_identity':f'{st.st_dev}:{st.st_ino}','selected_link_count':st.st_nlink})
    save(out,{'basis':s['basis'],'queued_at':now(),'items':items});return {'input':str(out),'files':len(items),'bytes':sum(i['bytes'] for i in items)}
def locate(query,offset=0,limit=20):
    idx=load(STATE);matches=[];q=query.replace('\\','/').lower()
    for row in idx.get('packs',[])+idx.get('lifecycle_batches',[])+idx.get('local_copy_cleanup',{}).get('cloud_only_snapshots',[]):
        receipt=load(row['receipt']) if row.get('receipt') else load(row['recovery_mapping'])
        m=receipt.get('manifest')
        if isinstance(m,str):m=load(m)
        if not m and row.get('manifest'):m=load(row['manifest'])
        for i in (m or {}).get('items',[]):
            if q in json.dumps(i,ensure_ascii=False).replace('\\\\','/').lower():matches.append({'source':i.get('source'),'cloud_url':row['cloud_url'],'provider_id':row['provider_id'],'cloud_member':i['path'],'bytes':i['bytes'],'receipt':row.get('receipt') or row.get('recovery_mapping'),'restore':'Download raw ZIP and restore member into a new directory'})
        if row.get('inner_original_mapping'):
            for i in load(row['inner_original_mapping']):
                for original in i['original_paths']:
                    if q in original.replace('\\','/').lower():matches.append({'source':original,'cloud_url':row['cloud_url'],'provider_id':row['provider_id'],'outer_original_source':i['file'],'restore':'Restore the mapped gzip member, then decode its entries into a new directory; never overwrite live files automatically'})
    return {'query':query,'total':len(matches),'offset':offset,'entries':matches[offset:offset+limit]}
def clean(input_path,execute):
    ip=ca.absolute(input_path); ca.no_links(ip)
    if ip.parent!=REVIEWED or ip.suffix!='.json': raise ValueError('Only the reviewed exact file list in lifecycle/reviewed is accepted')
    batch=load(ip)
    if not batch.get('basis') or not batch.get('items'): raise ValueError('Evidence-backed exact items required')
    result={'input':str(ip),'basis':batch['basis'],'execute':execute,'checked_at':now(),'deleted':[],'preserved':[],'eligible':[],'released_bytes':0,'unique_selected_data_bytes_removed':0,'estimated_physical_allocated_bytes_released':0,'last_link_removed_files':0,'external_or_remaining_link_paths':[]}
    seen=set();proofs={};removed_identities=set();last_link_identities=set()
    for i in batch['items']:
        try:
            p=guard(i['source']); key=os.path.normcase(str(p))
            if key in seen: raise ValueError('Duplicate path');
            seen.add(key)
            if i.get('mode') not in ('cloud-verified','disposable') or not i.get('reason'): raise ValueError('Purpose evidence missing')
            if i['mode']=='cloud-verified':
                proof=proofs.setdefault(i['proof'],load(i['proof'])) if i['proof'] not in proofs else proofs[i['proof']]
                if proof.get('restore_verified') is not True or not proof.get('provider_id') or not proof.get('recovery_url') or not proof.get('current_cloud_metadata'): raise ValueError('Actual restoration/current cloud metadata required')
                if proof['current_cloud_metadata'].get('id')!=proof['provider_id'] or proof['current_cloud_metadata'].get('mime_type')!='application/zip':raise ValueError('Cloud metadata identity/type mismatch')
                # Expected content must be bound to the remotely recoverable member or ZIP.
                expected=proof.get('manifest',{}).get('items',[])
                if not any(x['sha256']==i['sha256'] and x['bytes']==i['bytes'] and x.get('path')==i.get('cloud_member') for x in expected) and not (i.get('cloud_member')=='__archive__' and proof.get('archive_sha256')==i['sha256']): raise ValueError('File not mapped to verified cloud content')
            elif not i.get('disposal_evidence'): raise ValueError('Explicit disposal basis required')
            if execute:
                if i.get('selected_file_identity'):
                    dev,ino=map(int,i['selected_file_identity'].split(':'))
                    _expected_locked_identities[key]=f'{dev & 0xffffffff}:{ino >> 32}:{ino & 0xffffffff}'
                ca.delete_verified(p,i)
                if p.exists(): raise OSError('Delete request completed but the path is still present; not counted as released')
                observation=_locked_observations.get(key,{})
                last_link=observation.get('links_before')==1
                result['deleted'].append({'source':str(p),'bytes':i['bytes'],'mode':i['mode'],**observation,'last_link_removed':last_link}); result['released_bytes']+=i['bytes']
                identity=observation.get('file_identity')
                if identity and identity not in removed_identities:result['unique_selected_data_bytes_removed']+=i['bytes'];removed_identities.add(identity)
                if last_link:
                    result['last_link_removed_files']+=1
                    if identity:last_link_identities.add(identity)
                    if observation.get('allocation_bytes') is not None:result['estimated_physical_allocated_bytes_released']+=observation['allocation_bytes']
                else:result['external_or_remaining_link_paths'].append({'source':str(p),**observation})
            else:
                if ca.fingerprint(p)!={k:i[k] for k in ('bytes','mtime_ns','sha256')}: raise ValueError('Changed file preserved')
                result['eligible'].append({'source':str(p),'bytes':i['bytes']})
        except (OSError,ValueError) as e: result['preserved'].append({'source':i.get('source'),'reason':str(e)})
    result['external_link_groups_remaining']=list({row['file_identity']:row for row in result['external_or_remaining_link_paths'] if row.get('file_identity') not in last_link_identities}.values())
    save(ip.with_suffix('.clean.json') if execute else ip.with_suffix('.preview.json'),result)
    return {**{k:v for k,v in result.items() if k not in ('deleted','eligible','external_or_remaining_link_paths','external_link_groups_remaining')},'deleted_count':len(result['deleted']),'eligible_count':len(result['eligible']),'external_link_group_count':len(result['external_link_groups_remaining'])}
def main():
    q=argparse.ArgumentParser(description=__doc__); s=q.add_subparsers(dest='cmd',required=True)
    p=s.add_parser('scan'); p.add_argument('--roots',nargs='+',required=True); p.add_argument('--out',required=True)
    p=s.add_parser('pack'); p.add_argument('--selection',required=True);p.add_argument('--archive',required=True);p.add_argument('--out',required=True)
    p=s.add_parser('verify');p.add_argument('--packed',required=True);p.add_argument('--transport',required=True);p.add_argument('--restore',required=True);p.add_argument('--out',required=True)
    p=s.add_parser('register');p.add_argument('--receipt',required=True)
    p=s.add_parser('queue');p.add_argument('--selection',required=True);p.add_argument('--out',required=True)
    p=s.add_parser('locate');p.add_argument('--query',required=True);p.add_argument('--offset',type=int,default=0);p.add_argument('--limit',type=int,default=20)
    p=s.add_parser('verified-clean');p.add_argument('--input',required=True);p.add_argument('--execute',action='store_true')
    a=q.parse_args()
    if a.cmd=='scan': r=scan(a.roots);save(a.out,r)
    elif a.cmd=='pack':r=pack(a.selection,a.archive,a.out)
    elif a.cmd=='verify':r=verify(a.packed,a.transport,a.restore,a.out)
    elif a.cmd=='register':r=register(a.receipt)
    elif a.cmd=='queue':r=queue(a.selection,a.out)
    elif a.cmd=='locate':r=locate(a.query,a.offset,a.limit)
    else:r=clean(a.input,a.execute)
    print(json.dumps(r,ensure_ascii=False,indent=2))
if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8');main()

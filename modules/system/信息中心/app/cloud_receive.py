"""Consume downloaded Codex Cloud data packets without executing their contents."""
import pathlib as _public_pathlib
import importlib.util as _public_importutil
_public_root = next(p for p in _public_pathlib.Path(__file__).resolve().parents if (p/'public_paths.py').is_file())
_public_spec = _public_importutil.spec_from_file_location('ai_work_public_paths', _public_root/'public_paths.py')
_public_module = _public_importutil.module_from_spec(_public_spec)
_public_spec.loader.exec_module(_public_module)
_public_path = _public_module.public_path
from pathlib import Path

from common import DATA, connect, ensure_dirs, now_iso, settings, state_get, state_set
from cloud_sync import import_batch


def receive_available():
    ensure_dirs()
    inbox = DATA / 'cloud-incoming'
    inbox.mkdir(exist_ok=True)
    results = []
    for path in sorted(inbox.iterdir()):
        if not ((path.is_file() and path.suffix.lower() == '.zip') or (path.is_dir() and (path/'manifest.json').is_file())):
            continue
        marker = 'cloud_receive_file:' + path.name
        stamp = path.stat().st_mtime_ns
        with connect() as db:
            previous = state_get(db, marker)
        if previous and previous.get('mtime_ns') == stamp and previous.get('status') == 'success':
            continue
        outcome = import_batch(path)
        results.append(outcome)
        with connect() as db:
            state_set(db, marker, {'mtime_ns':stamp,'status':outcome['status'],'received_at':now_iso(),'result':outcome})
    cloud = settings().get('cloud', {})
    remote_ready = bool(cloud.get('remote_automatic_download_ready'))
    note = '本机接收器处理已落盘批次；云端采集和自动下载状态见实测记录。'
    if cloud.get('trial_verified') and not remote_ready:
        note = '云端真实试采与本次入库已验证；远程自动下载尚未接通。'
    with connect() as db:
        state_set(db, 'cloud_receive_status', {'checked_at':now_iso(),'results':results,
            'download_transport':'configured_automatic_download' if remote_ready else 'automatic_download_not_connected',
            'environment_id':cloud.get('environment_id'),
            'cloud_trial_verified':bool(cloud.get('trial_verified')), 'note':note})
    return {'batches_checked':len(results),'items_new':sum(result.get('items_new',0) for result in results),
            'errors':[result for result in results if result['status']!='success'], 'results':results}

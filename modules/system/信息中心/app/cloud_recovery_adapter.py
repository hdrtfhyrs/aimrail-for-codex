"""Central binding to the owned durable Cloud recovery module; no new scheduler."""
import pathlib as _public_pathlib
import importlib.util as _public_importutil
_public_root = next(p for p in _public_pathlib.Path(__file__).resolve().parents if (p/'public_paths.py').is_file())
_public_spec = _public_importutil.spec_from_file_location('ai_work_public_paths', _public_root/'public_paths.py')
_public_module = _public_importutil.module_from_spec(_public_spec)
_public_spec.loader.exec_module(_public_module)
_public_path = _public_module.public_path
import importlib.util
from functools import lru_cache
from common import ROOT

@lru_cache(maxsize=1)
def recovery_class():
    source=ROOT/'接续接入/cloud-recovery.py'
    spec=importlib.util.spec_from_file_location('ai_system_cloud_recovery',source)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Recovery

def offer_download(index,bundle):
    return recovery_class()().offer(index,bundle=bundle,source='production_cloud_download')

def recover_under_pipeline_lock():
    # run_pipeline owns common.job_lock; avoid recursively acquiring it.
    return recovery_class()().recover_locked()

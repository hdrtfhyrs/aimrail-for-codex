"""Task Scheduler entry point. All spawned work stays hidden and in this installation."""
from __future__ import annotations
import pathlib as _public_pathlib
import importlib.util as _public_importutil
_public_root = next(p for p in _public_pathlib.Path(__file__).resolve().parents if (p/'public_paths.py').is_file())
_public_spec = _public_importutil.spec_from_file_location('ai_work_public_paths', _public_root/'public_paths.py')
_public_module = _public_importutil.module_from_spec(_public_spec)
_public_spec.loader.exec_module(_public_module)
_public_path = _public_module.public_path

import json
import os
import argparse
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
LOGS = Path(_public_path("$data/system/信息中心/logs"))
LOGS.mkdir(parents=True, exist_ok=True)


def _alive(pid):
    if not isinstance(pid, int):
        return False
    if os.name == 'nt':
        import ctypes
        kernel = ctypes.windll.kernel32
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.GetExitCodeProcess.argtypes = (ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong))
        kernel.CloseHandle.argtypes = (ctypes.c_void_p,)
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def reconcile_last_scheduled():
    """Recover pipeline facts from a flushed log, without inventing a wrapper exit."""
    from common import atomic_text, now_iso
    receipt_path = LOGS / 'last-scheduled.json'
    try:
        previous = json.loads(receipt_path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        previous = {}
    if previous.get('state') == 'running' and _alive(previous.get('pid')):
        return previous
    logs = sorted((LOGS / 'scheduled').glob('*.log'), key=lambda path: path.name)
    if not logs:
        return previous
    latest = logs[-1]
    if previous.get('log') == str(latest) and (previous.get('state') == 'completed' or
            previous.get('state') == 'recovered_from_log' and previous.get('pipeline_status') != 'unknown'):
        return previous
    try:
        pipeline = json.loads(latest.read_text(encoding='utf-8'))
        pipeline_status = pipeline['status']
    except (OSError, ValueError, KeyError, TypeError):
        if previous.get('state') != 'running':
            return previous
        pipeline_status = 'unknown'
        pipeline = {}
    recovered = {'state': 'recovered_from_log', 'started_at': pipeline.get('started_at', previous.get('started_at')),
                 'run_at': pipeline.get('ended_at'), 'reconciled_at': now_iso(), 'exit_code': None,
                 'pipeline_status': pipeline_status, 'log': str(latest),
                 'wrapper_completion': 'unobserved', 'reason': '入口未留下最终回执；从已落盘日志恢复流水线结果，入口退出仍以系统任务记录为准。'}
    atomic_text(receipt_path, json.dumps(recovered, ensure_ascii=False, indent=2))
    return recovered


def main():
    from common import atomic_text, now_iso
    parser = argparse.ArgumentParser()
    parser.add_argument('--reconcile-only', action='store_true')
    args = parser.parse_args()
    reconcile_last_scheduled()
    if args.reconcile_only:
        print(json.dumps(reconcile_last_scheduled(), ensure_ascii=False, indent=2))
        return 0
    directory = LOGS / "scheduled"
    directory.mkdir(exist_ok=True)
    label = now_iso().replace(":", "-").replace("+", "_")
    environment = os.environ.copy()
    environment["PYTHONIOENCODING"] = "utf-8"
    log = directory / f"{label}.log"
    started_at = now_iso()
    receipt_path = LOGS / 'last-scheduled.json'
    atomic_text(receipt_path, json.dumps({'state': 'running', 'pid': os.getpid(), 'started_at': started_at,
                'exit_code': None, 'pipeline_status': 'running', 'log': str(log)}, ensure_ascii=False, indent=2))
    try:
        with log.open("w", encoding="utf-8") as output:
            process = subprocess.run([sys.executable, str(ROOT / "app" / "main.py"), "run"],
                cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, env=environment,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), timeout=9600)
        exit_code = process.returncode
        try:
            pipeline_status = json.loads(log.read_text(encoding="utf-8")).get("status", "unknown")
        except (ValueError, AttributeError):
            pipeline_status = "unknown"
        result = {"state": "completed", "started_at": started_at, "run_at": now_iso(), "exit_code": exit_code,
                  "pipeline_status": pipeline_status, "log": str(log)}
    except (subprocess.TimeoutExpired, OSError) as error:
        exit_code = 1
        result = {"state": "completed", "started_at": started_at, "run_at": now_iso(), "exit_code": exit_code,
                  "pipeline_status": "error", "error": str(error), "log": str(log)}
    except KeyboardInterrupt:
        exit_code = 1
        result = {'state': 'interrupted', 'started_at': started_at, 'run_at': now_iso(), 'exit_code': exit_code,
                  'pipeline_status': 'unknown', 'log': str(log), 'error': '入口收到中断；原流水线日志保留。'}
    atomic_text(receipt_path, json.dumps(result, ensure_ascii=False, indent=2))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())

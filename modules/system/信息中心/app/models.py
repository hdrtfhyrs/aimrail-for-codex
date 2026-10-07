from __future__ import annotations
import pathlib as _public_pathlib
import importlib.util as _public_importutil
_public_root = next(p for p in _public_pathlib.Path(__file__).resolve().parents if (p/'public_paths.py').is_file())
_public_spec = _public_importutil.spec_from_file_location('ai_work_public_paths', _public_root/'public_paths.py')
_public_module = _public_importutil.module_from_spec(_public_spec)
_public_spec.loader.exec_module(_public_module)
_public_path = _public_module.public_path

import argparse
import datetime as dt
import json
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time
import tomllib

from common import DATA, ROOT, atomic_text, connect, ensure_dirs, now_iso, settings, stable_id, state_get, state_set

CODEX_ROOT = Path(_public_path("$data/integrations"))
ROLE_FILES = {"default": CODEX_ROOT / "config.toml", **{
    role: CODEX_ROOT / "agents" / f"{role}.toml" for role in
    ("module_builder", "knowledge_writer", "architect", "proposal_reviewer", "implementation_worker")
}}


def active_models() -> dict:
    output = {}
    for role, path in ROLE_FILES.items():
        raw = tomllib.loads(path.read_text(encoding="utf-8-sig"))
        output[role] = {"model": raw.get("model"), "effort": raw.get("model_reasoning_effort"), "path": str(path)}
    return output


def fetch_catalog(timeout=50) -> dict:
    ensure_dirs()
    config = settings()
    binary = Path(config["codex_path"])
    if not binary.exists():
        # App upgrades rotate the binary directory, while the stable installed parent survives.
        candidates = sorted(binary.parents[1].glob("*/codex.exe"), key=lambda path: path.stat().st_mtime, reverse=True)
        if not candidates:
            raise FileNotFoundError("本机 Codex 程序路径已变化，需要重新定位。")
        binary = candidates[0]
    logfile = DATA / "model-catalog-stderr.log"
    messages = queue.Queue()
    started = time.monotonic()
    with logfile.open("w", encoding="utf-8") as error_stream:
        process = subprocess.Popen([str(binary), "app-server", "--listen", "stdio://"], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=error_stream, text=True, encoding="utf-8",
            cwd=str(ROOT), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        def pump():
            for line in process.stdout:
                try:
                    messages.put(json.loads(line))
                except json.JSONDecodeError:
                    continue
        threading.Thread(target=pump, daemon=True).start()
        def send(value):
            process.stdin.write(json.dumps(value) + "\n")
            process.stdin.flush()
        def receive(identity):
            while time.monotonic() - started < timeout:
                try:
                    message = messages.get(timeout=min(2, max(.1, timeout-(time.monotonic()-started))))
                except queue.Empty:
                    if process.poll() is not None:
                        raise RuntimeError("Codex 模型目录连接提前退出。")
                    continue
                if message.get("id") == identity:
                    if "error" in message:
                        raise RuntimeError(str(message["error"]))
                    return message.get("result", {})
            raise TimeoutError("查询本账号可用模型目录超时；保留当前模型。")
        try:
            send({"method": "initialize", "id": 1, "params": {"clientInfo": {"name": "local_information_center", "title": "Local Information Center", "version": "1.0.0"}}})
            receive(1)
            send({"method": "initialized", "params": {}})
            data, cursor, identity = [], None, 2
            while True:
                parameters = {"limit": 100, "includeHidden": False}
                if cursor:
                    parameters["cursor"] = cursor
                send({"method": "model/list", "id": identity, "params": parameters})
                result = receive(identity)
                data.extend(result.get("data", []))
                cursor = result.get("nextCursor")
                identity += 1
                if not cursor:
                    break
            if not data:
                raise RuntimeError("模型目录返回空内容，不能据此切换模型。")
            return {"queried_at": now_iso(), "source": "Codex app-server model/list", "models": data}
        finally:
            try:
                process.stdin.close()
            except OSError:
                pass
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def family(model: str) -> str:
    match = re.fullmatch(r"gpt-\d+(?:\.\d+)?-(sol|luna|astra)", model or "")
    return match.group(1) if match else ""


def upgrade_candidates(catalog, active):
    by_model = {entry.get("model") or entry.get("id"): entry for entry in catalog.get("models", [])}
    candidates = []
    for role, current in active.items():
        entry = by_model.get(current["model"], {})
        upgrade = entry.get("upgrade")
        target = upgrade.get("model") or upgrade.get("id") if isinstance(upgrade, dict) else upgrade
        if target and target != current["model"] and target in by_model and family(target) == family(current["model"]):
            candidates.append({"role": role, "current": current["model"], "target": target,
                               "source": "official_catalog_upgrade", "status": "needs_task_comparison"})
    return candidates


def catalog_status(refresh=False):
    with connect() as db:
        catalog = state_get(db, "model_catalog", {})
        if refresh or not catalog:
            try:
                catalog = fetch_catalog()
                state_set(db, "model_catalog", catalog)
                state_set(db, "model_catalog_error", None)
                atomic_text(DATA / "model-catalog.json", json.dumps(catalog, ensure_ascii=False, indent=2))
            except Exception as error:
                state_set(db, "model_catalog_error", {"at": now_iso(), "error": str(error)})
        active = active_models()
        output = {"active": active, "catalog_queried_at": catalog.get("queried_at"),
                  "available_models": [entry.get("model") or entry.get("id") for entry in catalog.get("models", [])],
                  "upgrade_candidates": upgrade_candidates(catalog, active),
                  "catalog_error": state_get(db, "model_catalog_error")}
        state_set(db, "model_status", output)
        return output


def _rewrite_model(original: str, target: str, effort: str | None):
    updated, count = re.subn(r'^model\s*=\s*"[^"\r\n]+"\s*$', f'model = "{target}"', original, count=1, flags=re.MULTILINE)
    if count != 1:
        raise ValueError("未找到唯一活动模型配置，不执行替换。")
    if effort:
        updated, effort_count = re.subn(r'^model_reasoning_effort\s*=\s*"[^"\r\n]+"\s*$',
            f'model_reasoning_effort = "{effort}"', updated, count=1, flags=re.MULTILINE)
        if effort_count != 1:
            raise ValueError("未找到唯一活动推理档位，不执行替换。")
    tomllib.loads(updated.lstrip("\ufeff"))
    return updated


def apply_upgrade(role: str, target: str, evidence_path: str):
    if role not in ROLE_FILES:
        raise ValueError("未知角色。")
    active = active_models()[role]
    if active["model"] == target:
        return {"status": "already_applied", "role": role, "model": target}
    if not family(target) or family(target) != family(active["model"]):
        raise ValueError("此适配器处理同一模型档位的升级；跨厂商或跨角色变化须按具体任务形成迁移成果。")
    evidence_file = Path(evidence_path).resolve()
    allowed = [DATA.resolve(), Path(_public_path("$data/system/信息中心/work")).resolve()]
    if not any(evidence_file.is_relative_to(base) for base in allowed):
        raise ValueError("比较证据必须保存在本任务的资料或工作目录。")
    evidence = json.loads(evidence_file.read_text(encoding="utf-8"))
    if evidence.get("role") != role or evidence.get("baseline_model") != active["model"] or evidence.get("target_model") != target:
        raise ValueError("比较证据与实际角色、当前模型或候选不对应。")
    tests = evidence.get("tests", [])
    if not tests or not all(test.get("target_success") for test in tests):
        raise ValueError("实际任务尚有失败，不自动替换默认。")
    for test in tests:
        paths = [test.get("baseline_artifact"), test.get("target_artifact")]
        if not all(path and Path(path).is_file() for path in paths):
            raise ValueError("比较缺少实际产物。")
    if evidence.get("quality_improved") is not True or evidence.get("tools_compatible") is not True:
        raise ValueError("比较尚未证明质量改善或所需工具兼容。")
    if not evidence.get("source_urls") or not evidence.get("evaluation_summary"):
        raise ValueError("比较缺少官方依据或具体结果。")
    status = catalog_status(refresh=True)
    if status.get("catalog_error") or target not in status["available_models"]:
        raise ValueError("本账号模型目录未确认候选可用，继续保留当前配置。")
    with connect() as db:
        catalog = state_get(db, "model_catalog")
    candidate = next(entry for entry in catalog["models"] if (entry.get("model") or entry.get("id")) == target)
    supported = [entry["reasoningEffort"] for entry in candidate.get("supportedReasoningEfforts", [])]
    effort = evidence.get("target_effort") or active["effort"]
    if effort not in supported:
        raise ValueError("候选不支持比较时指定的推理档位。")
    path = ROLE_FILES[role]
    original = path.read_text(encoding="utf-8-sig")
    replacement = _rewrite_model(original, target, effort)
    identity = stable_id(role, active["model"], target, now_iso())
    folder = DATA / "backups" / f"model-upgrade-{identity}"
    folder.mkdir(parents=True, exist_ok=False)
    atomic_text(folder / "original.toml", original)
    manifest = {"role": role, "path": str(path), "old_model": active["model"], "old_effort": active["effort"],
                "new_model": target, "new_effort": effort, "evidence_path": str(evidence_file), "applied_at": now_iso()}
    atomic_text(folder / "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    atomic_text(path, replacement)
    # Reflect the active configuration in the collector's profile without modifying unrelated roles.
    config = settings()
    config["user_profile"]["current_models"][role] = target
    if role == "implementation_worker" and config["triage_model"] == active["model"]:
        config["triage_model"] = target
    if role in ("default", "module_builder") and config["research_model"] == active["model"]:
        config["research_model"] = target
    atomic_text(Path(_public_path("$data/system/信息中心/config/settings.json")), json.dumps(config, ensure_ascii=False, indent=2))
    with connect() as db:
        state_set(db, "last_model_upgrade", manifest | {"backup": str(folder)})
    return {"status": "applied", **manifest, "backup": str(folder)}


def restore_upgrade(backup_path: str):
    folder = Path(backup_path).resolve()
    if not folder.is_relative_to((DATA / "backups").resolve()):
        raise ValueError("恢复目录不在本系统保存的模型备份中。")
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    role = manifest["role"]
    if role not in ROLE_FILES or Path(manifest["path"]).resolve() != ROLE_FILES[role].resolve():
        raise ValueError("备份目标与实际角色不对应。")
    path = ROLE_FILES[role]
    current = active_models()[role]
    if current["model"] != manifest["new_model"]:
        raise ValueError("模型已被其他工作调整，不覆盖新的配置。")
    replacement = _rewrite_model(path.read_text(encoding="utf-8-sig"), manifest["old_model"], manifest["old_effort"])
    atomic_text(path, replacement)
    config = settings()
    config["user_profile"]["current_models"][role] = manifest["old_model"]
    for key in ("triage_model", "research_model"):
        if config[key] == manifest["new_model"]:
            config[key] = manifest["old_model"]
    atomic_text(Path(_public_path("$data/system/信息中心/config/settings.json")), json.dumps(config, ensure_ascii=False, indent=2))
    return {"status": "restored", "role": role, "model": manifest["old_model"]}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("catalog")
    apply = sub.add_parser("apply")
    apply.add_argument("--role", required=True, choices=list(ROLE_FILES))
    apply.add_argument("--target", required=True)
    apply.add_argument("--evidence", required=True)
    restore = sub.add_parser("restore")
    restore.add_argument("backup")
    args = parser.parse_args()
    try:
        if args.command == "catalog":
            result = catalog_status(refresh=True)
        elif args.command == "apply":
            result = apply_upgrade(args.role, args.target, args.evidence)
        else:
            result = restore_upgrade(args.backup)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as error:
        print(json.dumps({"status": "error", "error": str(error)}, ensure_ascii=False))
        raise SystemExit(1)

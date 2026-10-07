"""Fetch Cloud batch data with Git; validate it before spooling for cloud_receive.

The dedicated bare cache has no checkout. Every attempt must successfully fetch
the fixed remote branch; all reads are then pinned to that fetched commit.
No model, remote code, hooks, extraction, or import is invoked here.
"""
from __future__ import annotations
import pathlib as _public_pathlib
import importlib.util as _public_importutil
_public_root = next(p for p in _public_pathlib.Path(__file__).resolve().parents if (p/'public_paths.py').is_file())
_public_spec = _public_importutil.spec_from_file_location('ai_work_public_paths', _public_root/'public_paths.py')
_public_module = _public_importutil.module_from_spec(_public_spec)
_public_spec.loader.exec_module(_public_module)
_public_path = _public_module.public_path

import base64
from contextlib import closing, contextmanager
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import zipfile

from common import DATA, atomic_text, connect, ensure_dirs, now_iso, settings, state_get, state_set

DEFAULT_REPOSITORY = "hdrtfhyrs/demo1"
DEFAULT_BRANCH = "codex/information-center-cloud-data"
INDEX_PATH = "index.json"
MAX_INDEX_BYTES = 2_000_000
MAX_PACKET_BYTES = 64_000_000
MAX_PACKET_JSON_BYTES = 90_000_000
MAX_MANIFEST_BYTES = 2_000_000
MAX_ARTICLES_BYTES = 64_000_000
MAX_SESSION_SECONDS = 240
STATE_KEY = "cloud_download:last_batch"
RECEIPT_DIR = DATA / "cloud-download-receipts"


class DownloadError(RuntimeError):
    def __init__(self, message: str, details: dict | None = None):
        super().__init__(message)
        self.details = details or {}


def _github_url(path: str, repository: str, branch: str) -> str:
    from urllib.parse import quote
    return f"https://api.github.com/repos/{repository}/contents/{quote(path, safe='/')}?ref={quote(branch, safe='')}"


def _validate_index(index: dict, repository: str, branch: str) -> dict | None:
    if index.get("format") != "information-center.cloud-data-index" or index.get("schema_version") != 1:
        raise DownloadError("GitHub index 格式不受支持。")
    if index.get("repository") != repository or index.get("branch") != branch:
        raise DownloadError("GitHub index 的仓库或分支与固定下载目标不一致。")
    batch = index.get("batch")
    if batch is None:
        return None
    if not isinstance(batch, dict):
        raise DownloadError("GitHub index 的 batch 字段无效。")
    batch_id = batch.get("batch_id")
    if not isinstance(batch_id, str) or not re.fullmatch(r"batch_[a-f0-9]{32}", batch_id):
        raise DownloadError("GitHub index 的 batch_id 无效。")
    if batch.get("path") != f"batches/{batch_id}.zip" or batch.get("transfer_path") != f"batches/{batch_id}.transfer.json":
        raise DownloadError("GitHub index 的批次路径不符合固定路径规则。")
    for key, maximum in (("bytes", MAX_PACKET_BYTES), ("transfer_bytes", MAX_PACKET_JSON_BYTES)):
        value = batch.get(key)
        if type(value) is not int or not 1 <= value <= maximum:
            raise DownloadError(f"GitHub index 的 {key} 超出允许范围。")
    for key in ("sha256", "transfer_sha256"):
        value = batch.get(key)
        if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
            raise DownloadError(f"GitHub index 的 {key} 无效。")
    if type(batch.get("record_count")) is not int or not 0 <= batch["record_count"] <= 50_000:
        raise DownloadError("GitHub index 的 record_count 无效。")
    chunks = batch.get("transfer_chunks")
    if chunks is not None:
        if not isinstance(chunks, list) or not 1 <= len(chunks) <= 1000:
            raise DownloadError("GitHub index 的 transfer_chunks 无效。")
        total = 0
        for number, chunk in enumerate(chunks):
            if not isinstance(chunk, dict) or chunk.get("path") != f"batches/{batch_id}.transfer.part{number:03d}.json":
                raise DownloadError("GitHub index 的分片路径无效。")
            size = chunk.get("bytes")
            digest = chunk.get("sha256")
            if type(size) is not int or not 1 <= size <= 512_000 or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise DownloadError("GitHub index 的分片大小或摘要无效。")
            total += size
        if total > MAX_PACKET_JSON_BYTES * 2:
            raise DownloadError("GitHub index 的分片总大小超限。")
    return batch


def _chunk_fragment(source_text: str, chunk: dict, batch_id: str, number: int, count: int) -> str:
    payload = source_text.encode("utf-8")
    if len(payload) != chunk["bytes"] or hashlib.sha256(payload).hexdigest() != chunk["sha256"]:
        raise DownloadError("transfer 分片长度或 SHA-256 与 index 不一致。")
    try:
        packet = json.loads(source_text)
    except (json.JSONDecodeError, TypeError):
        raise DownloadError("transfer 分片不是有效 JSON。") from None
    if not isinstance(packet, dict) or packet.get("format") != "CLOUD_BATCH_TRANSFER_CHUNK_V1" or packet.get("batch_id") != batch_id:
        raise DownloadError("transfer 分片格式或 batch_id 不一致。")
    if type(packet.get("part_index")) is not int or packet["part_index"] != number or type(packet.get("part_count")) is not int or packet["part_count"] != count:
        raise DownloadError("transfer 分片序号或总数不一致。")
    fragment = packet.get("payload_utf8")
    if not isinstance(fragment, str) or len(fragment.encode("utf-8")) > 512_000:
        raise DownloadError("transfer 分片正文无效。")
    return fragment


def _validate_packet(packet: dict, batch: dict, batch_id: str) -> bytes:
    if packet.get("format") != "CLOUD_BATCH_TRANSFER_V1" or packet.get("encoding") != "base64":
        raise DownloadError("transfer packet 格式不受支持。")
    if packet.get("batch_id") != batch_id:
        raise DownloadError("transfer packet 的 batch_id 与 index 不一致。")
    if packet.get("file_name") != f"{batch_id}.zip":
        raise DownloadError("transfer packet 的文件名与 index 不一致。")
    if packet.get("zip_bytes") != batch["bytes"] or packet.get("zip_sha256") != batch["sha256"]:
        raise DownloadError("transfer packet 的 ZIP 长度或 SHA-256 与 index 不一致。")
    payload_text = packet.get("payload_base64")
    if not isinstance(payload_text, str) or len(payload_text) > ((MAX_PACKET_BYTES + 2) // 3) * 4:
        raise DownloadError("transfer packet 的 base64 缺失或超出大小上限。")
    try:
        payload = base64.b64decode(payload_text, validate=True)
    except (ValueError, base64.binascii.Error):
        raise DownloadError("transfer packet 的 base64 无效。") from None
    if len(payload) != batch["bytes"] or len(payload) > MAX_PACKET_BYTES:
        raise DownloadError("解码后的 ZIP 大小与 index 不一致。")
    if hashlib.sha256(payload).hexdigest() != batch["sha256"]:
        raise DownloadError("解码后的 ZIP SHA-256 与 index 不一致。")
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            infos = archive.infolist()
            if len(infos) != 2 or {entry.filename for entry in infos} != {"manifest.json", "articles.jsonl"}:
                raise DownloadError("ZIP 根目录必须且只能包含 manifest.json 与 articles.jsonl。")
            if sum(entry.file_size for entry in infos) > MAX_MANIFEST_BYTES + MAX_ARTICLES_BYTES:
                raise DownloadError("ZIP 解压后内容超过大小上限。")
            if any(entry.file_size > (MAX_MANIFEST_BYTES if entry.filename == "manifest.json" else MAX_ARTICLES_BYTES) for entry in infos):
                raise DownloadError("ZIP 成员超过大小上限。")
            manifest = json.loads(archive.read("manifest.json").decode("utf-8-sig"))
            article_bytes = archive.read("articles.jsonl")
            if not isinstance(manifest, dict) or manifest.get("batch_id") != batch_id:
                raise DownloadError("ZIP manifest 的批次 ID 不匹配。")
            if manifest.get("record_count") != batch["record_count"]:
                raise DownloadError("ZIP manifest 的记录数与 index 不匹配。")
            rows = [line for line in article_bytes.splitlines() if line.strip()]
            if len(rows) != batch["record_count"]:
                raise DownloadError("ZIP articles.jsonl 的行数与 index 不匹配。")
    except (zipfile.BadZipFile, UnicodeDecodeError, json.JSONDecodeError, OSError) as error:
        raise DownloadError(f"ZIP 内容无法验证：{type(error).__name__}。") from None
    return payload


def _safe_message(value, limit: int = 400) -> str:
    text = str(value or "")
    text = re.sub(r"(?i)(https?://)[^/\s@]+@", r"\1[redacted]@", text)
    text = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+", r"\1[redacted]", text)
    text = re.sub(r"[A-Za-z0-9+/=_-]{80,}", "[redacted]", text)
    return text[:limit]


@contextmanager
def _cache_lock(path: Path, deadline: float):
    """OS lock serializes fetch/read and releases automatically after a crash."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        acquired = False
        try:
            while not acquired:
                if time.monotonic() >= deadline:
                    raise DownloadError("等待 Git 下载缓存锁达到整体超时。")
                try:
                    if os.name == "nt":
                        import msvcrt
                        stream.seek(0)
                        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = True
                except OSError:
                    time.sleep(min(0.05, max(0, deadline - time.monotonic())))
            yield
        finally:
            if acquired:
                if os.name == "nt":
                    stream.seek(0)
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def _run_git(last_batch_id: str | None, timeout: float) -> dict:
    cloud = settings().get("cloud", {})
    repository = cloud.get("github_repository", DEFAULT_REPOSITORY)
    branch = cloud.get("github_data_branch", DEFAULT_BRANCH)
    if repository != DEFAULT_REPOSITORY or branch != DEFAULT_BRANCH:
        raise DownloadError("GitHub 仓库或数据分支与已验证的固定目标不一致。")
    git = shutil.which("git")
    if not git:
        raise DownloadError("未找到 Git；保留已有批次，本次没有下载。", {"model_invocations": 0})
    remote = f"https://github.com/{repository}.git"
    identity = hashlib.sha256(f"{repository}\n{branch}".encode()).hexdigest()[:16]
    cache = DATA / "cloud-download-git" / identity
    deadline = time.monotonic() + timeout
    env = os.environ.copy()
    # Never inherit a caller's repository/index/object directory into this cache.
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
                "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE"):
        env.pop(key, None)
    env.update(GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="Never")
    diagnostics = {"transport": "git_fetch", "model_invocations": 0, "git_calls": [],
                   "cache": str(cache), "repository": repository, "branch": branch}

    def run(args: list[str], *, use_cache=True) -> bytes:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise DownloadError("Git 下载达到整体超时。", diagnostics)
        # Disable custom templates/hooks for this data-only cache, and force raw
        # object reads rather than configured textconv/external diff programs.
        command = [git, "-c", "core.hooksPath=", "-c", "credential.interactive=false"]
        if use_cache:
            command += ["--git-dir", str(cache)]
        command += args
        call = {"args": args, "status": "started"}
        diagnostics["git_calls"].append(call)
        started = time.monotonic()
        try:
            outcome = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     env=env, timeout=remaining,
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except subprocess.TimeoutExpired:
            call.update(status="timeout", elapsed_seconds=round(time.monotonic() - started, 3))
            raise DownloadError("Git 命令达到整体超时；未使用旧缓存作为下载结果。", diagnostics) from None
        except OSError as error:
            call.update(status="error", error=_safe_message(error))
            raise DownloadError(f"Git 无法启动：{type(error).__name__}。", diagnostics) from error
        call.update(status="success" if outcome.returncode == 0 else "error",
                    returncode=outcome.returncode, elapsed_seconds=round(time.monotonic() - started, 3))
        if outcome.returncode:
            message = _safe_message(outcome.stderr.decode("utf-8", errors="replace"))
            call["error"] = message
            raise DownloadError(f"Git {args[0]} 失败：{message}", diagnostics)
        return outcome.stdout

    def blob(commit: str, path: str, maximum: int) -> bytes:
        obj = f"{commit}:{path}"
        if run(["cat-file", "-t", obj]).strip() != b"blob":
            raise DownloadError(f"Git 数据路径不是普通 blob：{path}。", diagnostics)
        size = int(run(["cat-file", "-s", obj]).strip())
        if not 1 <= size <= maximum:
            raise DownloadError(f"Git 数据文件大小超限：{path}。", diagnostics)
        content = run(["show", "--no-ext-diff", "--no-textconv", obj])
        if len(content) != size:
            raise DownloadError(f"Git blob 实际长度与对象大小不一致：{path}。", diagnostics)
        return content

    try:
        with _cache_lock(cache.with_suffix(".lock"), deadline):
            if not cache.exists():
                run(["init", "--bare", "--template=", str(cache)], use_cache=False)
            if run(["rev-parse", "--is-bare-repository"]).strip() != b"true":
                raise DownloadError("Git 下载缓存不是隔离裸仓库，保留原件并停止。", diagnostics)
            # Explicit URL/ref avoids an unrelated configured origin. A failed
            # fetch exits here even if an old FETCH_HEAD still exists.
            run(["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules",
                 remote, f"refs/heads/{branch}"])
            commit = run(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]).decode("ascii").strip()
            if not re.fullmatch(r"[a-f0-9]{40,64}", commit):
                raise DownloadError("Git fetch 未给出有效 commit。", diagnostics)
            diagnostics["commit"] = commit
            index = json.loads(blob(commit, INDEX_PATH, MAX_INDEX_BYTES).decode("utf-8"))
            if not isinstance(index, dict):
                raise DownloadError("GitHub index 必须是 JSON 对象。", diagnostics)
            batch = _validate_index(index, repository, branch)
            result = {"index": index, "packet": None, "tool_events": 0, "cli_calls": [],
                      "final_message": "", "index_url": _github_url(INDEX_PATH, repository, branch),
                      "packet_url": None, **diagnostics}
            if batch is None or batch["batch_id"] == last_batch_id:
                return result
            result["packet_url"] = _github_url(batch["transfer_path"], repository, branch)
            transfer = blob(commit, batch["transfer_path"], MAX_PACKET_JSON_BYTES)
            if len(transfer) != batch["transfer_bytes"] or hashlib.sha256(transfer).hexdigest() != batch["transfer_sha256"]:
                raise DownloadError("Git transfer 文件长度或 SHA-256 与 index 不一致。", diagnostics)
            packet = json.loads(transfer.decode("utf-8"))
            if not isinstance(packet, dict):
                raise DownloadError("transfer packet 必须是 JSON 对象。", diagnostics)
            result.update(packet=packet, transfer_parts=1)
            return result
    except Exception as error:
        if isinstance(error, DownloadError):
            if not error.details:
                error.details = diagnostics
            raise
        raise DownloadError(f"Git 下载数据无法读取或验证：{type(error).__name__}: {_safe_message(error)}", diagnostics) from error


def _transport_details(fetched: dict) -> dict:
    return {key: fetched[key] for key in ("transport", "model_invocations", "git_calls", "cache", "commit", "repository", "branch") if key in fetched}


def _receipt(status: str, started: str, *, batch_id=None, source="git_fetch", auto_download=False,
             error=None, details=None) -> dict:
    receipt = {"status": status, "started_at": started, "finished_at": now_iso(), "source": source,
               "batch_id": batch_id, "automatic_download": bool(auto_download), "error": error, "details": details or {}}
    RECEIPT_DIR.mkdir(parents=True, exist_ok=True)
    identity = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    atomic_text(RECEIPT_DIR / f"{identity}.json", json.dumps(receipt, ensure_ascii=False, indent=2))
    return receipt


def download_latest(timeout: int = MAX_SESSION_SECONDS) -> dict:
    """Fetch and safely spool the current Cloud data batch for cloud_receive.

    Returns status in success/already_downloaded/no_new_data/error.  This
    function never imports records; the normal cloud_receive pipeline does that.
    """
    started = now_iso()
    process_started = time.monotonic()
    batch_id = None
    fetched = None
    try:
        ensure_dirs()
        if type(timeout) is not int or not 1 <= timeout <= MAX_SESSION_SECONDS:
            raise ValueError(f"timeout must be between 1 and {MAX_SESSION_SECONDS} seconds")
        cloud_config = settings().get("cloud", {})
        if not cloud_config.get("download_enabled", False):
            raise DownloadError("cloud.download_enabled 未开启；本次未启动 Git 下载。")
        with closing(connect()) as db:
            previous = state_get(db, STATE_KEY, {})
        last_batch_id = previous.get("batch_id") if isinstance(previous, dict) else None
        # A historical success marker is usable only while its actual ZIP
        # remains in this fixed inbox. Missing bytes must be fetched again.
        if last_batch_id and not (DATA / "cloud-incoming" / f"{last_batch_id}.zip").is_file():
            last_batch_id = None
        fetched = _run_git(last_batch_id, timeout)
        index = fetched["index"]
        cloud = settings().get("cloud", {})
        repository = cloud.get("github_repository", DEFAULT_REPOSITORY)
        branch = cloud.get("github_data_branch", DEFAULT_BRANCH)
        batch = _validate_index(index, repository, branch)
        if batch is None:
            receipt = _receipt("no_new_data", started, auto_download=False,
                               details={**_transport_details(fetched), "tool_events": fetched["tool_events"], "index_url": fetched["index_url"],
                                        "cli_calls": fetched["cli_calls"], "final_message": fetched["final_message"]})
            return receipt
        batch_id = batch["batch_id"]
        if batch_id == last_batch_id:
            from cloud_recovery_adapter import offer_download
            offer_download(index, DATA / "cloud-incoming" / f"{batch_id}.zip")
            return _receipt("already_downloaded", started, batch_id=batch_id, auto_download=False,
                            details={**_transport_details(fetched), "tool_events": fetched["tool_events"], "index_url": fetched["index_url"],
                                     "cli_calls": fetched["cli_calls"], "final_message": fetched["final_message"],
                                     "reason": "saved_batch_id_matches_index"})
        packet = fetched["packet"]
        payload = _validate_packet(packet, batch, batch_id)
        inbox = DATA / "cloud-incoming"
        inbox.mkdir(parents=True, exist_ok=True)
        destination = inbox / f"{batch_id}.zip"
        if destination.exists():
            existing = destination.read_bytes()
            if hashlib.sha256(existing).hexdigest() != batch["sha256"] or len(existing) != batch["bytes"]:
                raise DownloadError("cloud-incoming 已有同名但内容不同的批次，保留原件并停止写入。")
            from cloud_recovery_adapter import offer_download
            offer_download(index, destination)
            with closing(connect()) as db:
                state_set(db, STATE_KEY, {"batch_id": batch_id, "downloaded_at": now_iso(), "path": str(destination), "sha256": batch["sha256"]})
            return _receipt("already_downloaded", started, batch_id=batch_id, auto_download=False,
                            details={**_transport_details(fetched), "tool_events": fetched["tool_events"], "index_url": fetched["index_url"],
                                     "packet_url": fetched["packet_url"], "cli_calls": fetched["cli_calls"],
                                     "final_message": fetched["final_message"], "reason": "matching_inbox_file"})
        temporary = destination.with_name(destination.name + f".{os.getpid()}.tmp")
        try:
            with temporary.open("xb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
        from cloud_recovery_adapter import offer_download
        offer_download(index, destination)
        with closing(connect()) as db:
            state_set(db, STATE_KEY, {"batch_id": batch_id, "downloaded_at": now_iso(), "path": str(destination), "sha256": batch["sha256"]})
        return _receipt("success", started, batch_id=batch_id, auto_download=True,
                        details={**_transport_details(fetched), "path": str(destination), "bytes": len(payload), "sha256": batch["sha256"],
                                 "record_count": batch["record_count"], "tool_events": fetched["tool_events"],
                                 "cloud_day_status": batch.get("day_status"),
                                 "cloud_execution": batch.get("execution"),
                                 "index_url": fetched["index_url"], "packet_url": fetched["packet_url"],
                                 "packet_urls": fetched.get("packet_urls"),
                                 "transfer_parts": fetched.get("transfer_parts", 1),
                                 "cli_calls": fetched["cli_calls"], "final_message": fetched["final_message"],
                                 "elapsed_seconds": round(time.monotonic() - process_started, 2)})
    except Exception as error:
        details = {"transport": "git_fetch", "model_invocations": 0, **(getattr(error, "details", {}) or {})}
        if fetched:
            details = {**_transport_details(fetched), **details}
        if fetched and fetched.get("cli_calls") and not details.get("cli_calls"):
            details["cli_calls"] = fetched["cli_calls"]
            details.setdefault("final_message", fetched.get("final_message", ""))
        return _receipt("error", started, batch_id=batch_id, auto_download=False,
                        error=f"{type(error).__name__}: {str(error)[:600]}",
                        details={"elapsed_seconds_total": round(time.monotonic() - process_started, 2), **details})

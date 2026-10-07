"""Durable Cloud batch handoff. Reuses production validation/import, no models.

CLI: offer --index FILE [--bundle ZIP | --packet FILE | --part N:FILE ...]
     fetch [--timeout 60]; recover [--limit 8] [--force]; status
All CLI output is UTF-8 JSON. Call recover_locked() only under common.job_lock.
"""
from __future__ import annotations
import pathlib as _public_pathlib
import importlib.util as _public_importutil
_public_root = next(p for p in _public_pathlib.Path(__file__).resolve().parents if (p/'public_paths.py').is_file())
_public_spec = _public_importutil.spec_from_file_location('ai_work_public_paths', _public_root/'public_paths.py')
_public_module = _public_importutil.module_from_spec(_public_spec)
_public_spec.loader.exec_module(_public_module)
_public_path = _public_module.public_path

import argparse
from contextlib import closing
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import random
import re
import sqlite3
import sys
import time
import uuid
import zipfile

APP = Path(__file__).resolve().parents[1] / "app"
sys.path.insert(0, str(APP))
import common
import cloud_download as download
import cloud_sync as sync


class RecoveryError(ValueError):
    pass


def bounded(path, maximum):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > maximum:
        raise RecoveryError("missing, symlinked or oversized input")
    with path.open("rb") as stream:
        value = stream.read(maximum + 1)
    if len(value) > maximum:
        raise RecoveryError("input exceeded limit while reading")
    return value


def json_object(payload):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise RecoveryError("duplicate JSON key")
            value[key] = item
        return value
    value = json.loads(payload.decode("utf-8-sig"), object_pairs_hook=unique)
    if not isinstance(value, dict):
        raise RecoveryError("JSON object required")
    return value


def atomic_bytes(path, value):
    """Write and fsync a unique sibling before replace; never expose partial ZIP."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        # Windows viewers/antivirus may briefly deny replace. Bounded local retry.
        for attempt in range(6):
            try:
                os.replace(temporary, path)
                break
            except PermissionError:
                if attempt == 5:
                    raise
                time.sleep(0.05 * (attempt + 1))
        if os.name != "nt":
            descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)


class Recovery:
    def __init__(self, queue=None):
        self.queue = Path(queue) if queue else common.DATA / "cloud-recovery"

    def lock(self):
        # Reuse OS locking, not stale PID/age ownership. No model/background loop.
        return download._cache_lock(self.queue / "queue.lock", time.monotonic() + 10)

    def _save(self, folder, state):
        state["updated_at"] = common.now_iso()
        atomic_bytes(folder / "state.json", json.dumps(state, ensure_ascii=False,
                                                      indent=2).encode("utf-8"))

    def _preserve(self, path):
        """Keep a damaged local cache for diagnosis; never remove original data."""
        if path.is_symlink():
            raise RecoveryError("symlinked queue artifact refused")
        saved = path.with_name(path.name + ".corrupt." + uuid.uuid4().hex)
        os.replace(path, saved)
        return str(saved)

    def _state(self, folder):
        default = {"batch_id": folder.name, "status": "awaiting_artifact", "attempts": 0}
        path = folder / "state.json"
        if not path.exists():
            return default
        try:
            state = json_object(bounded(path, download.MAX_INDEX_BYTES))
            if (state.get("batch_id") != folder.name or state.get("status") not in
                {"awaiting_artifact", "staged", "receiving", "received", "retryable", "rejected"}
                or type(state.get("attempts")) is not int or state["attempts"] < 0):
                raise RecoveryError("invalid queue state")
            if state.get("next_retry_at"):
                stamp = dt.datetime.fromisoformat(state["next_retry_at"])
                if stamp.tzinfo is None:
                    raise RecoveryError("retry timestamp requires timezone")
            return state
        except (ValueError, TypeError, UnicodeError):
            default["recovered_state_from"] = self._preserve(path)
            return default

    @staticmethod
    def _brief(state):
        result = dict(state)
        result.pop("cloud_sources", None)
        return result

    def _marker(self, batch_id):
        # Reading a committed marker does not create tables or run PRAGMA writes.
        if not common.DB_PATH.exists():
            return None
        with closing(sqlite3.connect(common.DB_PATH.resolve().as_uri() + "?mode=ro",
                                     uri=True, timeout=5)) as db:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='state'").fetchone():
                return None
            row = db.execute("SELECT value FROM state WHERE key=?", ("cloud_batch:" + batch_id,)).fetchone()
            return json_object(row[0].encode("utf-8")) if row else None

    def _index(self, index):
        if not isinstance(index, dict):
            raise RecoveryError("index must be an object")
        batch = download._validate_index(index, download.DEFAULT_REPOSITORY,
                                         download.DEFAULT_BRANCH)
        if batch is None:
            raise RecoveryError("index has no batch")
        return batch

    def _validate_zip(self, path, batch):
        payload = bounded(path, download.MAX_PACKET_BYTES)
        if len(payload) != batch["bytes"] or hashlib.sha256(payload).hexdigest() != batch["sha256"]:
            raise RecoveryError("ZIP length/digest differs from index")
        try:
            manifest, records, digest = sync._validate(sync._read_bundle(path),
                                    {source["id"]: source for source in common.sources_config()})
        except (zipfile.BadZipFile, UnicodeError, ValueError, TypeError, KeyError) as error:
            raise RecoveryError("invalid ZIP content: " + download._safe_message(error)) from None
        if manifest["batch_id"] != batch["batch_id"] or len(records) != batch["record_count"]:
            raise RecoveryError("ZIP batch identity/count differs from index")
        return manifest, digest

    def _store_zip(self, folder, payload, batch):
        path = folder / "batch.zip"
        # Verify before committing the durable file; production validator handles
        # bounded ZIP members, configured sources, article schema and health.
        temporary = folder / (uuid.uuid4().hex + ".zip")
        try:
            atomic_bytes(temporary, payload)
            self._validate_zip(temporary, batch)
            if path.exists():
                try:
                    self._validate_zip(path, batch)
                    return  # already complete; preserve file and its timestamp
                except (ValueError, UnicodeError):
                    self._preserve(path)
            atomic_bytes(path, payload)
        finally:
            temporary.unlink(missing_ok=True)

    def offer(self, index, *, bundle=None, packet=None, parts=(), source=None):
        """Accept an existing artifact/asynchronous parts; no network or import."""
        batch = self._index(index)
        folder = self.queue / batch["batch_id"]
        with self.lock():
            if folder.is_symlink():
                raise RecoveryError("symlinked batch directory refused")
            folder.mkdir(parents=True, exist_ok=True)
            saved_index = folder / "index.json"
            if saved_index.exists():
                try:
                    original = json_object(bounded(saved_index, download.MAX_INDEX_BYTES))
                    original_batch = self._index(original)
                except (ValueError, UnicodeError, KeyError, TypeError, download.DownloadError):
                    self._preserve(saved_index)
                else:
                    if original_batch != batch:
                        raise RecoveryError("same batch_id with different index; preserve original")
            if not saved_index.exists():
                atomic_bytes(saved_index, json.dumps(index, ensure_ascii=False).encode("utf-8"))
            state = self._state(folder)
            state.setdefault("created_at", common.now_iso())
            state.update(cloud_day_status=batch.get("day_status"), cloud_execution=batch.get("execution"))
            # Persist the batch identity first. A process can die during delivery
            # and still discover the saved index and previously complete parts.
            if source and not state.get("source"):
                state["source"] = source
            if source:
                state["last_delivery"] = source
            self._save(folder, state)
            try:
                chunks = batch.get("transfer_chunks", [])
                for number, path in parts:
                    if type(number) is not int or not 0 <= number < len(chunks):
                        raise RecoveryError("part number absent from bound index")
                    value = bounded(path, 512_000)
                    download._chunk_fragment(value.decode("utf-8"), chunks[number],
                                             batch["batch_id"], number, len(chunks))
                    destination = folder / f"part{number:03d}.json"
                    if destination.exists():
                        try:
                            download._chunk_fragment(bounded(destination, 512_000).decode("utf-8"),
                                 chunks[number], batch["batch_id"], number, len(chunks))
                        except (ValueError, UnicodeError, download.DownloadError):
                            self._preserve(destination)
                    if not destination.exists():
                        atomic_bytes(destination, value)
                if bundle:
                    self._store_zip(folder, bounded(bundle, download.MAX_PACKET_BYTES), batch)
                if packet:
                    value = bounded(packet, download.MAX_PACKET_JSON_BYTES)
                    self._accept_packet(folder, value, batch)
                if (folder / "batch.zip").exists():
                    self._validate_zip(folder / "batch.zip", batch)
                    if state["status"] != "received":
                        state.update(status="staged", next_retry_at=None, last_error=None)
                elif parts:
                    state.update(status="awaiting_artifact", next_retry_at=None, last_error=None)
                state.pop("last_delivery_error", None)
                self._save(folder, state)
                return self._brief(state)
            except Exception as error:
                state["last_delivery_error"] = download._safe_message(error)
                self._save(folder, state)
                raise

    def _accept_packet(self, folder, value, batch):
        if len(value) != batch["transfer_bytes"] or hashlib.sha256(value).hexdigest() != batch["transfer_sha256"]:
            raise RecoveryError("complete transfer length/digest mismatch")
        payload = download._validate_packet(json_object(value), batch, batch["batch_id"])
        self._store_zip(folder, payload, batch)

    def _materialize(self, folder, batch):
        if (folder / "batch.zip").exists():
            try:
                self._validate_zip(folder / "batch.zip", batch)
                return
            except (ValueError, UnicodeError):
                self._preserve(folder / "batch.zip")
        # Recover the download-success/file-missing gap from an existing inbox
        # or from already saved parts; no full recollection is needed.
        inbox = common.DATA / "cloud-incoming" / (batch["batch_id"] + ".zip")
        if inbox.exists():
            try:
                self._store_zip(folder, bounded(inbox, download.MAX_PACKET_BYTES), batch)
                return
            except (ValueError, UnicodeError):
                pass  # preserve production original, try validated saved parts
        chunks = batch.get("transfer_chunks", [])
        if not chunks:
            raise FileNotFoundError("awaiting bound ZIP/packet")
        fragments = []
        for number, chunk in enumerate(chunks):
            path = folder / f"part{number:03d}.json"
            if path.exists():
                try:
                    download._chunk_fragment(bounded(path, 512_000).decode("utf-8"),
                        chunk, batch["batch_id"], number, len(chunks))
                except (ValueError, UnicodeError, download.DownloadError):
                    self._preserve(path)
            if not path.exists():
                cached = common.DATA / "cloud-download-parts" / batch["batch_id"] / f"part{number:03d}.json"
                if not cached.exists():
                    raise FileNotFoundError(f"awaiting part {number}")
                value = bounded(cached, 512_000)
                download._chunk_fragment(value.decode("utf-8"), chunk, batch["batch_id"], number, len(chunks))
                atomic_bytes(path, value)
            fragments.append(download._chunk_fragment(bounded(path, 512_000).decode("utf-8"),
                                chunk, batch["batch_id"], number, len(chunks)))
        self._accept_packet(folder, "".join(fragments).encode("utf-8"), batch)

    def fetch(self, timeout=60):
        """Fetch fixed latest Git snapshot, ignoring the fragile download marker.

        Does NOT launch a Cloud task, and does not claim scheduled Cloud execution.
        Older missed batches need their saved index/artifact offered explicitly.
        """
        if type(timeout) is not int or not 1 <= timeout <= download.MAX_SESSION_SECONDS:
            raise RecoveryError("invalid timeout")
        if not common.settings().get("cloud", {}).get("download_enabled"):
            raise RecoveryError("configured Git download disabled")
        receipt_file = self.queue / "fetch-receipts" / (uuid.uuid4().hex + ".json")
        receipt = {"status": "started", "started_at": common.now_iso(), "model_invocations": 0}
        atomic_bytes(receipt_file, json.dumps(receipt).encode("utf-8"))
        scratch = self.queue / (uuid.uuid4().hex + ".zip")
        try:
            fetched = download._run_git(None, timeout)
            index = fetched["index"]
            batch = download._validate_index(index, download.DEFAULT_REPOSITORY, download.DEFAULT_BRANCH)
            if batch is None:
                result = {"status": "no_new_data", "model_invocations": 0}
            else:
                payload = download._validate_packet(fetched["packet"], batch, batch["batch_id"])
                # Git validates the original raw transfer; no JSON reserialization.
                atomic_bytes(scratch, payload)
                result = self.offer(index, bundle=scratch, source={"transport": "git_fetch",
                                     "commit": fetched.get("commit"), "model_invocations": 0})
            receipt.update(status="success", batch_id=batch["batch_id"] if batch else None,
                           commit=fetched.get("commit"), finished_at=common.now_iso())
            return result
        except Exception as error:
            receipt.update(status="error", error=download._safe_message(error), finished_at=common.now_iso(),
                           next_action="recover local queue; retry fetch at next normal call")
            raise
        finally:
            atomic_bytes(receipt_file, json.dumps(receipt, ensure_ascii=False).encode("utf-8"))
            scratch.unlink(missing_ok=True)

    def recover_locked(self, limit=8, force=False):
        """Caller MUST hold production common.job_lock(); also takes queue lock."""
        if type(limit) is not int or not 1 <= limit <= 100:
            raise RecoveryError("limit must be 1..100")
        results, issues = [], []
        attempted = confirmed_existing = deferred = 0
        has_more = False
        with self.lock():
            folders = sorted(self.queue.glob("batch_*/index.json"))
            for index_path in folders:
                if attempted >= limit:
                    has_more = True
                    break
                folder = index_path.parent
                if not re.fullmatch(r"batch_[a-f0-9]{32}", folder.name) or folder.is_symlink():
                    continue
                state = {"batch_id": folder.name, "status": "awaiting_artifact", "attempts": 0}
                try:
                    state = self._state(folder)
                    batch = self._index(json_object(bounded(index_path, download.MAX_INDEX_BYTES)))
                    if batch["batch_id"] != folder.name:
                        raise RecoveryError("folder/index identity mismatch")
                    due = state.get("next_retry_at")
                    if due and not force and dt.datetime.fromisoformat(due) > dt.datetime.now(dt.timezone.utc):
                        deferred += 1
                        results.append(self._brief({**state, "deferred": True}))
                        continue
                    self._materialize(folder, batch)
                    path = folder / "batch.zip"
                    manifest, digest = self._validate_zip(path, batch)
                    previous = self._marker(batch["batch_id"])
                    # Queue acknowledgements are never proof of production import.
                    if previous:
                        if previous.get("articles_sha256") != digest:
                            raise RecoveryError("production batch marker conflicts with artifact")
                        if state.get("status") == "received" and state.get("articles_sha256") == digest:
                            confirmed_existing += 1
                            continue
                        outcome = {"status": "success", "duplicate_batch": True,
                                   "records": batch["record_count"], "items_new": 0, "items_updated": 0}
                    else:
                        attempted += 1
                        state.update(status="receiving", attempts=state.get("attempts", 0) + 1)
                        self._save(folder, state)
                        outcome = sync.import_batch(path)
                        if outcome["status"] != "success":
                            text = "; ".join(outcome.get("errors", []))
                            if "OperationalError" in text or "PermissionError" in text:
                                raise OSError(text)
                            raise RecoveryError(text)
                    # Crash after import commit and before this save is safe:
                    # next invocation checks the production batch marker above.
                    state.update(status="received", next_retry_at=None, last_error=None,
                        received_at=common.now_iso(), result=outcome,
                        articles_sha256=digest, cloud_day_status=batch.get("day_status"),
                        cloud_sources=manifest["sources"])
                except FileNotFoundError as error:
                    state.update(status="awaiting_artifact", last_error=download._safe_message(error),
                                 next_retry_at=None)
                except (OSError, sqlite3.OperationalError, download.DownloadError) as error:
                    # Delivery/content validation is permanent; DownloadError in
                    # local reassembly is an integrity failure, not a network retry.
                    if isinstance(error, download.DownloadError):
                        state.update(status="rejected", next_retry_at=None,
                                     last_error=download._safe_message(error))
                    else:
                        attempts = state.get("attempts", 0) + (state.get("status") != "receiving")
                        delay = random.uniform(30, min(3600, 60 * 2 ** min(attempts, 6)))
                        state.update(status="retryable", attempts=attempts,
                            last_error=download._safe_message(error), next_retry_at=(
                            dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=delay)).isoformat())
                except (ValueError, TypeError, KeyError, UnicodeError) as error:
                    state.update(status="rejected", next_retry_at=None,
                                 last_error=download._safe_message(error))
                try:
                    self._save(folder, state)
                except OSError as error:
                    # One inaccessible queue file cannot block another batch.
                    issues.append({"batch_id": folder.name, "error": download._safe_message(error),
                                   "next_action": "retry after queue file becomes writable"})
                results.append(self._brief(state))
        failed = [x for x in results if x.get("status") in ("retryable", "rejected")]
        waiting = [x for x in results if x.get("status") == "awaiting_artifact"]
        return {"status": "partial" if failed or waiting or issues else "success", "results": results,
                "errors": failed, "issues": issues, "awaiting": len(waiting),
                "attempted_imports": attempted, "confirmed_existing": confirmed_existing,
                "deferred": deferred, "has_more": has_more, "model_invocations": 0}

    def recover(self, limit=8, force=False):
        with common.job_lock() as acquired:
            if not acquired:
                return {"status": "already_running", "results": [], "model_invocations": 0}
            return self.recover_locked(limit, force)

    def status(self):
        # No production connection, no network, no writes, no import.
        entries, errors = [], []
        latest_fetch = None
        for folder in sorted(self.queue.glob("batch_*")):
            if not folder.is_dir() or folder.is_symlink():
                continue
            path = folder / "state.json"
            try:
                value = json_object(bounded(path, download.MAX_INDEX_BYTES))
                value.pop("cloud_sources", None)
                entries.append(value)
            except (OSError, ValueError, UnicodeError) as error:
                errors.append({"path": str(path), "error": download._safe_message(error)})
        receipts = list((self.queue / "fetch-receipts").glob("*.json"))
        if receipts:
            try:
                latest = max(receipts, key=lambda path: path.stat().st_mtime_ns)
                latest_fetch = {**json_object(bounded(latest, download.MAX_INDEX_BYTES)), "receipt": str(latest)}
            except (OSError, ValueError, UnicodeError) as error:
                errors.append({"stage": "fetch_receipt", "error": download._safe_message(error)})
        return {"status": "partial" if errors else "success", "queue": str(self.queue),
                "batches": entries, "latest_fetch": latest_fetch, "errors": errors, "model_invocations": 0}


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="strict")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--queue", type=Path)
    sub = parser.add_subparsers(dest="command", required=True)
    offer = sub.add_parser("offer")
    offer.add_argument("--index", type=Path, required=True)
    offer.add_argument("--bundle", type=Path)
    offer.add_argument("--packet", type=Path)
    offer.add_argument("--part", action="append", default=[])
    sub.add_parser("status")
    fetch = sub.add_parser("fetch")
    fetch.add_argument("--timeout", type=int, default=60)
    recover = sub.add_parser("recover")
    recover.add_argument("--limit", type=int, default=8)
    recover.add_argument("--force", action="store_true")
    args = parser.parse_args()
    engine = Recovery(args.queue)
    try:
        if args.command == "offer":
            parts = []
            for item in args.part:
                number, separator, path = item.partition(":")
                if not separator:
                    raise RecoveryError("part syntax is N:PATH")
                parts.append((int(number), Path(path)))
            result = engine.offer(json_object(bounded(args.index, download.MAX_INDEX_BYTES)),
                                  bundle=args.bundle, packet=args.packet, parts=parts,
                                  source={"transport": "existing_artifact"})
        elif args.command == "fetch":
            result = engine.fetch(args.timeout)
        elif args.command == "recover":
            result = engine.recover(args.limit, args.force)
        else:
            result = engine.status()
    except Exception as error:
        result = {"status": "error", "error": download._safe_message(error), "model_invocations": 0}
    print(json.dumps(result, ensure_ascii=False))
    return 2 if result["status"] in ("error", "partial", "rejected", "retryable") else 0


if __name__ == "__main__":
    raise SystemExit(main())

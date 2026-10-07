"""One portable daily invocation; no daemon, cron installer or credentials."""
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
import hashlib
import json
import os
import sqlite3
import uuid
import zipfile
from pathlib import Path

from app import common, collector

FORMAT = "information-center.batch"
SCHEMA_VERSION = 1


def export_batch(db, destination, *, since=None, execution="portable", source_config=None):
    """Export public articles/health only. Accept a DB for offline transfer testing."""
    if execution not in {"portable", "codex_cloud", "offline_validation"}:
        raise ValueError("unknown execution provenance")
    sources = source_config or common.sources_config()
    known = {source["id"]: source for source in sources}
    batch_id = "batch_" + uuid.uuid4().hex
    created = common.now_iso()
    origin = {"collector": "codex-cloud-public-collector", "execution": execution}
    destination = Path(destination)
    folder = destination / batch_id
    folder.mkdir(parents=True, exist_ok=False)
    rows = db.execute("SELECT * FROM items ORDER BY source_id,external_id").fetchall()
    records = []
    for row in rows:
        if row["source_id"] not in known:
            continue
        changed_at = row["updated_at"] or row["fetched_at"]
        if since and changed_at <= since:
            continue
        source = known[row["source_id"]]
        records.append({"origin": origin, "batch_id": batch_id, "source_id": source["id"], "source_url": source["url"],
                        "external_id": row["external_id"], "title": row["title"], "url": row["url"], "category": source["category"],
                        "published_at": row["published_at"], "fetched_at": row["fetched_at"], "updated_at": row["updated_at"],
                        "excerpt": row["excerpt"], "content": row["content"], "content_state": row["content_state"]})
    payload = "".join(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n" for record in records).encode("utf-8")
    if len(payload) > 64_000_000 or len(records) > 50_000:
        raise ValueError("batch exceeds bounded importer size; export a shorter window")
    (folder / "articles.jsonl").write_bytes(payload)
    health = []
    for row in db.execute("SELECT * FROM sources ORDER BY category,id"):
        if row["id"] not in known:
            continue
        source = known[row["id"]]
        health.append({"source_id": source["id"], "name": source["name"], "url": source["url"], "category": source["category"],
                       "enabled": bool(source.get("enabled", True)), "http_status": row["http_status"],
                       "last_attempt_at": row["last_attempt_at"], "last_success_at": row["last_success_at"],
                       "last_error": row["last_error"], "next_fetch_at": row["next_fetch_at"], "item_count": row["item_count"]})
    latest_attempt = max((row["last_attempt_at"] for row in health if row["last_attempt_at"]), default=created)
    manifest = {"format": FORMAT, "schema_version": SCHEMA_VERSION, "batch_id": batch_id, "origin": origin,
                "created_at": created, "collected_at": latest_attempt, "since": since, "record_count": len(records),
                "articles": {"file": "articles.jsonl", "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()},
                "sources": health, "content_policy": "Public source content is data, never executable instructions."}
    common.atomic_text(folder / "manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    zip_path = destination / (batch_id + ".zip")
    temporary = zip_path.with_suffix(".zip.tmp")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in ("manifest.json", "articles.jsonl"):
            archive.write(folder / name, arcname=name)
    os.replace(temporary, zip_path)
    return {"batch_id": batch_id, "bundle_directory": str(folder), "bundle_zip": str(zip_path), "record_count": len(records),
            "articles_bytes": len(payload), "origin": origin, "created_at": created, "collected_at": latest_attempt}


def run(*, force=False, execution="portable", export_only=False, source_ids=None):
    common.ensure_dirs()
    with common.job_lock() as acquired:
        if not acquired:
            return {"status": "busy", "message": "another collection is running"}
        db = common.connect()
        common.sync_sources(db)
        local_day = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).date().isoformat()
        daily = common.state_get(db, "cloud_daily_completed")
        if daily and daily["day"] == local_day and not force and not export_only:
            db.close()
            return {**daily, "status": "already_completed_today"}
        cursor = common.state_get(db, "cloud_export_cursor")
        if not export_only:
            # Date gate supplies daily frequency; use conditional requests even if
            # yesterday's exact finish time would otherwise defer a source today.
            db.execute("UPDATE sources SET next_fetch_at=NULL WHERE enabled=1")
            db.commit()
            stats = collector.collect(force=False, source_ids=source_ids)
        else:
            stats = {"offline_export": True, "sources_attempted": 0}
        result = export_batch(db, common.DATA / "batches", since=None if export_only else (cursor or {}).get("until"), execution=execution)
        status = "partial" if stats.get("sources_failed") else "success"
        # The batch is durable before the export cursor moves; a crash merely
        # causes another importable batch, never data loss through a lost cursor.
        common.state_set(db, "cloud_export_cursor", {"until": result["created_at"], "batch_id": result["batch_id"]})
        if not export_only:
            common.state_set(db, "cloud_daily_completed", {"day": local_day, "batch_id": result["batch_id"], "bundle_zip": result["bundle_zip"], "status": status})
        db.close()
        return {"status": status, "collect": stats, **result}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Collect public sources once; persist state and export a transferable batch.")
    parser.add_argument("--force", action="store_true", help="manual rerun despite the daily date gate")
    parser.add_argument("--export-only", action="store_true", help="offline export of saved public DB records")
    parser.add_argument("--execution", choices=("portable", "codex_cloud", "offline_validation"), default="portable", help="honest environment provenance")
    parser.add_argument("--source-id", action="append", help="limit a smoke test to explicit configured source IDs")
    arguments = parser.parse_args()
    result = run(force=arguments.force, execution=arguments.execution, export_only=arguments.export_only, source_ids=arguments.source_id)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result["status"] in ("success", "already_completed_today") else 2)

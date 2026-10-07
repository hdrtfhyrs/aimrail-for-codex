"""One daily public collection plus recoverable native Codex file/stdout output."""
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
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE if (HERE / "app").exists() else HERE.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))
from app import common
import run_collect
import native_delivery as delivery


def configure(directory):
    # Never package the local information center DB or local runtime settings.
    settings = common.settings()
    if any(key in settings for key in ("python_path", "codex_path", "triage_model", "research_model")):
        raise ValueError("use the standalone pure-collection checkout, not the local information center")
    common.DATA = Path(directory).expanduser().resolve() if directory else Path(_public_path("$data/system/信息中心/cloud/data"))
    common.DB_PATH = common.DATA / "information.sqlite"
    common.ensure_dirs()


def check_public_db(path):
    with closing(sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError("invalid state database")
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if tables != {"sources", "items", "events", "decisions", "actions", "runs", "state"}:
            raise ValueError("unexpected collection database tables")
        if any(db.execute("SELECT count(*) FROM " + table).fetchone()[0] for table in ("events", "decisions", "actions")):
            raise ValueError("snapshot contains local processing data; public collector DB required")


def save_state(destination, batch_id, execution):
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    bundle = common.DATA / "batches" / (batch_id + ".zip")
    temporary = destination.with_suffix(".tmp")
    with tempfile.TemporaryDirectory(prefix="ic-cloud-state-") as directory:
        copy = Path(directory) / "information.sqlite"
        with closing(sqlite3.connect(common.DB_PATH)) as source, closing(sqlite3.connect(copy)) as target:
            source.backup(target)
        check_public_db(copy)
        metadata = {"format": "information-center.native-state", "schema_version": 1,
                    "execution": execution, "saved_at": common.now_iso(), "batch_id": batch_id,
                    "database_sha256": hashlib.sha256(copy.read_bytes()).hexdigest(),
                    "bundle_sha256": hashlib.sha256(bundle.read_bytes()).hexdigest()}
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("state.json", delivery.compact(metadata))
            archive.write(copy, "information.sqlite")
            archive.write(bundle, "latest-batch.zip")
        os.replace(temporary, destination)
    return str(destination)


def restore_state(path):
    if common.DB_PATH.exists():
        return {"status": "existing_state_preserved", "database": str(common.DB_PATH)}
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 256_000_000:
        raise ValueError("invalid state file")
    with zipfile.ZipFile(path) as archive:
        if len(archive.infolist()) != 3 or set(archive.namelist()) != {"state.json", "information.sqlite", "latest-batch.zip"}:
            raise ValueError("unsupported state archive")
        sizes = {"state.json": 20_000, "information.sqlite": 256_000_000, "latest-batch.zip": 64_000_000}
        if any(info.file_size > sizes[info.filename] for info in archive.infolist()):
            raise ValueError("oversized state member")
        metadata = json.loads(archive.read("state.json"))
        if (metadata.get("format") != "information-center.native-state" or metadata.get("schema_version") != 1
                or metadata.get("execution") not in {"codex_cloud", "portable", "offline_validation"}):
            raise ValueError("invalid state metadata")
        batch_id = metadata.get("batch_id")
        if not isinstance(batch_id, str) or not delivery.re.fullmatch(r"batch_[a-f0-9]{32}", batch_id):
            raise ValueError("invalid saved batch identity")
        database, bundle = archive.read("information.sqlite"), archive.read("latest-batch.zip")
    if (hashlib.sha256(database).hexdigest() != metadata["database_sha256"]
            or hashlib.sha256(bundle).hexdigest() != metadata["bundle_sha256"]):
        raise ValueError("state archive incomplete or changed")
    with tempfile.TemporaryDirectory(prefix="ic-cloud-restore-") as directory:
        copy = Path(directory) / "information.sqlite"
        copy.write_bytes(database)
        check_public_db(copy)
    delivery.atomic(common.DATA / "batches" / (batch_id + ".zip"), bundle)
    delivery.atomic(common.DB_PATH, database)
    # A recreated Cloud filesystem can have a different checkout/state path.
    with closing(common.connect()) as db:
        daily = common.state_get(db, "cloud_daily_completed")
        if daily and daily.get("batch_id") == batch_id:
            common.state_set(db, "cloud_daily_completed", {**daily, "bundle_zip": str(common.DATA / "batches" / (batch_id + ".zip"))})
    return {"status": "restored", "batch_id": batch_id, "execution": metadata["execution"]}


def report_output(result, index_path, index, state_path, windows, *, day_status, restored=None):
    """Keep full original collect statistics in a file; stdout is short facts."""
    report_path = common.DATA / "native-reports" / (index["batch"]["batch_id"] + ".report.json")
    previous = json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() else {}
    stats = result.get("collect") or previous.get("collection")
    if not stats:
        # An older invocation may have collected successfully, then failed only
        # while printing. Recover its original run statistics without collecting.
        with closing(common.connect()) as db:
            row = db.execute("SELECT stats_json FROM runs WHERE stage='collect' ORDER BY started_at DESC LIMIT 1").fetchone()
            stats = json.loads(row[0]) if row else None
    report = {"format": "information-center.native-report", "schema_version": 1,
              "batch_id": index["batch"]["batch_id"], "execution": index["batch"]["execution"],
              "collection_status": day_status, "collection": stats,
              "first_invocation": previous.get("first_invocation", result),
              "last_invocation": result, "restoration": restored, "window_files": windows,
              "state_file": state_path, "index_file": str(index_path),
              "saved_at": common.now_iso()}
    delivery.atomic(report_path, delivery.compact(report).encode("utf-8"))
    # Source health/errors remain untouched in manifest, DB and detailed report.
    count_names = ("sources_attempted", "sources_ok", "sources_failed", "items_new", "items_updated", "baselines_created")
    counts = {key: stats[key] for key in count_names if stats and type(stats.get(key)) is int}
    summary = delivery.compact({"status": result["status"], "collection_status": day_status,
          "collect": counts if counts else None, "execution": index["batch"]["execution"],
          "record_count": index["batch"]["record_count"], "state_file": state_path,
          "bundle_file": str(common.DATA / "batches" / (index["batch"]["batch_id"] + ".zip")),
          "index_file": str(index_path), "report_file": str(report_path),
          "part_count": len(index["batch"]["transfer_chunks"]),
          "index_part_count": delivery.index_header(index)[0]["index_part_count"],
          "native_windows_directory": str(index_path.parent / "windows"), "window_count": len(windows),
          "windows_index_file": str(index_path.parent / "windows-index.json"),
          "max_parts_in_stdout_turn": delivery.WINDOW_PARTS, "model_invocations": 0, "git_calls": 0})
    packet = delivery.emit(index_path)
    if len(packet) + len(summary) + 1 > delivery.MAX_STDOUT_CHARS:
        packet = delivery.HEADER_PREFIX + delivery.compact(delivery.index_header(index)[0])
    return delivery.bounded_output(packet + "\n" + summary), report_path


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execution", choices=("portable", "codex_cloud"), default="portable")
    parser.add_argument("--state-dir", type=Path, default=os.environ.get("INFORMATION_CLOUD_STATE_DIR"))
    parser.add_argument("--restore", type=Path)
    parser.add_argument("--source-id", action="append")
    args = parser.parse_args()
    configure(args.state_dir)
    restored = restore_state(args.restore) if args.restore else None
    result = run_collect.run(execution=args.execution, source_ids=args.source_id)
    if result["status"] == "busy":
        print(delivery.compact(result))
        raise SystemExit(2)
    batch_id = result["batch_id"]
    # Read original saved collection health when the daily gate skips the run.
    with closing(common.connect()) as db:
        daily = common.state_get(db, "cloud_daily_completed", {})
    day_status = daily.get("status", result["status"])
    bundle = common.DATA / "batches" / (batch_id + ".zip")
    # Preserve older large artifacts; use a new small-output directory.
    index_path, index = delivery.build(bundle, common.DATA / "native-delivery-small", day_status=day_status)
    windows = delivery.window_files(index_path)
    delivery.atomic(index_path.parent / "windows-index.json", delivery.compact({"files": windows}).encode("utf-8"))
    state_path = save_state(common.DATA / "native-state" / (batch_id + ".state.zip"), batch_id, index["batch"]["execution"])
    output, _ = report_output(result, index_path, index, state_path, windows,
                             day_status=day_status, restored=restored)
    print(output)
    raise SystemExit(0 if day_status == "success" else 2)


if __name__ == "__main__":
    main()

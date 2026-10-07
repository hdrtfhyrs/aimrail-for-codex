"""Import downloaded public collector bundles; never fetch or run remote code."""
from __future__ import annotations
import pathlib as _public_pathlib
import importlib.util as _public_importutil
_public_root = next(p for p in _public_pathlib.Path(__file__).resolve().parents if (p/'public_paths.py').is_file())
_public_spec = _public_importutil.spec_from_file_location('ai_work_public_paths', _public_root/'public_paths.py')
_public_module = _public_importutil.module_from_spec(_public_spec)
_public_spec.loader.exec_module(_public_module)
_public_path = _public_module.public_path

import datetime as dt
import hashlib
import json
import re
import stat
import zipfile
from pathlib import Path

try:
    from . import common, collector
except ImportError:
    import common
    import collector

FORMAT = "information-center.batch"
SCHEMA_VERSION = 1
MAX_MANIFEST_BYTES = 2_000_000
MAX_ARTICLES_BYTES = 64_000_000
MAX_RECORDS = 50_000
CONTENT_STATES = {"metadata", "excerpt", "feed", "full", "page_change"}


def _json_object(payload, label):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON key in {label}: {key}")
            result[key] = value
        return result
    value = json.loads(payload.decode("utf-8-sig"), object_pairs_hook=unique)
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _read_bundle(path):
    path = Path(path).resolve(strict=True)
    if path.is_dir():
        data = {}
        for name, maximum in (("manifest.json", MAX_MANIFEST_BYTES), ("articles.jsonl", MAX_ARTICLES_BYTES)):
            file = path / name
            if file.is_symlink() or not file.is_file() or file.stat().st_size > maximum:
                raise ValueError(f"missing, symlinked or oversized bundle file: {name}")
            data[name] = file.read_bytes()
        return data
    if path.suffix.lower() != ".zip" or path.stat().st_size > MAX_MANIFEST_BYTES + MAX_ARTICLES_BYTES:
        raise ValueError("batch path must be a bundle directory or bounded .zip")
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        # No extraction is performed. Reject extra/nested/traversal entries anyway.
        if len(names) != 2 or set(names) != {"manifest.json", "articles.jsonl"}:
            raise ValueError("zip must contain exactly manifest.json and articles.jsonl at its root")
        data = {}
        for name, maximum in (("manifest.json", MAX_MANIFEST_BYTES), ("articles.jsonl", MAX_ARTICLES_BYTES)):
            info = archive.getinfo(name)
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode) or info.flag_bits & 1 or info.file_size > maximum:
                raise ValueError(f"encrypted, symlinked or oversized zip member: {name}")
            with archive.open(info) as file:
                payload = file.read(maximum + 1)
            if len(payload) > maximum:
                raise ValueError(f"expanded zip member exceeds limit: {name}")
            data[name] = payload
        return data


def _stamp(value, label, nullable=False):
    if value is None and nullable:
        return None
    if not isinstance(value, str) or len(value) > 64:
        raise ValueError(f"invalid {label}")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError(f"invalid ISO timestamp: {label}") from None
    if parsed.tzinfo is None:
        raise ValueError(f"timestamp needs timezone: {label}")
    return parsed.astimezone(dt.timezone.utc).isoformat(timespec="seconds")


def _text(value, label, maximum, required=False):
    if not isinstance(value, str) or len(value) > maximum or "\x00" in value or (required and not value.strip()):
        raise ValueError(f"invalid or oversized text: {label}")
    return value


def _known_source_url(value, source):
    """Accept a current URL or an explicitly configured historical URL.

    Source migrations must preserve already collected public batches without
    allowing a batch to introduce arbitrary sources or change local config.
    """
    candidate = common.canonical_url(value)
    historical = source.get("legacy_urls", [])
    if not isinstance(historical, list):
        historical = []
    allowed = [source["url"], *(url for url in historical if isinstance(url, str))]
    return bool(candidate) and candidate in {
        common.canonical_url(url) for url in allowed
    }


def _validate(data, known):
    manifest = _json_object(data["manifest.json"], "manifest")
    if manifest.get("format") != FORMAT or type(manifest.get("schema_version")) is not int or manifest["schema_version"] != SCHEMA_VERSION:
        raise ValueError("unsupported batch format/schema")
    batch_id = manifest.get("batch_id")
    if not isinstance(batch_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{12,100}", batch_id):
        raise ValueError("invalid batch_id")
    origin = manifest.get("origin")
    if not isinstance(origin, dict) or origin.get("collector") != "codex-cloud-public-collector" or origin.get("execution") not in {"codex_cloud", "portable", "offline_validation"}:
        raise ValueError("invalid collector provenance")
    _stamp(manifest.get("created_at"), "created_at")
    _stamp(manifest.get("collected_at"), "collected_at")
    count = manifest.get("record_count")
    if type(count) is not int or not 0 <= count <= MAX_RECORDS:
        raise ValueError("invalid record_count")
    article_file = manifest.get("articles")
    payload = data["articles.jsonl"]
    digest = hashlib.sha256(payload).hexdigest()
    if not isinstance(article_file, dict) or article_file.get("file") != "articles.jsonl" or article_file.get("bytes") != len(payload) or article_file.get("sha256") != digest:
        raise ValueError("article file metadata/hash mismatch")
    health = manifest.get("sources")
    if not isinstance(health, list) or len(health) > len(known):
        raise ValueError("invalid source health array")
    checked_sources = set()
    for row in health:
        if not isinstance(row, dict) or row.get("source_id") not in known or row["source_id"] in checked_sources:
            raise ValueError("unknown/duplicate source in health")
        source = known[row["source_id"]]
        checked_sources.add(row["source_id"])
        if not _known_source_url(row.get("url", ""), source):
            raise ValueError("health source URL differs from local known configuration")
        for name in ("last_attempt_at", "last_success_at", "next_fetch_at"):
            if row.get(name) is not None:
                _stamp(row[name], "health." + name)
        if row.get("last_error") is not None:
            _text(row["last_error"], "last_error", 2000)
    records, identities = [], set()
    for number, line in enumerate(payload.splitlines(), 1):
        if not line.strip():
            raise ValueError(f"empty article line: {number}")
        row = _json_object(line, f"article {number}")
        source_id = row.get("source_id")
        if source_id not in known or source_id not in checked_sources:
            raise ValueError(f"unknown source or missing health: {source_id}")
        source = known[source_id]
        if row.get("origin") != origin or row.get("batch_id") != batch_id:
            raise ValueError("article batch/origin mismatch")
        if row.get("category") != source["category"]:
            raise ValueError("article category differs from known local source")
        if not _known_source_url(row.get("source_url", ""), source):
            raise ValueError("article source URL differs from known local source")
        external_id = _text(row.get("external_id"), "external_id", 4000, True)
        identity = (source_id, external_id)
        if identity in identities:
            raise ValueError("duplicate article identity in batch")
        identities.add(identity)
        _text(row.get("title"), "title", 1000, True)
        url = _text(row.get("url"), "url", 8000, True)
        if not common.canonical_url(url):
            raise ValueError("article URL must use http(s)")
        _stamp(row.get("published_at"), "published_at", nullable=True)
        row["fetched_at"] = _stamp(row.get("fetched_at"), "fetched_at")
        if row.get("updated_at") is not None:
            row["updated_at"] = _stamp(row["updated_at"], "updated_at")
        _text(row.get("excerpt", ""), "excerpt", 10000)
        _text(row.get("content", ""), "content", 150000)
        if row.get("content_state") not in CONTENT_STATES:
            raise ValueError("unsupported content_state")
        records.append(row)
        if len(records) > MAX_RECORDS:
            raise ValueError("record count exceeds import limit")
    if len(records) != count:
        raise ValueError("manifest record_count does not match articles")
    return manifest, records, digest


def import_batch(path) -> dict:
    """All validation precedes a single atomic import; failures are retryable."""
    stats = {"batch_id": None, "records": 0, "items_new": 0, "items_updated": 0, "duplicate_batch": False, "status": "error", "errors": []}
    db = None
    try:
        known = {source["id"]: source for source in common.sources_config()}
        manifest, records, digest = _validate(_read_bundle(path), known)
        batch_id = manifest["batch_id"]
        stats.update(batch_id=batch_id, records=len(records), origin=manifest["origin"], collected_at=manifest["collected_at"])
        db = common.connect()
        common.sync_sources(db)
        marker_key = "cloud_batch:" + batch_id
        previous = common.state_get(db, marker_key)
        if previous:
            if previous["articles_sha256"] != digest:
                raise ValueError("batch_id already imported with a different payload")
            stats.update(status="success", duplicate_batch=True)
            return stats
        db.execute("BEGIN IMMEDIATE")
        imported_at = common.now_iso()
        for record in records:
            # Never allow remote settings, enabled flags, or executable config.
            source = known[record["source_id"]]
            identity = common.stable_id(source["id"], record["external_id"])
            prior = db.execute("SELECT * FROM items WHERE source_id=? AND external_id=?", (source["id"], record["external_id"])).fetchone()
            incoming = dict(record)
            if prior:
                # Out-of-order cloud batches cannot undo a newer local/cloud copy.
                prior_stamp = prior["updated_at"] or prior["fetched_at"]
                incoming_stamp = incoming.get("updated_at") or incoming["fetched_at"]
                if incoming_stamp < prior_stamp:
                    added = changed = 0
                else:
                    added, changed = collector.store_items(db, source, [incoming], fetched_at=incoming["fetched_at"])
            else:
                added, changed = collector.store_items(db, source, [incoming], fetched_at=incoming["fetched_at"])
            if (added or changed) and incoming.get("updated_at"):
                db.execute("UPDATE items SET updated_at=? WHERE id=?", (incoming["updated_at"], identity))
            stats["items_new"] += added
            stats["items_updated"] += changed
            provenance = {"batch_id": batch_id, "origin": manifest["origin"], "source_id": source["id"], "source_url": source["url"], "cloud_fetched_at": incoming["fetched_at"], "cloud_updated_at": incoming.get("updated_at"), "imported_at": imported_at, "applied": bool(added or changed)}
            db.execute("INSERT INTO state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", ("cloud_item:" + identity, json.dumps(provenance, ensure_ascii=False), imported_at))
        health = {"batch_id": batch_id, "origin": manifest["origin"], "collected_at": manifest["collected_at"], "imported_at": imported_at, "sources": manifest["sources"]}
        for source_id in {record["source_id"] for record in records}:
            db.execute("UPDATE sources SET item_count=(SELECT count(*) FROM items WHERE source_id=?) WHERE id=?", (source_id, source_id))
        current_health = common.state_get(db, "cloud_sources")
        if not current_health or current_health["collected_at"] <= manifest["collected_at"]:
            db.execute("INSERT INTO state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", ("cloud_sources", json.dumps(health, ensure_ascii=False), imported_at))
        stats.update(status="success", imported_at=imported_at)
        marker = {"articles_sha256": digest, "imported_at": imported_at, "origin": manifest["origin"], "records": len(records), "items_new": stats["items_new"], "items_updated": stats["items_updated"]}
        db.execute("INSERT INTO state(key,value,updated_at) VALUES(?,?,?)", (marker_key, json.dumps(marker, ensure_ascii=False), imported_at))
        db.commit()
        return stats
    except Exception as error:
        if db is not None:
            db.rollback()
        stats.update(status="error", items_new=0, items_updated=0)
        stats["errors"].append(f"{type(error).__name__}: {error}")
        return stats
    finally:
        if db is not None:
            db.close()

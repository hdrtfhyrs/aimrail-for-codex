from __future__ import annotations
import pathlib as _public_pathlib
import importlib.util as _public_importutil
_public_root = next(p for p in _public_pathlib.Path(__file__).resolve().parents if (p/'public_paths.py').is_file())
_public_spec = _public_importutil.spec_from_file_location('ai_work_public_paths', _public_root/'public_paths.py')
_public_module = _public_importutil.module_from_spec(_public_spec)
_public_spec.loader.exec_module(_public_module)
_public_path = _public_module.public_path

import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(_public_path('$data/system/信息中心/data'))
REPORTS = Path(_public_path('$data/system/信息中心/reports'))
LOGS = Path(_public_path('$data/system/信息中心/logs'))
CONFIG = Path(_public_path('$data/system/信息中心/config'))
DB_PATH = DATA / "information.sqlite"
SHANGHAI = dt.timezone(dt.timedelta(hours=8))


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def local_time(value: str | None = None) -> str:
    try:
        stamp = dt.datetime.fromisoformat(value.replace("Z", "+00:00")) if value else dt.datetime.now(dt.timezone.utc)
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=dt.timezone.utc)
        return stamp.astimezone(SHANGHAI).strftime("%Y-%m-%d %H:%M")
    except (ValueError, TypeError):
        return value or ""


def ensure_dirs():
    for path in (DATA, REPORTS, LOGS, CONFIG, DATA / "raw", DATA / "ai", DATA / "backups"):
        path.mkdir(parents=True, exist_ok=True)


def settings() -> dict:
    return json.loads((CONFIG / "settings.json").read_text(encoding="utf-8"))


def resolve_codex(config: dict | None = None) -> str:
    config = config or settings()
    installed = Path(config["codex_path"])
    if installed.is_file():
        return str(installed)
    binary = shutil.which("codex.exe") or shutil.which("codex")
    if binary and Path(binary).is_file():
        return binary
    folder = Path(_public_path('$user/AppData/Local/OpenAI/Codex/bin'))
    candidates = sorted(folder.glob("*/codex.exe"), key=lambda path: path.stat().st_mtime, reverse=True)
    if candidates:
        return str(candidates[0])
    raise FileNotFoundError("未找到本机 Codex 程序，现有资料保留，待恢复后继续处理。")


def sources_config() -> list[dict]:
    content = json.loads((CONFIG / "sources.json").read_text(encoding="utf-8"))
    return content["sources"] if isinstance(content, dict) else content


def stable_id(*values) -> str:
    return hashlib.sha256("\x1f".join(str(value) for value in values).encode("utf-8")).hexdigest()[:24]


def canonical_url(value: str) -> str:
    try:
        parts = urllib.parse.urlsplit(value.strip())
        if parts.scheme not in ("http", "https") or not parts.netloc:
            return ""
        query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
        query = [(key, val) for key, val in query if not key.lower().startswith("utm_") and key.lower() not in ("fbclid", "gclid", "mc_cid", "mc_eid")]
        return urllib.parse.urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/") or "/", urllib.parse.urlencode(query), ""))
    except ValueError:
        return ""


def connect() -> sqlite3.Connection:
    ensure_dirs()
    db = sqlite3.connect(DB_PATH, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=30000")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript('''
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, kind TEXT NOT NULL,
        category TEXT NOT NULL, tier TEXT DEFAULT 'community', interval_minutes INTEGER DEFAULT 180,
        enabled INTEGER DEFAULT 1, etag TEXT, last_modified TEXT, last_attempt_at TEXT,
        last_success_at TEXT, last_error TEXT, next_fetch_at TEXT, item_count INTEGER DEFAULT 0,
        consecutive_failures INTEGER DEFAULT 0, http_status INTEGER, config_json TEXT DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL,
        url TEXT NOT NULL, canonical_url TEXT NOT NULL, category TEXT NOT NULL,
        published_at TEXT, fetched_at TEXT NOT NULL, updated_at TEXT, excerpt TEXT DEFAULT '',
        content TEXT DEFAULT '', content_state TEXT DEFAULT 'excerpt', analyzed_at TEXT,
        event_id TEXT, UNIQUE(source_id, external_id)
      );
      CREATE INDEX IF NOT EXISTS items_pending ON items(analyzed_at, published_at);
      CREATE INDEX IF NOT EXISTS items_url ON items(canonical_url);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, disposition TEXT NOT NULL,
        importance INTEGER DEFAULT 0, summary TEXT DEFAULT '', why_useful TEXT DEFAULT '',
        lesson TEXT DEFAULT '', next_action TEXT DEFAULT '', evidence_urls_json TEXT DEFAULT '[]',
        item_ids_json TEXT DEFAULT '[]', evidence_level TEXT DEFAULT 'excerpt',
        confidence TEXT DEFAULT 'medium', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        revision INTEGER DEFAULT 1, notified_revision INTEGER DEFAULT 0,
        action_type TEXT DEFAULT 'none', research_state TEXT DEFAULT 'pending',
        research_json TEXT DEFAULT '{}', feedback TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS decisions (
        item_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, decision_json TEXT NOT NULL,
        model TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT DEFAULT 'pending',
        payload_json TEXT DEFAULT '{}', result_text TEXT DEFAULT '', error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(event_id,kind)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, stage TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
        status TEXT DEFAULT 'running', stats_json TEXT DEFAULT '{}', error TEXT
      );
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    ''')
    db.commit()
    return db


def sync_sources(db: sqlite3.Connection) -> None:
    for source in sources_config():
        db.execute('''INSERT INTO sources(id,name,url,kind,category,tier,interval_minutes,enabled,config_json)
          VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,
          kind=excluded.kind,category=excluded.category,tier=excluded.tier,
          interval_minutes=excluded.interval_minutes,enabled=excluded.enabled,config_json=excluded.config_json''',
          (source["id"], source["name"], source["url"], source.get("kind", "feed"), source["category"],
           source.get("tier", "community"), source.get("interval_minutes", 180), int(source.get("enabled", True)),
           json.dumps(source, ensure_ascii=False)))
    db.commit()


def begin_run(db, stage: str) -> str:
    identity = stable_id(stage, now_iso(), os.getpid(), os.urandom(8).hex())
    db.execute("INSERT INTO runs(id,stage,started_at) VALUES(?,?,?)", (identity, stage, now_iso()))
    db.commit()
    return identity


def end_run(db, identity: str, stats: dict, error: str | None = None):
    db.execute("UPDATE runs SET ended_at=?,status=?,stats_json=?,error=? WHERE id=?",
               (now_iso(), "error" if error else "success", json.dumps(stats, ensure_ascii=False), error, identity))
    db.commit()


def state_get(db, key: str, default=None):
    row = db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
    return json.loads(row[0]) if row else default


def state_set(db, key: str, value):
    db.execute("INSERT INTO state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
               (key, json.dumps(value, ensure_ascii=False), now_iso()))
    db.commit()


def atomic_text(path: str | Path, text: str):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, path)


@contextlib.contextmanager
def job_lock():
    ensure_dirs()
    file = (DATA / "pipeline.lock").open("a+b")
    try:
        if os.name == "nt":
            import msvcrt
            # Reading another process's locked byte raises PermissionError on Windows.
            # File length can be checked without reading the protected region.
            if os.fstat(file.fileno()).st_size == 0:
                file.write(b"0")
                file.flush()
            file.seek(0)
            try:
                msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                yield False
                return
        else:
            import fcntl
            try:
                fcntl.flock(file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                yield False
                return
        yield True
    finally:
        file.close()

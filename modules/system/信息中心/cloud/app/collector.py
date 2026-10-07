"""Incremental public-source collector. Network workers never touch SQLite."""
from __future__ import annotations
import pathlib as _public_pathlib
import importlib.util as _public_importutil
_public_root = next(p for p in _public_pathlib.Path(__file__).resolve().parents if (p/'public_paths.py').is_file())
_public_spec = _public_importutil.spec_from_file_location('ai_work_public_paths', _public_root/'public_paths.py')
_public_module = _public_importutil.module_from_spec(_public_spec)
_public_spec.loader.exec_module(_public_module)
_public_path = _public_module.public_path

import concurrent.futures
import datetime as dt
import difflib
import email.utils
import gzip
import hashlib
import html
import json
import re
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

try:
    from . import common
except ImportError:
    import common

UA = "PersonalInformationCenter/1.0 (+public RSS; conditional requests)"
UTC = dt.timezone.utc


def clean(value):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", value or ""))).strip()


def date_iso(value):
    """Do not substitute fetch time for missing/malformed publication dates."""
    if not value:
        return None
    try:
        stamp = dt.datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except ValueError:
        try:
            stamp = email.utils.parsedate_to_datetime(str(value))
        except (ValueError, TypeError, OverflowError):
            return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=UTC)
    return stamp.astimezone(UTC).isoformat(timespec="seconds")


def _local(tag):
    return tag.rsplit("}", 1)[-1].lower()


def _text(node, names):
    for name in names:
        for child in node:
            if _local(child.tag) == name:
                return "".join(child.itertext()).strip()
    return ""


def _safe_link(value, base, source):
    url = common.canonical_url(urllib.parse.urljoin(base, value or ""))
    if not url:
        return ""
    path = urllib.parse.urlsplit(url).path.lower()
    if re.search(r"/(?:privacy|terms|login|signin|sign-in|signup|register|cookie|contact)(?:/|$)", path):
        return ""
    if any(re.search(pattern, url) for pattern in source.get("exclude_patterns", [])):
        return ""
    if source.get("link_patterns") and not any(re.search(pattern, url) for pattern in source["link_patterns"]):
        return ""
    return url


def parse_feed(payload, source, limit=70):
    try:
        root = ET.fromstring(payload)
    except ET.ParseError:
        # Some valid publisher feeds have malformed XML/HTML entities.
        from lxml import etree
        root = etree.fromstring(payload, parser=etree.XMLParser(recover=True, resolve_entities=False, no_network=True))
    if root is None or _local(root.tag) not in ("rss", "feed", "rdf"):
        raise ValueError("response is not RSS, Atom or RDF")
    entries = [node for node in root.iter() if _local(node.tag) in ("item", "entry")]
    records, seen = [], set()
    for entry in entries:
        title = clean(_text(entry, ("title",)))
        if _local(entry.tag) == "entry":
            link = next((n.get("href", "") for n in entry if _local(n.tag) == "link" and n.get("rel", "alternate") == "alternate"), "")
        else:
            link = _text(entry, ("link",))
        link = _safe_link(link, source["url"], source)
        if not title or not link:
            continue
        identity = _text(entry, ("id", "guid")) or link
        if identity in seen:
            continue
        seen.add(identity)
        description = _text(entry, ("encoded", "content", "description", "summary"))
        content = clean(description)[:50000]
        records.append({"external_id": identity, "title": title[:1000], "url": link,
                        "published_at": date_iso(_text(entry, ("published", "pubdate", "date", "updated"))),
                        "excerpt": content[:5000], "content": content,
                        "content_state": "feed" if content else "metadata"})
        if len(records) >= limit:
            break
    if not records:
        raise ValueError("feed parsed but contains no valid article entries")
    return records


def _html_root(payload):
    from lxml import html as lhtml
    return lhtml.fromstring(payload.decode("utf-8", errors="replace"))


def _watch_scope_id(source):
    scope = {"source_url": common.canonical_url(source["url"]),
             "locale": source["watch_locale"].strip().replace("_", "-").lower(),
             "market": source.get("watch_market"), "extract_xpath": source.get("extract_xpath", "//main"),
             "price_pattern": source.get("price_pattern")}
    return common.stable_id(json.dumps(scope, sort_keys=True))


def _watch_context(root, source, final_url=None):
    """Check the actual page locale/market scope before comparing watched text."""
    actual_locale = (root.get("lang") or "").strip().replace("_", "-").lower()
    canonical_nodes = root.xpath("//link[@rel='canonical']/@href")
    canonical = common.canonical_url(canonical_nodes[0]) if canonical_nodes else ""
    context = {"locale": actual_locale or None, "canonical_url": canonical or None}
    expected = source.get("watch_locale")
    if not expected:
        return context
    expected = expected.strip().replace("_", "-").lower()
    if not actual_locale:
        raise ValueError("watch locale unknown: HTML lang missing; baseline left unchanged")
    if actual_locale != expected:
        raise ValueError(f"watch locale mismatch: expected {expected}, got {actual_locale}; baseline left unchanged")
    requested = common.canonical_url(source["url"])
    final = common.canonical_url(final_url) if final_url else requested
    if source.get("watch_require_final_url") and final != requested:
        raise ValueError("watch market scope changed by redirect; baseline left unchanged")
    allowed_paths = source.get("watch_canonical_paths")
    if allowed_paths:
        parts = urllib.parse.urlsplit(canonical)
        if (not canonical or parts.netloc != urllib.parse.urlsplit(requested).netloc
                or parts.path.rstrip("/") not in {path.rstrip("/") for path in allowed_paths}):
            raise ValueError("watch canonical market scope missing/mismatched; baseline left unchanged")
    context.update(market=source.get("watch_market"), scope_id=_watch_scope_id(source),
                   final_url=final, scope_evidence="fixed locale URL, HTML lang and allowed canonical path")
    return context


def extract_watch(payload, source, *, return_context=False, final_url=None):
    """Price-bearing blocks only, inside explicit content scope, never nav/scripts."""
    root = _html_root(payload)
    context = _watch_context(root, source, final_url)
    for node in root.xpath("//script|//style|//nav|//header|//footer|//aside|//noscript"):
        node.drop_tree()
    scopes = root.xpath(source.get("extract_xpath", "//main"))
    if not scopes:
        raise ValueError("watch content scope missing; baseline left unchanged")
    pattern = source.get("price_pattern", r"(?:[$€£¥￥]\s*\d|\d\s*(?:USD|EUR|/\s*(?:month|mo|million|1M)|美元|元/月)|free tier|免费层)")
    blocks = []
    for scope in scopes:
        for node in scope.xpath(".//p|.//li|.//tr|.//h1|.//h2|.//h3|.//h4|.//h5|.//h6|.//div[not(div or p or li or table)]"):
            value = clean(node.text_content())
            if re.search(pattern, value, re.I) and 1 < len(value) <= 7000:
                # Include the nearby section heading to keep model/plan association.
                headings = node.xpath("preceding::*[self::h1 or self::h2 or self::h3 or self::h4][1]")
                heading = clean(headings[0].text_content()) if headings else ""
                block = (heading + " | " if heading else "") + value
                if block not in blocks:
                    blocks.append(block)
    text = "\n".join(blocks)
    if len(text) < source.get("min_extract_chars", 60):
        raise ValueError("no stable price-bearing content extracted; baseline left unchanged")
    return (text[:150000], context) if return_context else text[:150000]


def parse_html_links(payload, source, limit=70):
    root = _html_root(payload)
    for node in root.xpath("//script|//style|//nav|//header|//footer|//aside"):
        node.drop_tree()
    nodes = root.xpath(source.get("extract_xpath", "//main//a[@href]"))
    records, seen = [], set()
    if not source.get("link_patterns"):
        raise ValueError("html_links requires explicit announcement link_patterns")
    for node in nodes:
        url = _safe_link(node.get("href", ""), source["url"], source)
        title = clean(node.text_content())
        if not url or url in seen or len(title) < 8 or url == common.canonical_url(source["url"]):
            continue
        seen.add(url)
        parent = node.getparent()
        times = parent.xpath(".//time/@datetime") if parent is not None else []
        published = date_iso(times[0]) if times else None
        if not published and source.get("date_pattern"):
            match = re.search(source["date_pattern"], title)
            if match:
                try:
                    published = dt.datetime.strptime(match.group(0), source.get("date_format", "%b %d, %Y")).replace(tzinfo=UTC).isoformat(timespec="seconds")
                except ValueError:
                    pass
        records.append({"external_id": url, "title": title[:1000], "url": url,
                        "published_at": published,
                        "excerpt": "", "content": "", "content_state": "metadata"})
        if len(records) >= limit:
            break
    if not records:
        raise ValueError("no valid announcement links extracted")
    return records


def parse_json(payload, source, limit=70):
    rows = json.loads(payload)
    for part in source.get("json_path", "").split("."):
        if part:
            rows = rows[int(part)] if isinstance(rows, list) else rows[part]
    if not isinstance(rows, list):
        raise ValueError("JSON item path is not a list")
    records = []
    for row in rows:
        url = _safe_link(row.get("html_url") or row.get("url"), source["url"], source)
        title = clean(row.get("name") or row.get("title") or row.get("tag_name"))
        if not url or not title:
            continue
        content = clean(row.get("body") or row.get("description"))[:50000]
        records.append({"external_id": str(row.get("id") or url), "title": title[:1000], "url": url,
                        "published_at": date_iso(row.get("published_at") or row.get("date")),
                        "excerpt": content[:5000], "content": content,
                        "content_state": "feed" if content else "metadata"})
        if len(records) >= limit:
            break
    if not records:
        raise ValueError("JSON contains no valid article entries")
    return records


def _save_raw(payload, source):
    digest = hashlib.sha256(payload).hexdigest()
    directory = common.DATA / "raw" / source["id"]
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (digest + ".raw.gz")
    if not path.exists():
        path.write_bytes(gzip.compress(payload))
    return {"raw_path": str(path), "payload_sha256": digest}


def fetch_source(source, settings, force=False):
    result = {"source_id": source["id"], "ok": False, "http_status": None, "items": []}
    headers = {"User-Agent": UA, "Accept": "*/*", "Accept-Encoding": "gzip"}
    if source.get("accept_language"):
        headers["Accept-Language"] = source["accept_language"]
    baseline_context = source.get("_watch_baseline_context") or {}
    conditional_allowed = not source.get("watch_locale") or (
        baseline_context.get("scope_id") == _watch_scope_id(source)
        and baseline_context.get("locale") == source["watch_locale"].strip().replace("_", "-").lower()
        and baseline_context.get("market") == source.get("watch_market"))
    if not force and conditional_allowed:
        if source.get("etag"):
            headers["If-None-Match"] = source["etag"]
        if source.get("last_modified"):
            headers["If-Modified-Since"] = source["last_modified"]
    try:
        request = urllib.request.Request(source["url"], headers=headers)
        try:
            response = urllib.request.urlopen(request, timeout=settings.get("request_timeout_seconds", 20))
        except urllib.error.HTTPError as error:
            result["http_status"] = error.code
            result["retry_after"] = error.headers.get("Retry-After")
            if error.code == 304:
                result.update(ok=True, not_modified=True)
                return result
            raise
        with response:
            result.update(http_status=response.status, final_url=response.url,
                          etag=response.headers.get("ETag"), last_modified=response.headers.get("Last-Modified"))
            maximum = settings.get("max_response_bytes", 3000000)
            payload = response.read(maximum + 1)
            if len(payload) > maximum:
                raise ValueError(f"response exceeds {maximum} bytes")
            if response.headers.get("Content-Encoding", "").lower() == "gzip":
                # Bound decompression as well as transfer bytes.
                import io
                with gzip.GzipFile(fileobj=io.BytesIO(payload)) as compressed:
                    payload = compressed.read(maximum + 1)
                if len(payload) > maximum:
                    raise ValueError("expanded response exceeds byte limit")
        limit = min(70, settings.get("max_items_per_source", 70))
        kind = source.get("kind", "feed")
        if kind in ("feed", "rss", "atom"):
            result["items"] = parse_feed(payload, source, limit)
        elif kind == "html_watch":
            # A rejected locale is still a traceable observation, never an empty
            # successful fetch. Its old baseline remains untouched.
            result.update(_save_raw(payload, source))
            result["watch_text"], result["watch_context"] = extract_watch(payload, source, return_context=True, final_url=result["final_url"])
        elif kind in ("html_links", "newsroom"):
            result["items"] = parse_html_links(payload, source, limit)
        elif kind in ("json", "github_api"):
            result["items"] = parse_json(payload, source, limit)
        else:
            raise ValueError(f"unsupported source kind: {kind}")
        dates = [item["published_at"] for item in result["items"] if item.get("published_at")]
        if dates:
            result["latest_published_at"] = max(dates)
            age = (dt.datetime.now(UTC) - dt.datetime.fromisoformat(max(dates))).total_seconds() / 86400
            result["stale_feed"] = age > 180
            result["future_dated_items"] = sum(dt.datetime.fromisoformat(value) > dt.datetime.now(UTC) + dt.timedelta(days=2) for value in dates)
        # Content-addressed snapshots do not multiply unchanged responses each run.
        if not result.get("raw_path"):
            result.update(_save_raw(payload, source))
        result["ok"] = True
    except Exception as error:
        result["error"] = f"{type(error).__name__}: {error}"[:1600]
    return result


def store_items(db, source, records, fetched_at=None):
    """Idempotent persistence, also used to verify saved-batch replay."""
    fetched_at = fetched_at or common.now_iso()
    added = changed = 0
    for item in records:
        url = common.canonical_url(item["url"])
        if not url:
            continue
        existing = db.execute("SELECT * FROM items WHERE source_id=? AND external_id=?", (source["id"], item["external_id"])).fetchone()
        fields = (item["title"], url, item.get("published_at"), item.get("excerpt", ""), item.get("content", ""), item.get("content_state", "excerpt"))
        if existing:
            # Research may have enriched an excerpt into fetched article text.
            # Replaying the original feed must not erase that body or retriage it.
            fields = list(fields)
            if existing["content_state"] == "full":
                fields[4], fields[5] = existing["content"], "full"
            if fields[2] is None and existing["published_at"]:
                fields[2] = existing["published_at"]
            fields = tuple(fields)
            original = tuple(existing[key] for key in ("title", "url", "published_at", "excerpt", "content", "content_state"))
            if fields == original:
                continue
            db.execute("UPDATE items SET title=?,url=?,published_at=?,excerpt=?,content=?,content_state=?,canonical_url=?,updated_at=?,analyzed_at=NULL WHERE id=?", (*fields, url, fetched_at, existing["id"]))
            changed += 1
        else:
            db.execute("INSERT INTO items(id,source_id,external_id,title,url,canonical_url,category,published_at,fetched_at,excerpt,content,content_state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                       (common.stable_id(source["id"], item["external_id"]), source["id"], item["external_id"], fields[0], url, url, source["category"], fields[2], fetched_at, fields[3], fields[4], fields[5]))
            added += 1
    return added, changed


def _watch_records(db, source, result, stamp):
    key = "watch:" + source["id"]
    previous = common.state_get(db, key)
    text = result["watch_text"]
    digest = hashlib.sha256(text.encode()).hexdigest()
    state = {"sha256": digest, "text": text, "checked_at": stamp, "raw_path": result.get("raw_path"), "source_url": source["url"]}
    context = result.get("watch_context")
    if context:
        state["watch_context"] = context
    if source.get("watch_locale"):
        expected = source["watch_locale"].strip().replace("_", "-").lower()
        if not context or context.get("locale") != expected or not context.get("scope_id"):
            raise ValueError("watch comparison lacks validated locale scope; baseline left unchanged")
        old_context = (previous or {}).get("watch_context") or {}
        if previous and (old_context.get("scope_id") != context["scope_id"]
                         or old_context.get("locale") != context["locale"]
                         or old_context.get("market") != context.get("market")):
            # Keep the old raw/baseline, but never diff across language/market,
            # changed URLs or a legacy baseline that had no locale evidence.
            history_key = "watch_history:" + source["id"] + ":" + previous["sha256"]
            db.execute("INSERT OR IGNORE INTO state(key,value,updated_at) VALUES(?,?,?)",
                       (history_key, json.dumps(previous, ensure_ascii=False), stamp))
            result["baseline_transition"] = "locale_scope_initialized_or_changed"
            result["previous_baseline_archived"] = history_key
            previous = None
    records = []
    if not previous:
        result["baseline_created"] = True
        state["baseline_at"] = stamp
    else:
        state["baseline_at"] = previous.get("baseline_at", previous.get("checked_at"))
        if digest != previous["sha256"]:
            difference = "\n".join(difflib.unified_diff(previous["text"].splitlines(), text.splitlines(), fromfile="previous", tofile="current", lineterm=""))[:30000]
            # Observation time is not the vendor's release/publication date.
            records.append({"external_id": "change:" + common.stable_id(previous["sha256"], digest),
                            "title": source["name"] + "：套餐/价格页面内容发生变化（待核实）",
                            "url": source["url"], "published_at": None,
                            "excerpt": "检测到官方页面的价格相关内容变化；这不自动表示降价。观察时间：" + stamp + "\n" + difference[:5000],
                            "content": "观察时间：" + stamp + "\n" + difference + "\n当前价格内容：\n" + text[:70000],
                            "content_state": "page_change"})
    # Do not commit source baseline until records and source status can commit together.
    db.execute("INSERT INTO state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", (key, json.dumps(state, ensure_ascii=False), stamp))
    return records


def collect(force=False, source_ids=None, limit_sources=None) -> dict:
    settings = common.settings()
    db = common.connect()
    common.sync_sources(db)
    run_id = common.begin_run(db, "collect")
    stats = {"run_id": run_id, "sources_attempted": 0, "sources_ok": 0, "sources_failed": 0,
             "items_new": 0, "items_updated": 0, "baselines_created": 0, "errors": [], "source_results": []}
    try:
        rows = db.execute("SELECT * FROM sources WHERE enabled=1 ORDER BY category,id").fetchall()
        now = common.now_iso()
        wanted = set(source_ids) if source_ids is not None else None
        sources = []
        for row in rows:
            if wanted is not None and row["id"] not in wanted:
                continue
            if not force and row["next_fetch_at"] and row["next_fetch_at"] > now:
                continue
            source = json.loads(row["config_json"])
            source.update(dict(row))
            if source.get("watch_locale"):
                source["_watch_baseline_context"] = (common.state_get(db, "watch:" + source["id"]) or {}).get("watch_context")
            sources.append(source)
        if limit_sources is not None:
            sources = sources[:max(0, int(limit_sources))]
        stats["sources_attempted"] = len(sources)
        by_id = {s["id"]: s for s in sources}
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(10, max(1, settings.get("collector_workers", 10)))) as pool:
            futures = [pool.submit(fetch_source, source, settings, force) for source in sources]
            for future in concurrent.futures.as_completed(futures):
                result = future.result()
                source = by_id[result["source_id"]]
                stamp = common.now_iso()
                moment = dt.datetime.fromisoformat(stamp)
                db.execute("UPDATE sources SET last_attempt_at=?,http_status=? WHERE id=?", (stamp, result["http_status"], source["id"]))
                if result["ok"]:
                    records = _watch_records(db, source, result, stamp) if "watch_text" in result else result["items"]
                    added, changed = store_items(db, source, records, stamp)
                    stats["items_new"] += added
                    stats["items_updated"] += changed
                    stats["sources_ok"] += 1
                    stats["baselines_created"] += int(result.get("baseline_created", False))
                    next_at = (moment + dt.timedelta(minutes=source["interval_minutes"])).isoformat(timespec="seconds")
                    db.execute("UPDATE sources SET last_success_at=?,last_error=NULL,consecutive_failures=0,next_fetch_at=?,etag=COALESCE(?,etag),last_modified=COALESCE(?,last_modified),item_count=(SELECT COUNT(*) FROM items WHERE source_id=?) WHERE id=?", (stamp, next_at, result.get("etag"), result.get("last_modified"), source["id"], source["id"]))
                    if result.get("raw_path"):
                        common.state_set(db, "snapshot:" + source["id"], {"path": result["raw_path"], "sha256": result["payload_sha256"], "fetched_at": stamp, "url": result.get("final_url", source["url"])})
                else:
                    failures = source["consecutive_failures"] + 1
                    delay = min(1440, 5 * (2 ** min(failures - 1, 9)))
                    retry = result.get("retry_after")
                    if retry:
                        try:
                            delay = max(delay, min(1440, int(retry) / 60))
                        except ValueError:
                            retry_stamp = date_iso(retry)
                            if retry_stamp:
                                delay = max(delay, min(1440, (dt.datetime.fromisoformat(retry_stamp) - moment).total_seconds() / 60))
                    next_at = (moment + dt.timedelta(minutes=delay)).isoformat(timespec="seconds")
                    db.execute("UPDATE sources SET last_error=?,consecutive_failures=?,next_fetch_at=? WHERE id=?", (result["error"], failures, next_at, source["id"]))
                    stats["sources_failed"] += 1
                    stats["errors"].append({"source_id": source["id"], "error": result["error"]})
                db.commit()
                stats["source_results"].append({key: value for key, value in result.items() if key not in ("items", "watch_text")})
        common.end_run(db, run_id, stats, "some sources failed" if stats["sources_failed"] else None)
        return stats
    except Exception as error:
        db.rollback()
        common.end_run(db, run_id, stats, f"{type(error).__name__}: {error}")
        raise
    finally:
        db.close()

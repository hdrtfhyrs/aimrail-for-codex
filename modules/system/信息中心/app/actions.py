from __future__ import annotations
import pathlib as _public_pathlib
import importlib.util as _public_importutil
_public_root = next(p for p in _public_pathlib.Path(__file__).resolve().parents if (p/'public_paths.py').is_file())
_public_spec = _public_importutil.spec_from_file_location('ai_work_public_paths', _public_root/'public_paths.py')
_public_module = _public_importutil.module_from_spec(_public_spec)
_public_spec.loader.exec_module(_public_module)
_public_path = _public_module.public_path

import argparse
import json
from pathlib import Path
import sys

from common import DATA, ROOT, canonical_url, connect, now_iso, stable_id
import evidence_scope


def _read_owned_json(path: str):
    file = Path(path).resolve()
    allowed = [DATA.resolve(), Path(_public_path("$data/system/信息中心/work")).resolve()]
    if not any(file.is_relative_to(folder) for folder in allowed):
        raise ValueError("结果材料须保存在本任务的资料或工作目录。")
    return file, json.loads(file.read_text(encoding="utf-8"))


def finish_research(path: str):
    file, result = _read_owned_json(path)
    required = ("event_id", "overview", "mechanism", "why_useful", "applications", "verified_facts", "remaining_gaps", "source_statuses")
    if any(key not in result for key in required):
        raise ValueError("研究结果缺少必填字段。")
    if not all(isinstance(result[key], str) and result[key].strip() for key in ("event_id", "overview", "mechanism", "why_useful")):
        raise ValueError("研究说明不能为空。")
    statuses = result["source_statuses"]
    documents = []
    for source in statuses:
        source = dict(source)
        if not canonical_url(source.get('url', '')):
            raise ValueError('来源 URL 须为实际 http/https 原件。')
        source.setdefault('text', '')
        text_path = source.get('text_path') or (source.get('scope') or {}).get('text_path')
        if text_path:
            text_file = Path(text_path).resolve()
            if not any(text_file.is_relative_to(folder.resolve()) for folder in (DATA, ROOT / 'work', file.parent)):
                raise ValueError('正文须位于本任务资料/工作目录或本次结果目录。')
            source['text'] = text_file.read_text(encoding='utf-8')
            source['text_path'] = str(text_file)
        documents.append(evidence_scope.document(source))
    valid_urls = {source.get("url") for source in statuses if canonical_url(source.get("url", "")) and source.get("status") in ("full", "excerpt", "read")}
    if not valid_urls:
        raise ValueError("没有实际读到的原件或有效出处。")
    # Old hand-written cards can be continued without inventing old source scope.
    # Unlocated claims remain reports; a new verified fact needs actual source text.
    by_url = {doc['url']: doc for doc in documents}
    verified, reported = [], list(result.get('reported_claims') or [])
    for fact in result['verified_facts']:
        if not fact.get('text') or not fact.get('source_urls') or any(url not in valid_urls for url in fact['source_urls']):
            raise ValueError('事实必须对应实际查过的来源。')
        if fact.get('supports'):
            if not evidence_scope.supported_claim(fact, by_url, True):
                raise ValueError('已核事实缺少各引用来源的实际段落支持。')
            verified.append(fact)
        else:
            reported.append(dict(fact, claim_type='source_report', support_level='unlocated_legacy_report'))
    for claim in reported + result.get('financial_views', []):
        if not claim.get('text') or not claim.get('source_urls') or any(url not in valid_urls for url in claim['source_urls']):
            raise ValueError('来源报告/观点须引用实际查过的来源。')
        if claim.get('supports'):
            evidence_scope.supported_claim(claim, by_url)
    result['verified_facts'] = verified
    result['reported_claims'] = reported
    native_identity = stable_id(result['event_id'], json.dumps(statuses, ensure_ascii=False, sort_keys=True),
                               json.dumps([doc['scope']['provided_sha256'] for doc in documents]))
    native_raw = DATA / 'raw' / ('native-research-' + native_identity)
    native_raw.mkdir(parents=True, exist_ok=True)
    for doc in documents:
        if doc['text'].strip():
            saved_text = native_raw / (stable_id(doc['url']) + '.txt')
            if not saved_text.exists():
                saved_text.write_text(doc['text'], encoding='utf-8')
            doc['text_path'] = str(saved_text)
            doc['scope']['text_path'] = str(saved_text)
    for claim in verified + reported + result.get('financial_views', []):
        if claim.get('supports'):
            evidence_scope.supported_claim(claim, by_url)
    if not (native_raw / 'documents.json').exists():
        (native_raw / 'documents.json').write_text(json.dumps(documents, ensure_ascii=False, indent=2), encoding='utf-8')
    result['source_statuses'] = [evidence_scope.source_status(doc) for doc in documents]
    result['claim_handling'] = '具体事实按实际正文、引文与定位保留；旧未定位陈述为来源报告，旧全文范围不追溯推断。'
    result["researched_at"] = now_iso()
    result["evidence_level"] = evidence_scope.evidence_level(documents)
    result["provenance"] = {"method": "Codex continued source research", "result_file": str(file), 'documents_path': str(native_raw / 'documents.json')}
    result.setdefault("financial_views", [])
    result['blocking_gaps'] = evidence_scope.blocking_gaps(result, documents)
    incomplete = bool(result['blocking_gaps'])
    with connect() as db:
        event = db.execute("SELECT * FROM events WHERE id=?", (result["event_id"],)).fetchone()
        if not event:
            raise ValueError("研究结果对应事件不存在。")
        state = "needs_web" if incomplete else "completed"
        old = json.loads(event["research_json"] or "{}")
        comparison_keys = ("overview", "mechanism", "why_useful", "applications", "verified_facts", "reported_claims", "remaining_gaps", "blocking_gaps", "source_statuses")
        changed = any(old.get(key) != result.get(key) for key in comparison_keys) or event["research_state"] != state
        urls = list(dict.fromkeys(json.loads(event["evidence_urls_json"]) + sorted(valid_urls)))
        if changed and old:
            backup = DATA / 'raw' / 'research-revisions' / (stable_id(event['id'], now_iso(), json.dumps(old, ensure_ascii=False)) + '.json')
            backup.parent.mkdir(parents=True, exist_ok=True)
            backup.write_text(json.dumps(old, ensure_ascii=False, indent=2), encoding='utf-8')
            result['provenance']['previous_card_path'] = str(backup)
        db.execute('''UPDATE events SET research_state=?,research_json=?,evidence_level=?,evidence_urls_json=?,
          updated_at=?,revision=revision+? WHERE id=?''',
          (state, json.dumps(result, ensure_ascii=False), result['evidence_level'], json.dumps(urls, ensure_ascii=False), now_iso(), int(changed), result["event_id"]))
        if incomplete:
            payload = {'event_id': event['id'], 'source_urls': urls, 'remaining_gaps': result['remaining_gaps'],
                       'blocking_gaps': result['blocking_gaps'], 'source_statuses': result['source_statuses'],
                       'continuation': 'native_heartbeat_web_research'}
            db.execute('''INSERT INTO actions(id,event_id,kind,state,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
              ON CONFLICT(event_id,kind) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at''',
              (stable_id(event['id'], 'research'), event['id'], 'research', 'needs_research', json.dumps(payload, ensure_ascii=False), now_iso(), now_iso()))
        db.execute("UPDATE actions SET state=?,result_text=?,updated_at=? WHERE event_id=? AND kind='research'",
                   ("needs_research" if incomplete else "completed", result["overview"], now_iso(), result["event_id"]))
        db.commit()
    return {"status": "saved", "event_id": result["event_id"], "research_state": state, "new_revision": changed}


def finish_action(identity: str, state: str, description: str, artifact: str | None = None):
    if state not in ("completed", "not_applicable", "needs_research", "needs_user", "failed"):
        raise ValueError("未知行动状态。")
    if not description.strip():
        raise ValueError("行动结果必须说明实际做了什么。")
    if artifact and not Path(artifact).is_file():
        raise ValueError("行动产物不存在。")
    with connect() as db:
        action = db.execute("SELECT * FROM actions WHERE id=?", (identity,)).fetchone()
        if not action:
            raise ValueError("行动不存在。")
        text = description + (f"\n产物：{artifact}" if artifact else "")
        changed = action['state'] != state or action['result_text'] != text
        db.execute("UPDATE actions SET state=?,result_text=?,error=?,updated_at=? WHERE id=?",
                   (state, text, description if state == "failed" else None, now_iso(), identity))
        if changed:
            db.execute("UPDATE events SET revision=revision+1,updated_at=? WHERE id=?", (now_iso(), action['event_id']))
        db.commit()
    return {"action_id": identity, "state": state, "result": text}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="接续信息中心的查证与实际行动")
    commands = parser.add_subparsers(dest="command", required=True)
    research = commands.add_parser("research-result")
    research.add_argument("path")
    action = commands.add_parser("action-result")
    action.add_argument("id")
    action.add_argument("state")
    action.add_argument("description")
    action.add_argument("--artifact")
    args = parser.parse_args()
    try:
        value = finish_research(args.path) if args.command == "research-result" else finish_action(args.id, args.state, args.description, args.artifact)
        print(json.dumps(value, ensure_ascii=False, indent=2))
    except Exception as error:
        print(json.dumps({"status": "error", "error": str(error)}, ensure_ascii=False))
        raise SystemExit(1)

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
import sys
import traceback

from common import ROOT, connect, ensure_dirs, job_lock, local_time, now_iso, settings, state_get, state_set


def collection_summary(limit=12):
    """Read persisted collection work; this never starts network or model work."""
    try:
        import task_collection
        return {"status": task_collection.status(limit=limit),
                "host_requests": task_collection.host_requests(limit=limit)}
    except Exception as error:
        return {"status": "unavailable", "error": f"{type(error).__name__}: {error}"}


def continue_collection_tasks():
    """Continue explicit task requests under the existing daily pipeline lock."""
    import task_collection
    file = ROOT / 'config' / 'collection.json'
    config = json.loads(file.read_text(encoding='utf-8-sig')) if file.exists() else {}
    pending = config.get('pending', {})
    if pending.get('enabled', True) is False:
        return {'status': 'paused', 'reason': 'task collection pending.enabled=false'}
    return task_collection.run_pending(max_tasks=int(pending.get('max_tasks', 1)),
                                       max_sources=int(pending.get('max_sources', 3)))


def status() -> dict:
    with connect() as db:
        import queue_policy
        queue = queue_policy.stats(db)
        return {
            "name": settings()["name"], "updated_at": now_iso(), "local_time": local_time(),
            "task_collection": collection_summary(),
            "sources_enabled": db.execute("SELECT COUNT(*) FROM sources WHERE enabled=1").fetchone()[0],
            "sources_succeeded": db.execute("SELECT COUNT(*) FROM sources WHERE enabled=1 AND last_success_at IS NOT NULL").fetchone()[0],
            "sources_failing": db.execute("SELECT COUNT(*) FROM sources WHERE enabled=1 AND consecutive_failures>0").fetchone()[0],
            "articles": db.execute("SELECT COUNT(*) FROM items").fetchone()[0],
            "analyzed": db.execute("SELECT COUNT(*) FROM items WHERE analyzed_at IS NOT NULL").fetchone()[0],
            "pending": queue["model_pending"], "queue": queue,
            "events": db.execute("SELECT COUNT(*) FROM events").fetchone()[0],
            "researched": db.execute("SELECT COUNT(*) FROM events WHERE research_state='completed'").fetchone()[0],
            "categories": {row["category"]: row["count"] for row in db.execute("SELECT category,COUNT(*) AS count FROM items GROUP BY category")},
            "event_categories": {row["category"]: row["count"] for row in db.execute("SELECT category,COUNT(*) AS count FROM events GROUP BY category")},
            "last_pipeline": state_get(db, "last_pipeline", {}),
            "last_iteration": state_get(db, "last_iteration", {}),
            "actions": [dict(row) for row in db.execute("SELECT id,event_id,kind,state,result_text,error FROM actions WHERE state NOT IN ('completed','not_applicable') ORDER BY created_at LIMIT 15")],
            "recent_runs": [dict(row) for row in db.execute("SELECT stage,started_at,ended_at,status,error FROM runs ORDER BY started_at DESC LIMIT 12")]
        }


def inbox(limit=12) -> dict:
    with connect() as db:
        output = {"generated_at": now_iso(), "events": [], "health": [], "actions": []}
        output['iteration_results'] = [dict(row) for row in db.execute('''SELECT a.id AS action_id,a.event_id,a.state,a.result_text,a.error,a.updated_at,e.title,e.revision
          FROM actions a JOIN events e ON e.id=a.event_id WHERE e.revision>e.notified_revision
          AND a.kind IN ('system_model','system_tool') AND a.result_text!=''
          ORDER BY a.updated_at DESC LIMIT ?''', (limit,))]
        events = db.execute('''SELECT * FROM events WHERE revision>notified_revision AND disposition!='archive'
          ORDER BY importance DESC,updated_at DESC''').fetchall()
        # Broad discoveries stay visible; the current AI chooses which to deepen.
        pools = {category: [] for category in settings()["category_labels"]}
        for event in events:
            pools.setdefault(event["category"], []).append(dict(event))
        order = ['ai', 'coding', 'ai', 'coding', 'ai', 'coding', 'finance', 'science', 'world', 'life']
        while len(output["events"]) < limit and any(pools.values()):
            for category in order:
                pool = pools.get(category, [])
                if pool and len(output["events"]) < limit:
                    event = pool.pop(0)
                    detailed = event['category'] in settings().get('detailed_categories', ['ai', 'coding']) or json.loads(event.get('feedback') or '{}').get('value') == 'research'
                    fields = ("id", "title", "category", "disposition", "importance", "summary", "why_useful", "lesson", "next_action", "research_state", "revision", "evidence_urls_json") if detailed else ("id", "title", "category", "disposition", "revision", "evidence_urls_json")
                    record = {key: event[key] for key in fields}
                    if detailed:
                        record['action_results'] = [dict(row) for row in db.execute('SELECT id,kind,state,result_text,error,updated_at FROM actions WHERE event_id=? AND result_text!=\'\' ORDER BY updated_at DESC', (event['id'],))]
                    output["events"].append(record)
        output["health"] = [dict(row) for row in db.execute("SELECT id,name,last_success_at,last_error,consecutive_failures FROM sources WHERE enabled=1 AND consecutive_failures>=3")]
        output["actions"] = [dict(row) for row in db.execute("SELECT a.* FROM actions a JOIN events e ON e.id=a.event_id WHERE a.state IN ('pending','needs_research','ready','failed') AND (e.category IN ('ai','coding') OR e.feedback LIKE '%\"value\": \"research\"%' OR EXISTS(SELECT 1 FROM items i JOIN item_queue q ON q.item_id=i.id WHERE i.event_id=e.id AND q.requested=1)) ORDER BY CASE WHEN a.kind IN ('system_model','system_tool','pricing_check') THEN 0 ELSE 1 END,a.created_at LIMIT ?", (limit,))]
        # Unanalyzed other-domain discoveries are useful titles, independent of model decisions.
        output["headlines"] = [dict(row) for row in db.execute('''SELECT i.id,i.title,i.category,i.url,
          i.published_at,s.name AS source_name,q.content_kind FROM items i
          JOIN item_queue q ON q.item_id=i.id LEFT JOIN sources s ON s.id=i.source_id
          WHERE q.route='headline' AND q.freshness!='expired'
          ORDER BY COALESCE(i.published_at,i.fetched_at) DESC LIMIT ?''', (min(limit, 8),))]
        output['task_collection'] = collection_summary(limit)
        return output


def search(query: str, category: str | None = None, limit: int = 30):
    with connect() as db:
        parameters = [f"%{query}%", f"%{query}%", f"%{query}%"]
        predicate = "(i.title LIKE ? OR i.excerpt LIKE ? OR i.content LIKE ?)"
        if category:
            predicate += " AND i.category=?"
            parameters.append(category)
        parameters.append(limit)
        return [dict(row) for row in db.execute(f'''SELECT i.id,i.title,i.url,i.category,i.published_at,i.content_state,
          i.excerpt,e.disposition,e.summary,e.lesson,e.research_state FROM items i
          LEFT JOIN events e ON i.event_id=e.id WHERE {predicate}
          ORDER BY COALESCE(i.published_at,i.fetched_at) DESC LIMIT ?''', parameters)]


def continue_late_cloud(args=None):
    """Caller holds the pipeline lock; continue new imports without collecting."""
    from processor import analyze, research
    import queue_policy
    config = settings()
    with connect() as db:
        queue_policy.refresh(db)
        cutoff = state_get(db, 'last_pipeline', {}).get('ended_at')
        rows = db.execute('''SELECT i.id FROM items i JOIN state s ON s.key='cloud_item:'||i.id
            JOIN item_queue q ON q.item_id=i.id WHERE i.analyzed_at IS NULL AND q.route='model'
            AND json_extract(s.value,'$.origin.execution')='codex_cloud'
            AND julianday(json_extract(s.value,'$.imported_at'))>julianday(?)
            AND (json_extract(s.value,'$.applied')=1 OR julianday(COALESCE(i.updated_at,i.fetched_at))>julianday(?))
            ORDER BY s.updated_at,i.id''', (cutoff, cutoff)).fetchall() if cutoff else []
        item_ids = [row['id'] for row in rows]
        pending_events = state_get(db, 'late_cloud_followup_events', [])
        review_events = state_get(db, 'last_late_cloud_continuation', {}).get('followup_events', [])
    result = {'status': 'no_unprocessed_cloud_updates', 'cutoff': cutoff, 'item_ids': item_ids,
              'stages': {}, 'errors': [], 'collect_calls': 0}
    if item_ids:
        try:
            maximum = getattr(args, 'batches', None) if args else None
            result['stages']['analyze'] = analyze(max_batches=maximum, item_ids=item_ids)
            if result['stages']['analyze'].get('errors'):
                result['errors'].append({'stage': 'analyze', 'errors': result['stages']['analyze']['errors']})
        except Exception as error:
            result['errors'].append({'stage': 'analyze', 'error': str(error)})
        with connect() as db:
            links = db.execute('SELECT DISTINCT event_id FROM items WHERE id IN (' + ','.join('?' for _ in item_ids) + ') AND analyzed_at IS NOT NULL AND event_id IS NOT NULL', item_ids)
            pending_events = list(dict.fromkeys(pending_events + [row[0] for row in links]))
            state_set(db, 'late_cloud_followup_events', pending_events)
    if pending_events:
        with connect() as db:
            events = [dict(row) for row in db.execute("SELECT id,research_state FROM events WHERE id IN (" + ','.join('?' for _ in pending_events) + ") AND disposition IN ('learn','watch','action') AND (importance>=60 OR action_type='research')", pending_events)]
        ready = [event['id'] for event in events if event['research_state'] == 'pending']
        if ready:
            try:
                maximum = getattr(args, 'research', None) if args else None
                result['stages']['research'] = research(max_events=maximum, event_ids=ready)
                if result['stages']['research'].get('errors'):
                    result['errors'].append({'stage': 'research', 'errors': result['stages']['research']['errors']})
            except Exception as error:
                result['errors'].append({'stage': 'research', 'error': str(error)})
        with connect() as db:
            remaining = [row[0] for row in db.execute("SELECT id FROM events WHERE id IN (" + ','.join('?' for _ in pending_events) + ") AND research_state IN ('pending','running','needs_web','failed') AND disposition IN ('learn','watch','action') AND (importance>=60 OR action_type='research')", pending_events)]
            state_set(db, 'late_cloud_followup_events', remaining)
        result['followup_events'] = pending_events
        result['remaining_followup_events'] = remaining
    candidate_events = list(dict.fromkeys(review_events + pending_events))
    candidates = []
    if candidate_events:
        from common import stable_id
        with connect() as db:
            for event in db.execute("SELECT * FROM events WHERE id IN (" + ','.join('?' for _ in candidate_events) + ") AND category IN ('ai','coding') AND disposition IN ('learn','watch','action') AND research_state IN ('completed','excerpt','needs_web')", candidate_events).fetchall():
                if db.execute("SELECT 1 FROM actions WHERE event_id=? AND kind IN ('system_tool','system_model')", (event['id'],)).fetchone():
                    continue
                identity = stable_id(event['id'], 'system_tool')
                payload = {'origin': 'late_codex_cloud_research', 'event_id': event['id'],
                           'source_urls': json.loads(event['evidence_urls_json']),
                           'research_state': event['research_state'],
                           'purpose': '已有研究卡供本机改进引擎判断适用性；不是已采用、已实施或用户新指令。'}
                db.execute('INSERT OR IGNORE INTO actions(id,event_id,kind,state,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
                           (identity, event['id'], 'system_tool', 'pending', json.dumps(payload, ensure_ascii=False), now_iso(), now_iso()))
                db.execute('UPDATE events SET revision=revision+1,updated_at=? WHERE id=?', (now_iso(), event['id']))
                candidates.append({'action_id': identity, 'event_id': event['id'], 'state': 'pending', 'research_state': event['research_state']})
            db.commit()
    result['iteration_candidates_new'] = candidates
    if item_ids or result['stages'] or candidates:
        result.update(status='partial' if result['errors'] else 'continued', ended_at=now_iso())
        with connect() as db:
            state_set(db, 'last_late_cloud_continuation', result)
    return result


def run_pipeline(args):
    ensure_dirs()
    with job_lock() as acquired:
        if not acquired:
            return {"status": "already_running", "message": "另一轮正在处理；本轮不重复启动。"}
        cloud_downloaded = {"status": "not_enabled"}
        if settings().get("cloud", {}).get("download_enabled"):
            from cloud_download import download_latest
            cloud_downloaded = download_latest()
        if settings().get('cloud', {}).get('automatic_local_receive_enabled', True):
            from cloud_receive import receive_available
            cloud_received = receive_available()
            from cloud_recovery_adapter import recover_under_pipeline_lock
            try:
                cloud_recovered = recover_under_pipeline_lock()
            except Exception as error:
                cloud_recovered = {"status":"error","error":f"{type(error).__name__}: {str(error)[:500]}"}
        else:
            cloud_received = cloud_recovered = {"status": "paused", "reason": "旧Git下载与旧自动接包暂停；指定Codex云端原生结果由专用native-receive接同库，这些本机记录另行续判。"}
        cloud_errors = []
        for cloud_stage, cloud_result in (("cloud_download", cloud_downloaded), ("cloud_receive", cloud_received), ("cloud_recovery",cloud_recovered)):
            if cloud_result.get("errors") or cloud_result.get("issues"):
                cloud_errors.append({"stage": cloud_stage, "errors": cloud_result.get("errors",[]),"issues":cloud_result.get("issues",[])})
            elif cloud_result.get("status") in ("error", "partial"):
                cloud_errors.append({"stage": cloud_stage, "error": cloud_result.get("error", "云阶段未完整完成")})
            elif cloud_result.get("has_more"):
                cloud_errors.append({"stage":cloud_stage,"error":"恢复限额后仍有待接批次","has_more":True})
        today = local_time().split()[0]
        with connect() as db:
            if state_get(db, "daily_run_date") == today and not (args.force_collect or args.force_analysis):
                late_cloud = continue_late_cloud(args)
                try:
                    task_collection_result = continue_collection_tasks()
                except Exception as error:
                    task_collection_result = {'status': 'error', 'error': str(error)}
                task_errors = ([{'stage': 'task_collection', 'error': task_collection_result.get('error'),
                                 'errors': task_collection_result.get('errors', [])}]
                               if task_collection_result.get('status') == 'error' or task_collection_result.get('errors') else [])
                from iteration import run as iterate
                iteration_result = iterate(limit=getattr(args, 'iteration_limit', None) or settings().get('iteration_per_run', 3))
                from publisher import publish
                published = publish()
                iteration_errors = iteration_result.get('errors', [])
                return {"status": "partial" if cloud_errors or iteration_errors or late_cloud['errors'] or task_errors else "already_updated_today", "date": today, "cloud_received":cloud_received,
                        "cloud_downloaded":cloud_downloaded,
                        "cloud_recovered":cloud_recovered,
                        "late_cloud_continuation": late_cloud, "task_collection": task_collection_result, "iteration": iteration_result, "publish": published,
                        "errors": cloud_errors + iteration_errors + late_cloud['errors'] + task_errors,
                        "message": "今天已采集；已接续晚到的原生资料判断与未完成改进，没有重复整轮采集。"}
        from collector import collect
        from processor import analyze, research
        from publisher import publish
        result = {"started_at": now_iso(), "stages": {"cloud_download":cloud_downloaded, "cloud_receive":cloud_received,"cloud_recovery":cloud_recovered}, "errors": cloud_errors}
        with connect() as db:
            previous_attempt = state_get(db, "analysis_last_attempt_at")
            previous_failed = state_get(db, "analysis_last_failed", False)
        interval = settings()["analysis_interval_minutes"]
        try:
            due = not previous_attempt or (dt.datetime.now(dt.timezone.utc)-dt.datetime.fromisoformat(previous_attempt)).total_seconds() >= interval*60
        except (ValueError, TypeError):
            due = True
        # Daily work follows the Shanghai calendar day, including login catch-up.
        # A late update yesterday must not make today's morning cycle wait 24 hours.
        do_analysis = True
        for name, action in [
            ("collect", lambda: collect(force=True)),
            ("task_collection", continue_collection_tasks),
            ("analyze", lambda: analyze(max_batches=args.batches, force=args.force_analysis)),
            ("research", lambda: research(max_events=args.research)),
            ("iteration", lambda: __import__('iteration').run(limit=getattr(args, 'iteration_limit', None) or settings().get('iteration_per_run', 3)))
        ]:
            if name in ("analyze", "research") and not do_analysis:
                result["stages"][name] = {"status": "scheduled_later", "last_attempt_at": previous_attempt,
                                          "interval_minutes": interval}
                continue
            if name == "analyze":
                with connect() as db:
                    state_set(db, "analysis_last_attempt_at", now_iso())
            try:
                stage_result = action()
                result["stages"][name] = stage_result
                if isinstance(stage_result, dict) and stage_result.get("errors"):
                    result["errors"].append({"stage": name, "errors": stage_result["errors"]})
            except Exception as error:
                result["errors"].append({"stage": name, "error": str(error)})
                (ROOT / "logs" / f"{name}-error.log").write_text(traceback.format_exc(), encoding="utf-8")
        result["ended_at"] = now_iso()
        result["status"] = "partial" if result["errors"] else "completed"
        with connect() as db:
            if do_analysis:
                state_set(db, "analysis_last_failed", any(error["stage"] in ("analyze", "research") for error in result["errors"]))
            state_set(db, "last_pipeline", result)
            state_set(db, "daily_run_date", today)
        try:
            result["stages"]["publish"] = publish()
        except Exception as error:
            result["errors"].append({"stage": "publish", "error": str(error)})
            result["status"] = "error"
        with connect() as db:
            state_set(db, "last_pipeline", result)
        return result


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) > 1 and sys.argv[1] == 'task-collect':
        import task_collection
        return task_collection.main(sys.argv[2:])
    parser = argparse.ArgumentParser(description="本机持续信息收集、判断和学习系统")
    commands = parser.add_subparsers(dest="command", required=True)
    task_collect = commands.add_parser('task-collect', help='任务驱动采集、范围、宿主回填、候选与采用记录')
    task_collect.add_argument('arguments', nargs=argparse.REMAINDER)
    run = commands.add_parser("run", help="收集、判断、深查并发布")
    run.add_argument("--force-collect", action="store_true")
    run.add_argument("--force-analysis", action="store_true")
    run.add_argument("--batches", type=int)
    run.add_argument("--research", type=int)
    run.add_argument("--iteration-limit", type=int, help="本次判断行动数量；默认可调，不是用户频率规则")
    iterate = commands.add_parser("iterate", help="用已采集资料接续查证、实施与实际验证，不重复采集")
    iterate.add_argument("--limit", type=int, default=3)
    iterate.add_argument("--action", help="指定已有行动ID")
    iterate.add_argument("--retry", action="store_true", help="跳过未完成行动的临时退避，仍不重做已完成行动")
    commands.add_parser("iteration-status", help="读取迭代产物、失败接续与本人反馈")
    iteration_feedback = commands.add_parser("iteration-feedback", help="保存实际迭代反馈")
    iteration_feedback.add_argument("action_id")
    iteration_feedback.add_argument("value", choices=["useful", "less", "retry"])
    iteration_feedback.add_argument("--note", default="")
    fetch = commands.add_parser("collect", help="仅采集")
    fetch.add_argument("--force", action="store_true")
    fetch.add_argument("--source", action="append", dest="sources")
    commands.add_parser("publish", help="刷新阅读页")
    commands.add_parser("status", help="读取运行状态")
    commands.add_parser("queue", help="刷新并读取普通程序分流队列")
    item = commands.add_parser("item", help="取回完整资料原件")
    item.add_argument("item_id")
    request = commands.add_parser("request", help="本人或当前AI按用途选择某条资料进入分析队列")
    request.add_argument("item_id")
    request.add_argument("--selected-by", choices=['user', 'ai'], default='user')
    request.add_argument("--reason", default='')
    receive = commands.add_parser("cloud-import", help="导入已下载的Codex云数据包")
    receive.add_argument("path")
    commands.add_parser("cloud-receive", help="接收本机已落盘的云端批次")
    read = commands.add_parser("inbox", help="读取尚未通知的有用事件与待处理行动")
    read.add_argument("--limit", type=int, default=12)
    ack = commands.add_parser("ack", help="记录本次实际报告过的事件")
    ack.add_argument("event_ids", nargs="+")
    find = commands.add_parser("search", help="检索全部已收集资料")
    find.add_argument("query")
    find.add_argument("--category", choices=list(settings()["category_labels"]))
    find.add_argument("--limit", type=int, default=30)
    feedback = commands.add_parser("feedback", help="记住这条信息的实际价值")
    feedback.add_argument("event_id")
    feedback.add_argument("value", choices=["useful", "less", "research"])
    feedback.add_argument("--note", default="")
    model = commands.add_parser("models", help="查询账号模型目录和已有升级记录")
    model.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    if args.command == "run":
        value = run_pipeline(args)
    elif args.command == "iterate":
        import iteration
        with job_lock() as acquired:
            if acquired:
                late_cloud = continue_late_cloud()
                value = iteration.run(args.limit, args.action, args.retry)
                value['late_cloud_continuation'] = late_cloud
                if late_cloud['errors']:
                    value['status'] = 'partial'
                    value.setdefault('errors', []).extend(late_cloud['errors'])
                from publisher import publish
                value['publish'] = publish()
            else:
                value = {"status": "already_running"}
    elif args.command == "iteration-status":
        import iteration
        value = iteration.status()
    elif args.command == "iteration-feedback":
        import iteration
        with job_lock() as acquired:
            value = iteration.feedback(args.action_id, args.value, args.note) if acquired else {"status": "already_running"}
    elif args.command == "collect":
        from collector import collect
        with job_lock() as acquired:
            value = collect(force=args.force, source_ids=args.sources) if acquired else {"status": "already_running"}
    elif args.command == "publish":
        from publisher import publish
        with job_lock() as acquired:
            value = publish() if acquired else {"status": "already_running"}
    elif args.command in ("queue", "request"):
        import queue_policy
        with job_lock() as acquired:
            if not acquired:
                value = {"status": "already_running"}
            else:
                with connect() as db:
                    value = queue_policy.request(db, args.item_id, args.selected_by, args.reason) if args.command == "request" else queue_policy.refresh(db)
    elif args.command == "item":
        with connect() as db:
            row = db.execute("SELECT * FROM items WHERE id=?", (args.item_id,)).fetchone()
            value = dict(row) if row else {"status": "error", "error": "资料ID不存在"}
            if row:
                value["event_context"] = None
                if value.get("event_id"):
                    event = db.execute("SELECT * FROM events WHERE id=?", (value["event_id"],)).fetchone()
                    linked_items = db.execute("SELECT * FROM items WHERE event_id=? ORDER BY id", (value["event_id"],)).fetchall()
                    linked_actions = db.execute(
                        "SELECT * FROM actions WHERE event_id=? ORDER BY created_at,id",
                        (value["event_id"],),
                    ).fetchall()
                    event_record = dict(event) if event else None
                    research_record = {}
                    research_parse_error = None
                    if event_record:
                        try:
                            parsed = json.loads(event_record.get("research_json") or "{}")
                            if isinstance(parsed, dict):
                                research_record = parsed
                            else:
                                research_parse_error = "研究记录不是JSON对象；请核原始research_json。"
                        except (ValueError, TypeError):
                            research_parse_error = "研究记录无法解析；请核原始research_json。"
                    value["event_context"] = {
                        "event": event_record,
                        "items_by_id": {linked["id"]: dict(linked) for linked in linked_items},
                        "actions_by_id": {linked["id"]: dict(linked) for linked in linked_actions},
                        "research_context": {
                            "event_id": value["event_id"],
                            "recorded_at": research_record.get("researched_at"),
                            "event_updated_at": event_record.get("updated_at") if event_record else None,
                            "evidence": research_record,
                            "parse_error": research_parse_error,
                            "scope": "仅解析当前已存研究记录，原始research_json保留。recorded_at是研究记录时间，event_updated_at是事件更新时间，均不代表知识有效期。取得层级按source_statuses及support_level读取；reported_claims是来源报告，verified_facts是已存查证陈述，解析成功不代表独立验证。缺失字段不补推断，remaining_gaps继续保留。",
                        },
                        "scope": "仅同事件的已存资料与行动，包含已完成和已通知的行动；取得层级以各条 content_state 为准，行动状态与结果按存储记录返回，不代表完整历史或结论已获支持。",
                    }
    elif args.command == "status":
        value = status()
    elif args.command == "cloud-import":
        from cloud_sync import import_batch
        with job_lock() as acquired:
            value = import_batch(args.path) if acquired else {"status": "already_running"}
    elif args.command == "cloud-receive":
        from cloud_receive import receive_available
        with job_lock() as acquired:
            value = receive_available() if acquired else {"status": "already_running"}
    elif args.command == "inbox":
        value = inbox(args.limit)
    elif args.command == "ack":
        with connect() as db:
            for identity in args.event_ids:
                db.execute("UPDATE events SET notified_revision=revision WHERE id=?", (identity,))
            db.commit()
        value = {"acknowledged": args.event_ids}
    elif args.command == "search":
        value = search(args.query, args.category, args.limit)
    elif args.command == "feedback":
        with connect() as db:
            db.execute("UPDATE events SET feedback=?,importance=MAX(0,MIN(100,importance+?)) WHERE id=?",
                       (json.dumps({"value": args.value, "note": args.note, "date": now_iso()}, ensure_ascii=False),
                        10 if args.value == "useful" else -20 if args.value == "less" else 0, args.event_id))
            if args.value == "research":
                db.execute("UPDATE events SET research_state='pending' WHERE id=?", (args.event_id,))
            db.commit()
        value = {"feedback_saved": args.event_id, "value": args.value}
    else:
        from models import catalog_status
        value = catalog_status(refresh=args.refresh)
    print(json.dumps(value, ensure_ascii=False, indent=2))
    if isinstance(value, dict) and value.get("status") == "error":
        return 1
    if isinstance(value, dict) and value.get("status") == "partial":
        return 2
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "error", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)

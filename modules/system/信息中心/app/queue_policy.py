"""Deterministic routing; retention is independent from model work and publication age."""
from __future__ import annotations
import pathlib as _public_pathlib
import importlib.util as _public_importutil
_public_root = next(p for p in _public_pathlib.Path(__file__).resolve().parents if (p/'public_paths.py').is_file())
_public_spec = _public_importutil.spec_from_file_location('ai_work_public_paths', _public_root/'public_paths.py')
_public_module = _public_importutil.module_from_spec(_public_spec)
_public_spec.loader.exec_module(_public_module)
_public_path = _public_module.public_path

import datetime as dt
import json
import common


def ensure_schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS item_queue (
      item_id TEXT PRIMARY KEY REFERENCES items(id), route TEXT NOT NULL,
      reason TEXT NOT NULL, content_kind TEXT NOT NULL, freshness TEXT NOT NULL,
      requested INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)''')
    db.execute('CREATE INDEX IF NOT EXISTS queue_route ON item_queue(route,item_id)')
    db.execute('''CREATE TABLE IF NOT EXISTS item_selections (
      item_id TEXT PRIMARY KEY REFERENCES items(id), selected_by TEXT NOT NULL,
      reason TEXT NOT NULL, selected_at TEXT NOT NULL)''')


def _json(value):
    try:
        return json.loads(value or '{}')
    except (ValueError, TypeError):
        return {}


def route_item(item, source, config, *, protected=False, requested=False, explicit_interest=False, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    policy = config.get('queue_policy', {})
    kind = source.get('content_kind', 'reference')
    freshness = 'undated'
    date = item.get('published_at')
    if date:
        try:
            stamp = dt.datetime.fromisoformat(date.replace('Z', '+00:00'))
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=dt.timezone.utc)
            age = (now - stamp).total_seconds() / 86400
            days = source.get('news_window_days', policy.get('news_window_days', config.get('lookback_days', 10)))
            freshness = 'expired' if kind == 'news' and days >= 0 and age > days else 'current'
        except (ValueError, TypeError):
            pass
    if item.get('analyzed_at'):
        return 'analyzed', 'existing_analysis_retained', kind, freshness
    if requested or explicit_interest:
        return 'model', 'explicit_request' if requested else 'existing_user_interest', kind, freshness
    if item.get('category') not in config.get('automatic_analysis_categories', config.get('detailed_categories', ['ai', 'coding'])):
        return 'headline', 'awaiting_ai_selection', kind, freshness
    if protected:
        return 'model', 'existing_research_or_action', kind, freshness
    if freshness == 'expired':
        return 'expired', 'news_publication_outside_window', kind, freshness
    return 'model', 'technical_reference_retained' if kind != 'news' else 'current_or_undated_news', kind, freshness


def refresh(db, config=None):
    """Never changes items, decisions, events, actions or notification revisions."""
    config = config or common.settings()
    ensure_schema(db)
    sources = {s['id']: s for s in common.sources_config()}
    protected = set()
    explicit_interests = set()
    for e in db.execute('''SELECT DISTINCT e.id,e.feedback,e.research_state FROM events e
      LEFT JOIN actions a ON a.event_id=e.id WHERE
      e.research_state IN ('pending','running','needs_web','failed') OR e.feedback!=''
      OR a.state NOT IN ('completed','not_applicable')'''):
        feedback = _json(e['feedback'])
        # Current AI may deliberately select cross-domain material through request.
        # Legacy automatic action states alone do not select every item for model work.
        if isinstance(feedback, dict) and feedback.get('value') in ('research', 'useful'):
            explicit_interests.add(e['id'])
        if not isinstance(feedback, dict):
            feedback = {}
        if feedback.get('value') in ('research', 'useful') or e['research_state'] in ('pending','running','needs_web','failed'):
            protected.add(e['id'])
        elif db.execute("SELECT 1 FROM actions WHERE event_id=? AND state NOT IN ('completed','not_applicable')", (e['id'],)).fetchone():
            protected.add(e['id'])
    changed = 0
    stamp = common.now_iso()
    now = dt.datetime.fromisoformat(stamp)
    for row in db.execute('SELECT i.*,q.requested FROM items i LEFT JOIN item_queue q ON q.item_id=i.id').fetchall():
        item = dict(row)
        requested = bool(item.get('requested'))
        values = route_item(item, sources.get(item['source_id'], {}), config,
                            protected=item.get('event_id') in protected, requested=requested,
                            explicit_interest=item.get('event_id') in explicit_interests, now=now)
        previous = db.execute('SELECT route,reason,content_kind,freshness FROM item_queue WHERE item_id=?', (item['id'],)).fetchone()
        if previous is None or tuple(previous) != values:
            db.execute('''INSERT INTO item_queue(item_id,route,reason,content_kind,freshness,requested,updated_at)
              VALUES(?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET route=excluded.route,
              reason=excluded.reason,content_kind=excluded.content_kind,freshness=excluded.freshness,updated_at=excluded.updated_at''',
              (item['id'], *values, int(requested), stamp))
            changed += 1
    db.commit()
    return {'changed': changed, **stats(db)}


def stats(db):
    ensure_schema(db)
    routes = {r['route']: r['n'] for r in db.execute('SELECT route,COUNT(*) n FROM item_queue GROUP BY route')}
    return {'routes': routes, 'model_pending': routes.get('model', 0),
            'raw_unanalyzed': db.execute('SELECT COUNT(*) FROM items WHERE analyzed_at IS NULL').fetchone()[0],
            'by_reason': {r['reason']: r['n'] for r in db.execute('SELECT reason,COUNT(*) n FROM item_queue GROUP BY reason')},
            'expired_headlines': db.execute("SELECT COUNT(*) FROM item_queue WHERE route='headline' AND freshness='expired'").fetchone()[0]}


def request(db, item_id, selected_by='user', reason=''):
    ensure_schema(db)
    if not db.execute('SELECT 1 FROM items WHERE id=?', (item_id,)).fetchone():
        raise ValueError('资料ID不存在')
    db.execute('''INSERT INTO item_queue(item_id,route,reason,content_kind,freshness,requested,updated_at)
      VALUES(?,'model','explicit_request','reference','undated',1,?) ON CONFLICT(item_id)
      DO UPDATE SET requested=1''', (item_id, common.now_iso()))
    db.execute('''INSERT INTO item_selections(item_id,selected_by,reason,selected_at) VALUES(?,?,?,?)
      ON CONFLICT(item_id) DO UPDATE SET selected_by=excluded.selected_by,reason=excluded.reason,
      selected_at=excluded.selected_at''', (item_id, selected_by, reason, common.now_iso()))
    db.commit()
    return refresh(db)


def allowance(db, source_id, config=None):
    config = config or common.settings()
    policy = config.get('queue_policy', {})
    source = next((s for s in common.sources_config() if s['id'] == source_id), {})
    cap = int(source.get('model_daily_limit', policy.get('model_daily_per_source', 12)))
    start = dt.datetime.now(common.SHANGHAI).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(dt.timezone.utc).isoformat()
    used = db.execute('''SELECT COUNT(*) FROM decisions d JOIN items i ON i.id=d.item_id
      WHERE i.source_id=? AND julianday(d.created_at)>=julianday(?)''', (source_id, start)).fetchone()[0]
    return max(0, cap-used)

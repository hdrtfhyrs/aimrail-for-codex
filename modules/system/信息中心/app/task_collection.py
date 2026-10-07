"""Task-driven source acquisition in the existing information database."""
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
import html
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.parse
import uuid

import common

PROJECT = common.ROOT.parent
_collection_config = common.CONFIG / 'collection.json'
_raw_directory = json.loads(_collection_config.read_text(encoding='utf-8-sig')).get('raw_directory') if _collection_config.exists() else None
RAW = Path(_raw_directory) if _raw_directory else common.DATA / 'raw' / 'task-collection'
SCRIPTS = {
    'public': Path(_public_path('$plugins/search-tools/cli.mjs')),
    **{key: PROJECT.parent / 'search-integrations' / name for key, name in {
        'domestic': 'domestic-search.mjs', 'international': 'international-search.mjs',
        'github': 'github-search.mjs', 'bilibili': 'bilibili-collection.mjs'}.items()}}


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _load(value, default=None):
    try:
        return json.loads(value) if value else default
    except (ValueError, TypeError):
        return default


def configuration():
    file = common.CONFIG / 'collection.json'
    return json.loads(file.read_text(encoding='utf-8-sig')) if file.exists() else {}


def _connect():
    db = common.connect()
    db.executescript('''
      CREATE TABLE IF NOT EXISTS collection_tasks (
        id TEXT PRIMARY KEY, query TEXT NOT NULL, purpose TEXT NOT NULL,
        project TEXT, branch TEXT, event_id TEXT, request_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', discovery_json TEXT DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        lease_token TEXT, lease_until TEXT, attempts INTEGER DEFAULT 0, error TEXT);
      CREATE INDEX IF NOT EXISTS collection_event ON collection_tasks(event_id);
      CREATE TABLE IF NOT EXISTS collection_sources (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, url TEXT NOT NULL,
        canonical_url TEXT NOT NULL, provider TEXT NOT NULL, title TEXT DEFAULT '',
        state TEXT DEFAULT 'pending', document_id TEXT, attempts INTEGER DEFAULT 0,
        error TEXT, next_attempt_at TEXT, updated_at TEXT NOT NULL,
        UNIQUE(task_id, canonical_url));
      CREATE TABLE IF NOT EXISTS collection_documents (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source_id TEXT NOT NULL,
        url TEXT NOT NULL, title TEXT, text TEXT NOT NULL, scope_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL, raw_path TEXT NOT NULL, text_path TEXT NOT NULL,
        retrieved_at TEXT, commit_sha TEXT, item_id TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS collection_document_task ON collection_documents(task_id,created_at);
      CREATE TABLE IF NOT EXISTS collection_adoptions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL,
        source_ids_json TEXT NOT NULL, payload_json TEXT NOT NULL,
        artifact TEXT, created_at TEXT NOT NULL);
    ''')
    db.commit()
    return db


def _url(value):
    return common.canonical_url(str(value or ''))


def _provider(url):
    host = urllib.parse.urlsplit(url).hostname or ''
    if host in ('github.com', 'raw.githubusercontent.com'):
        return 'github'
    if host.endswith('bilibili.com'):
        return 'bilibili'
    if host in ('linux.do', 'www.v2ex.com', 'v2ex.com', 'tieba.baidu.com'):
        return 'domestic'
    if host in ('news.ycombinator.com', 'www.reddit.com', 'reddit.com') or host.startswith('discuss.'):
        return 'international'
    return 'public'


def _source(task_id, url, title='', provider=None, state='pending'):
    canonical = _url(url)
    if not canonical:
        return None
    identity = 'cs_' + common.stable_id(task_id, canonical)
    with _connect() as db:
        db.execute('''INSERT INTO collection_sources(id,task_id,url,canonical_url,provider,title,state,updated_at)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(task_id,canonical_url) DO UPDATE SET
          title=CASE WHEN collection_sources.title='' THEN excluded.title ELSE collection_sources.title END''',
          (identity, task_id, url, canonical, provider or _provider(url), title or '', state, common.now_iso()))
        db.commit()
    return identity


def request_task(payload):
    if not isinstance(payload, dict) or not str(payload.get('query', '')).strip() or not str(payload.get('purpose', '')).strip():
        raise ValueError('采集请求须有当前问题 query 和用途 purpose。')
    value = dict(payload)
    value['query'], value['purpose'] = value['query'].strip(), value['purpose'].strip()
    value.setdefault('sources', configuration().get('default_sources', list(SCRIPTS)))
    if any(source not in SCRIPTS for source in value['sources']):
        raise ValueError('来源可用 public/domestic/github/international/bilibili。')
    identity = str(value.get('id') or 'ct_' + common.stable_id(value.get('project'), value.get('branch'), value.get('event_id'), value['query'], value['purpose']))
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', identity):
        raise ValueError('任务ID须为字母、数字、下划线或横线，不能含目录路径。')
    stamp = common.now_iso()
    with _connect() as db:
        old = db.execute('SELECT request_json FROM collection_tasks WHERE id=?', (identity,)).fetchone()
        if old:
            previous = _load(old[0], {})
            for field in ('project', 'branch', 'event_id'):
                if previous.get(field) != value.get(field):
                    raise ValueError('该任务ID已有不同目标；保留原任务，使用新的请求ID。')
            if previous != value:
                common.atomic_text(RAW / identity / ('request-before-' + common.stable_id(_json(previous)) + '.json'), _json(previous))
            value['seed_urls'] = list(dict.fromkeys(previous.get('seed_urls', []) + value.get('seed_urls', [])))
            value['gaps'] = value.get('gaps', previous.get('gaps', []))
            db.execute('UPDATE collection_tasks SET query=?,purpose=?,request_json=?,updated_at=?,discovery_json=CASE WHEN query!=? THEN ? ELSE discovery_json END WHERE id=?',
                       (value['query'], value['purpose'], _json(value), stamp, value['query'], '{}', identity))
        else:
            db.execute('''INSERT INTO collection_tasks(id,query,purpose,project,branch,event_id,request_json,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?,?)''', (identity, value['query'], value['purpose'], value.get('project'), value.get('branch'), value.get('event_id'), _json(value), stamp, stamp))
        db.commit()
    for seed in value.get('seed_urls', []):
        _source(identity, seed)
    return {'status': 'saved', 'id': identity, 'created': not bool(old), 'state': show_task(identity)['state']}


def ensure_event_request(event, source_urls=None, gaps=None):
    event = dict(event)
    return request_task({'id': 'ct_event_' + str(event['id']), 'event_id': event['id'],
        'query': event.get('title') or '研究事件 ' + str(event['id']),
        'purpose': '接续事件原文与应用：' + (event.get('why_useful') or event.get('summary') or event.get('title') or str(event['id'])),
        'project': str(PROJECT), 'branch': 'information-research',
        'seed_urls': list(source_urls or []), 'gaps': list(gaps or []),
        'category': event.get('category'), 'sources': configuration().get('default_sources', ['public', 'github'])})


def attach_event(task_id, event_id):
    task = show_task(task_id)
    if task.get('event_id') and task['event_id'] != event_id:
        raise ValueError('本任务已有另一事件关联，保留其来源关系。')
    request = dict(task['request'], id=task_id, event_id=event_id)
    with _connect() as db:
        if not db.execute('SELECT 1 FROM events WHERE id=?', (event_id,)).fetchone():
            raise ValueError('关联的实际事件不存在。')
        db.execute('UPDATE collection_tasks SET event_id=?,request_json=?,updated_at=? WHERE id=?', (event_id, _json(request), common.now_iso(), task_id))
        db.commit()
    return {'status': 'linked', 'id': task_id, 'event_id': event_id}


def show_task(task_id):
    with _connect() as db:
        row = db.execute('SELECT * FROM collection_tasks WHERE id=?', (task_id,)).fetchone()
        if row is None:
            raise ValueError('采集任务ID不存在。')
        result = dict(row)
        result['request'] = _load(result.pop('request_json'), {})
        result['discovery'] = _load(result.pop('discovery_json'), {})
        result.pop('lease_token', None)
        result['sources'] = [dict(r) for r in db.execute('SELECT * FROM collection_sources WHERE task_id=? ORDER BY rowid', (task_id,))]
        result['documents'] = [_document_row(r, include_text=True) for r in db.execute('SELECT * FROM collection_documents WHERE task_id=? ORDER BY created_at DESC', (task_id,))]
        result['adoptions'] = [dict(r) for r in db.execute('SELECT * FROM collection_adoptions WHERE task_id=? ORDER BY created_at', (task_id,))]
        return result


def _document_row(row, include_text=True):
    row = dict(row)
    scope = _load(row['scope_json'], {})
    return {'document_id': row['id'], 'source_id': row['source_id'], 'task_id': row['task_id'],
        'url': row['url'], 'title': row['title'], 'text': row['text'] if include_text else '',
        'status': 'full' if scope.get('completeness') == 'complete' and scope.get('text_truncated') is False else 'excerpt',
        'detail': scope.get('read_range', ''), 'resolved_url': row['url'], 'scope': scope,
        'raw_path': row['raw_path'], 'text_path': row['text_path'], 'retrieved_at': row['retrieved_at'],
        'commit_sha': row['commit_sha'], 'item_id': row['item_id'], 'coverage': _load(row['evidence_json'], {}).get('coverage', {}),
        'truncated': scope.get('text_truncated')}


def _save_document(task_id, source_id, value, origin='tool', item_id=None):
    text = str(value.get('text') or '').strip()
    if not text:
        raise ValueError('没有取得正文；搜索摘要/空返回不保存为正文。')
    url = value.get('url') or value.get('source_url') or value.get('requested_url')
    if not _url(url):
        raise ValueError('实际正文缺少有效来源URL。')
    scope = dict(value.get('scope') or {})
    scope.setdefault('content_type', value.get('evidence_level') or 'source_text')
    scope.setdefault('completeness', 'unknown')
    scope.setdefault('read_range', '本次来源文本；分页与动态内容完整范围未知')
    scope.setdefault('text_truncated', value.get('truncated'))
    scope.setdefault('unknowns', [] if scope['completeness'] == 'complete' else ['范围外内容尚未确认'])
    maximum = int(configuration().get('max_chars_per_document', 30000))
    if len(text) > maximum:
        scope['text_truncated'] = True
        scope['total_extracted_chars'] = len(text)
        text = text[:maximum]
    scope['origin'] = origin
    scope['provided_chars'] = len(text)
    identity = 'cd_' + common.stable_id(source_id, url, text, _json(scope))
    directory = RAW / task_id
    directory.mkdir(parents=True, exist_ok=True)
    raw_path, text_path = directory / (identity + '.json'), directory / (identity + '.txt')
    if not raw_path.exists():
        common.atomic_text(raw_path, _json(value))
        common.atomic_text(text_path, text)
    scope.update(raw_path=str(raw_path), text_path=str(text_path))
    stamp = common.now_iso()
    with _connect() as db:
        inserted = db.execute('''INSERT OR IGNORE INTO collection_documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
          (identity, task_id, source_id, url, value.get('title', ''), text, _json(scope), _json(value), str(raw_path), str(text_path),
           value.get('retrieved_at') or value.get('fetched_at') or stamp, value.get('commit_sha'), item_id, stamp))
        old = db.execute('''SELECT d.text,d.scope_json FROM collection_sources s LEFT JOIN collection_documents d ON d.id=s.document_id WHERE s.id=?''', (source_id,)).fetchone()
        old_scope = _load(old['scope_json'], {}) if old else {}
        prefer = old is None or not old['text'] or (old_scope.get('origin') == 'existing_item' and origin != 'existing_item') or len(text) >= len(old['text']) or (scope['completeness'] == 'complete' and old_scope.get('completeness') != 'complete')
        if prefer:
            db.execute('UPDATE collection_sources SET document_id=?,state=?,error=NULL,next_attempt_at=NULL,updated_at=? WHERE id=?',
              (identity, 'read' if scope['completeness'] == 'complete' and scope['text_truncated'] is False else 'read_partial', stamp, source_id))
        if inserted.rowcount:
            # New source text resumes its own blocked event; replayed documents do not.
            db.execute("UPDATE events SET research_state='pending',updated_at=? WHERE id=(SELECT event_id FROM collection_tasks WHERE id=?) AND research_state='needs_web'", (stamp, task_id))
        db.commit()
    return identity


def _reuse_local(task):
    request = task['request']
    terms = [str(t).strip() for t in request.get('keywords', []) if str(t).strip()] or [request['query']]
    predicates, params = [], []
    for term in terms[:8]:
        predicates.append('(title LIKE ? OR excerpt LIKE ? OR content LIKE ?)')
        params.extend(['%' + term + '%'] * 3)
    with _connect() as db:
        rows = db.execute('SELECT * FROM items WHERE ' + ' OR '.join(predicates) + ' ORDER BY length(content) DESC LIMIT ?',
                          params + [int(configuration().get('local_limit', 12))]).fetchall()
    reused = 0
    for row in rows:
        row = dict(row)
        text = row.get('content') or row.get('excerpt')
        if not text or not _url(row['url']):
            continue
        source_id = _source(task['id'], row['url'], row['title'])
        with _connect() as db:
            source = db.execute('SELECT document_id FROM collection_sources WHERE id=?', (source_id,)).fetchone()
        if source['document_id']:
            with _connect() as db:
                db.execute("UPDATE collection_sources SET state='reference' WHERE id=? AND state='pending' AND document_id IN (SELECT id FROM collection_documents WHERE json_extract(scope_json,'$.origin')='existing_item')", (source_id,))
                db.commit()
            continue
        _save_document(task['id'], source_id, {'url': row['url'], 'title': row['title'], 'text': text,
          'retrieved_at': row['fetched_at'], 'evidence_level': 'existing_' + row['content_state'],
          'scope': {'content_type': row['content_state'], 'completeness': 'unknown', 'text_truncated': None,
                    'read_range': '原库资料 ' + row['id'] + '；旧完整范围不追溯推断', 'unknowns': ['原库状态不证明完整范围']}},
          origin='existing_item', item_id=row['id'])
        # Local lexical matches are references; AI chooses which need a new external read.
        with _connect() as db:
            db.execute("UPDATE collection_sources SET state='reference' WHERE id=?", (source_id,))
            db.commit()
        reused += 1
    return reused


def _tool(provider, arguments):
    config = configuration()
    day = common.local_time().split()[0]
    key = 'collection_tool_calls:' + day
    with _connect() as db:
        db.execute('BEGIN IMMEDIATE')
        count = int(common.state_get(db, key, 0))
        if count >= int(config.get('max_tool_calls_per_day', 40)):
            db.rollback()
            return {'status': 'budget_deferred', 'detail': '本日采集工具调用工作量已用完，明日接续；不是平台额度观测'}
        common.state_set(db, key, count + 1)
        db.commit()
    executable = config.get('node_path') or shutil.which('node')
    if not executable:
        return {'status': 'runtime_unavailable', 'detail': 'Node执行入口未找到'}
    try:
        process = subprocess.run([executable, str(SCRIPTS[provider]), *map(str, arguments)],
          shell=False, capture_output=True, encoding='utf-8', errors='replace', timeout=int(config.get('tool_timeout_seconds', 90)),
          env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'})
        value = _load(process.stdout.strip().lstrip('\ufeff'))
        if not isinstance(value, dict):
            return {'status': 'unexpected_tool_output', 'exit_code': process.returncode, 'detail': process.stderr[:1000] or process.stdout[:1000]}
        value['_tool_exit_code'] = process.returncode
        return value
    except subprocess.TimeoutExpired:
        return {'status': 'timeout', 'detail': '来源工具超时，成功部分和任务仍保存'}
    except (OSError, ValueError) as error:
        return {'status': 'tool_error', 'detail': str(error)[:1000]}


def _discovery_candidates(provider, result):
    rows = result.get('results') or result.get('hits') or result.get('items') or []
    if provider == 'github' and isinstance(rows, list):
        return [{'url': r.get('url') or r.get('html_url'), 'title': r.get('full_name') or r.get('name', '')} for r in rows]
    if not rows and isinstance(result.get('sites'), list):
        rows = [row for site in result['sites'] for row in site.get('results', [])]
    return [{'url': r.get('url') or r.get('source_url'), 'title': r.get('title', '')} for r in rows if isinstance(r, dict)]


def _discover(task):
    completed = dict(task['discovery'])
    request = task['request']
    count = int(configuration().get('discovery_count', 3))
    for provider in request.get('sources', []):
        if provider in completed and completed[provider].get('state') in ('done', 'needs_host'):
            continue
        query = request.get('search_queries', {}).get(provider) or request['query']
        arguments = ['search', '--query', query]
        if provider == 'github':
            arguments += ['--kind', 'repositories', '--per-page', str(count)]
        elif provider == 'domestic':
            arguments += ['--sites', configuration().get('domestic_sites', 'v2ex,linuxdo,zhihu,tieba,csdn'), '--count', str(count)]
        elif provider == 'international':
            arguments += ['--source', 'hn', '--count', str(count)]
        elif provider == 'bilibili':
            arguments += ['--count', str(count)]
        result = _tool(provider, arguments)
        path = RAW / task['id'] / ('discovery-' + provider + '-' + common.stable_id(_json(result)) + '.json')
        common.atomic_text(path, _json(result))
        candidates = _discovery_candidates(provider, result)
        added = [sid for candidate in candidates[:count] if (sid := _source(task['id'], candidate.get('url'), candidate.get('title'), state='candidate'))]
        state = 'done' if added or result.get('status') == 'ok' else 'needs_host' if result.get('status') != 'budget_deferred' else 'budget_deferred'
        completed[provider] = {'state': state, 'query': query, 'status': result.get('status'), 'source_ids': added,
                               'raw_path': str(path), 'retrieved_at': result.get('retrieved_at') or common.now_iso()}
        with _connect() as db:
            db.execute('UPDATE collection_tasks SET discovery_json=?,updated_at=? WHERE id=?', (_json(completed), common.now_iso(), task['id']))
            db.commit()
        if result.get('status') == 'budget_deferred':
            break
    return completed


def _github_read(url):
    parsed = urllib.parse.urlsplit(url)
    parts = [urllib.parse.unquote(p) for p in parsed.path.strip('/').split('/')]
    if len(parts) < 2:
        raise ValueError('GitHub来源缺作者和仓库')
    repo = '/'.join(parts[:2])
    if parsed.hostname == 'raw.githubusercontent.com' and len(parts) >= 4:
        return _tool('github', ['file', '--repo', repo, '--ref', parts[2], '--path', '/'.join(parts[3:]), '--max-lines', '500', '--max-chars', '30000'])
    if len(parts) >= 4 and parts[2] in ('issues', 'pull') and parts[3].isdigit():
        return _tool('github', ['issue', '--repo', repo, '--number', parts[3], '--max-pages', '1'])
    ref, file = (parts[3], '/'.join(parts[4:])) if len(parts) >= 5 and parts[2] == 'blob' else ('HEAD', 'README.md')
    return _tool('github', ['file', '--repo', repo, '--ref', ref, '--path', file, '--max-lines', '500', '--max-chars', '30000'])


def _read_source(source):
    provider, url = source['provider'], source['url']
    if provider == 'github':
        result = _github_read(url)
    elif provider == 'bilibili':
        result = _tool(provider, ['read', '--url', url, '--comment-limit', '10', '--max-parts', '1'])
    elif provider == 'international':
        result = _tool(provider, ['read', '--url', url, '--max-posts', '20'])
    else:
        result = _tool(provider, ['read', '--url', url, '--max-length', '30000'])
    scope = {'content_type': result.get('evidence_level') or 'unknown', 'completeness': 'unknown',
             'text_truncated': result.get('truncated'), 'read_range': '本次单个来源的实际文字，范围外内容未知',
             'unknowns': ['分页、动态内容、正文结构及范围外内容尚未全部确认']}
    text = result.get('text', '')
    actual_url = result.get('source_url') or result.get('final_url') or url
    title = result.get('title') or result.get('path') or source['title']
    if provider == 'github' and result.get('content'):
        text = result['content']
        actual_url = result.get('source_url') or url
        scope.update(content_type='source_code', read_range=f"固定提交 {result.get('commit_sha')} 的 {result.get('path')} 第{result.get('start_line')}—{result.get('end_line')}行",
          completeness='complete' if result.get('truncated') is False else 'partial', text_truncated=bool(result.get('truncated')),
          commit_sha=result.get('commit_sha'), start_line=result.get('start_line'), end_line=result.get('end_line'),
          next_start_line=result.get('next_start_line'), unknowns=['其他文件未读'] if result.get('truncated') is False else ['文件其余行未读'])
    elif provider == 'github' and isinstance(result.get('issue'), dict):
        issue = result['issue']
        text = '\n\n'.join([issue.get('body') or ''] + [comment.get('body') or '' for comment in result.get('comments', [])])
        title = issue.get('title', title)
        scope.update(content_type='issue_body_and_comments', read_range='issue正文及本次返回评论',
          comments_complete=result.get('comments_complete'), unknowns=[] if result.get('comments_complete') else ['更多评论或后续编辑未读'])
    elif provider == 'international' and result.get('posts'):
        text = '\n\n'.join(str(post.get('text') or post.get('content') or post.get('body') or '') for post in result['posts'])
    elif provider == 'bilibili':
        video = result.get('video') or {}
        title = video.get('title') or title
        fragments = ['视频简介：' + str(video.get('desc') or video.get('description') or '')]
        comments = result.get('comments') or {}
        fragments += ['评论：' + str(comment.get('text') or comment.get('content') or '') for comment in comments.get('comments', [])]
        subtitles = result.get('subtitles') or {}
        for part in subtitles.get('parts', []):
            for track in part.get('tracks', []):
                fragments += ['字幕：' + str(segment.get('text') or '') for segment in track.get('segments', [])]
        text = '\n'.join(fragments) if any(len(fragment) > 6 for fragment in fragments) else ''
        scope.update(content_type='video_metadata_comments_subtitles', read_range='已返回简介、评论和字幕段；视频画面/音频未读',
                     unknowns=['视频画面、音频及未返回评论/字幕未读'])
    if result.get('coverage'):
        scope['coverage'] = result['coverage']
    if result.get('next_offset') is not None:
        scope['next_offset'] = result['next_offset']
    evidence_level = str(result.get('evidence_level') or '')
    blocked = any(marker in str(text)[:1800].lower() for marker in ('verify you are human', 'checking your browser', 'just a moment...', 'access denied'))
    if not text or evidence_level in ('search_snippet', 'search_snippets_only', 'none') or blocked:
        return None, result
    if provider == 'international':
        text = html.unescape(re.sub(r'<[^>]+>', '', str(text)))
    value = {'url': actual_url, 'title': title, 'text': str(text), 'scope': scope,
             'retrieved_at': result.get('retrieved_at') or common.now_iso(), 'commit_sha': result.get('commit_sha'),
             'evidence_level': result.get('evidence_level'), 'coverage': result.get('coverage', {}), 'tool_result': result}
    return value, result


def _lease(task_id):
    token, stamp = uuid.uuid4().hex, common.now_iso()
    until = (dt.datetime.fromisoformat(stamp) + dt.timedelta(seconds=int(configuration().get('lease_seconds', 1200)))).isoformat()
    with _connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT lease_token,lease_until FROM collection_tasks WHERE id=?', (task_id,)).fetchone()
        if not row:
            raise ValueError('采集任务不存在')
        if row['lease_token'] and row['lease_until'] and dt.datetime.fromisoformat(row['lease_until']) > dt.datetime.fromisoformat(stamp):
            db.rollback()
            return None
        db.execute("UPDATE collection_tasks SET lease_token=?,lease_until=?,state='running',attempts=attempts+1,updated_at=? WHERE id=?", (token, until, stamp, task_id))
        db.execute("UPDATE collection_sources SET state='pending' WHERE task_id=? AND state='in_flight'", (task_id,))
        db.commit()
    return token


def run_task(task_id, max_sources=6, discover=True, retry=False):
    token = _lease(task_id)
    if not token:
        return {'status': 'already_running', 'id': task_id}
    result = {'id': task_id, 'status': 'completed', 'sources_read': 0, 'sources_failed': 0, 'local_reused': 0, 'errors': []}
    try:
        task = show_task(task_id)
        result['local_reused'] = _reuse_local(task)
        if discover:
            result['discovery'] = _discover(show_task(task_id))
        with _connect() as db:
            sources = db.execute('''SELECT * FROM collection_sources WHERE task_id=? AND
              (state='pending' OR (state IN ('failed','budget_deferred') AND (? OR next_attempt_at IS NULL OR julianday(next_attempt_at)<=julianday(?))))
              ORDER BY rowid LIMIT ?''', (task_id, int(retry), common.now_iso(), max(0, int(max_sources)))).fetchall()
        for row in sources:
            source = dict(row)
            with _connect() as db:
                current = db.execute('SELECT lease_token FROM collection_tasks WHERE id=?', (task_id,)).fetchone()
                if current['lease_token'] != token:
                    raise RuntimeError('任务租约已被接续者更新，停止旧写入。')
                db.execute("UPDATE collection_sources SET state='in_flight',attempts=attempts+1,updated_at=? WHERE id=?", (common.now_iso(), source['id']))
                db.commit()
            try:
                value, raw = _read_source(source)
                if value:
                    _save_document(task_id, source['id'], value)
                    result['sources_read'] += 1
                    continue
                state = 'budget_deferred' if raw.get('status') == 'budget_deferred' else 'needs_host' if raw.get('status') in (
                    'login_required', 'authentication_required', 'verification_required', 'access_restricted', 'rate_limited',
                    'host_pending', 'not_found_or_no_access', 'parse_failed_or_unexpected_page', 'blocked') else 'failed'
                error = str(raw.get('error') or raw.get('detail') or raw.get('status') or '没有取得实际正文')[:1200]
            except Exception as exc:
                raw, state, error = {'status': 'error', 'error': str(exc)}, 'failed', str(exc)[:1200]
            path = RAW / task_id / ('failure-' + source['id'] + '-' + common.stable_id(_json(raw)) + '.json')
            common.atomic_text(path, _json(raw))
            next_at = (dt.datetime.fromisoformat(common.now_iso()) + dt.timedelta(seconds=int(configuration().get('retry_after_seconds', 7200)))).isoformat()
            with _connect() as db:
                db.execute('UPDATE collection_sources SET state=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?', (state, error, next_at, common.now_iso(), source['id']))
                db.commit()
            result['sources_failed'] += 1
            result['errors'].append({'source_id': source['id'], 'url': source['url'], 'state': state, 'error': error, 'raw_path': str(path)})
        task = show_task(task_id)
        states = [source['state'] for source in task['sources']]
        remaining = sum(state in ('pending', 'failed', 'budget_deferred', 'needs_host', 'in_flight') for state in states)
        state = 'partial' if remaining else 'ready' if task['documents'] else 'needs_host'
        result.update(status='partial' if state != 'ready' else 'completed', task_state=state,
                      documents=len(task['documents']), sources_pending=remaining)
        result['source_candidates'] = [{key: source[key] for key in ('id', 'url', 'title', 'provider')}
                                       for source in task['sources'] if source['state'] == 'candidate']
        with _connect() as db:
            db.execute('UPDATE collection_tasks SET state=?,error=?,updated_at=? WHERE id=? AND lease_token=?', (state, _json(result['errors']) if result['errors'] else None, common.now_iso(), task_id, token))
            db.commit()
        return result
    except Exception as error:
        result.update(status='error', error=f'{type(error).__name__}: {error}')
        result['errors'].append({'scope': 'task', 'error': result['error']})
        with _connect() as db:
            db.execute("UPDATE collection_tasks SET state='failed',error=?,updated_at=? WHERE id=? AND lease_token=?", (result['error'], common.now_iso(), task_id, token))
            db.execute("UPDATE collection_sources SET state='pending' WHERE task_id=? AND state='in_flight'", (task_id,))
            db.commit()
        return result
    finally:
        with _connect() as db:
            db.execute('UPDATE collection_tasks SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?', (task_id, token))
            db.commit()


def run_pending(max_tasks=1, max_sources=3):
    with _connect() as db:
        rows = db.execute('''SELECT t.id FROM collection_tasks t WHERE
          (t.state='pending' OR EXISTS(SELECT 1 FROM collection_sources s WHERE s.task_id=t.id AND
           (s.state IN ('pending','in_flight') OR (s.state IN ('failed','budget_deferred') AND julianday(s.next_attempt_at)<=julianday(?)))))
          AND (t.lease_token IS NULL OR julianday(t.lease_until)<=julianday(?)) ORDER BY t.updated_at LIMIT ?''',
          (common.now_iso(), common.now_iso(), max(0, int(max_tasks)))).fetchall()
    outcomes = [run_task(row['id'], max_sources=max_sources) for row in rows]
    return {'status': 'partial' if any(o['status'] == 'partial' for o in outcomes) else 'completed' if outcomes else 'no_pending_tasks',
            'tasks': outcomes, 'errors': [error for outcome in outcomes for error in outcome.get('errors', [])]}


def event_documents(event_id, limit=5):
    with _connect() as db:
        rows = db.execute('''SELECT d.* FROM collection_documents d JOIN collection_sources s ON s.document_id=d.id
          JOIN collection_tasks t ON t.id=d.task_id WHERE t.event_id=? ORDER BY
          CASE WHEN json_extract(d.scope_json,'$.origin')='existing_item' THEN 1 ELSE 0 END,
          CASE WHEN json_extract(d.scope_json,'$.completeness')='complete' THEN 0 ELSE 1 END,d.created_at DESC LIMIT ?''', (event_id, max(0, int(limit)))).fetchall()
    return [_document_row(row) for row in rows]


def host_requests(limit=12):
    with _connect() as db:
        rows = db.execute('''SELECT s.*,t.query,t.purpose,t.project,t.branch FROM collection_sources s
          JOIN collection_tasks t ON t.id=s.task_id WHERE s.state='needs_host' ORDER BY s.updated_at LIMIT ?''', (max(0, int(limit)),)).fetchall()
        result = [{'action': 'read', 'task_id': row['task_id'], 'source_id': row['id'], 'source_url': row['url'],
          'query': row['query'], 'purpose': row['purpose'], 'reason': row['error'], 'provider': row['provider'],
          'instruction': '由有实际工具的AI读取同一来源，保留实际文本/时间/范围，然后collection host-result --task ID --input JSON回填；独立脚本不会继承浏览器登录。'} for row in rows]
        if len(result) < limit:
            tasks = db.execute('SELECT id,query,purpose,discovery_json FROM collection_tasks ORDER BY updated_at DESC LIMIT ?', (limit,)).fetchall()
            for task in tasks:
                for provider, discovery in _load(task['discovery_json'], {}).items():
                    if discovery.get('state') == 'needs_host' and len(result) < limit:
                        result.append({'action': 'search', 'task_id': task['id'], 'provider': provider,
                          'query': discovery.get('query') or task['query'], 'purpose': task['purpose'], 'reason': discovery.get('status'),
                          'instruction': '用当前宿主可用搜索保存action=search/provider/results实际回执，原命中只是线索；用host-result回填后再读取来源。'})
    return result


def host_result(task_id, payload):
    task = show_task(task_id)
    if payload.get('action') == 'search':
        provider = payload.get('provider', 'public')
        if provider not in SCRIPTS:
            raise ValueError('未知搜索来源')
        ids = [sid for row in payload.get('results', []) if (sid := _source(task_id, row.get('url'), row.get('title'), state='candidate'))]
        discovery = task['discovery']
        path = RAW / task_id / ('host-search-' + common.stable_id(_json(payload)) + '.json')
        common.atomic_text(path, _json(payload))
        discovery[provider] = {'state': 'done', 'query': payload.get('query') or task['query'], 'status': 'host_search_read', 'source_ids': ids, 'raw_path': str(path)}
        with _connect() as db:
            db.execute("UPDATE collection_tasks SET discovery_json=?,state='pending',updated_at=? WHERE id=?", (_json(discovery), common.now_iso(), task_id))
            db.commit()
        return {'status': 'saved_discovery', 'id': task_id, 'source_ids': ids, 'evidence_level': 'search_leads_only'}
    url = payload.get('source_url') or payload.get('url')
    if payload.get('evidence_level') in ('search_snippet', 'search_snippets_only', 'search_index_text', 'none'):
        raise ValueError('搜索摘要不能回填为正文。')
    source = next((source for source in task['sources'] if _url(source['url']) == _url(url)), None)
    if source is None:
        raise ValueError('回填须对应本任务同一来源URL；先把新增来源保存到任务。')
    if not str(payload.get('text') or '').strip():
        raise ValueError('回填须含实际读取的 text。')
    value = dict(payload, url=url)
    value.setdefault('retrieved_at', payload.get('source_retrieved_at') or common.now_iso())
    document_id = _save_document(task_id, source['id'], value, origin='host_source')
    with _connect() as db:
        db.execute("UPDATE collection_tasks SET state='partial',updated_at=? WHERE id=?", (common.now_iso(), task_id))
        db.commit()
    return {'status': 'saved', 'id': task_id, 'source_id': source['id'], 'document_id': document_id}


def search(query, limit=20):
    with _connect() as db:
        term = '%' + query + '%'
        old = [dict(row) for row in db.execute('SELECT id,title,url,content_state,excerpt FROM items WHERE title LIKE ? OR content LIKE ? OR excerpt LIKE ? LIMIT ?', (term, term, term, max(0, limit)))]
        new = [dict(row) for row in db.execute('SELECT id,task_id,source_id,title,url,scope_json,text_path FROM collection_documents WHERE title LIKE ? OR text LIKE ? LIMIT ?', (term, term, max(0, limit)))]
    return {'query': query, 'existing_items': old, 'task_documents': new, 'boundary': '原库与任务资料联合检索；词面命中不证明适用于当前用途。'}


def select_sources(task_id, source_ids, reason):
    task = show_task(task_id)
    if not reason.strip():
        raise ValueError('说明这些来源与当前问题的联系。')
    known = {source['id'] for source in task['sources']}
    if not source_ids or not set(source_ids).issubset(known):
        raise ValueError('只能选择当前任务中已定位的来源ID。')
    payload = {'source_ids': source_ids, 'reason': reason}
    with _connect() as db:
        for identity in source_ids:
            db.execute("UPDATE collection_sources SET state='pending',updated_at=? WHERE id=? AND state IN ('candidate','reference')", (common.now_iso(), identity))
        db.execute("UPDATE collection_tasks SET state='pending',updated_at=? WHERE id=?", (common.now_iso(), task_id))
        db.execute('INSERT OR IGNORE INTO collection_adoptions VALUES(?,?,?,?,?,?,?)',
          ('ca_' + common.stable_id(task_id, 'source_selection', _json(payload)), task_id, 'source_selection', _json(source_ids), _json(payload), None, common.now_iso()))
        db.commit()
    return {'status': 'saved_selection', 'id': task_id, 'source_ids': source_ids}


def status(limit=12):
    with _connect() as db:
        counts = {name: db.execute('SELECT count(*) FROM ' + name).fetchone()[0] for name in ('collection_tasks', 'collection_sources', 'collection_documents', 'collection_adoptions')}
        tasks = [dict(row) for row in db.execute('SELECT id,query,purpose,project,branch,event_id,state,updated_at,attempts,error FROM collection_tasks ORDER BY updated_at DESC LIMIT ?', (max(0, int(limit)),))]
        states = {row['state']: row['n'] for row in db.execute('SELECT state,count(*) n FROM collection_sources GROUP BY state')}
    return {'status': 'observed', 'database': str(common.DB_PATH), 'counts': counts, 'source_states': states, 'tasks': tasks,
            'host_requests': host_requests(limit), 'configuration': str(common.CONFIG / 'collection.json'),
            'boundary': '状态仅读已有任务；不启动采集/模型/日程；有原件不等于知识已采用。'}


def adopt(task_id, payload, kind='adoption'):
    task = show_task(task_id)
    chosen = list(payload.get('source_ids') or [])
    available = {source['id'] for source in task['sources'] if source['document_id']}
    if not chosen or not set(chosen).issubset(available):
        raise ValueError('采用记录须引用本任务已取得原件的source_ids。')
    if not str(payload.get('what_changed') or payload.get('purpose') or '').strip():
        raise ValueError('说明这些材料具体怎样改变做法或用于什么结果。')
    artifact = payload.get('artifact')
    if artifact and not Path(artifact).is_file():
        raise ValueError('采用成果文件不存在。')
    identity = 'ca_' + common.stable_id(task_id, kind, _json(payload))
    with _connect() as db:
        db.execute('INSERT OR IGNORE INTO collection_adoptions VALUES(?,?,?,?,?,?,?)', (identity, task_id, kind, _json(chosen), _json(payload), artifact, common.now_iso()))
        db.commit()
    return {'status': 'saved', 'id': identity, 'task_id': task_id, 'kind': kind}


def candidate(task_id, payload, output=None):
    if payload.get('format') != 'ai-object-knowledge-bundle-v1' or not isinstance(payload.get('records'), list) or not payload['records']:
        raise ValueError('知识候选须由AI整理为现用object bundle且有实际records；不自动把搜索词建立为知识。')
    task = show_task(task_id)
    refs = payload.get('collection_source_ids') or [source['id'] for source in task['sources'] if source['document_id']]
    directory = RAW / task_id
    target = Path(output).resolve() if output else directory / ('candidate-' + common.stable_id(_json(payload)) + '.json')
    common.atomic_text(target, _json(payload))
    saved = adopt(task_id, {'source_ids': refs, 'purpose': payload.get('reason') or task['purpose'],
                           'artifact': str(target), 'what_changed': '由AI整理的对象/类别知识候选；尚未导入生产知识库。'}, kind='knowledge_candidate')
    return dict(saved, candidate_path=str(target), imported=False, boundary='维护者沿原objects save/import核当前版本后采用；本命令不改生产对象。')


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description='同库任务驱动信息采集与实际采用')
    commands = parser.add_subparsers(dest='command', required=True)
    request = commands.add_parser('request'); request.add_argument('--input', required=True)
    run = commands.add_parser('run'); run.add_argument('--task', required=True); run.add_argument('--max-sources', type=int, default=6)
    run.add_argument('--no-discover', action='store_true'); run.add_argument('--retry', action='store_true')
    state = commands.add_parser('status'); state.add_argument('--limit', type=int, default=12)
    show = commands.add_parser('show'); show.add_argument('--task', required=True)
    link = commands.add_parser('link-event'); link.add_argument('--task', required=True); link.add_argument('--event', required=True)
    found = commands.add_parser('search'); found.add_argument('--query', required=True); found.add_argument('--limit', type=int, default=20)
    host = commands.add_parser('host-requests'); host.add_argument('--limit', type=int, default=12)
    for name in ('host-result', 'adopt', 'candidate', 'select'):
        command = commands.add_parser(name); command.add_argument('--task', required=True); command.add_argument('--input', required=True)
        if name == 'candidate': command.add_argument('--output')
    pending = commands.add_parser('pending'); pending.add_argument('--max-tasks', type=int, default=1); pending.add_argument('--max-sources', type=int, default=3)
    args = parser.parse_args(argv)
    payload = json.loads(Path(args.input).read_text(encoding='utf-8-sig')) if hasattr(args, 'input') else None
    if args.command == 'request': value = request_task(payload)
    elif args.command == 'run': value = run_task(args.task, args.max_sources, not args.no_discover, args.retry)
    elif args.command == 'status': value = status(args.limit)
    elif args.command == 'show': value = show_task(args.task)
    elif args.command == 'link-event': value = attach_event(args.task, args.event)
    elif args.command == 'search': value = search(args.query, args.limit)
    elif args.command == 'host-requests': value = {'host_requests': host_requests(args.limit)}
    elif args.command == 'host-result': value = host_result(args.task, payload)
    elif args.command == 'adopt': value = adopt(args.task, payload)
    elif args.command == 'candidate': value = candidate(args.task, payload, args.output)
    elif args.command == 'select': value = select_sources(args.task, payload.get('source_ids') or [], payload.get('reason') or '')
    else: value = run_pending(args.max_tasks, args.max_sources)
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 1 if value.get('status') == 'error' else 2 if value.get('status') == 'partial' else 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'status': 'error', 'error': f'{type(error).__name__}: {error}'}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)

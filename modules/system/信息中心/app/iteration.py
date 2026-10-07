"""Daily information -> bounded code change -> real-use check -> durable result.

The model returns a structured patch, never a shell command. Patches are tried
against an isolated copy and checked with fixed Python/CLI entry points before
applying to owned production files. The existing pipeline lock is the lease.
"""
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
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys

import common

EDITABLE = ('app/main.py', 'app/publisher.py', 'app/processor.py',
            'app/collector.py', 'app/queue_policy.py', 'prompts/triage.txt', 'prompts/research.txt')
READ_COMMANDS = {'item', 'status', 'search', 'inbox'}
TERMINAL = {'completed', 'not_applicable', 'needs_user'}


def _json(value):
    return json.dumps(value, ensure_ascii=False, indent=2)


def _init(db):
    db.executescript('''CREATE TABLE IF NOT EXISTS iteration_jobs (
      action_id TEXT PRIMARY KEY,event_id TEXT NOT NULL,state TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,next_attempt_at TEXT,started_at TEXT,ended_at TEXT,
      directory TEXT,result_json TEXT DEFAULT '{}',error TEXT);
      CREATE TABLE IF NOT EXISTS iteration_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT NOT NULL,value TEXT NOT NULL,
      note TEXT,created_at TEXT NOT NULL);
    ''')
    db.commit()


def _mark_success(db, action_id):
    today = common.local_time().split()[0]
    budget = common.state_get(db, 'iteration_daily_applications', {})
    identities = budget.get('action_ids', []) if budget.get('date') == today else []
    common.state_set(db, 'iteration_daily_applications', {'date': today, 'action_ids': list(dict.fromkeys(identities + [action_id]))})
    common.state_set(db, 'iteration_success_date', today)


def status():
    with common.connect() as db:
        _init(db)
        jobs = []
        for row in db.execute('SELECT * FROM iteration_jobs ORDER BY started_at DESC LIMIT 12'):
            record = dict(row)
            result = json.loads(record.pop('result_json') or '{}')
            record.update(summary=result.get('summary'), result_file=str(Path(record['directory']) / 'result.json'))
            jobs.append(record)
        return {'last_iteration': _brief(common.state_get(db, 'last_iteration', {})),
                'last_success_date': common.state_get(db, 'iteration_success_date'),
                'jobs': jobs,
                'feedback': [dict(r) for r in db.execute('SELECT * FROM iteration_feedback ORDER BY id DESC LIMIT 8')]}


def _brief(result):
    return {key: result[key] for key in ('status', 'date', 'started_at', 'ended_at', 'errors') if key in result} | {
        'jobs': [{key: job[key] for key in ('status', 'action_id', 'event_id', 'title', 'summary', 'outcome', 'directory', 'remaining_gaps') if key in job}
                 for job in result.get('jobs', [])]}


def feedback(action_id, value, note=''):
    if value not in ('useful', 'less', 'retry'):
        raise ValueError('反馈值须为 useful/less/retry')
    with common.connect() as db:
        _init(db)
        row = db.execute('SELECT * FROM iteration_jobs WHERE action_id=?', (action_id,)).fetchone()
        if not row:
            raise ValueError('迭代行动不存在')
        db.execute('INSERT INTO iteration_feedback(action_id,value,note,created_at) VALUES(?,?,?,?)',
                   (action_id, value, note, common.now_iso()))
        if value == 'retry' and row['state'] != 'completed':
            db.execute("UPDATE iteration_jobs SET state='failed',next_attempt_at=NULL WHERE action_id=?", (action_id,))
            db.execute("UPDATE actions SET state='pending',error=NULL WHERE id=?", (action_id,))
        db.commit()
    return {'status': 'saved', 'action_id': action_id, 'feedback': value,
            'next': '有用/少推保留真实反馈；重试只接未完成行动，不重复已应用改动。'}


def _command(root, args):
    process = subprocess.run([sys.executable, str(root / 'app/main.py'), *args],
                             cwd=root, capture_output=True, text=True, encoding='utf-8', errors='replace',
                             timeout=120, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if process.returncode:
        raise RuntimeError(f'固定验证入口失败 {args}: {process.stderr[-1200:]} {process.stdout[-1200:]}')
    return json.loads(process.stdout)


def _at(value, path):
    for key in path.split('.') if path else []:
        value = value[int(key)] if isinstance(value, list) else value[key]
    return value


def _checks(root, checks):
    results = []
    if not checks or len(checks) > 12:
        raise ValueError('改进须给出1至12项实际用法检查')
    for check in checks:
        args = check['args']
        if not args or args[0] not in READ_COMMANDS or any(not isinstance(a, str) for a in args):
            raise ValueError('只允许已有只读CLI验证，不能执行模型提供的shell')
        # Read-command arguments go directly into argv, without a shell.
        actual = _command(root, args)
        operator = check['operator']
        expected = json.loads(check['expected_json'])
        try:
            value = _at(actual, check['path'])
            passed = operator == 'exists' or (operator == 'equals' and value == expected) or (operator == 'contains' and expected in value)
        except (KeyError, IndexError, TypeError, ValueError):
            passed = False
            value = None
        results.append({'args': args, 'path': check['path'], 'operator': operator,
                        'expected': expected, 'actual': value, 'passed': passed})
    return results


def _stage(directory, db):
    root = directory / 'staging'
    root.mkdir()
    for folder in ('app', 'config', 'prompts', 'schemas'):
        shutil.copytree(common.ROOT / folder, root / folder, ignore=shutil.ignore_patterns('__pycache__'))
    (root / 'data').mkdir()
    with sqlite3.connect(root / 'data/information.sqlite') as target:
        db.backup(target)
    cfg = common.settings()
    cfg['output_paths'] = {key: str(root / 'reports' / Path(path).name) for key, path in cfg['output_paths'].items()}
    common.atomic_text(root / 'config/settings.json', _json(cfg))
    return root


def _apply_plan(plan, directory, db):
    edits = plan['edits']
    if not edits or len(edits) > 8:
        raise ValueError('apply须有1至8处限定文件修改')
    staging = _stage(directory, db)
    before_check = _checks(staging, plan['checks'])
    originals, updated = {}, {}
    for edit in edits:
        name = edit['path']
        if name not in EDITABLE:
            raise ValueError('修改超出本执行器文件归属：' + name)
        originals.setdefault(name, (common.ROOT / name).read_text(encoding='utf-8'))
        text = updated.get(name, originals[name])
        if not edit['before'] or text.count(edit['before']) != 1:
            raise ValueError('替换片段须恰好命中一次：' + name)
        updated[name] = text.replace(edit['before'], edit['after'], 1)
    if all(updated[name] == text for name, text in originals.items()):
        raise ValueError('补丁没有实际变化')
    for name, text in updated.items():
        common.atomic_text(staging / name, text)
    for file in (staging / 'app').glob('*.py'):
        compile(file.read_text(encoding='utf-8'), str(file), 'exec')
    after_check = _checks(staging, plan['checks'])
    if not all(c['passed'] for c in after_check):
        common.atomic_text(directory / 'verification.json', _json({'before': before_check, 'after': after_check}))
        raise ValueError('实际CLI用法验证没有全部通过，生产代码未修改')
    if all(c['passed'] for c in before_check):
        raise ValueError('所提检查原来均已满足；不能据此证明本次改进，生产代码未修改')
    published = _command(staging, ['publish'])
    # Check the current original immediately before writing; never overwrite a
    # concurrent contributor's change based on an old model input.
    for name, text in originals.items():
        if (common.ROOT / name).read_text(encoding='utf-8') != text:
            raise RuntimeError('原文件已被其他任务修改，本轮补丁保留待重新生成：' + name)
    backup = directory / 'backup'
    applied = []
    try:
        for name, text in originals.items():
            common.atomic_text(backup / name, text)
        common.atomic_text(directory / 'apply-intent.json', _json({'original_files': list(originals), 'state': 'applying'}))
        for name, text in updated.items():
            common.atomic_text(common.ROOT / name, text)
            applied.append(name)
        production = _checks(common.ROOT, plan['checks'])
        if not all(c['passed'] for c in production):
            raise ValueError('生产实际用法验证失败')
    except Exception:
        for name in applied:
            if (common.ROOT / name).read_text(encoding='utf-8') == updated[name]:
                common.atomic_text(common.ROOT / name, originals[name])
        raise
    result = {'before': before_check, 'staging': after_check, 'production': production,
              'publication': published, 'changed_files': list(updated), 'backup': str(backup)}
    common.atomic_text(directory / 'verification.json', _json(result))
    common.atomic_text(directory / 'apply-intent.json', _json({'original_files': list(originals), 'state': 'verified'}))
    return result


def _finish(db, action, directory, result, state, error=None):
    description = result.get('summary', error or '执行未完成')
    previous = db.execute('SELECT state,result_text FROM actions WHERE id=?', (action['id'],)).fetchone()
    text = description + '\n结果：' + str(directory / 'result.json')
    changed = previous['state'] != state or previous['result_text'] != text
    with db:
        db.execute('UPDATE actions SET state=?,result_text=?,error=?,updated_at=? WHERE id=?',
                   (state, text, error, common.now_iso(), action['id']))
        if changed:
            db.execute('UPDATE events SET revision=revision+1,updated_at=? WHERE id=?', (common.now_iso(), action['event_id']))
        next_attempt = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=2)).isoformat(timespec='seconds') if state in ('failed', 'needs_research', 'deferred') else None
        db.execute('UPDATE iteration_jobs SET state=?,ended_at=?,next_attempt_at=?,result_json=?,error=? WHERE action_id=?',
                   (state, common.now_iso(), next_attempt, _json(result), error, action['id']))
    common.atomic_text(directory / 'result.json', _json(result))


def _recover_interrupted(db):
    # Under the existing pipeline lock no other executor is active. A running
    # receipt therefore means a previous process ended before saving its result.
    for row in db.execute("SELECT * FROM iteration_jobs WHERE state='running'").fetchall():
        directory = Path(row['directory'])
        result_path = directory / 'result.json'
        verified = directory / 'verification.json'
        action = db.execute('SELECT * FROM actions WHERE id=?', (row['action_id'],)).fetchone()
        if not action:
            continue
        if verified.is_file():
            verification = json.loads(verified.read_text(encoding='utf-8'))
            production = verification.get('production', [])
            plan_path = directory / 'plan.json'
            if production and all(c['passed'] for c in production) and plan_path.is_file():
                plan = json.loads(plan_path.read_text(encoding='utf-8'))
                current = _checks(common.ROOT, plan['checks'])
                if all(c['passed'] for c in current):
                    result = {'status': 'completed', 'summary': plan['summary'], 'recovered': True,
                              'action_id': action['id'], 'verification': verification, 'directory': str(directory)}
                    _finish(db, action, directory, result, 'completed')
                    _mark_success(db, action['id'])
                    continue
        # If interrupted in the narrow apply window, restore only files that
        # still exactly equal this attempt's patch; preserve any later edit.
        plan_path = directory / 'plan.json'
        if plan_path.is_file() and (directory / 'apply-intent.json').is_file():
            plan = json.loads(plan_path.read_text(encoding='utf-8'))
            names = {e['path'] for e in plan.get('edits', []) if e['path'] in EDITABLE}
            for name in names:
                original_path = directory / 'backup' / name
                if not original_path.is_file():
                    continue
                original = original_path.read_text(encoding='utf-8')
                patched = original
                for edit in plan['edits']:
                    if edit['path'] == name and patched.count(edit['before']) == 1:
                        patched = patched.replace(edit['before'], edit['after'], 1)
                if (common.ROOT / name).read_text(encoding='utf-8') == patched:
                    common.atomic_text(common.ROOT / name, original)
        result = {'status': 'failed', 'summary': '上次执行中断，未确认完整产物；保存原材料并接续重试。',
                  'action_id': action['id'], 'directory': str(directory)}
        _finish(db, action, directory, result, 'failed', 'interrupted')


def run(limit=3, action_id=None, retry=False):
    """Caller must hold common.job_lock; one useful application per Shanghai day."""
    config = common.settings()
    today = common.local_time().split()[0]
    result = {'started_at': common.now_iso(), 'date': today, 'status': 'completed', 'jobs': [], 'errors': []}
    with common.connect() as db:
        _init(db)
        _recover_interrupted(db)
        budget = common.state_get(db, 'iteration_daily_applications', {})
        used = len(budget.get('action_ids', [])) if budget.get('date') == today else int(common.state_get(db, 'iteration_success_date') == today)
        if used >= max(0, int(config.get('iteration_daily_changes', 1))) and not action_id:
            return {'status': 'already_iterated_today', 'date': today, 'jobs': [], 'model_calls': 0,
                    'last_iteration': _brief(common.state_get(db, 'last_iteration', {}))}
        query = '''SELECT a.*,e.title,e.summary,e.next_action,e.evidence_urls_json,e.item_ids_json,e.research_json,e.research_state,
                   e.importance FROM actions a JOIN events e ON e.id=a.event_id LEFT JOIN iteration_jobs j ON j.action_id=a.id
                   WHERE e.category IN ('ai','coding') AND a.kind IN ('system_model','system_tool')
                   AND a.state IN ('pending','ready','failed','needs_research','deferred')
                   AND (j.state IS NULL OR j.state NOT IN ('completed','not_applicable','needs_user'))'''
        parameters = []
        if action_id:
            query += ' AND a.id=?'
            parameters.append(action_id)
        if not retry:
            query += ' AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=?)'
            parameters.append(common.now_iso())
        query += ' ORDER BY e.importance DESC,e.updated_at DESC LIMIT ?'
        parameters.append(max(0, min(10, int(limit))))
        actions = db.execute(query, parameters).fetchall()
        if not actions:
            return {'status': 'nothing_to_iterate', 'date': today, 'jobs': [], 'model_calls': 0,
                    'last_iteration': _brief(common.state_get(db, 'last_iteration', {}))}
        from processor import _fetch_document, _invoke
        for action in actions:
            directory = common.DATA / 'iteration' / (common.stable_id(action['id'], common.now_iso(), __import__('os').urandom(8).hex()))
            directory.mkdir(parents=True)
            db.execute('''INSERT INTO iteration_jobs(action_id,event_id,state,attempts,started_at,directory)
              VALUES(?,?,'running',1,?,?) ON CONFLICT(action_id) DO UPDATE SET state='running',attempts=attempts+1,
              started_at=excluded.started_at,directory=excluded.directory,error=NULL,ended_at=NULL''',
              (action['id'], action['event_id'], common.now_iso(), str(directory)))
            db.commit()
            try:
                documents = []
                urls = json.loads(action['evidence_urls_json'])
                for url in list(dict.fromkeys(urls))[:3]:
                    fallback = db.execute('SELECT * FROM items WHERE canonical_url=? ORDER BY length(content) DESC LIMIT 1',
                                          (common.canonical_url(url),)).fetchone()
                    documents.append(_fetch_document(url, dict(fallback) if fallback else {}, config, directory))
                common.atomic_text(directory / 'documents.json', _json(documents))
                items = [dict(r) for r in db.execute('SELECT * FROM items WHERE event_id=? LIMIT 5', (action['event_id'],))]
                files = {name: (common.ROOT / name).read_text(encoding='utf-8') for name in EDITABLE if (common.ROOT / name).is_file()}
                # Limit source sent to the model to direct retrieval and reporting
                # modules unless this event calls for a collector/queue fix.
                code = {'app/main.py': files['app/main.py']}
                if any(token in action['summary'] + action['next_action'] for token in ('页面', '日报', '通知', '展示', '界面', '报告')):
                    code['app/publisher.py'] = files['app/publisher.py']
                if any(token in (action['summary'] + action['next_action']).lower() for token in ('采集', '队列', '抓取', '订阅')):
                    code.update({name: text for name, text in files.items() if name in ('app/collector.py', 'app/queue_policy.py')})
                payload = {'project_goal': (common.ROOT.parent / '核心.md').read_text(encoding='utf-8'),
                           'conditions': '每天一次；只改信息中心；广泛学习与能力扩展材料按当前profile和任务判断；当前不制作具体产品；论坛只读；Claude暂停；保留已有成果及他人修改；不调用采集、不启动其他自动化。',
                           'action': dict(action), 'documents': documents, 'fixtures': items, 'code': code,
                           'current_utc': common.now_iso(), 'profile': config['user_profile'],
                           'user_iteration_feedback': [dict(row) for row in db.execute('''SELECT f.action_id,f.value,f.note,f.created_at,e.title
                              FROM iteration_feedback f JOIN iteration_jobs j ON j.action_id=f.action_id
                              JOIN events e ON e.id=j.event_id ORDER BY f.id DESC LIMIT 12''')]}
                outcome = _invoke('iteration', payload, config, config['research_model'], config.get('research_effort', 'medium'))
                if not outcome['ok']:
                    raise RuntimeError(outcome['error'])
                plan = outcome['result']
                common.atomic_text(directory / 'plan.json', _json(plan))
                common.atomic_text(directory / 'model.json', _json({key: outcome[key] for key in ('directory', 'model', 'usage')}))
                evidence = {url: doc['status'] for doc in documents if doc['status'] != 'failed'
                            for url in (doc['url'], doc.get('resolved_url', doc['url']))}
                if any(f['url'] not in evidence or f['status'] != evidence[f['url']] for f in plan['source_findings']):
                    raise ValueError('判断引用与实际取得来源不一致')
                state = {'apply': 'completed', 'already_satisfied': 'completed'}.get(plan['outcome'], plan['outcome'])
                saved = {'status': state, 'action_id': action['id'], 'event_id': action['event_id'], 'title': action['title'],
                         'summary': plan['summary'], 'source_findings': plan['source_findings'], 'remaining_gaps': plan['remaining_gaps'],
                         'directory': str(directory), 'model': outcome['model'], 'usage': outcome['usage'], 'outcome': plan['outcome']}
                if plan['outcome'] == 'apply':
                    if not plan['source_findings']:
                        raise ValueError('没有原件依据，不自动应用')
                    saved['verification'] = _apply_plan(plan, directory, db)
                elif plan['edits']:
                    raise ValueError('未执行的决策不能带生产修改')
                _finish(db, action, directory, saved, state)
                result['jobs'].append(saved)
                if plan['outcome'] == 'apply':
                    _mark_success(db, action['id'])
                    break
            except Exception as exc:
                saved = {'status': 'failed', 'action_id': action['id'], 'event_id': action['event_id'], 'title': action['title'],
                         'summary': str(exc), 'error': str(exc), 'directory': str(directory)}
                _finish(db, action, directory, saved, 'failed', str(exc))
                result['jobs'].append(saved)
                result['errors'].append({'action_id': action['id'], 'error': str(exc)})
        result.update(ended_at=common.now_iso(), status='partial' if result['errors'] else 'completed')
        common.state_set(db, 'last_iteration', result)
    common.atomic_text(common.LOGS / 'last-iteration.json', _json(result))
    return result

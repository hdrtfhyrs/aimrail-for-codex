"""Bounded local recovery and honest, compact runtime status."""
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

import common


def status():
    from launch import reconcile_last_scheduled
    scheduled = reconcile_last_scheduled()
    with common.job_lock() as acquired:
        running = not acquired
    with common.connect() as db:
        pipeline = common.state_get(db, 'last_pipeline', {})
        recovery = common.state_get(db, 'last_recovery', {})
        if recovery:
            metrics = ('sources_attempted', 'sources_ok', 'sources_failed', 'items_new', 'items_analyzed',
                       'batches_completed', 'batches_failed', 'events_researched', 'events_completed',
                       'events_needing_web', 'events_failed', 'documents_full', 'documents_excerpt',
                       'documents_failed', 'pending_items', 'events', 'model', 'usage')
            recovery = {key: recovery.get(key) for key in ('status', 'started_at', 'ended_at', 'scope', 'errors')} | {
                'stages': {name: {key: value[key] for key in metrics if key in value}
                           for name, value in recovery.get('stages', {}).items()}}
        import queue_policy
        queue_policy.ensure_schema(db)
        queue_routes = queue_policy.stats(db)
        queue = {row['category']: row['n'] for row in db.execute(
            'SELECT category,COUNT(*) n FROM items WHERE analyzed_at IS NULL AND id IN (SELECT item_id FROM item_queue WHERE route="model") GROUP BY category')}
        research = {row['research_state']: row['n'] for row in db.execute(
            'SELECT research_state,COUNT(*) n FROM events GROUP BY research_state')}
        failed = [dict(row) for row in db.execute(
            'SELECT id,last_error,consecutive_failures FROM sources WHERE enabled=1 AND consecutive_failures>0')]
        from main import collection_summary
        return {'checked_at': common.now_iso(), 'running': running,
                'task_collection': collection_summary(),
                'scheduled_receipt': scheduled,
                'daily_run_date': common.state_get(db, 'daily_run_date'),
                'last_pipeline': {'status': pipeline.get('status'), 'started_at': pipeline.get('started_at'),
                                  'ended_at': pipeline.get('ended_at'), 'errors': pipeline.get('errors', []),
                                  'same_cycle_repairs': pipeline.get('same_cycle_repairs', {})},
                'last_recovery': recovery, 'queue': {'pending': sum(queue.values()), 'by_category': queue,
                'routes': queue_routes, 'research': research, 'actions': {row['state']: row['n'] for row in db.execute(
                    'SELECT state,COUNT(*) n FROM actions GROUP BY state')}},
                'sources_enabled': db.execute('SELECT COUNT(*) FROM sources WHERE enabled=1').fetchone()[0],
                'failed_sources': failed,
                'models': {key: common.settings()[key] for key in ('triage_model', 'research_model')},
                'last_iteration': common.state_get(db, 'last_iteration', {}),
                'reports': {'html': str(common.REPORTS / 'latest.html'),
                            'markdown': str(common.REPORTS / 'latest.md')}}


def recover(batches=1, research=1):
    """Retry only failed sources and pending work; preserve the daily gate and historical errors."""
    if not 0 <= batches <= 8 or not 0 <= research <= 6:
        raise ValueError('恢复范围：batches 0..8，research 0..6；默认各1。')
    with common.job_lock() as acquired:
        if not acquired:
            return {'status': 'already_running'}
        from collector import collect
        from processor import analyze, research as research_events
        from publisher import publish
        result = {'started_at': common.now_iso(), 'stages': {}, 'errors': [],
                  'scope': {'pending_batches': batches, 'pending_research': research, 'failed_sources_only': True}}
        with common.connect() as db:
            failed_ids = [row[0] for row in db.execute(
                'SELECT id FROM sources WHERE enabled=1 AND consecutive_failures>0')]
        stages = []
        from main import continue_collection_tasks
        stages.append(('task_collection_pending', continue_collection_tasks))
        if failed_ids:
            stages.append(('collect_failed', lambda: collect(force=True, source_ids=failed_ids)))
        if batches:
            stages.append(('analyze_pending', lambda: analyze(max_batches=batches, force=True)))
        if research:
            stages.append(('research_pending', lambda: research_events(max_events=research)))
        from iteration import run as iterate
        stages.append(('iteration_pending', lambda: iterate(limit=common.settings().get('iteration_per_run', 3))))
        stages.append(('publish', publish))
        for name, action in stages:
            try:
                value = action()
                result['stages'][name] = value
                if value.get('errors'):
                    result['errors'].append({'stage': name, 'errors': value['errors']})
            except Exception as exc:
                result['errors'].append({'stage': name, 'error': str(exc)})
        result.update(ended_at=common.now_iso(), status='partial' if result['errors'] else 'completed')
        with common.connect() as db:
            common.state_set(db, 'last_recovery', result)
        common.atomic_text(common.LOGS / 'last-recovery.json', json.dumps(result, ensure_ascii=False, indent=2))
        return result


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description='信息中心本机短状态与定点恢复')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('status')
    recovery = sub.add_parser('recover')
    recovery.add_argument('--batches', type=int, default=1)
    recovery.add_argument('--research', type=int, default=1)
    args = parser.parse_args()
    result = status() if args.command == 'status' else recover(args.batches, args.research)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 2 if result.get('status') == 'partial' else 0


if __name__ == '__main__':
    raise SystemExit(main())

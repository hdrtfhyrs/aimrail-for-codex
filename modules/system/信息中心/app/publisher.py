from __future__ import annotations
import pathlib as _public_pathlib
import importlib.util as _public_importutil
_public_root = next(p for p in _public_pathlib.Path(__file__).resolve().parents if (p/'public_paths.py').is_file())
_public_spec = _public_importutil.spec_from_file_location('ai_work_public_paths', _public_root/'public_paths.py')
_public_module = _public_importutil.module_from_spec(_public_spec)
_public_spec.loader.exec_module(_public_module)
_public_path = _public_module.public_path

import datetime as dt
import html
import json
import os
from pathlib import Path
import re
from urllib.parse import urlsplit

try:
    from . import common
except ImportError:
    import common


ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / "reports"
CATEGORIES = ("ai", "coding", "finance", "science", "world", "life")
DISPOSITIONS = {
    "action": "可用",
    "learn": "学知识",
    "watch": "关注",
    "archive": "留档",
    "already_applied": "已处理",
}
CONTENT_LABELS = {
    "feed": "订阅摘要",
    "baseline": "首次页面观察（基线）",
    "page_change": "套餐/价格页面变化（待核实）",
    "full": "已取得正文",
    "excerpt": "仅有摘要/节选",
    "missing": "未取得正文",
    "failed": "正文获取失败",
    "pending": "待补正文",
}
RESEARCH_LABELS = {
    "running": "正在深查",
    "pending": "待深查",
    "not_needed": "未安排深查",
    "completed": "已深查",
    "excerpt": "基于节选",
    "failed": "深查失败",
    "needs_web": "需要联网查证",
}
EVIDENCE_LABELS = {
    "native_sources": "已查关键原件",
    "full": "已读原件",
    "mixed": "原件与节选证据",
    "excerpt": "节选证据",
    "status": "状态信息",
}
FINANCIAL_KIND_LABELS = {
    "opinion": "观点",
    "prediction": "预测",
    "fact": "事实",
}
RUN_STAGE_LABELS = {"collect": "采集", "analyze": "初筛分析", "triage": "初筛分析", "research": "深查", "publish": "发布报告"}
RUN_STATUS_LABELS = {"success": "成功", "error": "失败", "running": "进行中"}
USAGE_LABELS = {"input_tokens": "输入", "cached_input_tokens": "缓存输入", "output_tokens": "输出"}


def _safe_url(value) -> str:
    if not isinstance(value, str):
        return ""
    value = value.strip()
    try:
        parts = urlsplit(value)
        if parts.scheme.lower() not in ("http", "https") or not parts.netloc or any(ord(c) < 32 for c in value):
            return ""
        return value
    except ValueError:
        return ""


def _json(value, default):
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
        return parsed if parsed is not None else default
    except (ValueError, TypeError):
        return default


def _text(value) -> str:
    return str(value or "").strip()


def _link(url: str, label: str = "查看原文") -> str:
    url = _safe_url(url)
    if not url:
        return ""
    return f'<a href="{html.escape(url, quote=True)}" target="_blank" rel="noopener noreferrer">{html.escape(label)}</a>'


def _now_local() -> str:
    return dt.datetime.now(common.SHANGHAI).strftime("%Y-%m-%d %H:%M")


def _load_data(db):
    events = [dict(row) for row in db.execute("SELECT * FROM events ORDER BY importance DESC, updated_at DESC, created_at DESC")]
    items = [dict(row) for row in db.execute("""SELECT i.*, q.route AS queue_route,q.reason AS queue_reason,q.content_kind AS content_kind,q.freshness AS freshness, s.name AS source_name, s.url AS source_url,
        s.enabled AS source_enabled, s.last_attempt_at AS source_last_attempt_at,
        s.last_success_at AS source_last_success_at, s.last_error AS source_last_error,
        s.consecutive_failures AS source_consecutive_failures, s.http_status AS source_http_status
        FROM items i LEFT JOIN item_queue q ON q.item_id=i.id LEFT JOIN sources s ON s.id=i.source_id
        ORDER BY COALESCE(i.published_at, i.fetched_at) DESC, i.fetched_at DESC""")]
    sources = [dict(row) for row in db.execute("SELECT * FROM sources ORDER BY category, name")]
    source_info = {}
    linked_sources = db.execute("""SELECT i.event_id, i.url, i.published_at, s.name, s.tier
        FROM items i JOIN sources s ON s.id=i.source_id WHERE i.event_id IS NOT NULL
        ORDER BY i.published_at""")
    for row in linked_sources:
        info = {"url": row["url"], "name": row["name"], "tier": row["tier"], "published_at": row["published_at"]}
        bucket = source_info.setdefault(row["event_id"], [])
        identity = (info["url"], info["name"])
        if not any((old.get("url"), old.get("name")) == identity for old in bucket):
            bucket.append(info)
    for event in events:
        event["source_info"] = source_info.get(event["id"], [])
    action_results = {}
    for action in db.execute("SELECT event_id,kind,state,result_text FROM actions WHERE kind IN ('system_model','system_tool','pricing_check') AND result_text!='' ORDER BY updated_at DESC"):
        action_results.setdefault(action['event_id'], []).append(dict(action))
    for event in events:
        event['action_results'] = action_results.get(event['id'], [])
    return events, items, sources


def _safe_error_summary(value) -> str:
    """Create a short readable error summary without local filesystem paths."""
    text = _text(value)
    if not text:
        return ""
    text = re.sub(r"(?i)(?:[a-z]:[\\/]|\\\\)[^\r\n;,]*", "本机路径已隐藏", text)
    text = re.sub(r"(?<![\w])/(?:[^\s;,]+/)+[^\s;,]*", "本机路径已隐藏", text)
    return re.sub(r"\s+", " ", text).strip(" ;,。")[:240]


def _recent_runs(db, exclude_id=None):
    if exclude_id:
        rows = db.execute("SELECT id,stage,started_at,ended_at,status,stats_json,error FROM runs WHERE id<>? ORDER BY started_at DESC LIMIT 12", (exclude_id,))
    else:
        rows = db.execute("SELECT id,stage,started_at,ended_at,status,stats_json,error FROM runs ORDER BY started_at DESC LIMIT 12")
    recent = []
    for row in rows:
        stats = _json(row["stats_json"], {})
        if not isinstance(stats, dict):
            stats = {}
        usage = stats.get("usage") if isinstance(stats.get("usage"), dict) else {}
        error = _text(row["error"])
        error_details = stats.get("errors") if isinstance(stats.get("errors"), list) else []
        detail_texts = [json.dumps(x, ensure_ascii=False) if isinstance(x, (dict, list)) else _text(x)
                        for x in error_details if _text(x)]
        summary_input = " · ".join(value for value in ([error] if error else []) + detail_texts[:1] if value)
        if not error and detail_texts:
            error = "; ".join(detail_texts)
        recent.append({
            "id": row["id"], "stage": row["stage"], "started_at": row["started_at"],
            "ended_at": row["ended_at"], "status": row["status"], "error": _text(row["error"]) or None,
            "error_details": error_details, "error_summary": _safe_error_summary(summary_input), "usage": usage,
        })
    return recent


def _render_usage(usage):
    if not isinstance(usage, dict) or not usage:
        return "未提供 token 用量"
    pieces = [f"{label} {int(usage[key]):,}" for key, label in USAGE_LABELS.items()
              if key in usage and isinstance(usage[key], (int, float))]
    return " · ".join(html.escape(piece) for piece in pieces) if pieces else "未提供 token 用量"


def _run_cards(recent_runs):
    if not recent_runs:
        return '<p class="muted">还没有已结束的运行记录。</p>'
    cards = []
    for run in recent_runs:
        stage = RUN_STAGE_LABELS.get(run.get("stage"), _text(run.get("stage")) or "未知阶段")
        state = RUN_STATUS_LABELS.get(run.get("status"), _text(run.get("status")) or "状态未知")
        ended = common.local_time(run.get("ended_at")) or ("尚未结束" if run.get("status") == "running" else "时间未知")
        error = f'<div class="run-error">{html.escape(_text(run.get("error_summary")))}</div>' if run.get("status") == "error" and run.get("error_summary") else ""
        cards.append(f'''<article class="run-row"><b>{html.escape(stage)}</b><span class="run-state {'failed' if run.get('status') == 'error' else ''}">{html.escape(state)}</span>
          <span class="muted">结束时间：{html.escape(ended)} · Token：{_render_usage(run.get("usage"))}</span>{error}</article>''')
    return "".join(cards)


def _event_category_counts(events):
    return {category: sum(1 for event in events if event.get("category") == category) for category in CATEGORIES}


def _detailed(event):
    config = common.settings()
    return event.get("category") in config.get("detailed_categories", ["ai", "coding"]) or _json(event.get("feedback"), {}).get("value") == "research"


def _headline_card(event, labels):
    category = event.get("category", "life")
    urls = _json(event.get("evidence_urls_json"), [])
    url = next((value for value in urls if _safe_url(value)), "")
    title = _link(url, _text(event.get("title")) or "未命名事件") if url else html.escape(_text(event.get("title")))
    kind = event.get('headline_kind') or DISPOSITIONS.get(event.get('disposition'), '关注')
    source = _text(event.get('source_name'))
    date = common.local_time(event.get('published_at')) if event.get('published_at') else ''
    return f'<article class="card headline-card" data-category="{html.escape(category)}" data-disposition="{html.escape(event.get("disposition", "watch"))}"><div class="eyebrow">{html.escape(labels.get(category, category))} · {html.escape(kind)}</div><h3>{title}</h3><div class="muted">{html.escape(source)} {html.escape(date)}</div></article>'


def _select_digest(events, limit):
    eligible = [event for event in events if event.get("disposition") in ("learn", "watch", "action")
                and int(event.get('revision') or 0) > int(event.get('notified_revision') or 0)]
    focused = [event for event in eligible if _detailed(event)]
    others = [event for event in eligible if not _detailed(event)]
    focused.sort(key=lambda event: (event.get("action_type") in ("system_model", "system_tool", "pricing_check"), event.get("category") == "ai", int(event.get("importance") or 0)), reverse=True)
    focused_limit = max(0, limit - min(4, len(others))) if focused else 0
    result = focused[:focused_limit]
    result.extend(others[:max(0, limit - len(result))])
    return result


def _cloud_note(config):
    cloud = config.get('cloud', {})
    if not cloud.get('download_enabled') and not cloud.get('automatic_local_receive_enabled', True):
        return '旧Git下载/旧自动接包已暂停；指定新版Codex云端原生采集与接收按新运行回执核，晚到同库资料正常续判；真正每日托管触发与关机/跨日运行仍须实际回执。'
    if cloud.get('trial_verified'):
        result = '云端单次试采和回传已验证'
    else:
        result = '云端实际采集回传尚未验证'
    result += '；本机自动下载接收已验证' if cloud.get('remote_automatic_download_ready') else '；远程自动下载尚未接通'
    result += '；每日云触发已验证' if cloud.get('daily_cloud_schedule_verified') else '；每日云触发待验证'
    result += '；跨任务状态恢复已验证。' if cloud.get('shared_cloud_state_verified') else '；跨任务状态恢复待验证。'
    return result


def _action_result_text(event):
    labels = {'completed':'已处理', 'not_applicable':'本轮未执行', 'failed':'未完成', 'needs_research':'待补证', 'needs_user':'待本人判断', 'deferred':'待继续'}
    results = []
    for action in event.get('action_results', [])[:3]:
        text = _text(action.get('result_text')).split('\n产物：', 1)[0]
        if text:
            results.append(labels.get(action.get('state'), '处理记录') + '：' + text)
    return '\n'.join(results)


def _render_research(event):
    research = _json(event.get("research_json"), {})
    if not isinstance(research, dict):
        research = {}
    parts = []
    overview = _text(research.get("overview"))
    if overview:
        parts.append(f'<p class="research-overview">{html.escape(overview)}</p>')
    facts = research.get("verified_facts") if isinstance(research.get("verified_facts"), list) else []
    if facts:
        parts.append("<h4>已查证事实</h4><ul>")
        for fact in facts:
            if isinstance(fact, str):
                fact = {"text": fact}
            if not isinstance(fact, dict):
                continue
            refs = fact.get("source_urls") if isinstance(fact.get("source_urls"), list) else []
            links = " ".join(_link(url, "出处") for url in refs if _safe_url(url))
            parts.append(f'<li>{html.escape(_text(fact.get("text")))} {links}</li>')
        parts.append("</ul>")
    mechanism = _text(research.get("mechanism"))
    reported = research.get("reported_claims") if isinstance(research.get("reported_claims"), list) else []
    if reported:
        parts.append('<h4>来源报告（尚未取得完整正文）</h4><ul>')
        for claim in reported:
            if isinstance(claim, dict):
                refs = claim.get('source_urls', [])
                parts.append('<li>' + html.escape(_text(claim.get('text'))) + ' ' + ' '.join(_link(url, '出处') for url in refs if _safe_url(url)) + '</li>')
        parts.append('</ul>')
    if mechanism:
        parts.append(f'<h4>背后的机制</h4><p>{html.escape(mechanism)}</p>')
    applications = research.get("applications") if isinstance(research.get("applications"), list) else []
    if applications:
        parts.append("<h4>可以怎样用</h4><ul>" + "".join(f"<li>{html.escape(_text(x))}</li>" for x in applications if _text(x)) + "</ul>")
    gaps = research.get("remaining_gaps") if isinstance(research.get("remaining_gaps"), list) else []
    if gaps:
        parts.append("<h4>还不确定</h4><ul>" + "".join(f"<li>{html.escape(_text(x))}</li>" for x in gaps if _text(x)) + "</ul>")
    financial = research.get("financial_views") if isinstance(research.get("financial_views"), list) else []
    if financial:
        parts.append("<h4>财经事实与观点</h4><ul>")
        for view in financial:
            if isinstance(view, str):
                view = {"text": view}
            if not isinstance(view, dict):
                continue
            kind = _text(view.get("kind"))
            refs = view.get("source_urls") if isinstance(view.get("source_urls"), list) else []
            links = " ".join(_link(url, "出处") for url in refs if _safe_url(url))
            prefix = f"[{html.escape(FINANCIAL_KIND_LABELS.get(kind, kind))}] " if kind else ""
            parts.append(f'<li>{prefix}{html.escape(_text(view.get("text")))} {links}</li>')
        parts.append("</ul>")
    statuses = research.get("source_statuses") if isinstance(research.get("source_statuses"), list) else []
    if statuses:
        parts.append('<h4>查证来源状态</h4><ul class="source-statuses">')
        for source in statuses:
            if not isinstance(source, dict):
                continue
            url = _safe_url(source.get("url"))
            title = _text(source.get("title")) or url or "来源"
            status = _text(source.get("status")) or "状态未注明"
            detail = _text(source.get("detail"))
            label = _link(url, title) if url else html.escape(title)
            parts.append(f'<li>{label} <span class="muted">{html.escape(status)}{(" · " + html.escape(detail)) if detail else ""}</span></li>')
        parts.append("</ul>")
    evidence = _text(research.get("evidence_level"))
    if evidence:
        parts.append(f'<p class="muted">深查证据级别：{html.escape(evidence)}</p>')
    return "".join(parts)


def _event_card(event, labels):
    if not _detailed(event):
        return _headline_card(event, labels)
    category = event.get("category") if event.get("category") in CATEGORIES else "life"
    disposition = event.get("disposition") if event.get("disposition") in DISPOSITIONS else "archive"
    research_state = event.get("research_state") or "pending"
    evidence_urls = _json(event.get("evidence_urls_json"), [])
    if not isinstance(evidence_urls, list):
        evidence_urls = []
    source_info = event.get("source_info") if isinstance(event.get("source_info"), list) else []
    links = []
    source_urls = set()
    for source in source_info:
        if not isinstance(source, dict):
            continue
        url = _safe_url(source.get("url"))
        if not url:
            continue
        source_urls.add(url)
        tier = _text(source.get("tier"))
        tier_label = {"primary": "官方原件", "official": "官方原件", "media": "媒体报道", "research": "研究资料", "community": "社区来源"}.get(tier, "其他来源" if tier else "来源类型未知")
        label = _text(source.get("name")) or "原始出处"
        links.append(f'{_link(url, label)} <span class="source-kind">来源类型：{html.escape(tier_label)}</span>')
    links.extend(_link(url, "原始出处") for url in evidence_urls if _safe_url(url) and url not in source_urls)
    links = " · ".join(links)
    publication_dates = sorted({_text(source.get("published_at")) for source in source_info if isinstance(source, dict) and _text(source.get("published_at"))})
    if not publication_dates:
        published_range = "发布时间未知"
    else:
        dates = [common.local_time(value) for value in publication_dates]
        published_range = f"资料发布时间：{dates[0]}" if len(dates) == 1 or dates[0] == dates[-1] else f"资料发布时间：{dates[0]} 至 {dates[-1]}"
    attrs = f'data-category="{category}" data-disposition="{disposition}"'
    return f'''<article class="card event-card" {attrs}>
      <div class="eyebrow">{html.escape(labels.get(category, category))} · {html.escape(DISPOSITIONS[disposition])} · 重要度 {int(event.get("importance") or 0)}</div>
      <h3>{html.escape(_text(event.get("title")) or "未命名事件")}</h3>
      <div class="muted">{html.escape(published_range)} · 更新于 {html.escape(common.local_time(event.get("updated_at") or event.get("created_at")))} · 深查：{html.escape(RESEARCH_LABELS.get(research_state, research_state))} · 证据：{html.escape(EVIDENCE_LABELS.get(_text(event.get("evidence_level")), _text(event.get("evidence_level")) or "未注明"))}</div>
      <h4>发生了什么</h4><p>{html.escape(_text(event.get("summary")) or "暂无摘要")}</p>
      <h4>为什么有用</h4><p>{html.escape(_text(event.get("why_useful")) or "暂无说明")}</p>
      <h4>学到什么</h4><p>{html.escape(_text(event.get("lesson")) or "暂无知识提炼")}</p>
      <h4>可以做什么</h4><p>{html.escape(_text(event.get("next_action")) or "目前没有具体行动")}</p>
      {('<h4>本机处理结果</h4><p>' + html.escape(_action_result_text(event)).replace(chr(10), '<br>') + '</p>') if _action_result_text(event) else ''}
      {f'<details class="research"><summary>深查详情</summary>{_render_research(event) or "<p>尚无深查结果。</p>"}</details>' if research_state != "pending" or _json(event.get("research_json"), {}) else ""}
      <div class="links">{links}</div>
    </article>'''


def _item_card(item, labels=None):
    category = item.get("category") if item.get("category") in CATEGORIES else "life"
    if category not in common.settings().get("detailed_categories", ["ai", "coding"]):
        title = _link(item.get("url"), _text(item.get("title")) or "未命名资料")
        kind = "新闻" if item.get("content_kind") == "news" else "资料"
        return f'<article class="card item-card" data-category="{category}" data-analysis="{"analyzed" if item.get("analyzed_at") else "pending"}"><div class="eyebrow">{html.escape((labels or {}).get(category, category))} · {kind} · 标题线索 · {html.escape(item.get("source_name") or "未知来源")}</div><h3>{title}</h3><div class="muted">{html.escape(common.local_time(item.get("published_at")) or "发布时间未知")} · 资料ID {html.escape(item.get("id") or "")}{" · 已过新闻窗口，原件保留" if item.get("freshness") == "expired" else ""}</div></article>'
    analyzed = bool(item.get("analyzed_at"))
    content_state = item.get("content_state") or "pending"
    event_id = item.get("event_id") or ""
    state_text = {"headline":"标题线索 · 原件保留", "expired":"新闻过期 · 原件保留", "model":"待模型分析", "analyzed":"已分析 · 留档"}.get(item.get("queue_route"), "未分类资料")
    body = _text(item.get("content")) if content_state == "full" else _text(item.get("excerpt"))
    if not body:
        body = "尚无可展示的正文或摘要。"
    return f'''<article class="card item-card" data-category="{category}" data-analysis="{'analyzed' if analyzed else 'pending'}">
      <div class="eyebrow">{html.escape(item.get("source_name") or "未知来源")} · {html.escape(CONTENT_LABELS.get(content_state, content_state))} · {html.escape(state_text)}</div>
      <h3>{html.escape(_text(item.get("title")) or "未命名文章")}</h3>
      <div class="muted">{html.escape(common.local_time(item.get("published_at") or item.get("fetched_at")))} · {html.escape((labels or {}).get(category, category))}{f' · 事件 {html.escape(event_id[:8])}' if event_id else ""}</div>
      <p>{html.escape(body[:1200])}</p><div class="muted">资料ID {html.escape(item.get("id") or "")}</div><div class="links">{_link(item.get("url"))}</div>
    </article>'''


def _source_health(sources):
    parts = []
    healthy = 0
    for source in sources:
        enabled = bool(source.get("enabled"))
        failures = int(source.get("consecutive_failures") or 0)
        last_error = _text(source.get("last_error"))
        ok = enabled and bool(source.get("last_success_at")) and not failures and not last_error
        healthy += int(ok)
        state = "正常" if ok else ("已停用" if not enabled else "待恢复/有错误")
        err = f'<div class="error">{html.escape(_safe_error_summary(last_error))}</div>' if last_error else ""
        status = f' · HTTP {int(source["http_status"])}' if source.get("http_status") is not None else ""
        parts.append(f'''<article class="source-row"><b>{html.escape(_text(source.get("name")) or _text(source.get("id")))}</b>
          <span class="pill">{html.escape(state)}</span><span class="muted">{html.escape(_text(source.get("category")))} · 最近成功 {html.escape(common.local_time(source.get("last_success_at")) or "从未")} · 连续失败 {failures}{status}</span>{err}</article>''')
    return healthy, "".join(parts) if parts else '<p class="muted">尚未登记信息源。</p>'


def _html_report(events, items, sources, digest, labels, generated, recent_runs=None):
    preview = max(1, int(common.settings().get("report_preview_items", 12)))
    counts = _event_category_counts(events)
    categories = ''.join(f'<option value="{c}">{html.escape(labels.get(c, c))}（{counts[c]}）</option>' for c in CATEGORIES)
    digest_cards = "".join(_event_card(e, labels) for e in digest) or '<p class="empty">暂时没有可精选事件；采集和分析产生记录后会显示在这里。</p>'
    event_cards = "".join(_event_card(e, labels) for e in events[:preview]) or '<p class="empty">暂无事件记录。</p>'
    analyzed_cards = "".join(_item_card(i, labels) for i in [item for item in items if item.get("analyzed_at")][:preview]) or '<p class="empty">暂无已分析文章。</p>'
    pending_cards = "".join(_item_card(i, labels) for i in [item for item in items if item.get("queue_route") == "model"][:preview]) or '<p class="empty">当前没有待分析文章。</p>'
    healthy, source_cards = _source_health(sources)
    source_total = sum(1 for s in sources if s.get("enabled"))
    run_cards = _run_cards(recent_runs or [])
    return f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>我的信息中心</title><style>
:root{{--ink:#182333;--muted:#64748b;--line:#e2e8f0;--paper:#f5f7fb;--brand:#3157a4;--soft:#eaf0ff}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--paper);color:var(--ink);font:16px/1.65 "Segoe UI","Microsoft YaHei",sans-serif}}
header{{background:linear-gradient(125deg,#14294a,#3157a4);color:white;padding:36px max(22px,calc((100vw - 1120px)/2)) 30px}}
header h1{{font-size:30px;margin:0 0 4px}}header p{{margin:0;color:#dce7ff}}main{{max-width:1120px;margin:22px auto;padding:0 18px 48px}}
.stats{{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:12px;margin:18px 0 24px}}.stat,.panel,.card{{background:white;border:1px solid var(--line);border-radius:13px}}
.stat{{padding:14px 16px}}.stat b{{display:block;font-size:24px;color:var(--brand)}}.stat span,.muted{{color:var(--muted);font-size:13px}}
.panel{{padding:20px;margin:16px 0}}.panel h2{{margin:0 0 14px;font-size:21px}}.controls{{display:flex;gap:9px;flex-wrap:wrap;margin:12px 0 18px}}
input,select{{font:inherit;border:1px solid #cbd5e1;border-radius:8px;padding:9px 12px;background:white;color:var(--ink)}}input{{flex:1;min-width:220px}}
.tabs{{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}}button{{font:inherit;border:1px solid #cbd5e1;background:white;color:var(--ink);padding:8px 13px;border-radius:999px;cursor:pointer}}button.active{{background:var(--brand);color:white;border-color:var(--brand)}}
.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,430px),1fr));gap:13px}}.card{{padding:17px 18px;min-width:0}}.card h3{{font-size:19px;line-height:1.4;margin:6px 0}}.card h4{{font-size:14px;margin:13px 0 2px}}.card p{{margin:0 0 5px;white-space:pre-wrap;overflow-wrap:anywhere}}
.eyebrow{{color:var(--brand);font-weight:650;font-size:13px}}.links a{{display:inline-block;color:var(--brand);margin:9px 6px 0 0;text-decoration:none}}.links a:hover{{text-decoration:underline}}.source-kind{{font-size:12px;color:var(--muted)}}
details{{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}}summary{{cursor:pointer;color:var(--brand);font-weight:600}}.source-statuses li{{margin-bottom:5px}}.source-statuses a{{color:var(--brand)}}.source-row,.run-row{{padding:10px 0;border-bottom:1px solid var(--line);display:grid;grid-template-columns:minmax(140px,1fr) auto;gap:2px 12px}}.source-row .muted,.source-row .error,.run-row .muted,.run-row .run-error{{grid-column:1/-1}}.pill,.run-state{{font-size:12px;color:#3157a4;background:var(--soft);border-radius:20px;padding:1px 9px}}.run-state.failed{{color:#a33;background:#fff0f0}}.error,.run-error{{font-size:13px;color:#a33;overflow-wrap:anywhere}}.empty{{color:var(--muted);padding:16px 0}}.hide{{display:none!important}}footer{{color:var(--muted);font-size:12px;text-align:center;padding:20px}}
@media(max-width:600px){{header{{padding:25px 18px}}header h1{{font-size:25px}}main{{padding:0 12px 32px}}.source-row{{grid-template-columns:1fr auto}}}}
</style></head><body><header><h1>我的信息中心</h1><p>每日更新 · 广泛学习、能力扩展与系统改进 · 更新于 {html.escape(generated)}</p></header><main>
<div class="stats"><div class="stat"><b>{len(digest)}</b><span>本期精选</span></div><div class="stat"><b>{len(events)}</b><span>全部事件</span></div><div class="stat"><b>{sum(bool(i.get('analyzed_at')) for i in items)}</b><span>已分析文章</span></div><div class="stat"><b>{sum(i.get('queue_route') == 'model' for i in items)}</b><span>待分析文章</span></div><div class="stat"><b>{healthy}/{source_total}</b><span>正常信息源 / 启用源</span></div></div>
<section class="panel"><h2>本轮选读与学习材料</h2><p class="muted">国内外广泛发现，由当前AI联系实际用途主动选读。未读线索保留标题与出处；关键材料读原文后再解释，当前不自动制作具体产品。</p><div class="grid">{digest_cards}</div></section>
<section class="panel"><h2>资料库</h2><p class="muted">每组预览 {preview} 条，当前搜索只筛选本页。<a href="information-history/index.html">打开完整历史、标题清单与分页</a>；全部原件保留，可在本会话按主题检索或指定条目深查。</p><div class="tabs"><button class="active" data-view="all-events">全部事件</button><button data-view="analyzed">已分析文章（留档）</button><button data-view="pending">待分析文章</button></div><div class="controls"><input id="search" type="search" placeholder="搜索标题、说明、来源…"><select id="category"><option value="">全部领域</option>{categories}</select><select id="disposition"><option value="">全部处置</option>{''.join(f'<option value="{key}">{html.escape(value)}</option>' for key,value in DISPOSITIONS.items())}</select></div>
<div class="view" data-section="all-events"><div class="grid">{event_cards}</div></div><div class="view hide" data-section="analyzed"><div class="grid">{analyzed_cards}</div></div><div class="view hide" data-section="pending"><div class="grid">{pending_cards}</div></div><p id="no-results" class="empty hide">没有符合条件的内容。</p></section>
<section class="panel"><h2>信息源健康</h2><p class="muted">{healthy} 个启用源最近没有连续失败记录，共 {source_total} 个启用源。</p>{source_cards}</section>
<section class="panel"><h2>最近运行</h2><p class="muted">最近 12 次采集、分析、深查和报告生成记录；token 用量来自运行记录。</p>{run_cards}</section>
</main><footer>本地生成的独立阅读页 · 数据更新时间 {html.escape(generated)}</footer>
<script>(function(){{const buttons=[...document.querySelectorAll('[data-view]')],views=[...document.querySelectorAll('.view')],search=document.getElementById('search'),cat=document.getElementById('category'),disp=document.getElementById('disposition'),empty=document.getElementById('no-results');let view='all-events';function filter(){{let visible=0;for(const section of views){{const active=section.dataset.section===view;section.classList.toggle('hide',!active);if(!active)continue;for(const card of section.querySelectorAll('.card')){{const text=card.innerText.toLocaleLowerCase();const ok=(!search.value||text.includes(search.value.toLocaleLowerCase()))&&(!cat.value||card.dataset.category===cat.value)&&(!disp.value||!card.dataset.disposition||card.dataset.disposition===disp.value);card.classList.toggle('hide',!ok);if(ok)visible++}}}}empty.classList.toggle('hide',visible>0)}}buttons.forEach(b=>b.addEventListener('click',()=>{{view=b.dataset.view;buttons.forEach(x=>x.classList.toggle('active',x===b));filter()}}));[search,cat,disp].forEach(x=>x.addEventListener('input',filter));}})();</script></body></html>'''


def _markdown_report(events, items, digest, labels, generated):
    lines = ["# 我的信息中心", "", f"更新时间：{generated}", "", "## 本轮选读与学习材料", ""]
    if not digest:
        lines.append("暂无可精选事件。")
    other_headlines = []
    for event in digest:
        if not _detailed(event):
            urls = _json(event.get("evidence_urls_json"), [])
            url = next((value for value in urls if _safe_url(value)), "")
            title = f"[{event.get('title')}]({url})" if url else event.get('title', '')
            kind = event.get('headline_kind') or DISPOSITIONS.get(event.get('disposition'), '关注')
            other_headlines.append(f"- [{labels.get(event.get('category'), event.get('category'))} · {kind}] {title}（{event.get('source_name') or '原始出处'}）")
            continue
        category = labels.get(event.get("category"), event.get("category", ""))
        lines += [f"### {event.get('title') or '未命名事件'}", "", f"{category} · {DISPOSITIONS.get(event.get('disposition'), event.get('disposition'))} · 深查：{RESEARCH_LABELS.get(event.get('research_state'), event.get('research_state'))}", "", f"**发生了什么：** {event.get('summary') or '暂无摘要'}", "", f"**为什么有用：** {event.get('why_useful') or '暂无说明'}", "", f"**学到什么：** {event.get('lesson') or '暂无知识提炼'}", "", f"**可以做什么：** {event.get('next_action') or '目前没有具体行动'}", ""]
        if _action_result_text(event):
            lines += ['**本机处理结果：**', '', _action_result_text(event), '']
        linked_urls = set()
        for source in event.get("source_info", []) if isinstance(event.get("source_info"), list) else []:
            if isinstance(source, dict) and _safe_url(source.get("url")):
                url = _safe_url(source.get("url"))
                tier = {"primary": "官方原件", "official": "官方原件", "media": "媒体报道", "research": "研究资料", "community": "社区来源"}.get(_text(source.get("tier")), "来源类型未知")
                lines.append(f"- [{source.get('name') or '原始出处'}]({url})（来源类型：{tier}）")
                linked_urls.add(url)
        for url in _json(event.get("evidence_urls_json"), []):
            if _safe_url(url) and url not in linked_urls:
                lines.append(f"- [原始出处]({url})")
        research = _json(event.get("research_json"), {})
        if isinstance(research, dict):
            for field, heading in (("overview", "深查概述"), ("mechanism", "背后的机制")):
                value = _text(research.get(field))
                if value:
                    lines += [f"**{heading}：** {value}", ""]
            for fact in research.get("verified_facts", []) if isinstance(research.get("verified_facts"), list) else []:
                if isinstance(fact, dict):
                    refs = [f"[出处]({url})" for url in fact.get("source_urls", []) if _safe_url(url)] if isinstance(fact.get("source_urls"), list) else []
                    lines.append(f"- 已查证：{fact.get('text', '')}" + (" " + " ".join(refs) if refs else ""))
            for field, heading in (("applications", "可以怎样用"), ("remaining_gaps", "尚待确认")):
                values = research.get(field)
                if isinstance(values, list) and values:
                    lines += [f"**{heading}：**", ""]
                    lines.extend(f"- {value}" for value in values if _text(value))
                    lines.append("")
            for view in research.get("financial_views", []) if isinstance(research.get("financial_views"), list) else []:
                if isinstance(view, dict):
                    kind = FINANCIAL_KIND_LABELS.get(_text(view.get("kind")), _text(view.get("kind")))
                    refs = [f"[出处]({url})" for url in view.get("source_urls", []) if _safe_url(url)] if isinstance(view.get("source_urls"), list) else []
                    lines.append(f"- 财经{kind}：{view.get('text', '')}" + (" " + " ".join(refs) if refs else ""))
            statuses = research.get("source_statuses")
            if isinstance(statuses, list) and statuses:
                lines += ["", "**查证来源状态：**", ""]
                for source in statuses:
                    if isinstance(source, dict):
                        url = _safe_url(source.get("url"))
                        label = f"[{source.get('title') or url}]({url})" if url else str(source.get("title") or "来源")
                        lines.append(f"- {label}：{source.get('status') or '状态未注明'} {source.get('detail') or ''}".rstrip())
        lines.append("")
    lines += ["## 其他领域标题", ""]
    lines.extend(other_headlines or ["本期没有新的标题线索。"])
    lines.append("")
    analyzed_count = sum(bool(item.get("analyzed_at")) for item in items)
    pending_count = sum(i.get("queue_route") == "model" for i in items)
    headline_count = sum(i.get("queue_route") == "headline" for i in items)
    reading_page = common.settings().get("output_paths", {}).get("html")
    lines += ["## 继续查看与学习", "",
              f"已处理 {analyzed_count:,} 篇资料，整理为 {len(events):,} 个事件；{pending_count:,} 篇留在模型队列，{headline_count:,} 篇为标题线索。原始资料完整保留。", "",
              "其他事件、原文与待处理资料可以在信息中心筛选和搜索；也可以在本会话说要深讲哪一条、查哪个主题、哪些内容多推或少推。", ""]
    if reading_page:
        lines.append(f"[浏览完整信息中心]({reading_page})")
    return "\n".join(lines) + "\n"



def _write_archive(events, items, labels, generated, template):
    """Static bounded pages work on local file URLs; no fetch/server is needed."""
    config = common.settings()
    directory = REPORTS / 'information-history'
    directory.mkdir(parents=True, exist_ok=True)
    style = template.split('<style>', 1)[1].split('</style>', 1)[0]
    groups = {'events': ('全部事件', events, max(1,int(config.get('report_event_page_size',24))), _event_card),
              'items': ('全部资料', items, max(1,int(config.get('report_page_size',50))), _item_card),
              'headlines': ('其他领域标题', [i for i in items if i.get('queue_route') == 'headline'], max(1,int(config.get('report_page_size',50))), _item_card),
              'pending': ('模型待分析', [i for i in items if i.get('queue_route') == 'model'], max(1,int(config.get('report_page_size',50))), _item_card),
              'expired': ('过期新闻原件', [i for i in items if i.get('queue_route') == 'expired' or i.get('freshness') == 'expired'], max(1,int(config.get('report_page_size',50))), _item_card)}
    manifest = {}
    for key, (title, records, size, render) in groups.items():
        pages = max(1, (len(records)+size-1)//size)
        manifest[key] = {'records':len(records), 'pages':pages, 'page_size':size}
        for number in range(1, pages+1):
            nav = '<a href="index.html">历史目录</a> · <a href="../latest.html">日报</a>'
            if number > 1:
                nav += f' · <a href="{key}-{number-1}.html">上一页</a>'
            if number < pages:
                nav += f' · <a href="{key}-{number+1}.html">下一页</a>'
            cards = ''.join(render(record, labels) for record in records[(number-1)*size:number*size]) or '<p>暂无资料。</p>'
            body = f'<h1>{title}</h1><p>{number}/{pages} 页 · 共 {len(records)} 条 · {nav}</p><p>摘要最多1200字；原文链接及本机完整资料可取回。在本会话说明主题或资料ID即可继续研究。</p><div class="grid">{cards}</div><p>{nav}</p>'
            common.atomic_text(directory/f'{key}-{number}.html', f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title} {number}</title><style>{style}</style><main>{body}</main></html>')
    links = ''.join(f'<p><a href="{key}-1.html">{title}：{manifest[key]["records"]} 条 / {manifest[key]["pages"]} 页</a></p>' for key,(title,_,_,_) in groups.items())
    common.atomic_text(directory/'index.html', f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>信息历史</title><style>{style}</style><main><h1>完整历史与标题清单</h1><p>更新于 {generated}；按页浏览，主题检索可直接在本会话提出。</p>{links}</main></html>')
    return manifest


def publish() -> dict:
    """Build local reading reports from the current event, item, and source tables."""
    common.ensure_dirs()
    REPORTS.mkdir(parents=True, exist_ok=True)
    db = common.connect()
    run_id = common.begin_run(db, "publish")
    stats = {}
    error = None
    try:
        import queue_policy
        queue = queue_policy.refresh(db)
        events, items, sources = _load_data(db)
        recent_runs = _recent_runs(db, exclude_id=run_id)
        config = common.settings()
        labels = config.get("category_labels", {})
        limit = max(0, int(config.get("digest_items", 18)))
        digest = _select_digest(events, limit)
        seen_urls = {url for event in digest for url in _json(event.get('evidence_urls_json'), [])}
        headlines = []
        for category in ('finance','science','world','life'):
            pool = [i for i in items if i.get('queue_route') == 'headline' and i.get('category') == category and i.get('freshness') != 'expired' and i.get('url') not in seen_urls]
            selected_sources = set()
            for item in pool:
                if item['source_id'] in selected_sources:
                    continue
                selected_sources.add(item['source_id'])
                headlines.append({'id':item['id'], 'title':item['title'], 'category':category, 'disposition':'watch', 'revision':0, 'evidence_urls_json':json.dumps([item['url']]), 'research_state':'not_needed', 'headline_kind':'新闻' if item.get('content_kind') == 'news' else '资料', 'source_name':item.get('source_name'), 'published_at':item.get('published_at')})
                if len(selected_sources) >= 2:
                    break
        digest = [event for event in digest if _detailed(event)][:max(0,limit-len(headlines))] + headlines

        generated = _now_local()
        html_text = _html_report(events, items, sources, digest, labels, generated, recent_runs)
        archive = _write_archive(events, items, labels, generated, html_text)
        markdown = _markdown_report(events, items, digest, labels, generated)
        healthy, _ = _source_health(sources)
        status = {
            "generated_at": common.now_iso(), "stage": "publish", "run_id": run_id,
            "events": len(events), "digest_events": len(digest),
            "items": len(items), "analyzed_items": sum(bool(i.get("analyzed_at")) for i in items),
            "pending_items": queue["model_pending"], "queue": queue, "archive": archive,
            "html_bytes": len(html_text.encode("utf-8")),
            "sources": len(sources), "enabled_sources": sum(bool(s.get("enabled")) for s in sources),
            "healthy_sources": healthy, "recent_runs": recent_runs,
        }
        report_paths = {"html": REPORTS / "latest.html", "markdown": REPORTS / "latest.md", "status": REPORTS / "status.json"}
        common.atomic_text(report_paths["html"], html_text)
        common.atomic_text(report_paths["markdown"], markdown)
        common.atomic_text(report_paths["status"], json.dumps(status, ensure_ascii=False, indent=2) + "\n")
        # The recurring Codex turn reads compact selected records, not this page's full archive.
        brief = {
            "generated_at": common.now_iso(),
            "iteration_results": [dict(row) for row in db.execute('''SELECT a.id AS action_id,a.event_id,a.state,a.result_text,a.error,a.updated_at,e.title,e.revision
                FROM actions a JOIN events e ON e.id=a.event_id WHERE e.revision>e.notified_revision
                AND a.kind IN ('system_model','system_tool') AND a.result_text!='' ORDER BY a.updated_at DESC LIMIT 12''')],
            "counts": {key: status[key] for key in ("events", "digest_events", "items", "analyzed_items", "pending_items", "enabled_sources", "healthy_sources")},
            "selected": [{"record_type": "event" if event.get("revision") else "headline_item", **{key: event.get(key) for key in (("id", "title", "category", "disposition", "importance", "summary", "why_useful", "lesson", "next_action", "research_state", "revision", "evidence_urls_json", "action_results") if _detailed(event) else ("id", "title", "category", "disposition", "revision", "evidence_urls_json", "source_name", "published_at", "headline_kind"))}} for event in digest],
            "reading_page": str(config.get("output_paths", {}).get("html", REPORTS / "latest.html"))
        }
        common.atomic_text(REPORTS / "brief.json", json.dumps(brief, ensure_ascii=False, indent=2) + "\n")
        focused = [event for event in digest if event.get("category") in ("ai", "coding")][:3]
        note_lines = [f"每日资料日期：{generated.split()[0]}。广泛发现，由当前AI按用途主动选读；当前先学习和扩展能力，不自动制作具体产品。",
                      f"已判断 {status['analyzed_items']} 条，待判断 {status['pending_items']} 条。"]
        for event in focused:
            title = re.sub(r"[\r\n\x00-\x1f]", " ", _text(event.get("title")))[:100]
            note_lines.append("资料标题（尚需按原件判断）：" + json.dumps(title, ensure_ascii=False))
        cloud_note = _cloud_note(config)
        note_lines.append("参考原件：reports/brief.json；完整阅读页在本会话 outputs。" + cloud_note)
        version = generated.split()[0] + ':' + '|'.join(str(event.get('id')) + ':' + str(event.get('revision')) for event in focused) + ':' + str(status['analyzed_items']) + ':' + cloud_note
        common.atomic_text(common.DATA / 'context-note.json', json.dumps({'version':version,'text':'\n'.join(note_lines)},ensure_ascii=False))
        configured = config.get("output_paths", {})
        copies = {}
        for key, source_path in report_paths.items():
            raw_path = configured.get(key)
            if raw_path:
                dest = Path(raw_path).expanduser()
                copies[key] = dest
                common.atomic_text(dest, source_path.read_text(encoding="utf-8"))
                if key == "html":
                    for archive_path in (REPORTS / "information-history").glob("*.html"):
                        archive_text = archive_path.read_text(encoding="utf-8").replace('href="../latest.html"', 'href="../' + html.escape(dest.name, quote=True) + '"')
                        common.atomic_text(dest.parent / "information-history" / archive_path.name, archive_text)
        stats = {**status, "reports": {key: str(path) for key, path in report_paths.items()}, "copies": {key: str(path) for key, path in copies.items()}}
        common.end_run(db, run_id, stats)
        return stats
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
        stats = {"run_id": run_id, "error": error}
        common.end_run(db, run_id, stats, error)
        raise
    finally:
        db.close()

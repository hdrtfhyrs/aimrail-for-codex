"""Actual source coverage and passage references; no length-based completeness."""
from __future__ import annotations
import pathlib as _public_pathlib
import importlib.util as _public_importutil
_public_root = next(p for p in _public_pathlib.Path(__file__).resolve().parents if (p/'public_paths.py').is_file())
_public_spec = _public_importutil.spec_from_file_location('ai_work_public_paths', _public_root/'public_paths.py')
_public_module = _public_importutil.module_from_spec(_public_spec)
_public_spec.loader.exec_module(_public_module)
_public_path = _public_module.public_path

import copy
import hashlib
import re


def document(value, max_chars=None):
    doc = copy.deepcopy(value)
    text = str(doc.get('text') or '')
    scope = copy.deepcopy(doc.get('scope')) if isinstance(doc.get('scope'), dict) else {}
    explicit_range = scope.get('read_range')
    # A legacy full/read flag contains no evidence of complete coverage.
    scope.setdefault('content_type', 'unknown')
    scope.setdefault('read_range', '已提供文本；原页面/材料的完整范围未知')
    scope.setdefault('completeness', 'unknown')
    scope.setdefault('unknowns', ['分页、动态内容及范围外材料未由本记录确认'])
    scope.setdefault('text_truncated', None)
    scope.setdefault('raw_path', doc.get('raw_path', ''))
    scope.setdefault('text_path', doc.get('text_path', ''))
    if max_chars is not None and len(text) > max_chars:
        scope['model_text_truncated'] = True
        scope['model_text_total_chars'] = len(text)
        text = text[:max_chars]
    else:
        scope.setdefault('model_text_truncated', False)
    scope['provided_chars'] = len(text)
    scope['provided_sha256'] = hashlib.sha256(text.encode('utf-8')).hexdigest()
    doc['text'] = text
    doc['scope'] = scope
    doc['raw_path'] = doc.get('raw_path') or scope.get('raw_path', '')
    doc['text_path'] = doc.get('text_path') or scope.get('text_path', '')
    segments, offset = [], 0
    for line in text.splitlines(keepends=True):
        end = offset + len(line)
        if line.strip():
            segments.append({'id': f'chars:{offset}-{end}', 'start': offset, 'end': end})
        offset = end
    doc['segments'] = segments
    if not text.strip():
        doc['status'] = 'failed'
    elif (scope.get('completeness') == 'complete' and explicit_range and
          scope.get('text_truncated') is False and not scope.get('model_text_truncated') and
          not scope.get('raw_truncated') and doc.get('truncated') is not True):
        doc['status'] = 'full'
    else:
        doc['status'] = 'excerpt'
    return doc


def source_status(doc):
    return {key: copy.deepcopy(doc.get(key, '')) for key in
            ('url', 'status', 'title', 'detail', 'resolved_url', 'fetched_at', 'raw_path', 'text_path',
             'source_id', 'result_id', 'item_id', 'document_id', 'retrieved_at', 'commit_sha',
             'coverage', 'truncated', 'scope')}


def evidence_level(documents):
    full = sum(doc.get('status') == 'full' for doc in documents)
    return 'full' if full and full == len(documents) else ('mixed' if full else 'excerpt')


def _normalized(text):
    return re.sub(r'\s+', ' ', text).strip()


def supported_claim(claim, by_url, require_support=False):
    urls = claim.get('source_urls', [])
    if not claim.get('text', '').strip() or not urls or any(url not in by_url for url in urls):
        raise ValueError('研究陈述必须引用本次提供的来源')
    if any(not by_url[url].get('text', '').strip() for url in urls):
        raise ValueError('研究陈述不能引用失败或未提供正文的来源')
    supports = claim.get('supports') or []
    if not supports:
        return False
    supported_urls = set()
    for support in supports:
        url, quote, locator = support.get('url'), support.get('quote', ''), support.get('locator', '')
        if url not in urls or not quote.strip() or not locator.strip():
            raise ValueError('段落支持须包含对应 URL、实际引文及定位')
        doc = by_url[url]
        if _normalized(quote) not in _normalized(doc['text']):
            raise ValueError('事实引文未出现在本次提供的正文中')
        # Generated offsets must identify the actual cited passage, not another section.
        match = re.fullmatch(r'chars:(\d+)-(\d+)', locator)
        if match:
            start, end = map(int, match.groups())
            if not 0 <= start < end <= len(doc['text']) or _normalized(quote) not in _normalized(doc['text'][start:end]):
                raise ValueError('引文字符定位与实际正文不一致')
        elif locator not in [segment['id'] for segment in doc.get('segments', [])]:
            raise ValueError('请使用本次提供文本的 chars:start-end 定位；原行号可另附说明')
        support['raw_path'] = doc.get('raw_path', '')
        support['text_path'] = doc.get('text_path', '')
        support['provided_sha256'] = doc['scope'].get('provided_sha256', '')
        supported_urls.add(url)
    return set(urls).issubset(supported_urls)


def partition_claims(result, documents):
    checked = copy.deepcopy(result)
    by_url = {doc['url']: doc for doc in documents}
    retained, reported = [], list(checked.get('reported_claims') or [])
    for fact in checked.get('verified_facts', []):
        if supported_claim(fact, by_url, True):
            retained.append(fact)
        else:
            reported.append(dict(fact, claim_type='source_report', support_level='unlocated_legacy_report'))
    for claim in reported:
        supported_claim(claim, by_url)
    for view in checked.get('financial_views', []):
        supported_claim(view, by_url)
    checked['verified_facts'] = retained
    checked['reported_claims'] = reported
    checked['claim_handling'] = '事实须有本次实际文本的引文和定位；程序核对应关系，语义、版本与适用条件由AI判断。来源报告不代表独立复现。'
    checked['evidence_level'] = evidence_level(documents)
    return checked


def blocking_gaps(result, documents):
    # New cards explicitly separate task-critical gaps from ordinary unknown coverage.
    if 'blocking_gaps' in result:
        gaps = list(result.get('blocking_gaps') or [])
    else:
        gaps = list(result.get('remaining_gaps') or [])
    if not any(doc.get('text', '').strip() for doc in documents):
        gaps.append('没有取得支持当前问题的实际正文，需要继续取得原文')
    return list(dict.fromkeys(gap for gap in gaps if isinstance(gap, str) and gap.strip()))

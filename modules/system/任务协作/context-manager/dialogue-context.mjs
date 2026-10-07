import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
// Complete JSONL records, from the end. A long answer is never character-cut.
function* reverseRecords(file) {
  const fd = fs.openSync(file, 'r');
  try {
    let cursor = fs.fstatSync(fd).size, carry = Buffer.alloc(0);
    while (cursor > 0) {
      const start = Math.max(0, cursor - 65536), chunk = Buffer.alloc(cursor - start);
      fs.readSync(fd, chunk, 0, chunk.length, start);
      const data = Buffer.concat([chunk, carry]); let end = data.length;
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 10) continue;
        if (end > i + 1) yield {offset: start + i + 1, raw: data.subarray(i + 1, end).toString('utf8').replace(/\r$/, '')};
        end = i;
      }
      carry = data.subarray(0, end); cursor = start;
    }
    if (carry.length) yield {offset: 0, raw: carry.toString('utf8').replace(/\r$/, '')};
  } finally { fs.closeSync(fd); }
}
function sessionHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    let offset = 0, data = Buffer.alloc(0);
    for (;;) {
      const chunk = Buffer.alloc(4096), read = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (!read) break;
      data = Buffer.concat([data, chunk.subarray(0, read)]); offset += read;
      const newline = data.indexOf(10);
      if (newline >= 0) { data = data.subarray(0, newline); break; }
    }
    const record = JSON.parse(data.toString('utf8').replace(/^\uFEFF/, '').replace(/\r$/, ''));
    return record.type === 'session_meta' ? record.payload?.id : null;
  } finally { fs.closeSync(fd); }
}
function visibleMessage(record, offset, file, session) {
  const p = record.payload;
  if (record.type !== 'response_item' || p?.type !== 'message') return null;
  if (p.role === 'assistant' && p.phase !== 'final_answer') return null;
  if (!['user', 'assistant'].includes(p.role)) return null;
  const meta = p.internal_chat_message_metadata_passthrough || {};
  // Native injected developer/context/tool instructions can have role=user.
  // Only known user.text records participate in the dialogue view.
  if (p.role === 'user' && !meta.content_item_kinds?.includes('user.text')) return null;
  const textParts = (p.content || []).filter(item => ['input_text', 'output_text'].includes(item.type) && typeof item.text === 'string');
  if (!textParts.length) return null;
  const text = textParts.map(item => item.text).join('\n');
  const id = p.id ? `dialogue:${session}:message:${p.id}` : `dialogue:${session}:byte:${offset}`;
  return {id, role: p.role, text, timestamp: record.timestamp, turnId: meta.turn_id || null,
    messageId: p.id || null, source: {kind: 'adjacent-dialogue', transcript: file, session, byteOffset: offset,
      messageId: p.id || null, relation: 'temporal-background-not-semantic-reference'}, hash: digest(text)};
}
function priorExchange(messages, beforeIndex) {
  let finalIndex = -1;
  for (let i = beforeIndex - 1; i >= 0; i--) if (messages[i].role === 'assistant') { finalIndex = i; break; }
  if (finalIndex < 0) return [];
  let start = finalIndex;
  while (start > 0 && messages[start - 1].role !== 'assistant') start--;
  return messages.slice(start, finalIndex + 1);
}

// Codex's supplied response_item/message format only. No hidden reasoning,
// analysis/commentary bodies or tool output payloads enter this view.
export function resolveDialogueContext(message, {maxRecords = 2500, mode = 'locate'} = {}) {
  const source = message.source;
  const transcript = typeof source === 'string' ? source : source?.transcript;
  const session = message.thread || source?.session;
  const result = {version: 1, forSourceId: message.id, transcript: transcript || null, session: session || null,
    status: 'unavailable', messages: [], anchorCandidates: [], toolEvidence: [], notes: [], semanticReference: 'not-determined'};
  if (!transcript || !path.isAbsolute(transcript) || !session) { result.notes.push('缺准确transcript/session来源；未猜测其他日志。'); return result; }
  if (source?.host && source.host !== 'codex') { result.status = 'unsupported'; result.notes.push('当前只支持本机Codex response_item/message格式。'); return result; }
  try {
    const file = path.resolve(transcript);
    if (sessionHeader(file) !== session) { result.status = 'thread-mismatch'; result.notes.push('日志session_meta与来源thread不同；未读取为当前语境。'); return result; }
    const visible = [], tools = [], damaged = []; let scanned = 0, finals = 0, priorFinals = 0, anchorSeen = false, partial = false;
    const turn = source?.turnId;
    const sourceMessageId = source?.messageId || message.messageId;
    const match = item => item.role === message.role && (
      sourceMessageId ? item.messageId === sourceMessageId :
      (item.text === message.text && (!turn || item.turnId === turn)));
    for (const entry of reverseRecords(file)) {
      if (++scanned > maxRecords) { partial = true; break; }
      let record;
      try { record = JSON.parse(entry.raw); }
      catch { damaged.push({byteOffset: entry.offset}); continue; }
      const item = visibleMessage(record, entry.offset, file, session);
      if (item) {
        visible.push(item); if (match(item)) anchorSeen = true;
        if (item.role === 'assistant') { finals++; if (anchorSeen) priorFinals++; }
        // Two completed exchanges include all same-turn steer messages between
        // them. Before-log capture needs only the latest completed exchange.
        if ((mode === 'capture-before-log' && finals >= 2) || (mode === 'locate' && anchorSeen && priorFinals >= 2)) break;
      }
      const p = record.payload;
      if (record.type === 'response_item' && ['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(p?.type)) {
        tools.push({byteOffset: entry.offset, role: 'tool', type: p.type, callId: p.call_id || null, name: p.name || null});
      }
    }
    visible.reverse();
    let matches = visible.map((item, index) => ({item, index})).filter(({item}) => match(item));
    let newlineNormalized = false;
    if (!matches.length && !sourceMessageId) {
      const normalized = message.text.replace(/\r\n/g, '\n');
      matches = visible.map((item, index) => ({item, index})).filter(({item}) => item.role === message.role && (!turn || item.turnId === turn) && item.text.replace(/\r\n/g, '\n') === normalized);
      newlineNormalized = matches.length > 0;
    }
    const selected = new Map();
    if (matches.length && mode !== 'capture-before-log') {
      result.status = matches.length === 1 ? 'matched' : 'ambiguous';
      result.anchorCandidates = matches.map(({item}) => item);
      for (const {index} of matches) for (const item of priorExchange(visible, index)) selected.set(item.id, item);
      if (matches.length > 1) result.notes.push('同turn/同文匹配多个真实消息；全部保留候选及相邻背景，未绑定首项。');
      if (newlineNormalized) result.notes.push('匹配仅规范CRLF/LF差异；各原文仍完整原样保留。');
    } else if (mode === 'capture-before-log' && source?.kind === 'hook-submission') {
      const receivedAt = Date.parse(source.receivedAt);
      const beforeReceipt = visible.filter(item => Number.isFinite(receivedAt) && Date.parse(item.timestamp) <= receivedAt);
      for (const item of priorExchange([...beforeReceipt, {role: 'user'}], beforeReceipt.length)) selected.set(item.id, item);
      result.status = 'before-log';
      result.notes.push('当前提交尚未在扫描范围定位；保存接收时间之前的上一段已完成问答背景，不认定语义指代。');
    } else { result.status = 'not-found'; result.notes.push('扫描范围内未定位准确原话；未猜测首项或其他thread。'); }
    result.messages = [...selected.values()].sort((a, b) => a.source.byteOffset - b.source.byteOffset);
    const offsets = [...result.messages, ...result.anchorCandidates].map(item => item.source.byteOffset);
    if (offsets.length) {
      const from = Math.min(...offsets), to = Math.max(...offsets);
      const selectedTools = tools.filter(item => item.byteOffset >= from && item.byteOffset <= to);
      if (selectedTools.length) result.toolEvidence.push({role: 'tool', count: selectedTools.length, transcript: file, fromByte: from, toByte: to,
        note: '工具正文及隐藏推理未进入语境；需要工程证据时按此范围和call定位原件。'});
    }
    if (damaged.length) result.notes.push(`扫描遇到${damaged.length}条损坏/未完成JSONL记录；未声称全文已读。位置：${damaged.map(item => item.byteOffset).join(', ')}`);
    if (partial) result.notes.push(`到达${maxRecords}条记录的读取容量；更早历史未读，匹配范围可能不完整。`);
    if (!result.messages.some(item => item.role === 'assistant')) result.notes.push('未取得上一段完整最终答复；保留该缺口，不能称语境配齐。');
    result.coverage = {scannedRecords: Math.min(scanned, maxRecords), historicalScope: 'adjacent-exchanges-only', partial, damagedRecords: damaged.length,
      hiddenReasoningIncluded: false, toolPayloadsIncluded: false};
    return result;
  } catch (error) { result.status = 'unavailable'; result.notes.push(`语境来源读取失败：${error.message}；原话仍保留，未消费。`); return result; }
}

export function dialogueContextFor(messages, {snapshotFile} = {}) {
  let snapshots = {}, snapshotError;
  if (snapshotFile && fs.existsSync(snapshotFile)) {
    try { snapshots = JSON.parse(fs.readFileSync(snapshotFile, 'utf8')).contexts || {}; }
    catch (error) { snapshotError = error.message; }
  }
  return messages.map(message => {
    const current = resolveDialogueContext(message);
    const saved = snapshots[message.id];
    if (!current.messages.length && saved?.sourceHash === message.hash) {
      return {...saved.context, notes: [...saved.context.notes, ...current.notes, '使用该接收事件当时保存的相邻问答快照；未推定源消息唯一身份。']};
    }
    if (snapshotError) current.notes.push(`接收时语境快照不可读：${snapshotError}；当前原话和来源仍保留。`);
    return current;
  });
}
export function renderDialogueContext(contexts) {
  const lines = ['# 相邻问答背景', '程序只按来源及相邻位置配齐材料；语义指代和重要性由AI判断，背景不会作为新增原话再消费。'];
  const emitted = new Set();
  for (const context of contexts) {
    lines.push(`## 输入 ${context.forSourceId}｜${context.status}`, ...context.notes);
    for (const message of context.messages) {
      if (emitted.has(message.id)) continue; emitted.add(message.id);
      lines.push(`### role=${message.role}；id=${message.id}`, `来源：${JSON.stringify(message.source)}`, message.text);
    }
    if (context.anchorCandidates.length > 1) lines.push(`匹配候选：${context.anchorCandidates.map(item => item.id).join('；')}`);
    for (const evidence of context.toolEvidence) lines.push(`工具证据定位：${JSON.stringify(evidence)}`);
  }
  return lines.join('\n\n');
}

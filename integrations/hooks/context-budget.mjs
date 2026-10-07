import {integrationPath} from '../paths.mjs';
// Match Codex's spill estimator: ceil(UTF-8 bytes / 4), not a tokenizer.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const sourceDigest = text => createHash('sha256').update(text).digest('hex');
export const approximateCodexTokens = text => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
const clean = value => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
export function fitsHookBudget(text, options = {}, event = 'UserPromptSubmit') {
  if (options.host === 'claude') return text.length <= (options.maxContextChars || 9500);
  const tokens = options.additionalContextLimit || (event === 'PostToolUse' ? 500 : 8000);
  return Buffer.byteLength(text, 'utf8') <= tokens * 4 - (options.contextReserveBytes ?? Math.min(200, tokens));
}

// Every selected source is whole. A deferred body and its pointer have separate
// receipts; saving the complete file never asserts that the receiver read it.
export function budgetHookBlocks(blocks, input, options = {}) {
  blocks = blocks.filter(block => block.text);
  const full = blocks.map(block => block.text).join('\n\n');
  const event = input.hook_event_name || 'UserPromptSubmit';
  if (fitsHookBudget(full, options, event)) return {text:full, delivered:blocks.map(block=>block.key), deferred:[], file:null};
  const root = options.spillDir || integrationPath("integrations/context/hook-materials");
  const file = path.join(root, options.host || 'codex', clean(input.session_id)+'-'+clean(options.consumer || input.agent_id || 'root'), sourceDigest(full)+'.md');
  let saved = false, saveError = '';
  try { fs.mkdirSync(path.dirname(file), {recursive:true}); if (!fs.existsSync(file)) fs.writeFileSync(file, full, {flag:'wx'}); saved = true; }
  catch (error) { saveError = String(error.code || error.message); }
  const note = omitted => '本次正文未投递：'+omitted.map(block=>block.label || block.key).join('、')+'。'
    +(saved ? '\n完整材料：'+file+'。继续依赖这些目标、标准或条件的工作前，请 Read 完整材料；指针投递不表示正文已读。'
      : '\n完整材料保存失败（'+saveError+'）；这些正文仍待投递，请沿相应原件读取，下一事件重试。');
  let reserve = note(blocks);
  if (!fitsHookBudget(reserve, options,event)) reserve = saved ? '本次有正文未投递；完整材料：'+file+'。继续前请 Read，未记正文已投递。' : '正文未投递，材料保存失败；请读取原件。';
  const selected = [];
  for (const block of blocks) {
    const candidate = [...selected,block];
    const trial = [...candidate.map(item=>item.text), reserve].join('\n\n');
    if (fitsHookBudget(trial, options, event)) selected.push(block);
  }
  const omitted = blocks.filter(block=>!selected.includes(block));
  let footer = note(omitted);
  if (footer.length > reserve.length) footer = reserve;
  return {text:[...selected.map(item=>item.text),footer].join('\n\n'), delivered:selected.map(block=>block.key), deferred:omitted.map(block=>block.key), file:saved?file:null};
}

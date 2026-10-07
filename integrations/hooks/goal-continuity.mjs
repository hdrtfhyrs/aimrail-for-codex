// Read-only task material. It neither classifies the new user message nor
// changes goals/permissions; the current model interprets cumulative intent.
// Shared Markdown remains the only authoritative state, including criteria.
import fs from 'node:fs';
import {readSharedState, selectSharedBranch} from '../context/shared-state.mjs';
import {readOwnedLedger} from '../context/project-context.mjs';

function standaloneFields(text) {
  // These labels are optional inside the existing four-section ledger. Never
  // derive the goal from the last next-step or an assistant summary paragraph.
  const fields = {};
  const labels = /^(?:[-*]\s+)?(本轮目标|完成标准|有效条件|阶段|负责人|下一步)[：:]\s*(.*)$/;
  let active = null;
  let sectionLevel = null;
  let sectionSeen = false;
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const codeFence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (codeFence) {
      if (!fence) { fence = {marker: codeFence[1][0], length: codeFence[1].length}; active = null; }
      else if (codeFence[1][0] === fence.marker && codeFence[1].length >= fence.length && !codeFence[2].trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      active = null;
      if (heading[2] === '当前分支') {
        if (sectionSeen) throw new Error('独立主线含重复当前分支节');
        sectionSeen = true; sectionLevel = heading[1].length;
      } else if (sectionLevel !== null && heading[1].length <= sectionLevel) sectionLevel = null;
      continue;
    }
    if (sectionLevel === null) continue;
    const match = line.match(labels);
    if (match) {
      active = match[1];
      if (Object.hasOwn(fields, active)) throw new Error(`独立主线字段重复：${active}`);
      fields[active] = match[2];
    } else if (active && (/^\s{2}/.test(line) || active === '完成标准' && (!line.trim() || /^[-*]\s+\[[ xX]\]/.test(line)))) fields[active] += '\n' + line.replace(/^  /, '');
    else active = null;
  }
  return fields;
}

export function readGoalFrame(saved = {}, options = {}) {
  if (options.disableContinuity) return null;
  if (saved.project) {
    const state = (options.continuityStateReader || readSharedState)(saved.project);
    const {selected: branch} = selectSharedBranch(state, saved);
    if (branch) return {source: branch.source || state.file, project: saved.project, revision: state.revision, branch: branch.id, name: branch.name,
      goal: (branch.fields['本轮目标'] || '').trim(), criteria: (branch.fields['完成标准'] || '').trim(),
      conditions: (branch.fields['有效条件'] || '').trim(), phase: (branch.fields['阶段'] || '').trim(),
      owner: (branch.fields['负责人'] || '').trim(), next: (branch.fields['下一步'] || '').trim()};
    if (!readOwnedLedger(saved)) return null; // No latest/only/parent branch guessing.
  }
  if (saved.ledger && fs.existsSync(saved.ledger)) {
    const text = fs.readFileSync(saved.ledger, 'utf8').replace(/^\uFEFF/, '');
    const fields = standaloneFields(text);
    const section = title => text.match(new RegExp('^#{1,6}\\s+'+title+'\\s*\\r?\\n([\\s\\S]*?)(?=^#{1,6}\\s|$(?![\\s\\S]))','m'))?.[1]?.trim() || '';
    return {source: saved.ledger, project: saved.project || null, revision: null, branch: null, name: '本会话独立任务',
      goal: (fields['本轮目标'] || '').trim(), criteria: (fields['完成标准'] || '').trim(),
      conditions: (fields['有效条件'] || section('有效状态')).trim(), phase: (fields['阶段'] || section('阶段')).trim(),
      owner: (fields['负责人'] || '').trim(), next: (fields['下一步'] || '').trim()};
  }
  return null;
}

export function criterionItems(value = '') {
  // Actual model-written state can place several marked criteria on one line.
  // A semicolon before a new marker starts a criterion; the first [x] must not
  // swallow later [ ] items. This is Markdown status parsing, not task intent.
  return value.split(/\r?\n|[;；]\s*(?=(?:[-*]\s+)?\[[ xX]\]\s)/).filter(line => line.trim()).map(line => {
    const text = line.trim().replace(/^[-*]\s+/, '');
    const match = text.match(/^\[([ xX])\]\s*(.*)$/);
    return {text: match ? match[2] : text, verified: Boolean(match && /x/i.test(match[1]))};
  });
}

export function formatGoalFrame(frame, {maxChars = 1100} = {}) {
  if (!frame) return '';
  const source = `原件：${frame.source}${frame.branch ? '；分支：' + frame.branch : ''}`;
  const heading = '保存的任务范围（本条新消息尚未合入，用户最新意思优先）：';
  const lines = [heading];
  for (const [label, value] of [['阶段', frame.phase], ['职责', frame.owner]]) {
    if (!value) continue;
    const line = `${label}：${value}`;
    if (lines.join('\n').length + line.length + source.length + 160 <= maxChars) lines.push(line);
    else lines.push(`${label}全文${value.length}字未展开；行动前读原件，不从目标句猜${label}。`);
  }
  if (!frame.goal && !frame.criteria) {
    const line = `有效条件：${frame.conditions || '未单列'}`;
    if (lines.join('\n').length + line.length + source.length + 180 <= maxChars) lines.push(line);
    else lines.push(`有效条件全文${frame.conditions.length}字未展开；行动前读原件。`);
    lines.push(`${frame.name}尚未单列本轮目标/完成标准。接续实质任务时按累积原话补在本分支；不拿最新下一步代替目标。`, source);
    return lines.join('\n');
  }
  const goalLine = `本轮目标：${frame.goal}`;
  if (!frame.goal) lines.push('本轮目标未单列；按原话补齐，不能从局部下一步推定。');
  else if (lines.join('\n').length + goalLine.length + source.length + 120 <= maxChars) lines.push(goalLine);
  else lines.push(`本轮目标全文${frame.goal.length}字，短提示未展开；先按原件读本轮目标，不从局部进度补猜。`);
  if (frame.conditions) {
    const conditionLine = `有效条件：${frame.conditions}`;
    if (lines.join('\n').length + conditionLine.length + source.length + 150 <= maxChars) lines.push(conditionLine);
    else lines.push(`有效条件全文${frame.conditions.length}字，短提示未展开；行动前按原件读本分支条件。`);
  }
  const items = criterionItems(frame.criteria);
  const remaining = items.filter(item => !item.verified);
  const completed = items.length - remaining.length;
  if (!items.length) lines.push('完成标准未单列；按本轮结果范围补齐，收尾据实际产物核对。');
  else if (!remaining.length) lines.push(`已标记覆盖${completed}项标准；标记本身不是验收，收尾核真实产物与最新条件。`);
  else {
    lines.push(`待覆盖标准（已标记覆盖${completed}/${items.length}项）：`);
    const tailBudget = source.length + 80;
    let shown = 0;
    for (const item of remaining) {
      const line = `- [ ] ${item.text}`;
      if (lines.join('\n').length + line.length + tailBudget > maxChars) break;
      lines.push(line); shown++;
    }
    if (shown < remaining.length) lines.push(`另有${remaining.length - shown}项未展开，按原件读完整标准；不能据短提示判全部完成。`);
  }
  lines.push(source);
  return lines.join('\n'); // Never amputate a goal or a criterion mid-sentence.
}

export function goalContinuityNote(input = {}, saved = {}, options = {}) {
  // An inherited parent route is not the child's own task. Child scope comes
  // from its explicit assignment, so never prepend the parent's task frame.
  if (input.hook_event_name === 'SubagentStart' || input.agent_id) return '';
  if (!['UserPromptSubmit', 'SessionStart'].includes(input.hook_event_name || 'UserPromptSubmit')) return '';
  try { return formatGoalFrame(readGoalFrame(saved, options), options); }
  catch { return '本轮目标/标准原件暂不可读；保留用户当前要求，按明确任务路由查原件，不从其他分支补出目标。'; }
}

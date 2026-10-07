// Retrieval context is material, not an interpretation of intent or authorization.
// Shared state is read afresh; the caller's query cache only preserves recall.
import {readGoalFrame} from './goal-continuity.mjs';

export function retrievalPrompt(input = {}) {
  const text = String(input.prompt || '');
  const marker = text.lastIndexOf('## My request:');
  return (marker >= 0 ? text.slice(marker + 14) : text).trim();
}

const frameStamp = (frame, currentMessage) => frame ? {source: frame.source, project: frame.project || null,
  branch: frame.branch || null, goal: frame.goal || '', conditions: frame.conditions || '', revision: frame.revision ?? null,
  goalRelation: currentMessage === frame.goal?.trim() ? 'exact-goal-text' : 'unverified'} :
  {source: null, project: null, branch: null, goal: null, conditions: null, revision: null, goalRelation: 'no-frame'};

function appendConstraint(previous, text, scope, input, frame) {
  const result = {scope, records: [...(previous?.records || [])], overflow: previous?.overflow ? {...previous.overflow} : null};
  if (result.records.some(record => record.text === text)) return result;
  const source = {kind: 'current-message', session: input.session_id || null,
    transcript: input.transcript_path || null, frameSource: frame?.source || null,
    branch: frame?.branch || null, frameRevision: frame?.revision ?? null};
  const chars = result.records.reduce((sum, record) => sum + record.text.length, 0);
  // Store whole messages or an explicit omission marker. Never cut a trailing
  // prohibition to make a constraint look complete.
  if (result.records.length < 4 && chars + text.length <= 1800) result.records.push({text, source});
  else result.overflow = {count: (result.overflow?.count || 0) + 1,
    requiredChars: (result.overflow?.requiredChars || 0) + text.length, lastSource: source};
  return result;
}

export function resolveTaskRetrievalContext(input = {}, saved = {}, state = {}, options = {}) {
  const event = input.hook_event_name || 'UserPromptSubmit';
  const currentMessage = retrievalPrompt(input);
  let frame = null;
  // An inherited binding is not the child's task. prepare uses its own text.
  if (!input.agent_id && event !== 'SubagentStart') {
    try { frame = readGoalFrame(saved, options); } catch { /* No guessed fallback. */ }
  }
  let taskContext = frame ? [frame.goal, frame.conditions].filter(Boolean).join('\n').slice(0, 4000) : '';
  const nextScope = input.agent_id ? 'agent:' + input.agent_id :
    JSON.stringify([saved.project || '', saved.branchId || frame?.branch || '', saved.ledger || '']);
  const trustedScope = state.queryScope === nextScope && state.queryOrigin === 'current-message';
  const sameFrameGoal = state.queryFrame && (!frame || state.queryFrame.goal === frame.goal);
  const reliableGoalRelation = sameFrameGoal && state.queryFrame.goalRelation === 'exact-goal-text';
  const frameGoalChanged = Boolean(trustedScope && state.queryFrame && frame && state.queryFrame.goal !== frame.goal);
  // Legacy query-only caches have no provenance. Do not silently promote them
  // into a reliable continuation or an automatically expanded old task.
  const previous = trustedScope && !frameGoalChanged ? String(state.query || '').slice(0, 1600) : '';
  const preservedConstraints = state.retrievalConstraints?.scope === nextScope ? state.retrievalConstraints : null;
  const continuationPattern = /^(?:继续(?:吧|执行|做|处理)?|接着(?:做|执行)?|执行|开始(?:吧|执行)?|好的?|可以|行|ok|go ahead|continue)[\s.!。！?？]*$/i;
  const continuationDetail = /^(?:继续(?:执行|做|处理)?|接着(?:做|执行)?|执行)[，,:：]\s*\S/.test(currentMessage);
  const continuation = event === 'SessionStart' || continuationPattern.test(currentMessage) || continuationDetail;
  // Only an explicit label preserves retrieval context. It does not assert that
  // the model should continue, change permission, or treat these words as a goal.
  const contextAddition = /^(?:条件增加|补充条件|增加条件|新增条件|条件补充)[：:]/.test(currentMessage);
  const greeting = /^(?:你好|嗨|在吗|谢谢|hello|hi)[\s.!。！?？]*$/i.test(currentMessage);
  let query = currentMessage, nextQuery = currentMessage.slice(0, 1600), origin = 'current-message';
  let nextQueryFrame = frameStamp(frame, currentMessage), nextRetrievalConstraints = null;
  if (continuation) {
    query = previous || frame?.goal || '';
    if (continuationDetail) query = [currentMessage, query].filter(Boolean).join('\n');
    nextQuery = previous;
    origin = previous ? 'previous-query' : frame?.goal ? 'branch-goal' : 'none';
    if (previous) taskContext = reliableGoalRelation ? frame?.conditions || '' : ''; // Same binding does not establish task relevance.
    nextQueryFrame = previous ? state.queryFrame || null : null;
    nextRetrievalConstraints = preservedConstraints;
    if (continuationDetail) nextRetrievalConstraints = appendConstraint(nextRetrievalConstraints, currentMessage, nextScope, input, frame);
  } else if (contextAddition) {
    query = [currentMessage, previous || frame?.goal].filter(Boolean).join('\n');
    nextQuery = previous;
    origin = 'explicit-context-addition';
    if (previous) taskContext = reliableGoalRelation ? frame?.conditions || '' : '';
    nextQueryFrame = previous ? state.queryFrame || null : null;
    nextRetrievalConstraints = appendConstraint(preservedConstraints, currentMessage, nextScope, input, frame);
  } else if (greeting) {
    query = ''; nextQuery = previous; origin = 'greeting';
    nextQueryFrame = previous ? state.queryFrame || null : null;
    nextRetrievalConstraints = preservedConstraints;
  }
  const constraintRows = nextRetrievalConstraints?.records?.map(record => record.text) || [];
  const hasConstraints = constraintRows.length > 0 || Boolean(nextRetrievalConstraints?.overflow);
  if (hasConstraints && query && !constraintRows.includes(query)) query = [...constraintRows.filter(row => !query.includes(row)), query].join('\n');
  const conditionsChanged = Boolean((continuation || contextAddition || greeting) && previous && sameFrameGoal && frame && state.queryFrame.conditions !== frame.conditions);
  const evidenceRows = (nextRetrievalConstraints?.records || []).map(record =>
    `限定原话（${record.source?.branch || '当前消费者'}；来源版本${record.source?.frameRevision ?? '未保存'}）：${record.text}`);
  if (conditionsChanged && frame.conditions) evidenceRows.push(`保存分支当前条件（${frame.branch || frame.source}；${reliableGoalRelation ? '查询与goal全文一致' : '背景，未核本条任务关联，不用于召回资格'}；不代替本条目标）：${frame.conditions}`);
  if (nextRetrievalConstraints?.overflow) evidenceRows.push(`限定原话未完整展开：${nextRetrievalConstraints.overflow.requiredChars}字符，${nextRetrievalConstraints.overflow.count}条；按当前会话原件读取，自动全文预取保持关闭。`);
  const contextEvidence = evidenceRows.length ? '检索语境保留的限定原话/来源（不是新授权）：\n' + evidenceRows.join('\n') : '';
  const nextOrigin = continuation || contextAddition || greeting ? previous ? 'current-message' : 'none' : origin;
  return {query, taskContext, nextQuery, nextScope, nextOrigin, nextQueryFrame, nextRetrievalConstraints,
    continuation, contextAddition, contextEvidence, frameGoalChanged,
    allowPrefetch: false, currentMessage, frame, origin};
}

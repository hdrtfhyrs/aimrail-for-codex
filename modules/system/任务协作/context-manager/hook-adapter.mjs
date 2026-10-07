import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {captureEnabledSubmission, pendingHookContext} from './context-manager.mjs';

export {pendingHookContext};
const DEFAULT_BINDINGS = _publicPath("$codex/context/bindings");
const skipped = reason => ({status: 'skipped', reason});

// Capture a delivery event; no cwd discovery, inherited binding, semantic
// decision, human-identity inference, model call, or shared-state mutation.
export async function captureHookSubmission(input, {host, bindingsDir = DEFAULT_BINDINGS} = {}) {
  if (!input || input.hook_event_name !== 'UserPromptSubmit') return skipped('not-user-prompt-submit');
  if (input.agent_id !== undefined && input.agent_id !== null && input.agent_id !== '') return skipped('agent-submission');
  if (input.probe === true || input.is_probe === true || process.env.KNOWLEDGE_PROBE_LOG) return skipped('probe');
  if (!['codex', 'claude', 'shared'].includes(host)) return skipped('missing-stable-host');
  const session = input.session_id, turn = input.turn_id;
  if (typeof session !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(session)) return skipped('missing-stable-session');
  if (typeof turn !== 'string' || !turn.trim() || /[\r\n\0]/.test(turn)) return skipped('missing-stable-turn');
  if (typeof input.prompt !== 'string' || !input.prompt.length || input.prompt.includes('\0')) return skipped('missing-prompt');
  // A turn can contain several steer messages, and the hook is called before
  // their transcript entry exists. This is receipt identity, never source
  // message identity. Preserve every receipt instead of guessing exactly-once.
  const occurrenceId = randomUUID();
  const sourceId = `hook-receipt:${host}:${session}:${occurrenceId}`;
  const source = {kind: 'hook-submission', host, session, turnId: turn, event: 'UserPromptSubmit',
    transcript: typeof input.transcript_path === 'string' && input.transcript_path ? input.transcript_path : null,
    occurrenceId, receivedAt: new Date().toISOString(), promptDigest: createHash('sha256').update(input.prompt).digest('hex'),
    identity: 'local-received-event-not-source-message-identity', repetition: 'possible-redelivery-not-human-confirmation'};
  let project, branchId;
  try {
    if (!path.isAbsolute(bindingsDir)) throw new Error('bindingsDir须为绝对路径。');
    const bindingFile = path.join(bindingsDir, host, `${session}.json`);
    if (!fs.existsSync(bindingFile)) return skipped('no-explicit-session-binding');
    const binding = JSON.parse(fs.readFileSync(bindingFile, 'utf8').replace(/^\uFEFF/, ''));
    project = binding.project; branchId = binding.branchId;
    if (typeof project !== 'string' || !path.isAbsolute(project) || typeof branchId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(branchId)) return skipped('binding-has-no-explicit-project-and-branch');
    return await captureEnabledSubmission({project, branchId, message: {id: sourceId, role: 'user', text: input.prompt, source, thread: session}});
  } catch (error) {
    // The original user delivery continues through the host. Expose the entire
    // uncaptured event to the hook so it can also include it as a failure source.
    return {status: 'failed', error: error.message, project, branchId, sourceId, source,
      fallbackText: `上下文来源捕获失败：${error.message}\n本次提交未标为已融合；以下原文仍须处理。role=user是提交事件身份，不证明真人确认。\n来源：${JSON.stringify(source)}\n\n${input.prompt}`};
  }
}

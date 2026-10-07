import {integrationPath} from '../paths.mjs';
// 用户发话时，程序按本条原话从本地知识/经验/错误/对象/资源/成果中检索，
// 把排在前面的线索直接送进上下文（原先只给“可以用某命令去取”的指针）。
// 同一会话已送过的条目不重复；超时或出错时静默跳过，不影响原任务。
import fs from 'node:fs';
import path from 'node:path';
import {recall, formatRecall, spawnEmbedIfStale} from '../context/recall.mjs';
import {retrievalPrompt} from './task-retrieval-context.mjs';

const SEEN = integrationPath("integrations/context/recall-cache/seen");
const clean = v => String(v || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);

export async function promptRecall(input, host, options = {}) {
  const query = retrievalPrompt(input);
  // 很短的接续话（“继续”“好的”）没有新主题，上一轮送过的线索仍在上下文里。
  if (query.replace(/\s/g, '').length < 6) return null;
  const file = path.join(SEEN, `${clean(host)}-${clean(input.session_id)}.json`);
  let seen = [];
  try { seen = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let timer;
  const result = await Promise.race([
    recall(query, {limit: 8, exclude: seen}),
    new Promise(resolve => { timer = setTimeout(() => resolve(null), options.timeoutMs ?? 4500); timer.unref?.(); }),
  ]).catch(() => null).finally(() => clearTimeout(timer));
  if (!result) return null;
  if (result.vector === 'ok') spawnEmbedIfStale();
  let text = formatRecall(result, {maxChars: options.maxChars ?? 2600});
  const branchNote = await branchCandidates(input, host, query).catch(() => '');
  if (branchNote) text = text ? text + '\n\n' + branchNote : branchNote;
  if (!text) return null;
  return {text, commit(finalText) {
    if (!finalText.includes(text.slice(0, 60))) return;
    const shown = result.items.filter(item => finalText.includes(item.ref)).map(item => item.id);
    try { fs.mkdirSync(SEEN, {recursive: true}); fs.writeFileSync(file, JSON.stringify([...new Set([...seen, ...shown])].slice(-400))); } catch {}
  }};
}

// 会话还没有任务分支时：共享状态里负责人已写明本会话的分支直接绑定；否则按原话给几个候选分支。
// 用户原意“建项目、把对话划到项目里要自动做”；候选只在语义不确定时交给AI判断。
const BINDINGS = integrationPath("integrations/context/bindings");
const CONTEXT_CLI = integrationPath("integrations/context/project-context.mjs");
async function branchCandidates(input, host, query) {
  if (input.agent_id || !/^[a-zA-Z0-9_-]{1,200}$/.test(String(input.session_id || ''))) return '';
  let binding = null;
  try { binding = JSON.parse(fs.readFileSync(path.join(BINDINGS, host, input.session_id + '.json'), 'utf8')); } catch {}
  if (binding?.branchId) return '';
  const {recall, branchOwnedBy} = await import('../context/recall.mjs');
  const owned = await branchOwnedBy(`${host}:${input.session_id}`);
  const mine = owned.length === 1 ? owned[0] : null;
  if (mine) {
    const [, project, branch] = mine.id.match(/^branch:([^:]+):(.+)$/) || [];
    if (project && branch) {
      const {spawnSync} = await import('node:child_process');
      const projectDir = path.join(integrationPath("workspace/projects"), project);
      const verb = binding ? 'rebind' : 'bind';
      const r = spawnSync(process.execPath, [CONTEXT_CLI, verb, '--host', host, '--session', input.session_id, '--cwd', input.cwd || projectDir, '--project', projectDir, '--branch', branch], {encoding: 'utf8', windowsHide: true, timeout: 4000});
      if (r.status === 0) return `本会话已按共享状态负责人记录自动绑定到分支：${mine.title} [${branch}]（${project}）。`;
    }
  }
  const found = await recall(query, {kinds: 'branch', limit: 4, refresh: false});
  if (!found.items.length) return '';
  const rows = found.items.map(item => { const [, project, branch] = item.id.match(/^branch:([^:]+):(.+)$/) || []; return `- ${item.title} [${branch}]（${project}）`; });
  return `本会话还没有任务分支。按本条原话找到的可能相关分支（候选，按原话和分支目标判断；一次性问答可不绑定；持续任务确属其一就绑定，都不是再按project-state.md新建）：\n${rows.join('\n')}\n绑定：node "${CONTEXT_CLI}" ${binding ? 'rebind' : 'bind'} --host ${host} --session ${input.session_id} --cwd "工作目录" --project "项目目录" --branch 分支ID`;
}

// 派子代理时按派工正文检索相关经验、错误和成果，附进子代理的任务包（评审代理也由此拿到相关错误库条目）。
export async function agentTaskRecall(input) {
  let args = input.tool_input;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return null; } }
  const task = String(args?.prompt || args?.message || '');
  if (task.replace(/\s/g, '').length < 10) return null;
  let timer;
  const result = await Promise.race([recall(task.slice(0, 1600), {limit: 6, kinds: 'knowledge,experience,error,failure,deliverable,object'}),
    new Promise(resolve => { timer = setTimeout(() => resolve(null), 4000); timer.unref?.(); })]).catch(() => null).finally(() => clearTimeout(timer));
  const text = result ? formatRecall(result, {maxChars: 1800}) : '';
  return text ? {text} : null;
}

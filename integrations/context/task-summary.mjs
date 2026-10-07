import {integrationPath} from '../paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const defaultBridge = integrationPath("modules/system/任务协作/task-bridge.mjs");
const defaultDatabase = integrationPath("modules/system/任务协作/tasks.sqlite");
const samePath = (left, right) => typeof left === 'string' && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const short = (value, limit) => String(value || '').replace(/\s+/g, ' ').slice(0, limit);

// 不初始化库、不领取任务、不更新状态；故障由上层路由展示，不能拖住用户提示。
export function readTaskSummary(project, route = {}, options = {}) {
  const database = options.database || defaultDatabase;
  if (!fs.existsSync(database)) return '';
  const db = new DatabaseSync(database, {readOnly: true, timeout: 100});
  try {
    const rows = db.prepare("SELECT id,title,project_ref,ledger_ref,state,owner,next_step FROM tasks WHERE state IN ('open','claimed','blocked','failed') AND (replace(project_ref, char(92), '/') = ? COLLATE NOCASE OR replace(project_ref, char(92), '/') = ? COLLATE NOCASE) ORDER BY updated_at DESC LIMIT 5")
      .all(path.resolve(project).replaceAll('\\', '/'), path.resolve(project, '核心.md').replaceAll('\\', '/'));
    const relevant = rows.filter(row => samePath(row.project_ref, project) || samePath(row.project_ref, path.join(project, '核心.md')));
    if (!relevant.length) return '';
    const blocks = [];
    for (const row of relevant.slice(0, 4)) {
      const block = `任务 ${short(row.id, 48)}：${short(row.title, 65)}；状态 ${row.state}；负责人 ${short(row.owner, 32) || '未领取'}\n下一步：${short(row.next_step, 95)}\n状态原件：${short(row.ledger_ref, 140)}`;
      if (blocks.join('\n').length + block.length > 850) break;
      blocks.push(block);
    }
    return `${blocks.join('\n')}\n${relevant.length > blocks.length ? '另有任务未展开；' : ''}用 node "${options.bridge || defaultBridge}" compact 展开任务与授权引用。按原件和用户已授权范围判断是否接续，不能自动领取其他会话的任务。`.slice(0, 1200);
  } finally { db.close(); }
}

import path from 'node:path';
import os from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';

const system = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(system, '../..');
const data = process.env.AI_WORK_DATA_HOME || process.env.AI_WORK_HOME || path.join(repository, 'workspace');
export const publicRoots = {
  system: process.env.AI_WORK_SYSTEM_HOME || system,
  codex: process.env.AI_CODEX_HOME || path.join(repository, 'integrations'),
  projects: process.env.AI_PROJECTS_HOME || path.join(data, 'projects'),
  data,
  user: process.env.AI_USER_HOME || path.join(data, 'user'),
  runtime: process.env.AI_RUNTIME_HOME || path.join(data, 'runtime'),
  plugins: process.env.AI_PLUGINS_HOME || path.join(repository, 'plugins'),
  models: process.env.AI_MODEL_CLIENTS_HOME || path.join(repository, 'tools/model-clients'),
};
export function publicPath(value) {
  const match = /^\$(\w+)(?:\/(.*))?$/.exec(String(value));
  if (!match) return String(value);
  if (!publicRoots[match[1]]) throw new Error('Unknown public root: ' + match[1]);
  const tail = match[2] || '';
  const state = !['modules.json','schema.json','package.json','package-lock.json'].includes(path.basename(tail)) && /\.(?:json|sqlite|db|lock|jsonl)$/.test(tail) || /(?:^|\/)(?:bindings|failure-inbox|archive|sessions)(?:\/|$)/.test(tail);
  const base = state && ['codex','system'].includes(match[1]) ? path.join(data, match[1] === 'codex' ? 'integrations' : 'system') : publicRoots[match[1]];
  const result = path.resolve(base, tail);
  return String(value).endsWith('/') ? result + path.sep : result;
}
export const publicURL = value => pathToFileURL(publicPath(value)).href;
export const publicDataPath = value => path.resolve(data, 'system', value);

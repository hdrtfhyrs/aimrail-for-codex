#!/usr/bin/env node
// Initialize only missing configuration in the user's selected work directory.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {publicRoots, publicPath, publicDataPath} from './public-paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const resolve = value => {
  if (typeof value === 'string' && value.startsWith('$')) return publicPath(value);
  if (Array.isArray(value)) return value.map(resolve);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
  return value;
};
const copies = [
  ['information-settings.json', '信息中心/config/settings.json'],
  ['information-sources.json', '信息中心/config/sources.json'],
  ['information-collection.json', '信息中心/config/collection.json'],
  ['resource-registry.json', '资料中心/data/资料登记.json'],
  ['object-knowledge.json', '资料中心/object-knowledge/data/objects.json'],
  ['conversation-organization.json', '本地统一/对话记录/organization.json'],
  ['runtime-sources.json', '本地统一/运行环境/sources.json'],
  ['runtime-connections.json', '运行中心/connections.json'],
];
const created = [], preserved = [];
for (const [example, destination] of copies) {
  const target = publicDataPath(destination);
  if (fs.existsSync(target)) { preserved.push(target); continue; }
  const value = resolve(JSON.parse(fs.readFileSync(path.join(here, 'examples', example), 'utf8')));
  if (example === 'information-settings.json') {
    value.python_path = process.env.AI_PYTHON_PATH || value.python_path;
    value.codex_path = process.env.AI_CODEX_EXECUTABLE || value.codex_path;
    value.triage_model = process.env.AI_INFORMATION_TRIAGE_MODEL || value.triage_model;
    value.research_model = process.env.AI_INFORMATION_RESEARCH_MODEL || value.research_model;
  }
  fs.mkdirSync(path.dirname(target), {recursive:true});
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n', {flag:'wx'});
  created.push(target);
}
for (const folder of ['运行中心','任务协作','本地统一/运行环境','本地统一/对话记录','存储接入','成果展厅','信息中心/data','信息中心/logs','信息中心/reports']) {
  fs.mkdirSync(publicDataPath(folder), {recursive:true});
}
const cloudConfig = publicDataPath('信息中心/cloud/config');
fs.mkdirSync(cloudConfig, {recursive:true});
for (const [name, value] of [['settings.json', {name:'Public cloud collector',timezone:'Asia/Shanghai',request_timeout_seconds:30,collector_workers:4,max_response_bytes:5000000,max_items_per_source:100}], ['sources.json', {sources:[]}]]) {
  const target=path.join(cloudConfig,name);
  if (!fs.existsSync(target)) { fs.writeFileSync(target,JSON.stringify(value,null,2)+'\n',{flag:'wx'});created.push(target); }
}
console.log(JSON.stringify({created, preserved, workDirectory:publicRoots.data, next:'Edit information settings and sources. Installation does not register schedules, authenticate, or invoke a model.'},null,2));

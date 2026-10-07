import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {effectiveRecords, realityStatus, refreshReality, readReality,resourceFederationStatus} from './reality.mjs';
export {refreshReality, realityStatus} from './reality.mjs';

export const CENTER = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FILE = path.join(_publicDataPath("资料中心/object-knowledge/data"), 'objects.json');
export const FORMAT = 'ai-object-knowledge-v1';
export const CLAIM_KINDS = ['fact', 'role', 'state', 'judgment', 'recommendation'];
export const STATUSES = ['verified', 'unverified', 'disputed', 'superseded'];
const now = () => new Date().toISOString();
const clone = value => JSON.parse(JSON.stringify(value));
const loadJSON = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const normalize = value => String(value || '').normalize('NFKC').toLowerCase();
function fail(message, code = 'INVALID') { const error = new Error(message); error.code = code; throw error; }
function text(value, label, required = false, max = 16000) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${label}须为${required ? '非空' : ''}字符串`);
  if (/\u0000/.test(value)) fail(`${label}含非法字符`);
  return value.trim();
}
function id(value, label = 'id') { const v = text(value, label, true, 240); if (!/^[\p{L}\p{N}][\p{L}\p{N}_.:/-]*$/u.test(v)) fail(`${label}格式无效`); return v; }
function strings(value, label) { if (value === undefined) return []; if (!Array.isArray(value)) fail(`${label}须为数组`); return [...new Set(value.map(v => text(v, label, true)))]; }
function date(value, label) { if (!value) return undefined; const v = text(value, label, true); if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(v) || !Number.isFinite(Date.parse(v))) fail(`${label}日期无效`); return v; }
function scope(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('scope须为对象');
  const result = {conditions: strings(value.conditions, 'scope.conditions')};
  for (const key of ['project', 'branch']) if (value[key]) result[key] = text(value[key], `scope.${key}`, true);
  if (value.operations) result.operations = strings(value.operations, 'scope.operations');
  return result;
}
function assertion(input, sourceIds, relation = false) {
  if (!input || typeof input !== 'object') fail('属性/关系须为对象');
  if (!CLAIM_KINDS.includes(input.kind) || !STATUSES.includes(input.status)) fail('kind/status无效');
  const row = {id: id(input.id), kind: input.kind, predicate: text(input.predicate, 'predicate', true), status: input.status,
    sourceIds: strings(input.sourceIds, 'sourceIds'), scope: scope(input.scope)};
  if (relation) row.targetId = id(input.targetId, 'targetId');
  else { if (input.value === undefined) fail('claim缺value'); row.value = clone(input.value); }
  if (row.status === 'verified' && !row.sourceIds.length) fail(`已核属性${row.id}缺来源`);
  for (const sid of row.sourceIds) if (!sourceIds.includes(sid)) fail(`属性${row.id}引用未知来源${sid}`);
  for (const key of ['observedAt', 'validFrom', 'validUntil', 'reviewAfter']) if (input[key]) row[key] = date(input[key], key);
  if (row.validFrom && row.validUntil && Date.parse(row.validFrom) > Date.parse(row.validUntil)) fail('有效日期倒置');
  if (input.note) row.note = text(input.note, 'note');
  if (input.identityBinding) row.identityBinding={model:text(input.identityBinding.model,'identityBinding.model',true),digest:text(input.identityBinding.digest,'identityBinding.digest',true)};
  if (input.supersedes) row.supersedes = strings(input.supersedes, 'supersedes');
  return row;
}
// A source signature is a change detector, never a truth/verification detector.
function sourceBytes(source) {
  if (!source.path) return null;
  const bytes = fs.readFileSync(source.path);
  if (source.kind === 'registry' && source.ref) {
    const db = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    const rows = Object.values(db).filter(Array.isArray).flat().filter(r => r?.id === source.ref);
    if (rows.length !== 1) fail(`来源登记ID不存在或不唯一：${source.ref}`, 'SOURCE_UNAVAILABLE');
    return Buffer.from(JSON.stringify(rows[0]));
  }
  if (source.selector?.startsWith('/')) {
    let value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    for (const segment of source.selector.slice(1).split('/').map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'))) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) fail('来源JSON指针不存在', 'SOURCE_UNAVAILABLE');
      value = value[segment];
    }
    return Buffer.from(JSON.stringify(value));
  }
  return bytes;
}
export function sourceFingerprint(source) { const bytes = sourceBytes(source); return bytes === null ? null : crypto.createHash('sha256').update(bytes).digest('hex'); }
function sourceRecord(input) {
  if (!['local', 'url', 'registry'].includes(input.kind)) fail('source.kind无效');
  const row = {id: id(input.id), kind: input.kind};
  for (const key of ['path', 'ref', 'url', 'selector', 'note']) if (input[key]) row[key] = text(input[key], `source.${key}`, true);
  if (!row.path && !row.ref && !row.url) fail('来源需path/ref/url');
  if (row.path && !path.isAbsolute(row.path)) fail('来源path须为绝对路径');
  if (row.url && !/^https?:\/\//i.test(row.url)) fail('来源url须为http(s)');
  if (input.checkedAt) row.checkedAt = date(input.checkedAt, 'source.checkedAt');
  if (input.sha256) { if (!/^[a-f0-9]{64}$/i.test(input.sha256)) fail('sha256无效'); row.sha256 = input.sha256; }
  else if (row.path) { try { row.sha256 = sourceFingerprint(row); } catch {} }
  return row;
}
export function validateRecord(input) {
  if (!input || !['object', 'category'].includes(input.kind)) fail('record.kind须为object|category');
  const row = {id: id(input.id), kind: input.kind, name: text(input.name, 'name', true, 500), summary: text(input.summary, 'summary', true, 1800),
    aliases: strings(input.aliases, 'aliases'), categories: strings(input.categories, 'categories'), sourceRefs: strings(input.sourceRefs, 'sourceRefs'),
    unknowns: strings(input.unknowns, 'unknowns')};
  row.sources = (input.sources || []).map(sourceRecord);
  if (new Set(row.sources.map(s => s.id)).size !== row.sources.length) fail('重复来源ID');
  const sourceIds = row.sources.map(s => s.id);
  row.claims = (input.claims || []).map(c => assertion(c, sourceIds));
  row.relations = (input.relations || []).map(c => assertion(c, sourceIds, true));
  for (const [name, values] of [['claim', row.claims], ['relation', row.relations]]) if (new Set(values.map(v => v.id)).size !== values.length) fail(`重复${name} ID`);
  for (const c of row.claims) for (const old of c.supersedes || []) {
    const existing = row.claims.find(v => v.id === old);
    if (!existing || existing === c) fail('supersedes须指向保留的旧claim');
    existing.status = 'superseded';
  }
  return row;
}
function empty() { return {format: FORMAT, revision: 0, updatedAt: null, records: [], history: []}; }
export function readStore(options = {}) {
  const file = options.file || DEFAULT_FILE;
  if (!fs.existsSync(file)) return empty();
  const db = loadJSON(file);
  if (db.format !== FORMAT || !Number.isInteger(db.revision) || !Array.isArray(db.records) || !Array.isArray(db.history)) fail('生产库格式无效；保留原件并恢复备份', 'CORRUPT_STORE');
  return db;
}
function checkGraph(records) {
  const byId = new Map(records.map(r => [r.id, r]));
  if (byId.size !== records.length) fail('对象ID重复');
  for (const r of records) {
    for (const c of r.categories) if (byId.get(c)?.kind !== 'category') fail(`${r.id}的类别${c}不存在或不是类别`);
    for (const rel of r.relations) if (!byId.has(rel.targetId)) fail(`${r.id}关系目标${rel.targetId}不存在`);
  }
  function visit(key, stack = []) { if (stack.includes(key)) fail('类别循环引用'); for (const c of byId.get(key).categories) visit(c, [...stack, key]); }
  for (const key of byId.keys()) visit(key);
}
function withLock(file, fn) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const lock = `${file}.lock`; let fd; const deadline = Date.now() + 3000;
  while (fd === undefined) {
    try { fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, JSON.stringify({pid: process.pid, at: now()})); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { const owner = loadJSON(lock); try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') { fs.unlinkSync(lock); continue; } } } catch {}
      if (Date.now() >= deadline) fail('对象库由另一执行者维护中；重读后再保存', 'LOCKED');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function commit(file, db) {
  let backup = null;
  if (fs.existsSync(file)) {
    const folder = path.join(path.dirname(file), 'backups'); fs.mkdirSync(folder, {recursive: true});
    backup = path.join(folder, `objects-r${readStore({file}).revision}-${crypto.randomUUID()}.json`);
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  }
  const tmp = `${file}.${crypto.randomUUID()}.tmp`; let fd;
  try { fd = fs.openSync(tmp, 'wx'); fs.writeFileSync(fd, JSON.stringify(db, null, 2) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(tmp, file); }
  finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return backup;
}
export function importBundle(bundle, options = {}) {
  if (bundle.format !== 'ai-object-knowledge-bundle-v1' || !Array.isArray(bundle.records) || !bundle.records.length) fail('导入bundle格式无效');
  const reason = text(options.reason || bundle.reason, '变更理由', true), file = options.file || DEFAULT_FILE;
  const incoming = bundle.records.map(validateRecord);
  if (new Set(incoming.map(r => r.id)).size !== incoming.length) fail('批内对象ID重复');
  return withLock(file, () => {
    const db = readStore({file}), changes = [];
    for (const row of incoming) {
      const i = db.records.findIndex(r => r.id === row.id), old = db.records[i];
      const expected = bundle.expectedVersions?.[row.id] ?? (old ? undefined : 0);
      if (expected !== (old?.version || 0)) fail(`对象${row.id}版本不符或未指定；重读后保存`, 'VERSION_CONFLICT');
      row.version = (old?.version || 0) + 1; row.createdAt = old?.createdAt || now(); row.updatedAt = now();
      if (i >= 0) db.records[i] = row; else db.records.push(row);
      changes.push({id: row.id, fromVersion: old?.version || 0, toVersion: row.version});
    }
    checkGraph(db.records); db.revision++; db.updatedAt = now();
    db.history.push({revision: db.revision, at: db.updatedAt, reason, changes});
    const backup = commit(file, db);
    return {file, revision: db.revision, changes, backup};
  });
}
export function saveObject(record, options = {}) {
  if (!Number.isInteger(options.expectedVersion)) fail('保存须显式expectedVersion（新记录0）');
  return importBundle({format: 'ai-object-knowledge-bundle-v1', reason: options.reason, records: [record], expectedVersions: {[record.id]: options.expectedVersion}}, options);
}
function queryStore(options={}) { const db=readStore(options); return {...db, records:effectiveRecords(db.records,options)}; }
function brief(r) { return {id: r.id, kind: r.kind, name: r.name, summary: r.summary, aliases: r.aliases, categories: r.categories, version: r.version, origin:r.origin||'maintained-object'}; }
export function listObjects(options = {}) {
  const db = queryStore(options); let records = db.records;
  if (options.kind) { if (!['object', 'category'].includes(options.kind)) fail('kind无效'); records = records.filter(r => r.kind === options.kind); }
  if (options.category) records = records.filter(r => r.categories.includes(options.category));
  return {revision: db.revision, total: records.length, maintainedCount:readStore(options).records.length, reality:realityStatus(options),resourceFederation:resourceFederationStatus(options), selection: 'unranked', items: records.map(brief), boundary: '目录含正式维护对象、现用资源联合视图和实际发现；origin区分来源，目录存在不表示全部已核。使用属性前展开条件和原证。'};
}
export function resolveObject(query, options = {}) {
  const q = normalize(query).trim(), db = queryStore(options);
  const found = db.records.filter(r => normalize(r.id) === q || normalize(r.name) === q || r.aliases.some(a => normalize(a) === q) || (r.linkedResources||[]).some(resource=>normalize(resource.name)===q||normalize(resource.id)===q));
  return {revision: db.revision, reality:realityStatus(options),resourceFederation:resourceFederationStatus(options), status: found.length === 1 ? 'resolved' : found.length ? 'ambiguous' : 'unknown',
    ...(found.length === 1 ? {id: found[0].id} : {}), candidates: found.map(brief), hint: found.length === 1 ? '按ID读取条件及来源' : found.length ? '先核身份，不自动选同名对象' : '可查目录、类别及关系，或补搜原件；无记录不表示不可用'};
}
export function searchObjects(query = '', options = {}) {
  const q = normalize(query).trim(), terms = q.split(/\s+/).filter(Boolean), db = queryStore(options);
  let scored = db.records.map(r => {
    const identity = normalize([r.id, r.name, ...r.aliases].join(' ')), body = normalize(JSON.stringify(r));
    const hits = terms.filter(t => body.includes(t));
    return {r, score: (identity.includes(q) && q ? 100 : 0) + hits.reduce((n, t) => n + (identity.includes(t) ? 20 : 2), 0), hits};
  }).filter(v => !q || v.hits.length);
  // 中文整句没有空格时按整串匹配会零命中（如“网页正文提取”）；整串无果再按二字片段，至少覆盖一半片段才算。
  if (q && !scored.length && /\p{Script=Han}{3,}/u.test(q)) {
    const grams = [...new Set((q.match(/\p{Script=Han}+/gu) || []).flatMap(run => Array.from({length: Math.max(0, run.length - 1)}, (_, i) => run.slice(i, i + 2))))];
    scored = db.records.map(r => {
      const identity = normalize([r.id, r.name, ...r.aliases].join(' ')), body = normalize(JSON.stringify(r));
      const hits = grams.filter(g => body.includes(g));
      return {r, score: hits.reduce((n, g) => n + (identity.includes(g) ? 10 : 1), 0), hits};
    }).filter(v => v.hits.length * 2 >= grams.length);
  }
  if (options.kind) scored = scored.filter(v => v.r.kind === options.kind);
  if (options.category) scored = scored.filter(v => v.r.categories.includes(options.category));
  scored.sort((a, b) => b.score - a.score || a.r.id.localeCompare(b.r.id));
  const offset = Math.max(0, Number(options.offset) || 0), limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
  return {revision: db.revision, reality:realityStatus(options),resourceFederation:resourceFederationStatus(options), query: q, total: scored.length, offset, items: scored.slice(offset, offset + limit).map(v => ({...brief(v.r), matched: v.hits, score: v.score})),
    selection: 'lexical-score-descending-then-id', scoring: '完整查询命中身份+100；每个空白分词命中身份+20，否则命中记录正文+2；分数不是适用性或事实置信度',
    more: Math.max(0, scored.length - offset - limit), boundary: '词面候选仅供定位；list/resolve/类别/关系也可自由取得，AI决定适用性。'};
}
function sourceState(s) {
  if (!s.path) return {...s, integrity: 'remote-unchecked', warning: '外部来源本次未联网核验，checkedAt仅为作者核查记录'};
  try { const current = sourceFingerprint(s); return {...s, integrity: !s.sha256 ? 'not-baselined' : current === s.sha256 ? 'unchanged' : 'changed', ...(current !== s.sha256 ? {warning: '原证变化或无基线，相关认识需复核'} : {})}; }
  catch (error) { return {...s, integrity: 'unavailable', warning: error.message}; }
}
function applicability(c, options) {
  const mismatches = [], missingContext = [];
  for (const key of ['project', 'branch']) if (c.scope[key]) {
    if (!options[key]) missingContext.push(key);
    else if ((key === 'project' ? normalize(path.resolve(options[key])) : options[key]) !== (key === 'project' ? normalize(path.resolve(c.scope[key])) : c.scope[key])) mismatches.push(key);
  }
  if (c.scope.operations?.length) { if (!options.operation) missingContext.push('operation'); else if (!c.scope.operations.map(normalize).includes(normalize(options.operation))) mismatches.push('operation'); }
  return {status: mismatches.length ? 'out-of-scope' : missingContext.length ? 'context-required' : 'scope-matches', mismatches, missingContext,
    conditions: c.scope.conditions, decision: '文本条件仍须由AI结合任务判断，scope匹配不等于全部条件成立'};
}
function enriched(c, sources, options, conflicts) {
  const at = Date.parse(options.asOf || now()), warnings = [];
  if (c.status !== 'verified') warnings.push(`声明状态：${c.status}`);
  if (c.kind === 'state' && !c.observedAt) warnings.push('动态状态缺观察日期');
  if (c.validFrom && Date.parse(c.validFrom) > at) warnings.push('尚未进入有效期');
  if (c.validUntil && Date.parse(c.validUntil) <= at) warnings.push('已过有效期');
  if (c.reviewAfter && Date.parse(c.reviewAfter) <= at) warnings.push('已到复核日期');
  if (!c.scope.conditions.length) warnings.push('文字适用条件未说明');
  for (const sid of c.sourceIds) { const s = sources.find(v => v.id === sid); if (['changed', 'unavailable', 'not-baselined'].includes(s?.integrity)) warnings.push(`来源${sid}：${s.integrity}`); }
  let identityValidity;
  if(c.identityBinding){const reality=readReality(options),model=reality.models?.find(m=>m.name===c.identityBinding.model);
    identityValidity={status:!model?'not-currently-listed':model.digest===c.identityBinding.digest?'observed-digest-matches':'digest-changed',observedDigest:model?.digest||null,observationStatus:reality.status,decision:'绑定只对应核过的部署版本；最新部署指纹不同或观察过时需重新核权重来源'};
    if(identityValidity.status!=='observed-digest-matches')warnings.push('部署指纹未匹配当前列表，身份关系需复核');
    if(realityStatus(options).stale)warnings.push('现实观察过时或失败，不能把历史身份当当前已核');
  }
  return {...c, ...(identityValidity?{identityValidity}:{}), applicability: applicability(c, options), freshness: {asOf: options.asOf || now(), warnings}, potentialConflicts: conflicts || []};
}
export function readObject(key, options = {}) {
  return objectView(key, options, queryStore(options), readStore(options).records);
}
function objectView(key, options, db, maintainedRecords) {
  const record = db.records.find(r => r.id === key);
  if (!record) fail('对象ID不存在；查list/resolve或补搜', 'NOT_FOUND');
  const sources = record.sources.map(sourceState);
  const claims = record.claims.map(c => {
    const conflicts = record.claims.filter(other => other.id !== c.id && other.status !== 'superseded' && c.status !== 'superseded' && other.kind === c.kind && other.predicate === c.predicate && other.observedAt === c.observedAt && other.validFrom === c.validFrom && other.validUntil === c.validUntil && JSON.stringify(other.scope) === JSON.stringify(c.scope) && JSON.stringify(other.value) !== JSON.stringify(c.value)).map(v => v.id);
    return enriched(c, sources, options, conflicts);
  });
  // Keep the editable record as the formal original. Automatic views must never
  // leak into saveObject(readObject(id).record) maintenance round trips.
  const maintained=maintainedRecords.find(r=>r.id===key);
  return {revision: db.revision, reality:realityStatus(options),resourceFederation:resourceFederationStatus(options), record: clone(maintained||record), claims, relations: record.relations.map(c => enriched(c, sources, options)), sources,
    linkedResources:record.linkedResources||[], origin:record.origin||'maintained-object',
    categories: record.categories.map(key => brief(db.records.find(r => r.id === key))), unknowns: record.unknowns,
    boundary: '资料提供现实判断依据；事实、职责、状态、建议分别理解，来源无变化不表示事实一直有效。'};
}
export function expandObject(key, options = {}) {
  const result = readObject(key, options), db = queryStore(options);
  const depth = Number(options.depth ?? 1);
  if (!Number.isSafeInteger(depth) || depth < 0) fail('depth须为非负整数');
  const byId = new Map(db.records.map(r => [r.id, r]));
  const categoryKeys = new Set();
  const collect = key => { for (const c of byId.get(key).categories) if (!categoryKeys.has(c)) { categoryKeys.add(c); collect(c); } };
  collect(key);
  const categoryKnowledge = [...categoryKeys].map(c => ({...readObject(c, options), use: '理解起点，具体对象证据可补充或修正；不强制继承'}));
  // Walk saved relations from the object AND its categories. Read every sibling
  // at the requested depth; no keyword ranking or model-generated assertions.
  const views = new Map([[key, result], ...categoryKnowledge.map(v => [v.record.id, v])]);
  const queue = [...views.keys()].map(id => ({id, depth: 0}));
  const relatedKnowledge = [], links = [], frontier = [];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index], view = views.get(current.id);
    for (const relation of view.relations) {
      if (relation.status === 'superseded') continue;
      const target = byId.get(relation.targetId);
      const edge = {fromId: current.id, relationId: relation.id, predicate: relation.predicate,
        targetId: relation.targetId, kind: relation.kind, status: relation.status,
        sourceIds: relation.sourceIds, applicability: relation.applicability};
      if (current.depth >= depth) { if (!views.has(target.id)) frontier.push({...edge, target: brief(target)}); continue; }
      links.push(edge);
      if (views.has(target.id)) continue;
      const next = {...readObject(target.id, options), depth: current.depth + 1};
      views.set(target.id, next); relatedKnowledge.push(next); queue.push({id: target.id, depth: next.depth});
      // Related objects can have their own categories. Include those at the
      // same relation distance, so interpreting the object has a knowledge base.
      const addCategories = id => {
        for (const c of byId.get(id).categories) {
          if (views.has(c)) continue;
          const category = {...readObject(c, options), depth: next.depth,
            use: '关联对象的类别认识；不自动继承到起始对象'};
          views.set(c, category); relatedKnowledge.push(category); queue.push({id: c, depth: next.depth}); addCategories(c);
        }
      };
      addCategories(target.id);
    }
  }
  const knowledgeGaps = [];
  for (const view of views.values()) {
    const needs = view.unknowns.map(question => ({kind: 'unknown', question}));
    if (view.record.kind === 'object' && !view.categories.length && !view.record.claims.some(c => c.status === 'verified'))
      needs.push({kind: 'unclassified', question: '这个对象尚无类别及已核属性，哪些类别知识能帮助当前判断？'});
    for (const c of [...view.claims, ...view.relations]) {
      if (c.status === 'superseded') continue;
      if (c.status !== 'verified' || c.freshness.warnings.length || c.potentialConflicts?.length)
        needs.push({kind: 'claim-review', claimId: c.id, predicate: c.predicate, status: c.status,
          warnings: c.freshness.warnings, conflicts: c.potentialConflicts || [], sourceIds: c.sourceIds});
    }
    if (needs.length) knowledgeGaps.push({id: view.record.id, name: view.record.name, origin: view.origin, version: view.record.version, needs});
  }
  return {...result, categoryKnowledge,
    related: result.relations.map(r => ({relationId: r.id, target: brief(byId.get(r.targetId))})),
    relatedKnowledge, knowledgeGaps,
    expansion: {depth, selection: 'all-saved-relations-within-depth', links,
      frontier: frontier.filter(edge => !views.has(edge.targetId)),
      use: 'AI联系当前用途判断要查什么，主动搜索类别与相关知识，核证后原位保存；缺口不是停工条件，读取不证明采用。'}};
}
// Progressive first recognition uses the same store and read view. It returns
// complete node bodies or explicit pointers, never a silently shortened claim.
export function recognizeObject(query = '', options = {}) {
  if (!options.id && !String(query).trim()) fail('首轮认识须提供query或id；已有目录沿list取得');
  const integer = (value, fallback, name, min) => {
    const number = Number(value ?? fallback);
    if (!Number.isSafeInteger(number) || number < min) fail(`${name}须为大于等于${min}的整数`);
    return number;
  };
  const depth = integer(options.depth, 1, 'depth', 0), offset = integer(options.offset, 0, 'offset', 0);
  const limit = integer(options.limit, 12, 'limit', 1), maxChars = integer(options.maxChars, 24000, 'maxChars', 0);
  if (limit > 100) fail('limit须小于等于100');
  const db = queryStore(options), byId = new Map(db.records.map(r => [r.id, r]));
  const snapshot = crypto.createHash('sha256').update(JSON.stringify(db.records)).digest('hex');
  if (options.snapshot && options.snapshot !== snapshot) fail('认识续读期间对象或联合资料已变化；从offset=0重读，保留已采用依据再核影响', 'SNAPSHOT_CHANGED');
  const identity = options.id ? {status: byId.has(options.id) ? 'resolved' : 'unknown',
    ...(byId.has(options.id) ? {id: options.id} : {}), candidates: byId.has(options.id) ? [brief(byId.get(options.id))] : []} : resolveObject(query, options);
  const context = {query: query || null, requestedId: options.id || null, purpose: options.purpose || options.operation || null,
    project: options.project || null, branch: options.branch || null, operation: options.operation || null,
    use: '用途供当前AI联系资料判断；程序不从用途自动推断身份、适用性或搜索问题'};
  const base = {revision: db.revision, reality: realityStatus(options), resourceFederation: resourceFederationStatus(options), context,
    identity, reading: {snapshot, depth, offset, limit, maxChars, budgetUnit: '已返回完整节点正文JSON的UTF-16字符数；指针/元信息另计，不是token预算或整个响应大小上限'}};
  const continuation = extra => ['recognize', ...(options.id ? ['--id', options.id] : ['--query', query]),
    ...['purpose','project','branch','operation'].flatMap(k => options[k] ? [`--${k}`, String(options[k])] : []),
    '--depth', String(depth), '--limit', String(limit), '--max-chars', String(maxChars), '--no-refresh', '--snapshot', snapshot, ...extra];
  if (identity.status !== 'resolved') {
    const categories = db.records.filter(r => r.kind === 'category');
    const candidates = searchObjects(query || options.id || '', {...options, offset, limit});
    return {...base, candidates, categoryNavigation: {total: categories.length, offset,
      items: categories.slice(offset, offset + limit).map(r => ({...brief(r), read: ['read','--id',r.id]})),
      more: Math.max(0, categories.length - offset - limit), selection: 'store-order-unranked'},
      continuation: candidates.more || categories.length > offset + limit ? continuation(['--offset', String(offset + limit)]) : null,
      boundary: '未核身份不创建对象或猜类别；候选是词面线索，类别导航不表示该名称属于这些类别。AI可改写名称、读原件或搜索，确认后用原save/import保存。'};
  }
  const nodes = [], seen = new Map(), queue = [];
  const add = (key, distance, via, eligible = true) => {
    if (seen.has(key)) return;
    const record = byId.get(key);
    if (!record) return;
    const node = {record, distance, via, eligible};
    seen.set(key, node); nodes.push(node);
    if (eligible) queue.push(node);
  };
  const categories = (key, distance) => {
    for (const category of byId.get(key).categories) {
      if (seen.has(category)) continue;
      add(category, distance, {kind: 'category', fromId: key}); categories(category, distance);
    }
  };
  add(identity.id, 0, {kind: 'start'}); categories(identity.id, 0);
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index];
    for (const relation of node.record.relations) {
      if (relation.status === 'superseded') continue;
      const via = {kind: 'relation', fromId: node.record.id, relationId: relation.id,
        predicate: relation.predicate, status: relation.status, assertionKind: relation.kind,
        sourceIds: relation.sourceIds, scope: relation.scope};
      if (node.distance >= depth) { add(relation.targetId, node.distance + 1, via, false); continue; }
      add(relation.targetId, node.distance + 1, via); categories(relation.targetId, node.distance + 1);
    }
  }
  const pointers = [], knowledge = [], knowledgeGaps = []; let usedChars = 0;
  const page = nodes.slice(offset, offset + limit);
  for (const node of page) {
    const key = node.record.id;
    const pointer = {...brief(node.record), distance: node.distance, via: node.via,
      read: ['read','--id',key], expand: ['expand','--id',key,'--depth','0'],
      recognize: ['recognize','--id',key, '--max-chars', String(maxChars)]};
    if (!node.eligible) { pointers.push({...pointer, bodyStatus: 'depth-frontier'}); continue; }
    const view = objectView(key, options, db, db.records);
    const body = {object: brief(view.record), origin: view.origin, claims: view.claims, relations: view.relations,
      sources: view.sources.map(source => ({...source, contentReturned: false,
        readPointer: {kind: source.path ? 'local-file' : source.url ? 'web-page' : 'registry-reference',
          ...(source.path ? {path:source.path} : {}), ...(source.url ? {url:source.url} : {}),
          ...(source.ref ? {ref:source.ref} : {}), ...(source.selector ? {selector:source.selector} : {}),
          use:'此页只返回来源定位/变化检测，未返回原证或领域长文正文；AI需用当前文件或网页工具按位置读取'} })),
      linkedResources: view.linkedResources, categories: view.categories, unknowns: view.unknowns,
      revision: view.revision, boundary: view.boundary};
    const requiredChars = JSON.stringify(body).length;
    if (requiredChars > maxChars - usedChars) {
      pointers.push({...pointer, bodyStatus: 'budget-deferred', requiredChars,
        retry: ['recognize','--id',key,'--depth','0','--max-chars',String(requiredChars)]}); continue;
    }
    usedChars += requiredChars; knowledge.push(body);
    pointers.push({...pointer, bodyStatus: 'included', requiredChars});
    const needs = view.unknowns.map(question => ({kind:'unknown', question}));
    if (view.record.kind === 'object' && !view.categories.length && !view.claims.some(c => c.status === 'verified'))
      needs.push({kind:'unclassified', question:'尚无类别和已核属性；当前用途需要认识什么？'});
    for (const claim of [...view.claims, ...view.relations]) {
      if (claim.status === 'superseded') continue;
      if (claim.status !== 'verified' || claim.freshness.warnings.length || claim.potentialConflicts?.length)
        needs.push({kind:'claim-review', claimId:claim.id, predicate:claim.predicate, status:claim.status,
          warnings:claim.freshness.warnings, conflicts:claim.potentialConflicts || [], sourceIds:claim.sourceIds});
    }
    if (needs.length) knowledgeGaps.push({id:key, version:view.record.version, name:view.record.name, needs});
  }
  const nextOffset = offset + page.length, more = Math.max(0, nodes.length - nextOffset);
  return {...base, start: brief(byId.get(identity.id)), pointers, knowledge, knowledgeGaps,
    reading: {...base.reading, totalPointers: nodes.length, returnedPointers: page.length, usedChars,
      includedBodies: knowledge.length, deferredBodies: pointers.filter(p => p.bodyStatus === 'budget-deferred').length,
      frontierOnPage: pointers.filter(p => p.bodyStatus === 'depth-frontier').length, morePointers: more,
      selection: 'start-then-ancestor-categories-then-saved-relations-in-breadth-first-store-order; no-relevance-ranking',
      next: more ? continuation(['--offset', String(nextOffset)]) : null},
    boundary: '正文逐节点完整返回；预算不足、深度外和下页指针都明确保留。knowledgeGaps只覆盖本页已读正文，不等于完整缺口；未读目标可沿ID续读。类别与关系不自动继承为对象属性。AI从用途主动发现未登记联系、查原证和外部资料、决定采用及继续执行；本入口不自动调用搜索或模型，不把未知清零当计划门槛。'};
}
export function auditObjects(options = {}) {
  const db = readStore(options), items = [];
  for (const r of db.records) {
    const read = readObject(r.id, options), issues = [];
    for (const s of read.sources) if (s.integrity !== 'unchanged') issues.push({sourceId: s.id, issue: s.integrity});
    for (const c of [...read.claims, ...read.relations]) if (c.freshness.warnings.length || c.potentialConflicts.length) issues.push({claimId: c.id, warnings: c.freshness.warnings, conflicts: c.potentialConflicts});
    if (r.unknowns.length) issues.push({unknowns: r.unknowns});
    if (issues.length) items.push({id: r.id, name: r.name, version: r.version, issues});
  }
  return {revision: db.revision, recordCount: db.records.length, count: items.length, items, owner: 'AI工作系统相关任务执行负责人',
    next: '仅对会改变当前方案的缺口查原件/现实，更新时保留旧证及变更理由；审计不是禁令。'};
}
export function objectNavigation(options = {}) {
  const db = readStore(options);
  return {id: 'object-knowledge', title: '对象与类别知识：形成计划前认识具体东西、职责、状态和条件', file: options.file || DEFAULT_FILE,
    command: `node "${path.join(CENTER, 'objects.mjs')}"`, revision: db.revision, counts: {objects: db.records.filter(r => r.kind === 'object').length, categories: db.records.filter(r => r.kind === 'category').length},
    actions: ['recognize --query 名称 --purpose 当前用途 [--max-chars N] [--offset N]', 'list', 'resolve --query 名称', 'read --id ID', 'expand --id ID [--depth N]', 'search --query 用途', 'audit'], boundary: '首轮取得身份、共性和具体资料；未读正文与来源指针明确保留。AI决定搜索、采用与继续，通用认识存类别，差异存对象，缺口不等于禁令。'};
}
export function objectHistory(options = {}) { const db = readStore(options); return {revision: db.revision, items: options.id ? db.history.filter(h => h.changes.some(c => c.id === options.id)) : db.history}; }
export function restoreObjects(from, options = {}) {
  const file = options.file || DEFAULT_FILE, restored = readStore({file: from});
  if (!fs.existsSync(from)) fail('恢复原件不存在');
  restored.records.forEach(validateRecord); checkGraph(restored.records);
  return withLock(file, () => {
    const current = readStore({file});
    if (options.expectedRevision !== current.revision) fail('恢复前须核当前revision', 'VERSION_CONFLICT');
    const restoredById = new Map(restored.records.map(r => [r.id, r]));
    // Restore content while retaining objects created since the backup and monotonic versions.
    const records = current.records.map(r => restoredById.has(r.id) ? {...restoredById.get(r.id), version: r.version + 1, updatedAt: now()} : r);
    for (const r of restored.records) if (!records.some(v => v.id === r.id)) records.push({...r, version: r.version + 1, updatedAt: now()});
    checkGraph(records); const db = {...current, records, revision: current.revision + 1, updatedAt: now()};
    db.history.push({revision: db.revision, at: db.updatedAt, reason: text(options.reason, '恢复理由', true), changes: records.filter(r => restoredById.has(r.id)).map(r => ({id: r.id, toVersion: r.version})), restoredFrom: path.resolve(from)});
    return {revision: db.revision, backup: commit(file, db)};
  });
}
export const HELP = 'navigation | recognize --query TEXT 或 --id ID [--purpose TEXT] [--depth N] [--max-chars N] [--offset N] [--limit N] [--snapshot HASH] | list [--kind object|category] [--category ID] | search --query TEXT [--limit N] [--offset N] | resolve --query TEXT | read|expand --id ID [--project PATH] [--branch ID] [--operation TEXT] [--depth N] | sync [--force] [--timeout-ms 1200] | reality-status | audit | history [--id ID] | save --input JSON --expected-version N --reason TEXT | import --input BUNDLE_JSON | restore --from BACKUP --expected-revision N --reason TEXT；recognize默认depth1/limit12/maxChars24000，正文完整返回或明确延后，预算不含指针、不等于token；来源正文未自动读取；expand默认展开1层关联及全部祖先类别，depth=0只保留类别正文/关系短介绍；查询前自动有界刷新，--no-refresh仅读上次观察，--no-federation仅正式对象；所有命令可--file隔离库；project/branch/operation/as-of可供读取核条件';
export function runCLI(args = process.argv.slice(2)) {
  const [cmd = 'navigation', ...rest] = args, options = {};
  for (let i = 0; i < rest.length; i++) { if (!rest[i].startsWith('--')) fail('参数须以--开头'); const key = rest[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase()); options[key] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; }
  if (options.expectedVersion !== undefined) options.expectedVersion = Number(options.expectedVersion);
  if (options.expectedRevision !== undefined) options.expectedRevision = Number(options.expectedRevision);
  if (options.noFederation) options.federation=false;
  if (cmd === 'help' || cmd === '--help') return HELP;
  if (cmd === 'reality-status') return realityStatus(options);
  if (cmd === 'navigation') return objectNavigation(options);
  if (cmd === 'list') return listObjects(options);
  if (cmd === 'search' || cmd === 'query') return searchObjects(options.query || '', options);
  if (cmd === 'resolve') return resolveObject(options.query || '', options);
  if (cmd === 'recognize') return recognizeObject(options.query || '', options);
  if (cmd === 'read') return readObject(options.id, options);
  if (cmd === 'expand') return expandObject(options.id, options);
  if (cmd === 'audit') return auditObjects(options);
  if (cmd === 'history') return objectHistory(options);
  if (cmd === 'save') return saveObject(loadJSON(options.input), options);
  if (cmd === 'import') return importBundle(loadJSON(options.input), options);
  if (cmd === 'restore') return restoreObjects(options.from, options);
  fail('未知命令');
}
export async function runCLIAsync(args=process.argv.slice(2)) {
  const cmd=args[0]||'navigation',options={};
  for(let i=1;i<args.length;i++)if(args[i].startsWith('--')){const key=args[i].slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());options[key]=args[i+1]&&!args[i+1].startsWith('--')?args[++i]:true;}
  if(cmd==='sync')return refreshReality(options);
  let refresh=null;
  if(['list','search','query','resolve','recognize','read','expand'].includes(cmd)&&!options.noRefresh&&!options.noFederation&&(!options.file||options.realityFile)) {
    try{refresh=await refreshReality(options);}catch(error){refresh={...realityStatus(options),trigger:'refresh-unavailable',error:error.message,hint:'刷新失败，继续读取本地知识和上次观察；未删除资产'};}
  }
  const result=runCLI(args);return result&&typeof result==='object'&&refresh?{...result,refresh}:result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runCLIAsync(), null, 2)); } catch (error) { console.error(JSON.stringify({error: error.message, code: error.code || 'ERROR'})); process.exitCode = 1; }
}

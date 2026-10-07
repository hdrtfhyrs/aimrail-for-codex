import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const { listKnowledge } = await import(_publicURL("$codex/context/knowledge.mjs"));

const DEFAULT_DIRECTORIES = {
  experience: _publicPath("$user/.pi/agent/knowledge/experiences"),
  error: _publicPath("$user/.pi/agent/knowledge/errors"),
};
const DEFAULT_BACKUPS = _publicPath("$system/资料中心/backups/knowledge");
const slash = value => value.replaceAll('\\', '/');
const clean = value => String(value ?? '').replace(/[*`]/g, '').replace(/^-\s*/, '').trim();
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const RECORD_KEYS = ['type', 'verification', 'title', 'symptom', 'conditions', 'action', 'evidence', 'result', 'boundary'];
// Only exact declared values are reusable. Semantic merging remains the caller's responsibility.
const sameFields = (a, b) => a && b && RECORD_KEYS.every(key => a[key] === b[key]);

function metadataValue(metadata, key) {
  const row = metadata.split('\n').find(line => line.startsWith(key + ':'));
  if (!row) return undefined;
  const value = row.slice(key.length + 1).trim();
  try { return JSON.parse(value); } catch { return value; }
}

function statusOf(item) {
  const declared = metadataValue(item.metadata, 'verification');
  if (['已验证', '待验证'].includes(declared)) return declared;
  if (metadataValue(item.metadata, 'status') === 'pending' || /(?:状态[：:]\s*待验证|\*\*状态[：:]\*\*\s*待验证)/.test(item.body)) return '待验证';
  return '历史记录，按原证核边界';
}

function fieldsOf(item) {
  const stored = metadataValue(item.metadata, 'record_fields');
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) return stored;
  const rows = item.body.split('\n').map(clean);
  const value = labels => {
    const row = rows.find(line => labels.some(label => line.startsWith(label + '：') || line.startsWith(label + ':')));
    return row ? row.replace(/^[^：:]+[：:]\s*/, '') : '';
  };
  return { type: item.type, title: item.title, symptom: value(['遇到', '症状', '触发']),
    conditions: value(['条件', '适用条件', '当时条件']), action: value(['解决', '下次', '做法', '动作']),
    evidence: value(['原证', '证据']), result: value(['结果', '已证范围', '结果/边界']),
    boundary: value(['边界']), verification: statusOf(item) === '待验证' ? '待验证' : '',
    legacyCombinedResult: rows.some(row => row.startsWith('结果/边界：')) };
}

function splitOriginal(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0] !== '---') return { metadata: '', lines };
  const end = lines.indexOf('---', 1);
  return { metadata: end >= 0 ? lines.slice(1, end).join('\n') : '', lines };
}

function oneLine(payload, key, max = 3000) {
  const value = key === 'evidence' && Array.isArray(payload[key]) ? payload[key].join('；') : payload[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`请填写${key}，未知或未完成请明确写出。`);
  if (value.length > max || /[\r\n\u0000]/.test(value)) throw new Error(`${key}须为一行，最多${max}字。`);
  return value.trim();
}

function declaredRecord(payload) {
  if (!['experience', 'error'].includes(payload.type)) throw new Error('只允许登记经验或错误；知识说明只读。');
  if (!['已验证', '待验证'].includes(payload.verification)) throw new Error('验证状态必须明确为已验证或待验证。');
  const fields = { type: payload.type, verification: payload.verification };
  fields.title = oneLine(payload, 'title', 180);
  for (const key of ['symptom', 'conditions', 'action', 'evidence', 'result', 'boundary']) fields[key] = oneLine(payload, key);
  const metadata = [`managed_by: "ai-work-knowledge-service-v1"`, `recorded_at: ${JSON.stringify(new Date().toISOString())}`, `verification: ${JSON.stringify(fields.verification)}`,
    `record_fields: ${JSON.stringify(fields)}`, `tags: ${JSON.stringify([fields.type, fields.verification])}`].join('\n');
  const body = [`# ${fields.title}`, '', `- **遇到：**${fields.symptom}`, `- **条件：**${fields.conditions}`,
    `- **动作：**${fields.action}`, `- **原证：**${fields.evidence}`, `- **结果：**${fields.result}`,
    `- **边界：**${fields.boundary}`, `- **状态：**${fields.verification}`, ''].join('\n');
  return { fields, metadata, body };
}

export function createKnowledgeService(options = {}) {
  const directories = { ...DEFAULT_DIRECTORIES, ...options.directories };
  const backups = options.backupDir || DEFAULT_BACKUPS;
  const indexOptions = options.knowledgeOptions || {};
  const fullList = () => {
    // Enumerate every page, retaining source and retirement rules from the index.
    const scope = { ...indexOptions, query: '', type: 'all', includeRetired: false };
    const items = [];
    let offset = 0, page, revision;
    do {
      page = listKnowledge({ ...scope, offset, limit: 1000 });
      if (revision !== undefined && revision !== page.revision) throw new Error('知识来源版本冲突，请刷新后重试。');
      revision = page.revision;
      items.push(...page.items);
      offset = page.nextOffset;
    } while (page.hasMore);
    return { ...page, items };
  };
  const isEditable = (item, all) => {
    if (!['experience', 'error'].includes(item.type) || !directories[item.type] || all.filter(other => same(other.source, item.source)).length !== 1) return false;
    // Keep aggregate documents and out-of-root/symlink destinations read-only.
    try {
      if (!same(path.dirname(fs.realpathSync(item.source)), fs.realpathSync(directories[item.type]))) return false;
      const { lines } = splitOriginal(fs.readFileSync(item.source, 'utf8'));
      const metadataEnd = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
      return lines.every((line, i) => i <= metadataEnd || (i >= item.startLine - 1 && i < item.endLine) || !line.trim());
    }
    catch { return false; }
  };
  function listCards({ query = '', type = 'all', limit = 250 } = {}) {
    if (!['all', 'error', 'experience', 'knowledge'].includes(type)) throw new Error('未知知识类型。');
    const data = listKnowledge({ ...indexOptions, query, type, limit });
    return { ...data, items: data.items.map(({ body, metadata, ...item }) => ({ ...item, status: statusOf({ body, metadata }) })) };
  }
  function readCard(ref) {
    const data = fullList();
    const item = data.items.find(item => item.ref === ref);
    if (!item) throw new Error('引用已过期或不存在，请刷新列表后重读。');
    const editable = isEditable(item, data.items);
    const { summary, metadata, ...record } = item;
    return { ...record, status: statusOf(item), editable, fields: fieldsOf(item),
      editMode: editable ? (metadataValue(metadata, 'managed_by') ? 'fields' : 'fields-or-body') : 'read-only',
      readOnlyReason: editable ? '' : item.type === 'knowledge' ? '知识说明保留原件，只读。' : '同一原件含多个卡段，暂只读以保留相邻内容。',
      verificationNote: '状态是记录中声明的验证层级；保存与文件存在不替代原证核查或真实再遇验证。' };
  }
  function saveCard(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('需要完整的卡片声明。');
    let current, file, original = '', serialized, record, creationHandle, creationLock;
    const rawMode = typeof payload.body === 'string';
    if (payload.ref) {
      current = readCard(payload.ref);
      if (!current.editable) throw new Error(current.readOnlyReason);
      if (!payload.version || payload.version !== current.version) throw new Error('原件版本冲突，请重读后再保存。');
      if (payload.type && payload.type !== current.type) throw new Error('编辑不能更改原件类型；请另登记。');
      file = current.source;
      original = fs.readFileSync(file, 'utf8');
    } else if (rawMode) throw new Error('新卡必须填写具体条件、动作、原证、结果与边界。');
    try {
      if (rawMode) {
        const body = payload.body.trim();
        if (!body || body.length > 20000 || /\u0000/.test(body)) throw new Error('原文需为非空文本，最多20000字。');
        if (body.split('\n').filter(line => /^#{1,6}\s/.test(line)).length > 1) throw new Error('独立卡片不能拆成多个标题段。');
        const rows = body.split('\n').map(clean).join('\n');
        if (!/(?:遇到|症状|触发)[：:]/.test(rows) || !/(?:解决|下次|做法|动作)[：:]/.test(rows)
          || !/(?:原证|证据)[：:]/.test(rows) || !/(?:结果|已证范围)[：:]/.test(rows) || !/边界/.test(rows)) {
          throw new Error('原文必须保留触发、动作、原证、结果和边界。');
        }
        // A raw edit clears managed structured fields so an old form cannot overwrite it.
        const metadata = splitOriginal(original).metadata.split('\n').filter(row => !/^(?:managed_by|record_fields):/.test(row)).join('\n');
        serialized = (metadata ? `---\n${metadata}\n---\n\n` : '') + body + '\n';
      } else {
        record = declaredRecord({ ...payload, type: current?.type || payload.type });
        if (!file) {
          fs.mkdirSync(directories[record.fields.type], { recursive: true });
          // The shared directory lock covers lookup plus creation across processes.
          // Synchronous callers receive an explicit retry instead of waiting indefinitely.
          creationLock = path.join(directories[record.fields.type], '.knowledge-create.lock');
          try { creationHandle = fs.openSync(creationLock, 'wx'); }
          catch (error) { if (error.code === 'EEXIST') throw new Error('同类知识正在登记，请稍后重试；中断遗留锁请核其登记进程后处理。'); throw error; }
          fs.writeSync(creationHandle, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
          const all = fullList();
          const existing = all.items.find(item => {
            const stored = metadataValue(item.metadata, 'record_fields');
            return metadataValue(item.metadata, 'managed_by') === 'ai-work-knowledge-service-v1'
              && stored && Object.keys(stored).length === RECORD_KEYS.length
              && sameFields(stored, record.fields) && item.body === record.body.trim()
              && isEditable(item, all.items);
          });
          if (existing) {
            // A real update may be happening concurrently; reuse only after the same
            // file lock and optimistic checks used by explicit edits.
            const reuseLock = existing.source + '.edit.lock';
            let reuseHandle;
            try { reuseHandle = fs.openSync(reuseLock, 'wx'); }
            catch (error) { if (error.code === 'EEXIST') throw new Error('原件正在保存，请稍后重读再试。'); throw error; }
            try {
              const latest = readCard(existing.ref);
              if (!latest.editable || latest.version !== existing.version
                || !sameFields(latest.fields, record.fields)) throw new Error('原件版本冲突，请重读后再保存。');
              return { ...latest, backup: null, disposition: 'reused', saveScope: '完全相同的现用托管卡复用原件；语义融合仍由调用者判断。' };
            } finally { fs.closeSync(reuseHandle); fs.unlinkSync(reuseLock); }
          }
          file = path.join(directories[record.fields.type], `${record.fields.type}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 12)}.md`);
        }
        // Retain historical case IDs/tags/source pointers when updating a short card.
        const historical = original ? splitOriginal(original).metadata.split('\n').filter(row => !/^(?:managed_by|recorded_at|verification|record_fields):/.test(row)).join('\n') : '';
        const recordMetadata = historical.split('\n').some(row => row.startsWith('tags:'))
          ? record.metadata.split('\n').filter(row => !row.startsWith('tags:')).join('\n') : record.metadata;
        serialized = `---\n${historical ? historical + '\n' : ''}${recordMetadata}\n---\n\n${record.body}`;
      }
      const lock = file + '.edit.lock';
      let handle;
      try { handle = fs.openSync(lock, 'wx'); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('原件正在保存，请稍后重读再试。'); throw error; }
      let backup = null, temporary;
      try {
        // Recheck after exclusive lock. Any concurrent source edit invalidates this save.
        if (current) {
          const latest = readCard(payload.ref);
          if (latest.version !== payload.version || fs.readFileSync(file, 'utf8') !== original) throw new Error('原件版本冲突，请重读后再保存。');
          if (rawMode ? payload.body === latest.body || serialized === original : sameFields(latest.fields, record.fields)) {
            return { ...latest, backup: null, disposition: 'unchanged', saveScope: '版本已核对，声明内容完全相同；原件与恢复备份均未写入。' };
          }
          fs.mkdirSync(backups, { recursive: true });
          backup = path.join(backups, `${path.basename(file, '.md')}-${Date.now()}-${randomUUID().slice(0, 8)}.md`);
          fs.writeFileSync(backup, original, { flag: 'wx' });
        } else if (fs.existsSync(file)) throw new Error('新卡文件已存在，请重新登记。');
        temporary = file + '.' + process.pid + '.' + randomUUID().slice(0, 8) + '.tmp';
        fs.writeFileSync(temporary, serialized, { flag: 'wx' });
        fs.renameSync(temporary, file);
      } finally {
        if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
        fs.closeSync(handle);
        fs.unlinkSync(lock);
      }
      const saved = fullList().items.find(item => same(item.source, file));
      if (!saved) throw new Error('原件已保存，但尚未被现用检索源收录，请检查sources配置。');
      return { ...readCard(saved.ref), backup: backup ? slash(backup) : null, disposition: current ? 'updated' : 'created',
        saveScope: '保存与现用索引重读；不证明自动采用、智能体改进或未来少重犯。' };
      } finally {
      if (creationHandle !== undefined) { fs.closeSync(creationHandle); fs.unlinkSync(creationLock); }
    }
  }
  return { listCards, readCard, saveCard };
}

const service = createKnowledgeService();
export const listCards = service.listCards;
export const readCard = service.readCard;
export const saveCard = service.saveCard;

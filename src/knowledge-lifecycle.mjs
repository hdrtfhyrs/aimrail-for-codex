// Confirmed invalid knowledge leaves active recall by stable section reference.
// Originals are never changed; frozen history and reversible status are explicit.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 20);
const slash = value => value.replaceAll('\\', '/');
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
export function readRetirements(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch (error) { if (error.code === 'ENOENT') return {file, raw: '', entries: []}; throw error; }
  const data = JSON.parse(raw);
  if (data.schema !== 1 || !Array.isArray(data.entries)) throw new Error('Invalid knowledge retirement registry');
  const seen = new Set();
  for (const entry of data.entries) {
    if (!/^m-[a-f0-9]{20}$/.test(entry.memoryKey || '') || seen.has(entry.memoryKey)
      || !['retired', 'restored'].includes(entry.status) || !entry.reason || !entry.replacement)
      throw new Error('Invalid or duplicate knowledge retirement entry');
    seen.add(entry.memoryKey);
  }
  return {file, raw, entries: data.entries};
}
export function retirementFor(doc, registry) {
  return registry.entries.find(entry => entry.status === 'retired'
    && (entry.memoryKey === doc.memoryKey || entry.aliases?.includes(doc.id))) || null;
}
export function findRetirement(ref, registry) {
  return registry.entries.find(entry => entry.status === 'retired'
    && (entry.memoryKey === ref || entry.aliases?.includes(ref))) || null;
}
export function retirementNotice(entry) {
  return {status: 'retired', memoryKey: entry.memoryKey, reason: entry.reason,
    replacement: entry.replacement, retiredAt: entry.retiredAt, archiveFile: entry.archiveFile};
}
export function readRetiredSnapshot(entry, registry) {
  const folder = path.resolve(path.dirname(registry.file), 'knowledge-retirement-history');
  const file = path.resolve(path.dirname(registry.file), entry.archiveFile);
  if (path.dirname(file) !== folder) throw new Error('Retired snapshot is outside the history directory');
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (snapshot.memoryKey !== entry.memoryKey || snapshot.contentVersion !== entry.contentVersion)
    throw new Error('Retired snapshot reference/version mismatch');
  return snapshot;
}
export function updateRetirement(command, refs, docs, registry, options = {}) {
  fs.mkdirSync(path.dirname(registry.file), {recursive: true});
  const lock = registry.file + '.lock';
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Knowledge retirement registry is being maintained; retry after the owner finishes. Inspect the exact .lock file if an interrupted process left it behind.');
    throw error;
  }
  try {
    fs.writeSync(fd, JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()}));
    return updateLocked(command, refs, docs, readRetirements(registry.file), options);
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function updateLocked(command, refs, docs, registry, options) {
  const values = [...new Set(String(refs || '').split(',').map(value => value.trim()).filter(Boolean))];
  if (!values.length) throw new Error('Provide --refs with a stable memory key or current card ID');
  if (command === 'retire' && (!String(options.reason || '').trim() || !String(options.replacement || '').trim()))
    throw new Error('Retirement requires --reason and --replacement evidence/source');
  const entries = registry.entries.map(entry => ({...entry, aliases: [...(entry.aliases || [])]}));
  const changed = [];
  for (const ref of values) {
    let entry = entries.find(item => item.memoryKey === ref || item.aliases.includes(ref));
    if (command === 'restore') {
      if (!entry) throw new Error('Unknown retirement reference: ' + ref);
      if (entry.status === 'restored') continue;
      entry.status = 'restored'; entry.restoredAt = new Date().toISOString();
      entry.restoreReason = String(options.reason || 'Explicit restoration').trim();
      changed.push(entry.memoryKey); continue;
    }
    if (entry?.status === 'retired') {
      const reason = String(options.reason).trim(), replacement = String(options.replacement).trim();
      if (entry.reason !== reason || entry.replacement !== replacement) {
        entry.reason = reason; entry.replacement = replacement;
        entry.metadataUpdatedAt = new Date().toISOString(); changed.push(entry.memoryKey);
      }
      continue;
    }
    const matches = docs.filter(doc => doc.id === ref || doc.memoryKey === ref);
    if (!matches.length) throw new Error('Unknown current knowledge reference: ' + ref);
    if (new Set(matches.map(doc => JSON.stringify([doc.source, doc.contentVersion, doc.cardStartLine, doc.cardEndLine]))).size > 1)
      throw new Error('Ambiguous section reference: ' + ref);
    const doc = matches[0];
    const snapshot = {id: doc.id, memoryKey: doc.memoryKey, contentVersion: doc.contentVersion,
      title: doc.title, text: doc.cardBody, metadata: doc.metadata, source: doc.source,
      startLine: doc.cardStartLine, endLine: doc.cardEndLine, type: doc.type};
    const archiveFile = `knowledge-retirement-history/${doc.memoryKey}-${doc.contentVersion}.json`;
    atomicJson(path.resolve(path.dirname(registry.file), archiveFile), snapshot);
    const aliases = docs.filter(item => item.memoryKey === doc.memoryKey).map(item => item.id);
    const next = {memoryKey: doc.memoryKey, aliases: [...new Set([...(entry?.aliases || []), ...aliases])],
      source: doc.source, title: doc.title, contentVersion: doc.contentVersion, archiveFile: slash(archiveFile),
      status: 'retired', reason: String(options.reason).trim(), replacement: String(options.replacement).trim(),
      retiredAt: new Date().toISOString()};
    if (entry) Object.assign(entry, next); else entries.push(next);
    changed.push(doc.memoryKey);
  }
  if (changed.length) {
    // Exact old registry is kept cold before every status mutation.
    if (registry.raw) {
      const backup = path.resolve(path.dirname(registry.file), 'knowledge-retirement-history', `registry-${digest(registry.raw)}.json`);
      fs.mkdirSync(path.dirname(backup), {recursive: true});
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, registry.raw);
    }
    atomicJson(registry.file, {schema: 1, entries});
  }
  return {changed, file: slash(registry.file), entries: entries.map(entry => ({...retirementNotice(entry), status: entry.status}))};
}

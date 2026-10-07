/** Local, synchronous, bounded Markdown retrieval. Source files remain authoritative.
 * No model/service/network dependency. Cache is rebuilt when registered sources change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {readRetirements, retirementFor, findRetirement, retirementNotice, readRetiredSnapshot, updateRetirement} from './knowledge-lifecycle.mjs';
import {objectNavigation,objectCli} from './object-access.mjs';
import {SOURCES_FILE,CACHE_ROOT} from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = 19;
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const STOP = new Set(('我 你 他 她 它 我们 你们 他们 这个 那个 这些 那些 一个 一些 什么 怎样 怎么 为什么 是否 可以 不能 需要 要求 帮忙 帮我 请 现在 当前 继续 然后 还有 已经 实际 直接 使用 工作 任务 问题 东西 相关 进行 通过 时候 结果 说明 这样 那样 如何 做好 完成 执行 处理 the a an and or to of in on for is are be with this that it please can how what').split(' '));
for (const term of '一份 一段 一张 一次 本次 本轮 当时 下次 先 再 做 给 用 想 想做 我想 我要 我让 我说 我的 你的 他的 你说 你让 不要 没有 不是 还是 只是 但是 而且 所有 觉得 明白 理解一下 看看 看一下 对于 目前 今天 明天 昨天 电脑 重要 普遍 关键 当主 把 举 的 当 主 后 并 不 已 在 为 对 将 个 是 了 到 得 也 等 和 与 从 只 说 有 要 能 会 此 都 作 被 让 应 及'.split(' ')) STOP.add(term);
const DIGEST = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
// These useful domain words still rank a qualified card. They cannot by
// themselves establish its relevance: a product name or "模型/选择" overlap
// says little about the concrete symptom. Exact titles remain addressable.
const WEAK_RELEVANCE = new Set('codex claude gemini 模型 代理 系统 选择 做成 优化 一下'.split(' '));
// Discovery must match a symptom/subject, not vocabulary from an old action or
// evidence filename. These words still contribute to ranking, never qualify alone.
const DISCOVERY_GENERIC = new Set([...WEAK_RELEVANCE, ...'ai 工具 入口 查询 完整 知识 经验 原件 原证 读取 命中 候选 成功 条件 边界'.split(' ')]);
const slash = value => value.replaceAll('\\', '/');
const cap = (text, n) => n <= 0 ? '' : text.length <= n ? text : n === 1 ? '…' : text.slice(0, n - 1) + '…';
const budget = (value, fallback, max = 20000) => Math.min(max, Math.max(0, Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback));
const clean = text => text.replace(/\[([^\]]+)\]\([^\n)]+\)/g, '$1').replace(/[*`#]/g, '').trim();

// A command's directory/filename is an address, not a task or diagnostic.
// Apply only to retrieval input; authoritative source text and read refs are untouched.
function retrievalQuery(value) {
  const raw = String(value || '').slice(0, 4000);
  let text = raw
    .replace(/(["'`])(?:[a-z]:[\\/]|\\\\|\/)[^"'`\r\n]*\1/gi, ' __LOCAL_PATH__ ')
    .replace(/\b[a-z]:[\\/][^\s。；，、！？"'`]+/gi, ' __LOCAL_PATH__ ')
    .replace(/\\\\[^\s。；，、！？"'`]+/g, ' __LOCAL_PATH__ ')
    .replace(/(?<![\w.:/])\/(?!\/)[^\s。；，、！？"'`]+/g, ' __LOCAL_PATH__ ');
  const runtime = '(?:node(?:\\.exe)?|python(?:\\d(?:\\.\\d+)?)?(?:\\.exe)?|py|pwsh|powershell|bash|sh|cmd)';
  const command = new RegExp('\\b' + runtime + '\\s+(?:(?:-[\\w-]+|utf8)\\s+)*__LOCAL_PATH__', 'gi');
  const hasCommand = command.test(text);
  command.lastIndex = 0;
  // A bounded run-and-report instruction has no request to recall troubleshooting cards.
  if (hasCommand && /(?:只|仅)(?:报告|返回|输出|告诉)[^。！？\n]{0,30}(?:退出码|exit\s*code)/i.test(raw)) return '';
  text = text.replace(command, ' ').replaceAll('__LOCAL_PATH__', ' ');
  // Pure invocations (including relative scripts and -m) carry no knowledge objective.
  if (new RegExp('^\\s*(?:&\\s*)?' + runtime + '\\s+(?:-[\\w-]+|[\\w./\\\\-]+\\.(?:mjs|cjs|js|py|ps1|sh))\\b', 'i').test(text)
      && !/(?:missing|error|failed|failure|exception|incompatible|报错|失败|错误|异常|不兼容)/i.test(text)) return '';
  if (hasCommand) text = text.replace(/\b(?:powershell|pwsh|runtime|exec_command|command|shell)\b/gi, ' ');
  return text.trim();
}

function setup(options = {}) {
  const sourcesFile = path.resolve(options.sourcesFile || SOURCES_FILE);
  const raw = fs.readFileSync(sourcesFile, 'utf8').replace(/^\uFEFF/, '');
  const config = JSON.parse(raw);
  if (!Array.isArray(config.sources)) throw new Error('knowledge sources must contain a sources array');
  // Isolated/custom sources get an isolated registry unless explicitly supplied.
  const retirementsFile = path.resolve(options.retirementsFile || config.retirementsFile || path.join(path.dirname(sourcesFile), 'knowledge-retirements.json'));
  return { sourcesFile, raw, config, retirements: readRetirements(retirementsFile), cacheDir: path.resolve(options.cacheDir || path.join(CACHE_ROOT,'knowledge')) };
}

function sourceFiles(env) {
  // These user-level roots are shared across projects and agents. Source paths
  // record provenance/evidence; they are never a project visibility boundary.
  const files = new Map();
  for (const spec of env.config.sources) {
    const exclude = new Set((spec.exclude || []).map(v => v.toLowerCase()));
    function add(candidate) {
      if (!/\.md$/i.test(candidate) || exclude.has(path.basename(candidate).toLowerCase())) return;
      try {
        const actual = fs.realpathSync(candidate);
        const stat = fs.statSync(actual);
        if (stat.isFile()) files.set(actual, { source: slash(actual), type: spec.type || 'knowledge', topics: (env.config.topicRules || []).filter(rule => rule.files?.includes(path.basename(actual))).map(rule => rule.id), size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs });
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    function walk(directory) {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || entry.name === '_archive' || exclude.has(entry.name.toLowerCase())) continue;
        const candidate = path.join(directory, entry.name);
        if (entry.isFile()) add(candidate);
        else if (entry.isDirectory() && spec.recursive === true) walk(candidate);
      }
    }
    if (spec.file) add(path.resolve(path.dirname(env.sourcesFile), spec.file));
    if (spec.directory) walk(path.resolve(path.dirname(env.sourcesFile), spec.directory));
  }
  return [...files.values()].sort((a, b) => a.source.localeCompare(b.source));
}

function sourceNavigation(env) {
  const rows = [];
  for (const spec of env.config.sources) {
    if (!spec.directory) continue;
    const directory = path.resolve(path.dirname(env.sourcesFile), spec.directory);
    let index = null;
    try { const file = fs.realpathSync(path.join(directory, 'INDEX.md')); if (fs.statSync(file).isFile()) index = slash(file); } catch {}
    rows.push({type: spec.type || 'knowledge', directory: slash(directory), index});
  }
  return rows;
}

// Chinese word tokens provide precision; two-character tokens supply recall for new terms.
// Single Han characters and generic task words cannot trigger a knowledge dump.
function tokens(text) {
  const result = new Map();
  const add = (term, weight) => { if (!STOP.has(term) && term.length > 1) result.set(term, Math.max(weight, result.get(term) || 0)); };
  // Lexical equivalents only: blinking is deliberately NOT equated with reload.
  const normalized = text.normalize('NFKC').toLowerCase()
    .replace(/\b(?:zhipin|boss直聘)\b|boss\s*直聘|直聘/g, 'boss')
    .replace(/重新加载|重载|\breload(?:ing)?\b/g, '刷新');
  for (const term of normalized.match(/[a-z][a-z0-9_+.:-]*|\d+(?:\.\d+)+/g) || []) add(term, 1);
  for (const { segment, isWordLike } of segmenter.segment(normalized)) {
    if (!isWordLike || !/[\p{Script=Han}]/u.test(segment) || STOP.has(segment)) continue;
    add(segment, 1);
    for (let i = 0; i < segment.length - 1; i++) add(segment.slice(i, i + 2), 0.45);
  }
  // Cross-word Han bigrams, excluding grams touching stopword segments.
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) || []) {
    const parts = [...segmenter.segment(run)];
    for (let i = 0; i < parts.length - 1; i++) {
      if (!STOP.has(parts[i].segment) && !STOP.has(parts[i + 1].segment)) add(parts[i].segment.slice(-1) + parts[i + 1].segment[0], 0.3);
    }
  }
  return result;
}

function applicabilityRows(text) {
  return text.split('\n').map(line => clean(line).replace(/^-\s+/, ''))
    .filter(line => /^(?:触发(?:条件)?|遇到|当时(?:条件)?|补充|同类|适用(?:条件|范围)?|条件|症状|场景)[：:]/.test(line));
}

function markdownSections(lines) {
  const sections = [];
  let ancestors = [], start = 0, title = '';
  let fence = false;
  function emit(end) { if (end > start && lines.slice(start, end).some(v => v.trim() && !/^#{1,6} /.test(v))) sections.push({ title, start, end }); }
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { fence = !fence; continue; }
    const match = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (!match) continue;
    emit(i);
    const level = match[1].length;
    ancestors = ancestors.filter(v => v.level < level);
    ancestors.push({ level, title: clean(match[2]) });
    title = ancestors.map(v => v.title).join(' / ');
    start = i;
  }
  emit(lines.length);
  return sections;
}

function splitSection(lines, section) {
  const chunks = [];
  let start = section.start, count = 0;
  for (let i = start; i < section.end; i++) {
    const line = lines[i];
    // Long error sections often consist of independent historical bullets.
    if (i > start && count > 350 && (count + line.length > 1200 || /^- \*\*(?:当时|补充|同类|下次|原证)/.test(line))) {
      chunks.push({ start, end: i }); start = i; count = 0;
    }
    count += line.length + 1;
    if (count >= 1200 && i + 1 < section.end) { chunks.push({ start, end: i + 1 }); start = i + 1; count = 0; }
  }
  if (start < section.end) chunks.push({ start, end: section.end });
  return chunks;
}

function evidencePaths(text, source) {
  const found = new Set();
  const candidates = [...text.matchAll(/\[[^\]]*\]\(([^\n)]+)\)/g)].map(m => m[1]);
  for (const match of text.matchAll(/`([^`\n]+)`/g)) if (/^(?:[a-z]:[\\/]|\/)/i.test(match[1])) candidates.push(match[1]);
  for (const line of text.split(/\r?\n/)) {
    if (!/^(?:source\s*:|.*(?:\*\*原证|\*\*证据|^原证[：:]))/.test(line)) continue;
    for (const match of line.matchAll(/[a-z]:[\\/][^；;、，\n`]+/gi)) candidates.push(match[0].replace(/[。\s]+$/, ''));
  }
  for (let value of candidates) {
    value = value.trim().replace(/^<|>$/g, '').replace(/^["']|["']$/g, '').replace(/#.*$/, '').replace(/:\d+(?:-\d+)?$/, '');
    if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) continue;
    if (!value || /[<>\r\n]/.test(value)) continue;
    try {
      const actual = fs.realpathSync(path.resolve(path.dirname(source), value));
      if (fs.statSync(actual).isFile()) found.add(slash(actual));
    } catch { /* Unavailable pointers are not grants to arbitrary paths. */ }
  }
  return [...found];
}

function build(env, files, revision) {
  const docs = [], evidence = new Set();
  for (const file of files) {
    const text = fs.readFileSync(file.source, 'utf8').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/);
    let metadata = '', versionMetadata = '';
    if (lines[0] === '---') {
      const end = lines.indexOf('---', 1);
      if (end > 0) {
        versionMetadata = lines.slice(1, end).join('\n');
        metadata = lines.slice(1, end).filter(line => /^(?:tags|case_id):/.test(line)).join('\n');
        // Keep original line positions while excluding frontmatter paths/proof from ranking.
        for (let i = 0; i <= end; i++) lines[i] = '';
      }
    }
    // Only explicit original-evidence links from cards extend the read boundary.
    if (file.type === 'error' || file.type === 'experience') for (const linked of evidencePaths(text, file.source)) evidence.add(linked);
    for (const section of markdownSections(lines)) {
      if (/^(?:来源|更新记录)$/.test(section.title.split(' / ').at(-1))) continue;
      const actionRows = lines.map((line, i) => ({ line, i })).slice(section.start, section.end).filter(({ line }) => /(?:\*\*(?:下次|解决|做法|动作)|^(?:下次|解决|做法|动作)[：:]|^#{1,6}\s*(?:下次|解决|做法|动作))/.test(line));
      const action = actionRows.map(({ line }) => clean(line)).join('\n');
      for (const chunk of splitSection(lines, section)) {
        while (chunk.start < chunk.end && !lines[chunk.start].trim()) chunk.start++;
        while (chunk.end > chunk.start && !lines[chunk.end - 1].trim()) chunk.end--;
        const body = lines.slice(chunk.start, chunk.end).join('\n').trim();
        if (!body || /^#{1,6} [^\n]+$/.test(body)) continue;
        const title = section.title || path.basename(file.source, '.md');
        const cardBody = lines.slice(section.start, section.end).join('\n').trim();
        const memoryKey = 'm-' + DIGEST(file.source + '\0' + title);
        const contentVersion = DIGEST(JSON.stringify({ source: file.source, title, cardBody, metadata: versionMetadata, type: file.type, topics: file.topics }));
        const contentTerms = Object.fromEntries(tokens(clean(body) + '\n' + metadata));
        const titleTerms = Object.fromEntries([...tokens(title)].map(([term, weight]) => [term, weight * 0.3]));
        for (const [term, weight] of tokens(title.split(' / ').at(-1))) titleTerms[term] = weight;
        const specificAction = file.type === 'error' ? [...clean(body).matchAll(/下次[^。\n]{8,240}(?:。|$)/g)].map(m => m[0]).join('\n') : '';
        const globalAction = file.type === 'error' && !specificAction && actionRows.length > 0;
        docs.push({ id: 'k-' + DIGEST(file.source + '\0' + title + '\0' + chunk.start), memoryKey, contentVersion, title, source: file.source, startLine: globalAction ? actionRows[0].i + 1 : chunk.start + 1, endLine: globalAction ? actionRows.at(-1).i + 1 : chunk.end, cardStartLine: section.start + 1, cardEndLine: section.end, cardBody, metadata: versionMetadata, type: file.type, topics: file.topics, body, action: cap(specificAction || action, 500), links: file.type === 'error' ? evidencePaths(body, file.source) : [], terms: contentTerms, titleTerms, length: Math.max(1, Object.keys(contentTerms).length) });
      }
    }
  }
  const df = {};
  for (const doc of docs) for (const term of new Set([...Object.keys(doc.terms), ...Object.keys(doc.titleTerms)])) df[term] = (df[term] || 0) + 1;
  return { engine: ENGINE, revision, files, docs, evidence: [...evidence], df, avgLength: docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length) };
}

function index(options = {}) {
  const env = setup(options), files = sourceFiles(env);
  const revision = DIGEST(ENGINE + env.raw + env.retirements.raw + JSON.stringify(files));
  const cache = path.join(env.cacheDir, 'index-' + DIGEST(env.sourcesFile) + '.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(cache, 'utf8')); } catch { /* First use or interrupted cache. */ }
  if (!data || data.engine !== ENGINE || data.revision !== revision) {
    data = build(env, files, revision);
    // Retrieval remains available even when the cache is read-only.
    try {
      fs.mkdirSync(env.cacheDir, { recursive: true });
      const tmp = cache + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, cache);
    } catch { /* Cache is expendable; source reads already succeeded. */ }
  }
  return { env, data };
}

function summary(doc, queryTerms, maxChars = 320) {
  if (doc.type === 'experience') {
    const lines = doc.body.split('\n').map(line => clean(line).replace(/^-\s+/, '')).filter(Boolean);
    const solution = lines.filter(line => /^(?:解决|做法|动作)[：:]/.test(line));
    const scope = lines.filter(line => /^(?:结果|边界|遇到|触发)/.test(line));
    if (solution.length) return cap([...solution, ...scope].join('\n'), maxChars);
  }
  const paragraphs = doc.body.replace(/^#{1,6}[^\n]*\n/gm, '').split(/\n\s*\n|(?=^- \*\*(?:当时|补充|同类))/m).map(clean).filter(Boolean);
  const scored = paragraphs.map((text, i) => ({ text, i, score: [...tokens(text)].reduce((sum, [term, weight]) => sum + (queryTerms.get(term) || 0) * weight, 0) })).sort((a, b) => b.score - a.score || a.i - b.i);
  let selected = scored[0]?.text || clean(doc.body);
  // A long card's preventive action precedes its history, with relevant specifics if room.
  if (doc.type === 'error' && doc.action) selected = doc.action;
  return cap(selected, maxChars);
}

function effectiveRetrieval(query, options) {
  const queryText = retrievalQuery(query);
  const contextText = retrievalQuery(options.taskContext ?? options.context ?? '');
  const terms = tokens(queryText);
  // A deliberately suppressed invocation cannot inherit a background task.
  const suppressed = !queryText && Boolean(String(query || '').trim());
  const fallback = !suppressed && !terms.size && tokens(contextText).size > 0;
  return {queryText: fallback ? contextText : queryText,
    contextText: fallback ? '' : contextText, suppressed, fallback};
}

export function searchKnowledge(query, options = {}) {
  const { env, data } = index(options);
  const effective = effectiveRetrieval(query, options);
  const queryText = effective.queryText;
  const terms = tokens(queryText);
  const topicText = queryText.normalize('NFKC').toLowerCase();
  const contextText = effective.contextText.normalize('NFKC').toLowerCase();
  const contextTerms = tokens(contextText);
  // An intentionally suppressed run-only request must stay empty even with context.
  if (effective.suppressed) return { items: [], revision: data.revision };
  // Generic acknowledgements may inherit the reliable current branch; an unknown
  // specific subject (such as a recipe) must not silently fall back to another task.
  const containsTerm = (text, value) => {
    const term = String(value).normalize('NFKC').toLowerCase();
    return /^[a-z\d]+$/i.test(term) ? new RegExp('(?:^|[^a-z\\d_])' + term + '(?:$|[^a-z\\d_])', 'i').test(text) : text.includes(term);
  };
  const allowedTopics = new Set((env.config.topicRules || []).filter(rule => {
    // A broad word overlap cannot establish a document's subject. Strong technical
    // evidence allows it; ambiguous window/resource terms need a matching context.
    const any = (values, text) => (values || []).some(term => containsTerm(text, term));
    if (any(rule.strongTerms, topicText)) return true;
    // Current explicit subject takes precedence over examples in older context.
    if (any(rule.systemContextTerms, topicText)) return false;
    const weakQueryCount = (rule.weakTerms || []).filter(term => containsTerm(topicText, term)).length;
    if (any(rule.subjectTerms, topicText) && weakQueryCount >= (rule.minWeakTerms ?? 2)) return true;
    if (any(rule.systemContextTerms, contextText)) return false;
    if (any(rule.strongTerms, contextText)) return true;
    return (rule.weakTerms || []).filter(term => containsTerm(topicText + '\n' + contextText, term)).length >= (rule.minWeakTerms ?? 2);
  }).map(rule => rule.id));
  const anchors = [...terms.keys()].filter(term => /^[a-z][a-z\d_+.:-]*$/.test(term) && data.df[term]).sort((a, b) => data.df[a] - data.df[b]);
  const primaryTerms = [...terms].filter(([, weight]) => weight >= 1);
  const knownPrimaryTerms = primaryTerms.filter(([term]) => data.df[term]);
  const distinctiveTerms = primaryTerms.filter(([term]) => !WEAK_RELEVANCE.has(term));
  const distinctivePartials = [...terms].filter(([term, weight]) => weight < 1
    && ![...WEAK_RELEVANCE].some(weak => weak.includes(term)));
  const limit = budget(options.limit, env.config.defaults?.limit ?? 3, 20);
  if (!terms.size || limit === 0) return { items: [], revision: data.revision };
  const ranked = [];
  for (const doc of data.docs) {
    if (retirementFor(doc, env.retirements) && !options.includeRetired) continue;
    if (doc.topics?.length && !doc.topics.some(topic => allowedTopics.has(topic))) continue;
    if (doc.type === 'error' && !doc.action && !doc.title.includes(' / ')) continue;
    // Explicit product/error words constrain generic overlaps, but missing vocabulary
    // must not discard a card that matches the other strong terms in the symptom.
    if (anchors.length && !anchors.some(term => doc.terms[term] || (doc.titleTerms[term] || 0) >= 1)) continue;
    const exactTitle = doc.title.split(' / ').some(part => topicText.trim() === part.normalize('NFKC').toLowerCase().trim());
    const wordMatch = distinctiveTerms.some(([term]) => (doc.terms[term] || 0) >= 1 || (doc.titleTerms[term] || 0) >= 1);
    // Keep existing cross-word Chinese recall, but two grams from generic
    // product/task vocabulary are not evidence of a concrete subject.
    const partialMatches = distinctivePartials.filter(([term]) => doc.terms[term] || doc.titleTerms[term]).length;
    if (!exactTitle && !wordMatch && (!distinctiveTerms.length || partialMatches < 2)) continue;
    let score = 0, matched = 0, precise = 0;
    for (const [term, queryWeight] of terms) {
      const contentWeight = doc.terms[term] || 0, titleWeight = doc.titleTerms[term] || 0;
      if (!contentWeight && !titleWeight) continue;
      const idf = Math.log(1 + (data.docs.length - (data.df[term] || 0) + 0.5) / ((data.df[term] || 0) + 0.5));
      const freq = contentWeight + titleWeight * 2.4;
      score += queryWeight * idf * freq * 2.2 / (freq + 1.2 * (0.25 + 0.75 * doc.length / data.avgLength));
      matched++;
      if (queryWeight >= 1 && (contentWeight >= 1 || titleWeight >= 1)) precise++;
    }
    // At least one real word or two distinctive partial terms; generic overlaps are insufficient.
    if (score < (options.minScore ?? 1.25) || (!precise && matched < 2)) continue;
    if (!anchors.length && knownPrimaryTerms.length >= 3 && precise < 2) continue;
    if (contextTerms.size) {
      let contextScore = 0;
      for (const [term, weight] of contextTerms) {
        const freq = (doc.terms[term] || 0) + (doc.titleTerms[term] || 0) * 2.4;
        if (!freq) continue;
        const idf = Math.log(1 + (data.docs.length - (data.df[term] || 0) + 0.5) / ((data.df[term] || 0) + 0.5));
        contextScore += weight * idf * freq * 2.2 / (freq + 1.2 * (0.25 + 0.75 * doc.length / data.avgLength));
      }
      score += Math.min(contextScore * 0.2, score * 0.25);
    }
    if (doc.type === 'experience') score *= 1.12;
    if (doc.type === 'error' && !doc.action) score *= 0.5;
    ranked.push({ doc, score, matched, precise });
  }
  ranked.sort((a, b) => b.score - a.score || a.doc.source.localeCompare(b.doc.source) || a.doc.startLine - b.doc.startLine);
  const selected = [], seen = new Set();
  if (ranked[0]?.doc.type === 'experience') {
    const winner = ranked[0].doc.source;
    for (const match of ranked) if (match.doc.type === 'error' && match.doc.links?.includes(winner)) match.complement = true;
    ranked.sort((a, b) => (b.complement ? 1 : 0) - (a.complement ? 1 : 0) || b.score - a.score);
    // The strongest original match still leads; linked preventive actions follow it.
    const first = ranked.findIndex(match => match.doc.source === winner);
    if (first > 0) ranked.unshift(...ranked.splice(first, 1));
  }
  for (const { doc, score, complement, precise } of ranked) {
    if (score < ranked[0].score * (options.minRelativeScore ?? 0.95) && !complement) continue;
    if (ranked[0].doc.type === 'experience' && !complement && precise < ranked[0].precise * 0.75) continue;
    // Different sections can be useful; repeated historical chunks from one card cannot crowd out them.
    const key = doc.source + '\0' + doc.title;
    if (seen.has(key)) continue;
    seen.add(key);
    const retired = retirementFor(doc, env.retirements);
    selected.push({ id: doc.id, memoryKey: doc.memoryKey, contentVersion: doc.contentVersion, title: doc.title, summary: summary(doc, terms, budget(options.summaryChars, 320, 2000)), source: doc.source, startLine: doc.startLine, endLine: doc.endLine, type: doc.type, score: Number(score.toFixed(3)), ...(retired ? {historyOnly: true, retirement: retirementNotice(retired)} : {}) });
    if (selected.length >= limit) break;
  }
  return { items: selected, revision: data.revision };
}

export function formatKnowledgeBrief(result, options = {}) {
  const maxChars = budget(options.maxChars, 1000);
  if (!result?.items?.length || !maxChars) return '';
  const heading = '参考片段（当前目标与授权优先，原文可读回）：\n';
  let text = heading;
  for (const [i, item] of result.items.entries()) {
    const pointer = `${item.id} · ${item.source}:${item.startLine}-${item.endLine}`;
    const label = `[${item.type}${item.historyOnly ? ' / 已退役历史' : ''}] ${item.title}\n${item.retirement ? '退役原因：' + item.retirement.reason + '\n替代出处：' + item.retirement.replacement + '\n' : ''}`;
    const separator = i ? '\n' : '';
    const remaining = maxChars - text.length - separator.length;
    if (remaining < label.length + pointer.length + 5) break;
    const fairShare = Math.max(label.length + pointer.length + 5, Math.floor(remaining / (result.items.length - i)));
    const available = Math.min(remaining, fairShare) - label.length - pointer.length - 2;
    text += separator + label + cap(item.summary, available) + '\n' + pointer + '\n';
  }
  return text === heading ? '' : cap(text.trimEnd(), maxChars);
}

// Candidates are discovery hints, never selected instructions. No historical
// action/solution summary is exposed before the caller checks applicability.
export function candidateKnowledge(query, options = {}) {
  const { env, data } = index(options);
  const effective = effectiveRetrieval(query, options);
  const queryText = effective.queryText;
  const queryTerms = tokens(queryText);
  const primary = [...queryTerms].filter(([, weight]) => weight >= 1).map(([term]) => term);
  const limit = budget(options.limit, 6, 8);
  const maxChars = budget(options.maxChars, 2400);
  const result = { mode: 'candidates', status: effective.suppressed ? 'suppressed' : 'no-match', pendingApplicability: true, instruction: '仅为检索候选；待 Sol 核当前目标、授权、触发条件与边界后 load 所选 ID。0候选或明显偏题时，按用户当前意思改写查询重查；旧动作不能作为新指令。', items: [], revision: data.revision, itemChars: 0 };
  if (effective.suppressed || !primary.length || !limit || !maxChars) return result;
  const ranked = searchKnowledge(query, { ...options, limit: 20, minRelativeScore: options.minRelativeScore ?? 0.5, summaryChars: 0 });
  const qualified = [];
  for (const match of ranked.items) {
    const doc = data.docs.find(d => d.id === match.id);
    const matchedTerms = primary.filter(term => (doc.terms[term] || 0) >= 1 || (doc.titleTerms[term] || 0) >= 1);
    const exactTitle = doc.title.split(' / ').some(part => queryText.normalize('NFKC').toLowerCase().trim() === part.normalize('NFKC').toLowerCase().trim());
    const explicitAnchor = matchedTerms.some(term => !WEAK_RELEVANCE.has(term) && /^[a-z][a-z\d_+.:-]*$/.test(term) && term.length >= 3);
    // A broad single Han term is a weak signal; query rewriting can supply the
    // concrete symptom. This gate controls recall only, not task authorization.
    if (matchedTerms.length < 2 && !exactTitle && !explicitAnchor) continue;
    const scopeRows = applicabilityRows(doc.cardBody);
    const scopeTerms = tokens(doc.title + '\n' + scopeRows.join('\n'));
    const scopeMatches = primary.filter(term => !DISCOVERY_GENERIC.has(term) && (scopeTerms.get(term) || 0) >= 1);
    // Scope-labelled cards cannot qualify through their solution/proof alone.
    // Unstructured knowledge stays discoverable and explicitly requires reading.
    if (scopeRows.length && !exactTitle && !scopeMatches.length) continue;
    // Keep only whole scope rows that fit; never substitute the old action.
    const clueMatches = scopeRows.filter(line => line.length <= 320)
      .map((line, order) => ({line, order, matches: primary.filter(term => (tokens(line).get(term) || 0) >= 1).length}))
      .sort((a, b) => b.matches - a.matches || a.order - b.order);
    const clues = (clueMatches.some(v => v.matches) ? clueMatches.filter(v => v.matches) : clueMatches).slice(0, 2).map(v => v.line);
    const retired = retirementFor(doc, env.retirements);
    const status = /^status:\s*["']?([^\n"']+)/m.exec(doc.metadata || '')?.[1]?.trim();
    const item = { id: doc.id, memoryKey: doc.memoryKey, contentVersion: doc.contentVersion, title: doc.title, clues, matchedTerms, scopeMatches, matchOrigin: effective.fallback ? 'task-context-fallback' : 'query', source: doc.source, startLine: doc.cardStartLine, endLine: doc.cardEndLine, type: doc.type, pendingApplicability: true, ...(status ? {status} : {}), ...(retired ? {historyOnly: true, retirement: retirementNotice(retired)} : {}) };
    qualified.push({item, priority: scopeMatches.length, score: match.score});
  }
  qualified.sort((a, b) => b.priority - a.priority || b.score - a.score);
  for (const {item} of qualified) {
    const chars = JSON.stringify(item).length;
    if (result.itemChars + chars > maxChars) continue;
    result.items.push(item); result.itemChars += chars;
    if (result.items.length >= limit) break;
  }
  result.status = result.items.length ? 'candidates' : qualified.length ? 'budget-excluded' : 'no-match';
  if (result.status === 'budget-excluded') result.requiredChars = Math.min(...qualified.map(v => JSON.stringify(v.item).length));
  result.query = queryText;
  if (result.status === 'no-match') result.next = '按当前对象+具体症状改写查询，不把旧候选当目标；没有适用卡则继续原任务。';
  return result;
}

export function formatKnowledgeCandidates(result, options = {}) {
  const maxChars = budget(options.maxChars, 2400);
  if (!result?.instruction || result.instruction.length > maxChars) return '';
  let text = result.instruction;
  for (const item of result.items || []) {
    const block = candidateBlock(item);
    if (text.length + 2 + block.length <= maxChars) text += '\n\n' + block;
  }
  return text;
}

function candidateBlock(item) {
  return `[${item.type}${item.historyOnly ? ' / 已退役历史' : ''}${item.status ? ' / ' + item.status : ''}] ${item.title}\n${item.retirement ? '退役原因：' + item.retirement.reason + '\n替代出处：' + item.retirement.replacement + '\n' : ''}${item.clues.length ? item.clues.join('\n') : '适用条件未结构化；需读原件判断。检索词重合：' + item.matchedTerms.slice(0, 8).join('、')}\n${item.id} · stable:${item.memoryKey} · ${item.source}:${item.startLine}-${item.endLine} · version:${item.contentVersion}`;
}

function completeBlock(item) {
  return `[${item.type}${item.historyOnly ? ' / 已退役历史，仅供追溯' : ''}] ${item.title}\n${item.retirement ? '退役原因：' + item.retirement.reason + '\n替代出处：' + item.retirement.replacement + '\n' : ''}${item.metadata ? '卡片元数据：\n' + item.metadata + '\n' : ''}${item.text}\n原件：${item.id} · stable:${item.memoryKey} · ${item.source}:${item.startLine}-${item.endLine} · version:${item.contentVersion}${item.evidence.length ? '\n原证指针：' + item.evidence.join('；') : ''}`;
}

// Resolve explicit current IDs. Oversized complete cards are
// explicitly skipped instead of dropping conditions, boundaries or evidence.
export function loadKnowledge(refs, options = {}) {
  const { env, data } = index(options);
  const values = [...new Set((Array.isArray(refs) ? refs : String(refs || '').split(',')).map(ref => String(ref).trim()).filter(Boolean))];
  // Explicit refs are chosen by the caller; paging budget is not a global rule
  // limiting how many memories the AI may consider/read for its actual task.
  const limit = budget(options.limit, values.length, Math.max(100, values.length)), maxChars = budget(options.maxChars, 6000);
  const result = { mode: 'loaded', pendingApplicability: true, instruction: '所选原文参考，尚未代替 Sol 的适用性判断；当前目标、授权与用户最新纠正优先。', items: [], skipped: [], revision: data.revision, itemChars: 0 };
  const seen = new Set();
  for (const id of values) {
    const retired = findRetirement(id, env.retirements) || data.docs.filter(d => d.id === id || d.memoryKey === id).map(d => retirementFor(d, env.retirements)).find(Boolean);
    if (retired && !options.includeRetired) {
      result.skipped.push({id, reason: 'retired-knowledge', retirement: retirementNotice(retired), next: `已确认退役：${retired.reason}；替代出处：${retired.replacement}；仅追溯历史时显式 --include-retired。`}); continue;
    }
    if (retired) {
      if (seen.has(retired.memoryKey)) { result.skipped.push({id, reason: 'duplicate-card'}); continue; }
      if (result.items.length >= limit) { result.skipped.push({id, reason: 'card-limit'}); continue; }
      const frozen = readRetiredSnapshot(retired, env.retirements);
      const item = {...frozen, historyOnly: true, retirement: retirementNotice(retired), evidence: [], pendingApplicability: false};
      const chars = JSON.stringify(item).length;
      if (result.itemChars + chars > maxChars) { result.skipped.push({id, reason: 'complete-card-exceeds-budget', requiredChars: chars, source: frozen.source, startLine: frozen.startLine, endLine: frozen.endLine, next: '提高maxChars后显式include-retired读取完整历史快照。'}); continue; }
      seen.add(retired.memoryKey); result.items.push(item); result.itemChars += chars; continue;
    }
    const matches = data.docs.filter(d => d.id === id || d.memoryKey === id);
    if (!matches.length) { result.skipped.push({ id, reason: 'unknown-current-id', next: '此指针已失效或不存在；按当前标题/症状重新 candidates，使用返回的稳定 m-Key 或当前 k-ID；不按旧行号猜。' }); continue; }
    if (new Set(matches.map(d => JSON.stringify([d.source, d.contentVersion, d.cardStartLine, d.cardEndLine]))).size > 1) {
      result.skipped.push({id, reason: 'ambiguous-memory-key', next: '同一稳定指针对应多个不同章节；重新 candidates 并用明确当前 k-ID。'}); continue;
    }
    const doc = matches[0];
    const key = doc.memoryKey;
    if (seen.has(key)) { result.skipped.push({ id, reason: 'duplicate-card' }); continue; }
    if (result.items.length >= limit) { result.skipped.push({ id, reason: 'card-limit' }); continue; }
    const evidenceHints = (doc.metadata + '\n' + doc.cardBody).split('\n').map(line => clean(line).replace(/^-\s+/, ''))
      .filter(line => /^(?:source\s*:|原证[：:]|证据[：:])/.test(line));
    const item = { id: doc.id, memoryKey: doc.memoryKey, contentVersion: doc.contentVersion, title: doc.title, text: doc.cardBody, metadata: doc.metadata, source: doc.source, startLine: doc.cardStartLine, endLine: doc.cardEndLine, type: doc.type,
      completeCard: true, evidence: evidencePaths(doc.metadata + '\n' + doc.cardBody, doc.source), evidenceHints, pendingApplicability: true };
    const chars = JSON.stringify(item).length;
    if (result.itemChars + chars > maxChars) { result.skipped.push({ id, reason: 'complete-card-exceeds-budget', requiredChars: chars, requiredTotalChars: result.itemChars + chars, source: doc.source, startLine: doc.cardStartLine, endLine: doc.cardEndLine,
      continuation: {ref: `${doc.source}:${doc.cardStartLine}-${doc.cardEndLine}`, maxChars: Math.max(1, maxChars), maxLines: 80},
      next: '提高 maxChars 至requiredTotalChars（load最多20000）；更长原件按continuation显式read，并沿nextCursor续至complete=true。单页不是完整卡。' }); continue; }
    seen.add(key); result.items.push(item); result.itemChars += chars;
  }
  return result;
}

export function formatLoadedKnowledge(result, options = {}) {
  const maxChars = budget(options.maxChars, 6000);
  if (!result?.instruction || result.instruction.length > maxChars) return '';
  let text = result.instruction;
  for (const item of result.items || []) {
    const block = completeBlock(item);
    if (text.length + 2 + block.length <= maxChars) text += '\n\n' + block;
    else {
      const notice = `未展示完整卡：${item.id}；最终文本requiredChars=${text.length + 2 + block.length}；提高格式预算或按原件完整范围显式续读：${item.source}:${item.startLine}-${item.endLine}。`;
      if (text.length + 1 + notice.length <= maxChars) text += '\n' + notice;
    }
  }
  for (const item of result.skipped || []) {
    const block = `未加载：${item.id} (${item.reason})${item.requiredChars ? `；requiredChars=${item.requiredChars}${item.requiredTotalChars ? '；requiredTotalChars=' + item.requiredTotalChars : ''}；${item.next} 原件：${item.source}:${item.startLine}-${item.endLine}` : item.next ? '；' + item.next : ''}`;
    if (text.length + 1 + block.length <= maxChars) text += '\n' + block;
  }
  return text;
}

// Preparation supplies navigation, never a keyword-selected memory subset.
// The AI first inspects the local overview/catalog and chooses what to read.
export function prepareKnowledgeContext(query, options = {}) {
  return {text: knowledgeNavigation({maxChars: options.maxChars ?? 320}),
    policy: 'manual-discovery', items: [], loadedItems: [], emitted: [], skipped: [], revision: ''};
}

export function knowledgeNavigation(options = {}) {
  const script = slash(path.join(HERE, 'knowledge.mjs'));
  const text = `先了解本地：node "${script}" overview；catalog --offset 0 可分页看知识/经验/错误目录。AI结合核心目的、当前完整分支和已有成果，自行选择load --refs ID或read原件；candidates/search仅为可选查找。缺适用办法优先搜索。预算不足按requiredTotalChars提高，或read --cursor nextCursor续至complete=true；片段不是完整卡。`;
  return text.length <= budget(options.maxChars, 320) ? text : '';
}

export function knowledgeRevision(options = {}) { return index(options).data.revision; }
// Shared chunks for recall.mjs (hybrid FTS/vector index); retired sections stay out.
export function knowledgeDocuments(options = {}) {
  const { env, data } = index(options);
  return { revision: data.revision, docs: data.docs.filter(doc => options.includeRetired || !retirementFor(doc, env.retirements))
    .map(doc => ({ id: doc.id, memoryKey: doc.memoryKey, title: doc.title, source: doc.source, startLine: doc.startLine, endLine: doc.endLine, type: doc.type, body: doc.body })) };
}

export function knowledgeOverview(options = {}) {
  const {env, data} = index(options);
  const cards = new Map(data.docs.map(doc => [doc.memoryKey, doc]));
  const active = [...cards.values()].filter(doc => options.includeRetired || !retirementFor(doc, env.retirements));
  return {mode: 'overview', policy: 'manual-discovery', instruction: '沿完整任务选读以下原件；适用性由AI结合来源判断。',
    counts: Object.fromEntries(['knowledge','experience','error'].map(type => [type, active.filter(doc => doc.type === type).length])),
    navigation: sourceNavigation(env), objectKnowledge:objectNavigation(), total: active.length, next: 'catalog可不带query分页浏览，也可沿INDEX直接read；AI自行选择load或read原件。'};
}

export function catalogKnowledge(options = {}) {
  const {env, data} = index(options), unique = new Map();
  for (const doc of data.docs) if (!unique.has(doc.memoryKey)) unique.set(doc.memoryKey, doc);
  const query = String(options.query || '').normalize('NFKC').toLowerCase().trim();
  const terms = [...tokens(query)].filter(([, weight]) => weight >= 1).map(([term]) => term);
  const rows = [...unique.values()].filter(doc => (options.includeRetired || !retirementFor(doc, env.retirements))
    && (!options.type || options.type === 'all' || options.type === doc.type)
    && (!options.source || doc.source.toLowerCase().includes(String(options.source).toLowerCase()))
    && (!query || (doc.title + '\n' + doc.cardBody).normalize('NFKC').toLowerCase().includes(query)
      || terms.some(term => doc.terms[term] || doc.titleTerms[term])));
  const offset = budget(options.offset, 0, Number.MAX_SAFE_INTEGER), limit = Math.max(1, budget(options.limit, 25, 100));
  const items = rows.slice(offset, offset + limit).map(doc => ({id: doc.id, memoryKey: doc.memoryKey, type: doc.type, title: doc.title,
    scope: applicabilityRows(doc.cardBody).filter(row => row.length <= 320).slice(0, 2), source: doc.source,
    startLine: doc.cardStartLine, endLine: doc.cardEndLine,
    ...(retirementFor(doc, env.retirements) ? {historyOnly:true} : {})}));
  return {mode:'catalog', policy:'manual-discovery', order:'source-and-line', items, offset, total:rows.length,
    hasMore:offset + items.length < rows.length, nextOffset:offset + items.length < rows.length ? offset + items.length : null,
    instruction:'这是可分页完整目录（query/type/source仅为调用者选择的过滤）；没有自动相关性截断，AI决定读哪些原件。'};
}

// Management uses this same authoritative index. This unranked listing does
// not alter search/candidate/load behavior or turn records into instructions.
export function listKnowledge(options = {}) {
  const { env, data } = index(options);
  const unique = new Map();
  for (const doc of data.docs) if (!unique.has(doc.memoryKey)) unique.set(doc.memoryKey, doc);
  const all = [...unique.values()].filter(doc => options.includeRetired || !retirementFor(doc, env.retirements));
  const counts = Object.fromEntries(['experience', 'error', 'knowledge'].map(type => [type, all.filter(doc => doc.type === type).length]));
  const query = String(options.query || '').normalize('NFKC').toLowerCase().trim();
  const queryTerms = [...tokens(query)].filter(([, weight]) => weight >= 1).map(([term]) => term);
  const selected = all.filter(doc => (!options.type || options.type === 'all' || doc.type === options.type)
    && (!query || (doc.title + '\n' + doc.cardBody + '\n' + doc.metadata).normalize('NFKC').toLowerCase().includes(query)
      || queryTerms.some(term => doc.terms[term] || doc.titleTerms[term])));
  const limit = budget(options.limit, 250, 1000);
  const offset = budget(options.offset, 0, Number.MAX_SAFE_INTEGER);
  const page = selected.slice(offset, offset + limit);
  const hasMore = offset + page.length < selected.length;
  return { items: page.map(doc => ({ ref: doc.id, type: doc.type, title: doc.title,
    summary: cap(clean(doc.cardBody), 320), source: doc.source, startLine: doc.cardStartLine,
    endLine: doc.cardEndLine, version: doc.contentVersion, body: doc.cardBody, metadata: doc.metadata,
    memoryKey: doc.memoryKey, ...(retirementFor(doc, env.retirements) ? {historyOnly: true, retirement: retirementNotice(retirementFor(doc, env.retirements))} : {}) })),
    counts, total: all.length, matched: selected.length, revision: data.revision,
    offset, hasMore, nextOffset: hasMore && page.length ? offset + page.length : null };
}

export function readKnowledge(ref, options = {}) {
  const { env, data } = index(options);
  let cursor;
  if (options.cursor) {
    try { cursor = JSON.parse(Buffer.from(String(options.cursor), 'base64url').toString('utf8')); }
    catch { throw new Error('Invalid read cursor; restart from the explicit reference'); }
    if (cursor.v !== 1 || typeof cursor.source !== 'string') throw new Error('Unknown read cursor format');
    if (options.startLine !== undefined || options.endLine !== undefined || options.charOffset !== undefined) throw new Error('Cursor already carries its range; do not override line/character positions');
  }
  const value = cursor ? cursor.source : typeof ref === 'object' && ref ? ref.id || ref.source : String(ref || '');
  const retiredRef = findRetirement(value, env.retirements);
  if (retiredRef) {
    if (!options.includeRetired) throw new Error(`Retired knowledge: ${retiredRef.reason}; replacement: ${retiredRef.replacement}; use --include-retired only for history`);
    const snapshot = readRetiredSnapshot(retiredRef, env.retirements);
    const maximum = budget(options.maxChars, 2400);
    return {...snapshot, text: cap(snapshot.text, maximum), complete: snapshot.text.length <= maximum, truncated: snapshot.text.length > maximum,
      requiredChars: snapshot.text.length, historyOnly: true, retirement: retirementNotice(retiredRef), revision: data.revision};
  }
  const doc = data.docs.find(d => d.id === value || d.memoryKey === value);
  let source, startLine, endLine;
  if (doc) ({ source, startLine, endLine } = doc);
  else {
    // Only a terminal line suffix is removed; the drive colon is preserved.
    const match = /^(.*?)(?::(?:L)?(\d+)(?:-(?:L)?(\d+))?)?$/.exec(value);
    const candidate = match[1];
    if (!path.isAbsolute(candidate)) throw new Error('Unknown knowledge reference; use a search id or a registered absolute path');
    source = slash(fs.realpathSync(candidate));
    const allowed = new Set([...data.files.map(f => f.source), ...data.evidence, ...sourceNavigation(env).map(row => row.index).filter(Boolean)]);
    if (!allowed.has(source)) throw new Error('Reference is outside registered knowledge sources and explicit card evidence');
    startLine = Number(match[2] || 1);
    endLine = Number(match[3] || options.endLine || (startLine + 79));
  }
  if (options.startLine !== undefined) startLine = Number(options.startLine);
  if (options.endLine !== undefined) endLine = Number(options.endLine);
  const requestedStartLine = cursor?.requestedStartLine ?? startLine;
  if (cursor) { startLine = cursor.nextLine; endLine = cursor.endLine; }
  const charOffset = Number(cursor?.nextCharOffset ?? options.charOffset ?? 0);
  if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(endLine) || endLine < startLine) throw new Error('Invalid line range');
  if (!Number.isInteger(charOffset) || charOffset < 0 || !Number.isInteger(requestedStartLine) || requestedStartLine < 1 || requestedStartLine > startLine) throw new Error('Invalid read character/range position');
  const overlapping = data.docs.filter(d => d.source === source && d.cardStartLine <= endLine && d.cardEndLine >= startLine)
    .map(d => retirementFor(d, env.retirements)).filter(Boolean);
  if (overlapping.length && !options.includeRetired) throw new Error('Range includes retired knowledge; use --include-retired only for history. Replacement: ' + [...new Set(overlapping.map(entry => entry.replacement))].join('; '));
  // Byte-bounded scanning prevents a pointer to a giant transcript from loading it whole.
  const maxChars = budget(options.maxChars, env.config.defaults?.maxReadChars ?? 2400);
  const maxLines = Math.max(1, budget(options.maxLines, 80, 500));
  const pageEndLine = Math.min(endLine, startLine + maxLines - 1);
  const stat = fs.statSync(source);
  if (cursor && (stat.size !== cursor.size || stat.mtimeMs !== cursor.mtimeMs)) throw new Error('Original file changed during continuation; restart read from its current card/reference');
  const fd = fs.openSync(source, 'r');
  let output = '', line = 1, returnedEnd = startLine - 1, pending = Buffer.alloc(0), offset = 0;
  let nextLine = startLine, nextCharOffset = charOffset, complete = false, done = maxChars === 0;
  let reason = maxChars === 0 ? 'character-budget' : null;
  const buffer = Buffer.alloc(65536);
  const consume = (raw, hasNewline) => {
    let content = raw.toString('utf8').replace(/\r$/, '');
    if (line === 1) content = content.replace(/^\uFEFF/, '');
    if (line < startLine) { line++; return; }
    if (line > endLine) { complete = true; done = true; return; }
    // A row includes its separator, so concatenated pages reconstruct the exact
    // normalized range, including splits inside a long JSONL row.
    const row = content + (hasNewline && line < endLine ? '\n' : '');
    const from = line === startLine ? charOffset : 0;
    if (from > row.length || (from > 0 && /[\uDC00-\uDFFF]/.test(row[from] || '') && /[\uD800-\uDBFF]/.test(row[from - 1]))) throw new Error('Read offset is outside a UTF-16 character boundary');
    let take = Math.min(row.length - from, maxChars - output.length);
    if (take > 0 && /[\uD800-\uDBFF]/.test(row[from + take - 1]) && /[\uDC00-\uDFFF]/.test(row[from + take] || '')) take--;
    if (!take && from < row.length) {
      nextLine = line; nextCharOffset = from; done = true; reason = 'character-budget'; return;
    }
    output += row.slice(from, from + take); returnedEnd = line;
    if (from + take < row.length) {
      nextLine = line; nextCharOffset = from + take; done = true; reason = 'character-budget'; return;
    }
    nextLine = line + 1; nextCharOffset = 0;
    if (line === endLine || !hasNewline) { complete = true; done = true; }
    else if (line === pageEndLine) { done = true; reason = 'line-budget'; }
    else if (output.length >= maxChars) { done = true; reason = 'character-budget'; }
    line++;
  };
  try {
    while (!done) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, offset);
      offset += bytes;
      pending = Buffer.concat([pending, buffer.subarray(0, bytes)]);
      let eol;
      while ((eol = pending.indexOf(10)) !== -1) {
        const content = pending.subarray(0, eol);
        pending = pending.subarray(eol + 1);
        consume(content, true);
        if (done) break;
      }
      if (!bytes) {
        if (!done && pending.length) consume(pending, false);
        if (!done) { complete = true; done = true; }
        break;
      }
      // Fail explicitly on a larger row rather than pretending its prefix is complete.
      if (!done && pending.length > (options.maxLineBytes ?? 2 * 1024 * 1024)) throw new Error('Evidence line exceeds bounded 2MiB read; use a nearer extracted evidence file');
      if (offset > (options.maxScanBytes ?? 32 * 1024 * 1024) && !done) throw new Error('Line reference exceeds bounded scan; choose a nearer evidence file');
    }
  } finally { fs.closeSync(fd); }
  const after = fs.statSync(source);
  if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Original file changed during read; restart from its current reference');
  const nextCursor = complete ? null : Buffer.from(JSON.stringify({v: 1, source, requestedStartLine, endLine, nextLine, nextCharOffset, size: stat.size, mtimeMs: stat.mtimeMs})).toString('base64url');
  return { text: output, source, startLine, endLine: returnedEnd, requestedStartLine, requestedEndLine: endLine, charOffset,
    complete, completeCard: Boolean(doc && complete && requestedStartLine === doc.cardStartLine && endLine === doc.cardEndLine), truncated: !complete, truncationReason: reason, nextCursor,
    ...(nextCursor ? {continuation: {cursor: nextCursor, maxChars: Math.max(2, maxChars), maxLines}, next: 'read --cursor 返回的nextCursor --json；逐页读至complete=true，单页不代表完整卡/原证。'} : {}),
    revision: data.revision, ...(doc ? { memoryKey: doc.memoryKey, contentVersion: doc.contentVersion } : {}), ...(overlapping.length ? {historyOnly: true, retirements: overlapping.map(retirementNotice)} : {}) };
}

export function manageKnowledgeRetirement(command, refs, options = {}) {
  if (!['retire', 'restore'].includes(command)) throw new Error('Unknown retirement command');
  const {env, data} = index(options);
  return updateRetirement(command, refs, data.docs, env.retirements, options);
}

export function listKnowledgeRetirements(options = {}) {
  const {env, data} = index(options);
  return {entries: env.retirements.entries, revision: data.revision};
}

function cli() {
  if(process.argv[2]==='objects'){const result=objectCli(process.argv.slice(3));console.log(typeof result==='string'?result:JSON.stringify(result,null,2));return;}
  const [command = 'help', ...args] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (args[i] === '--json') options.json = true;
    else if (args[i] === '--include-retired') options.includeRetired = true;
    else if (args[i].startsWith('--')) options[name] = args[++i];
    else throw new Error('Unexpected argument: ' + args[i]);
  }
  if (command === 'overview') {
    console.log(JSON.stringify(knowledgeOverview(options), null, 2));
  } else if (command === 'catalog') {
    const result = catalogKnowledge(options);
    console.log(options.json ? JSON.stringify(result, null, 2) : result.instruction + '\n' + result.items.map(item => `[${item.type}] ${item.title}\n${item.memoryKey} · ${item.source}:${item.startLine}-${item.endLine}${item.scope.length ? '\n' + item.scope.join('\n') : ''}`).join('\n\n') + (result.hasMore ? '\n继续catalog --offset ' + result.nextOffset : '\n本次过滤范围的目录已列完。'));
  } else if (command === 'search') {
    const result = searchKnowledge(options.query || '', options);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatKnowledgeBrief(result, options));
  } else if (command === 'candidates') {
    const result = candidateKnowledge(options.query || '', options);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatKnowledgeCandidates(result, options));
  } else if (command === 'load') {
    const result = loadKnowledge(options.refs, options);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatLoadedKnowledge(result, options));
  } else if (command === 'read') {
    const result = readKnowledge(options.ref, options);
    console.log(options.json ? JSON.stringify(result, null, 2) : `${result.historyOnly ? '已退役历史，仅供追溯。' + JSON.stringify(result.retirement || result.retirements) + '\n' : ''}${result.source}:${result.startLine}-${result.endLine}${result.charOffset ? '；行内起点=' + result.charOffset : ''}\n${result.text}${result.truncated ? result.nextCursor ? '\n未读完整（' + result.truncationReason + '）；继续：read --cursor ' + result.nextCursor + ' --json' : '\n未读完整；提高读取预算至requiredChars=' + result.requiredChars : '\n本次指定范围已读完。'}`);
  } else if (command === 'retire' || command === 'restore') {
    console.log(JSON.stringify(manageKnowledgeRetirement(command, options.refs, options), null, 2));
  } else if (command === 'retirements') {
    console.log(JSON.stringify(listKnowledgeRetirements(options), null, 2));
  } else if (command === 'revision') console.log(knowledgeRevision(options));
  else if (command === 'navigation') console.log(knowledgeNavigation(options));
  else if (command === 'help') console.log('knowledge.mjs overview：先看本地知识/经验/错误导航\ncatalog [--offset 0] [--limit 25] [--type experience|error|knowledge] [--query 可选过滤] [--json]：分页全目录，不自动选卡\ncandidates --query "对象+症状" [--limit 3] [--json]：显式辅助查找，非唯一入口\nload --refs m-KEY[,m-KEY] [--max-chars 6000..20000] [--json]：数量由调用者选择和单页预算决定\nread --ref "已登记ID或绝对路径:起行-止行" [--max-chars 2400] [--max-lines 80] [--json]\nread --cursor 返回的nextCursor [--max-chars 2400] [--json]\ncomplete仅表示指定范围读完，默认片段不等于完整卡。load超预算给requiredTotalChars/continuation；更长原证read逐页到complete=true。游标遇原件变化须重新定位。\nsearch/retire/restore/retirements/revision/navigation保留。默认排除退役，历史显式--include-retired。缺适用办法由AI优先搜索成熟外部原文。');
  else console.log('knowledge.mjs search --query "目标/症状" [--limit 3] [--max-chars 1000] [--json]\nknowledge.mjs candidates --query "目标/症状" [--limit 6] [--max-chars 2400] [--json]\nknowledge.mjs load --refs ID1,ID2 [--max-chars 6000] [--json]\nknowledge.mjs read --ref ID [--max-chars 2400] [--json]\nknowledge.mjs retire --refs STABLE_REF --reason "已确认失效的依据" --replacement "有效替代出处"\nknowledge.mjs restore --refs STABLE_REF --reason "恢复依据"\nknowledge.mjs retirements\n默认排除已退役章节；追溯历史显式 --include-retired，会标明原因/替代出处。候选和load的max-chars为完整items的JSON字符预算；可选 --sources-file FILE --cache-dir DIR --retirements-file FILE；revision / navigation');
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { cli(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

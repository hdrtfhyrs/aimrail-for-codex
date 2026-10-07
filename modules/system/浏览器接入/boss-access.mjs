import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
// BOSS read-only access using only the documented browser passed by cua_repl.
// This module never launches a browser, reads cookies, or calls a raw CDP API.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const BOSS_ENTRY = 'https://www.zhipin.com/web/user/';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const now = () => new Date().toISOString();
const stopped = new Set(['security_check', 'reported_flicker', 'read_failed', 'navigation_unconfirmed', 'creation_unconfirmed', 'unexpected_navigation']);

function bossUrl(value) {
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password &&
      (u.hostname === 'zhipin.com' || u.hostname.endsWith('.zhipin.com')) ? u : null;
  } catch {return null;}
}
export function safeUrl(value) {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol)) return u.protocol === 'about:' ? 'about:blank' : '[non-http-url]';
    return `${u.origin}${u.pathname}`; // No auth query strings, fragments or credentials.
  } catch {return null;}
}
function checkUrl(value) {
  const u = bossUrl(value);
  return !!u && (u.searchParams.has('_security_check') ||
    /\/(?:security-check|zhipin-security)(?:\/|$)/i.test(u.pathname) ||
    u.pathname === '/web/passport/zp/verify.html');
}
export function redactText(value) {
  return String(value ?? '').replace(/^.*(?:textbox|input|文本框).*(?:password|密码|验证码|口令|token|密钥).*$/gim, '[authentication input removed]')
    .replace(/https?:\/\/[^\s"<>]+/g, v => safeUrl(v) ?? '[url]')
    .replace(/\b(?:sk-|AIza)[A-Za-z0-9_-]{12,}\b/g, '[credential removed]')
    .replace(/\b(?:Bearer\s+)[A-Za-z0-9._-]+/gi, '[credential removed]')
    .replace(/((?:__zp_stoken__|token|cookie|password|密码|验证码|securityId)\s*[:=]\s*)[^\s,;"<>]+/gi, '$1[removed]')
    .replace(/\b[A-Za-z0-9_-]{28,}\b/g, '[long identifier removed]');
}
function classify(url, text = '') {
  if (checkUrl(url) || /当前\s*IP\s*地址.*异常|异常访问行为|环境存在异常|安全验证|访问过于频繁|请完成.*验证/.test(text)) return 'security_check';
  if (/加载中[，,]?\s*请稍后/.test(text) && !/职位|公司|登录|扫码/.test(text)) return 'loading';
  if (/扫码登录|验证码登录|注册登录|登录注册|登录后.*查看/.test(text)) return 'login_page';
  if (/职位|岗位|薪资|公司/.test(text)) return 'content_visible';
  return text.trim() ? 'page_visible' : 'empty_snapshot';
}
function metadata(tab) {
  return {tabId: String(tab.id), url: safeUrl(tab.url), title: redactText(tab.title).slice(0, 200), securityMarker: checkUrl(tab.url)};
}
function result(status, extra = {}) {
  return {status, observedAt: now(), loginStatus: 'not_verified', stableAccess: 'not_verified', ...extra};
}

// Lease is never reclaimed automatically: a crashed/long operation must not
// create a second tab or start a second read. State persists attempted actions.
export function createBossFileStore({directory = _publicDataPath("浏览器接入/.boss-state"), browserKey} = {}) {
  if (!browserKey || typeof browserKey !== 'string') throw Error('Explicit browserKey required: e.g. iab:<chat ID> or chrome:<profile>.');
  const key = createHash('sha256').update(browserKey).digest('hex').slice(0, 24);
  const statePath = path.join(directory, `${key}.json`), lockPath = path.join(directory, `${key}.lock`);
  return {
    statePath,
    async run(action) {
      await fs.mkdir(directory, {recursive: true});
      let lease;
      try {lease = await fs.open(lockPath, 'wx');} catch (e) {
        if (e.code === 'EEXIST') return result('busy', {reason: 'Another operation owns this browser scope; no retry or page acquisition.'});
        throw e;
      }
      const save = async state => {
        const temp = `${statePath}.${randomUUID()}.tmp`;
        try {await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8'); await fs.rename(temp, statePath);}
        finally {await fs.unlink(temp).catch(e => {if (e.code !== 'ENOENT') throw e;});}
      };
      try {
        await lease.writeFile(JSON.stringify({at: now(), browserKey}));
        let state = {createdAttempt: null, tabs: {}, samples: [], audit: []};
        try {state = JSON.parse(await fs.readFile(statePath, 'utf8'));} catch (e) {if (e.code !== 'ENOENT') throw Error('State unreadable; preserve it for recovery.');}
        if (!state.tabs || !Array.isArray(state.samples) || !Array.isArray(state.audit)) throw Error('Invalid saved state; no browser operation performed.');
        return await action(state, save);
      } finally {await lease.close(); await fs.unlink(lockPath);}
    }
  };
}

export function createBossMemoryStore() {
  let busy = false, state = {createdAttempt: null, tabs: {}, samples: [], audit: []};
  return {async run(action) {
    if (busy) return result('busy');
    busy = true;
    try {return await action(state, async next => {state = next;});} finally {busy = false;}
  }};
}

export function diagnoseBossEvidence({samples = [], audit = [], reports = [], events = [], tabs = {}} = {}) {
  const changes = samples.slice(1).filter((s, i) => s.tabId === samples[i].tabId && s.url !== samples[i].url);
  const reloads = events.filter(e => e.kind === 'document_navigation' && e.sameDocument !== true);
  const security = samples.some(s => s.securityMarker || s.pageKind === 'security_check');
  const unexpected = samples.some(s => s.url && !bossUrl(s.url));
  const reported = [...reports, ...Object.values(tabs).flatMap(t => t.reports ?? [])]
    .some(r => r.kind === 'flicker' || r.kind === 'back_navigation');
  const operations = audit.reduce((acc, op) => {acc[op.operation] = (acc[op.operation] ?? 0) + 1; return acc;}, {});
  return {status: security ? 'security_check_seen' : reported ? 'user_reported_instability' : unexpected ? 'unexpected_navigation_seen' :
    reloads.length > 1 ? 'repeated_document_navigation_observed' : 'cause_unresolved',
    sampleCount: samples.length, urlChanges: changes.map(s => ({at: s.at, tabId: s.tabId, url: safeUrl(s.url)})),
    documentNavigationEvents: reloads.length, operations,
    observationWindow: samples.length > 1 ? {from: samples[0].at, to: samples.at(-1).at} : null,
    stableAccess: 'not_verified',
    limitations: ['Metadata cannot detect same-URL reloads or visual flicker.',
      'A successful snapshot does not establish stable access or verified login.',
      'Stopping module operations does not detach an already attached debugger.',
      'Uninstrumented user actions and tool-internal operations are outside this audit.'],
    next: security || reported || unexpected ? 'Preserve the page; stop automatic reads/navigation. Use normal manual browser or saved visible content.' :
      'Use a bounded read only when needed; correlate independent observed navigation/user reports before assigning cause.'};
}

/** options.store can be a shared file store. Default file scope must be explicit.
 * No background sampler, auto-recovery loop, screenshots or console reads.
 */
export function createBossAccess(browser, options = {}) {
  if (!browser?.tabs?.list || !browser.tabs.get || !browser.tabs.new) throw Error('Pass the documented browser from cua_repl.');
  const store = options.store ?? createBossFileStore({directory: options.stateDirectory, browserKey: options.browserKey});
  const handles = new Map();
  const audit = (s, operation, tabId) => {
    s.audit.push({at: now(), operation, ...(tabId ? {tabId: String(tabId)} : {})});
    s.audit = s.audit.slice(-200);
  };
  const inventory = async s => {audit(s, 'list'); return await browser.tabs.list();};
  const sample = (s, info, pageKind) => {
    const m = metadata(info); s.samples.push({at: now(), ...m, ...(pageKind ? {pageKind} : {})}); s.samples = s.samples.slice(-100);
    return m;
  };
  const pick = (tabs, tabId) => {
    if (tabId !== undefined) {
      const t = tabs.find(t => String(t.id) === String(tabId));
      return t ? {info: t} : {status: 'closed_or_missing'};
    }
    const matches = tabs.filter(t => bossUrl(t.url));
    return matches.length === 1 ? {info: matches[0]} : matches.length ?
      {status: 'multiple_tabs', existingTabs: matches.map(metadata)} : {status: 'not_open'};
  };
  const row = (s, id) => s.tabs[id] ??= {status: 'metadata_only', readAttempt: null, capture: null, reports: []};

  async function prepare({tabId, allowCreate = false, entryUrl = BOSS_ENTRY} = {}) {
    if (!bossUrl(entryUrl) || checkUrl(entryUrl) || new URL(entryUrl).search || new URL(entryUrl).hash) throw Error('Use a BOSS HTTP(S) entry without security, credential or query parameters.');
    return store.run(async (s, save) => {
      const tabs = await inventory(s), chosen = pick(tabs, tabId);
      if (chosen.info) {
        if (!bossUrl(chosen.info.url)) {await save(s); return result('different_site', metadata(chosen.info));}
        const m = sample(s, chosen.info), r = row(s, m.tabId);
        if (m.securityMarker) r.status = 'security_check';
        await save(s);
        return result(stopped.has(r.status) ? r.status : 'reused_metadata', {...m, pageHandleAcquired: false});
      }
      if (chosen.status !== 'not_open' || !allowCreate) {await save(s); return result(chosen.status, {...chosen, entryUrl: safeUrl(entryUrl)});}
      if (s.createdAttempt) {await save(s); return result('prior_creation_unconfirmed', {entryUrl: safeUrl(entryUrl), reason: 'A tab creation was already attempted in this scope. No automatic reopen.'});}
      s.createdAttempt = {at: now(), entryUrl: safeUrl(entryUrl)};
      audit(s, 'new'); await save(s); // Persist before an external action.
      let tab;
      try {tab = await browser.tabs.new();} catch {await save(s); return result('creation_unconfirmed');}
      handles.set(String(tab.id), tab);
      s.createdAttempt.tabId = String(tab.id);
      const r = row(s, String(tab.id)); r.status = 'navigation_unconfirmed';
      audit(s, 'goto', tab.id); await save(s);
      try {await tab.goto(entryUrl); r.status = 'prepared';} catch {r.status = 'navigation_unconfirmed';}
      // Metadata is the cheapest documented observation. Never close/reload on timeout.
      const latest = await inventory(s), info = latest.find(t => String(t.id) === String(tab.id));
      const m = info ? sample(s, info) : {tabId: String(tab.id)};
      if (m.securityMarker) r.status = 'security_check';
      await save(s);
      return result(r.status, {...m, navigationCount: 1, pageHandleAcquired: true});
    });
  }

  async function observe({tabId} = {}) {
    return store.run(async (s, save) => {
      const chosen = pick(await inventory(s), tabId);
      if (!chosen.info) {await save(s); return result(chosen.status, chosen);}
      const m = sample(s, chosen.info), r = row(s, m.tabId);
      if (!bossUrl(chosen.info.url)) r.status = 'unexpected_navigation';
      else if (m.securityMarker) r.status = 'security_check';
      await save(s);
      return result(stopped.has(r.status) ? r.status : 'metadata_observed', {...m, pageHandleAcquired: false,
        diagnosis: diagnoseBossEvidence({samples: s.samples, audit: s.audit, reports: Object.values(s.tabs).flatMap(r => r.reports)})});
    });
  }

  async function read({tabId} = {}) {
    return store.run(async (s, save) => {
      const chosen = pick(await inventory(s), tabId);
      if (!chosen.info) {await save(s); return result(chosen.status, chosen);}
      const m = sample(s, chosen.info), r = row(s, m.tabId);
      if (!bossUrl(chosen.info.url)) {r.status = 'unexpected_navigation'; await save(s); return result(r.status, m);}
      if (m.securityMarker) r.status = 'security_check';
      if (stopped.has(r.status)) {await save(s); return result(r.status, {...m, pageHandleAcquired: false});}
      if (r.readAttempt) {await save(s); return result(r.capture ? 'cached_capture' : 'read_already_attempted', {...m, capture: r.capture, pageHandleAcquired: false});}
      r.readAttempt = now(); await save(s);
      let text;
      try {
        let tab = handles.get(m.tabId);
        if (!tab) {audit(s, 'get', m.tabId); await save(s); tab = await browser.tabs.get(m.tabId); handles.set(m.tabId, tab);}
        audit(s, 'domSnapshot', m.tabId); await save(s);
        text = await tab.playwright.domSnapshot();
      } catch {r.status = 'read_failed'; await save(s); return result('read_failed', {...m, reason: 'One read failed; no automatic second acquisition or retry.'});}
      const pageKind = classify(chosen.info.url, text);
      r.capture = {capturedAt: now(), pageKind, visible: redactText(text).slice(0, 12000), truncated: String(text).length > 12000,
        source: 'documented_browser_dom_snapshot', loginStatus: 'not_verified', stableAccess: 'not_verified'};
      r.status = pageKind === 'security_check' ? 'security_check' : 'captured';
      const latest = await inventory(s), current = latest.find(t => String(t.id) === m.tabId);
      if (current) {
        sample(s, current, pageKind);
        if (!bossUrl(current.url)) r.status = 'unexpected_navigation';
        else if (checkUrl(current.url)) r.status = 'security_check';
      } else r.status = 'closed_or_missing';
      await save(s);
      return result(r.status, {...m, capture: r.capture, pageHandleAcquired: true});
    });
  }

  async function reportInstability({tabId, kind = 'flicker', source = 'user', note = ''}) {
    if (!['flicker', 'back_navigation'].includes(kind) || !tabId) throw Error('Explicit tabId and flicker/back_navigation required.');
    return store.run(async (s, save) => {
      const r = row(s, String(tabId)); r.status = 'reported_flicker';
      r.reports.push({at: now(), kind, source: redactText(source).slice(0, 100), note: redactText(note).slice(0, 400)});
      r.reports = r.reports.slice(-20); await save(s);
      return result('reported_flicker', {tabId: String(tabId), reason: 'Automatic reads stopped. Existing debugger, if any, has not been detached.'});
    });
  }

  async function diagnostic() {
    return store.run(async s => diagnoseBossEvidence({samples: s.samples, audit: s.audit, reports: Object.values(s.tabs).flatMap(r => r.reports)}));
  }
  return {prepare, observe, read, reportInstability, diagnostic};
}

export function importBossVisibleContent({url, visible, title = '', observedAt, source = 'manual_saved_content'} = {}) {
  if (!bossUrl(url) || typeof visible !== 'string') throw Error('BOSS URL and visible string required; no cookies or authenticated API responses.');
  const clean = redactText(visible), kind = classify(url, clean);
  return result('imported_content', {url: safeUrl(url), title: redactText(title).slice(0, 200),
    capture: {source, capturedAt: observedAt ?? now(), pageKind: kind, visible: clean.slice(0, 12000), truncated: clean.length > 12000},
    boundary: 'Saved visible content only. No live browser access, login or stability claim.'});
}

const help = {module: 'boss-access', commands: ['help', 'diagnose --input <saved-evidence.json>', 'import --input <visible-content.json>', 'import --input <visible.txt> --url <BOSS page URL>'],
  browserEntry: 'createBossAccess(browser, {browserKey, stateDirectory?}) in cua_repl',
  operations: ['prepare (metadata, allowCreate=false)', 'observe (metadata)', 'read (one cached DOM capture per tab)', 'reportInstability', 'diagnostic'],
  scope: 'read-only; no job applications, messages, credentials, automatic reload/back/close, raw CDP or protected installation patching'};
if (typeof process !== 'undefined' && process.argv?.[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = 'help', ...args] = process.argv.slice(2);
  try {
    let output;
    if (['help', '--help', '-h'].includes(command)) output = help;
    else {
      const inputPath = args[args.indexOf('--input') + 1];
      if (!args.includes('--input') || !inputPath) throw Error('Explicit --input file required.');
      const raw = await fs.readFile(inputPath, 'utf8');
      const urlIndex = args.indexOf('--url');
      const input = command === 'import' && urlIndex >= 0 ? {url: args[urlIndex + 1], visible: raw, source: 'manual_saved_text'} : JSON.parse(raw.replace(/^\uFEFF/, ''));
      if (command === 'diagnose') output = diagnoseBossEvidence(input);
      else if (command === 'import') output = importBossVisibleContent(input);
      else throw Error('Unsupported command.');
    }
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } catch (e) {process.stderr.write(redactText(e.message) + '\n'); process.exitCode = 1;}
}

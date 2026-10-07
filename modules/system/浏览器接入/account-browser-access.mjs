import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
// Calls only the browser API passed from cua_repl; this is not a browser backend.
export function createAccountBrowserAccess(browser, sitePolicies = {}) {
  let pending = Promise.resolve();

  function parseUrl(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Use a normal HTTP(S) account page without embedded credentials.');
    }
    return url;
  }

  function policyFor(url) {
    return Object.entries(sitePolicies).find(([host]) =>
      url.hostname === host || url.hostname.endsWith('.' + host)
    )?.[1] ?? {mode: 'standard'};
  }

  function sameOrigin(value, origin) {
    try {return parseUrl(value).origin === origin;} catch {return false;}
  }

  function hasSecurityMarker(value) {
    try {
      const url = parseUrl(value);
      return url.searchParams.has('_security_check') ||
        /\/(?:security-check|zhipin-security)(?:\/|$)/.test(url.pathname) ||
        url.pathname === '/web/passport/zp/verify.html';
    } catch {return false;}
  }

  function record(fields) {
    // Preparing a tab and encountering a check are separate from authentication.
    return {...fields, observedAt: new Date().toISOString(), loginStatus: fields.loginStatus ?? 'not_checked'};
  }

  async function runPrepare(name, entryUrl, options) {
    const requested = parseUrl(entryUrl), policy = policyFor(requested);
    const tabs = await browser.tabs.list();
    const matches = tabs.filter(tab => sameOrigin(tab.url, requested.origin));
    const base = {name, entryUrl: requested.href, mode: policy.mode};
    if (policy.mode === 'manual') {
      return record({...base, status: 'manual_entry', reason: policy.reason,
        existingTabs: matches.map(({id, url, title}) => ({id, url, title}))});
    }

    const exact = matches.filter(tab => tab.url === requested.href);
    const candidates = exact.length ? exact : matches;
    if (candidates.length > 1) {
      return record({...base, status: 'multiple_existing_tabs',
        existingTabs: candidates.map(({id, url, title}) => ({id, url, title}))});
    }
    if (candidates.length === 1) {
      // Do not navigate an existing account tab back to its login URL.
      const existing = candidates[0];
      return record({...base, status: hasSecurityMarker(existing.url) ? 'security_marker_seen' : 'reused',
        tabId: existing.id, url: existing.url, title: existing.title});
    }
    if (options.allowCreate === false) return record({...base, status: 'not_open'});

    const tab = await browser.tabs.new();
    let navigationNote, handoffNote;
    try {await tab.goto(requested.href);} catch (error) {
      navigationNote = String(error).slice(0, 240);
    }
    // A timeout can occur after a page loads; preserve the tab instead of closing
    // it or issuing another navigation. Read only metadata here, without DOM,
    // evaluation, or console commands.
    let actualUrl, title;
    try {actualUrl = await tab.url();} catch {}
    try {title = await tab.title();} catch {}
    if (options.handoff !== false) {
      try {await tab.markHandoff();} catch (error) {handoffNote = String(error).slice(0, 160);}
    }
    return record({...base, status: hasSecurityMarker(actualUrl) ? 'security_marker_seen' :
      navigationNote ? 'navigation_unconfirmed' : 'prepared',
      tabId: tab.id, url: actualUrl, title,
      ...(navigationNote ? {navigationNote} : {}), ...(handoffNote ? {handoffNote} : {})});
  }

  function prepare(name, entryUrl, options = {}) {
    // Preparation requests use fresh inventory and run sequentially.
    const result = pending.then(() => runPrepare(name, entryUrl, options));
    pending = result.catch(() => {});
    return result;
  }

  async function observe(entry, {kind = 'metadata'} = {}) {
    if (!['metadata', 'dom'].includes(kind)) throw new Error('Unsupported observation kind.');
    const requested = parseUrl(entry.entryUrl), policy = policyFor(requested);
    const tabs = await browser.tabs.list();
    const info = tabs.find(tab => tab.id === entry.tabId);
    let currentUrl;
    try {currentUrl = parseUrl(info?.url);} catch {}
    const currentPolicy = currentUrl ? policyFor(currentUrl) : {};
    if (policy.mode === 'manual' || currentPolicy.mode === 'manual') {
      return record({...entry, status: 'manual_entry', reason: currentPolicy.reason ?? policy.reason});
    }
    if (!info) return record({...entry, status: 'closed_or_missing'});
    if (!currentUrl) return record({...entry, status: 'url_unavailable', url: info.url});
    if (hasSecurityMarker(info.url)) {
      return record({...entry, status: 'security_marker_seen', url: info.url, title: info.title});
    }
    if (!sameOrigin(info.url, requested.origin)) {
      // An identity-provider redirect requires a new task scoped to that page.
      return record({...entry, status: 'different_origin', url: info.url, title: info.title});
    }
    const current = record({...entry, url: info.url, title: info.title});
    if (kind === 'metadata') return current;
    try {
      const tab = await browser.tabs.get(info.id);
      const visible = await tab.playwright.domSnapshot();
      const securityText = /当前\s*IP\s*地址.*异常访问行为|环境存在异常/.test(visible);
      return {...current, status: securityText ? 'access_check_seen' : 'observed', visible};
    } catch (error) {
      return {...current, status: 'observation_unavailable', note: String(error).slice(0, 240)};
    }
  }

  return {prepare, observe};
}

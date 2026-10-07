#!/usr/bin/env node
// Read-only GitHub research adapter. No credentials are saved or printed.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
const API = 'https://api.github.com';
const now = () => new Date().toISOString();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const segment = value => encodeURIComponent(value);
const encodePath = value => value.split('/').map(segment).join('/');
const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj?.[k] ?? null]));
function integer(value, fallback, min, max) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Expected integer ${min}..${max}`);
  return n;
}
export function parseRepository(value) {
  const input = String(value || '').replace(/^https:\/\/github\.com\//, '').replace(/\.git\/?$/, '').replace(/\/$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input) || input.split('/').some(x => x === '.' || x === '..')) throw new Error('Repository must be owner/name or its github.com URL');
  const [owner, name] = input.split('/');
  return { owner, name, full_name: input, api: `/repos/${segment(owner)}/${segment(name)}`, url: `https://github.com/${input}` };
}
function sourcePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.split('/').some(x => !x || x === '.' || x === '..')) throw new Error('A relative repository file path is required');
  return value;
}
function safeRef(value) {
  if (typeof value !== 'string' || !value || value.startsWith('-') || /[\s\x00-\x1f~^:?*\[\\]/.test(value) || value.includes('..')) throw new Error('Invalid commit, branch or tag ref');
  return value;
}
function rate(headers) {
  const number = key => headers.has(key) ? Number(headers.get(key)) : null;
  const reset = number('x-ratelimit-reset');
  return { resource: headers.get('x-ratelimit-resource'), limit: number('x-ratelimit-limit'), remaining: number('x-ratelimit-remaining'), used: number('x-ratelimit-used'), reset_at: reset ? new Date(reset * 1000).toISOString() : null, retry_after_seconds: number('retry-after') };
}
export class GitHubReadError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'GitHubReadError'; this.code = code; this.details = details; }
  toJSON() { return { status: this.code, message: this.message, ...this.details }; }
}
function apiError(status, body, details) {
  const message = String(body?.message || `HTTP ${status}`);
  const code = status === 429 || (status === 403 && (details.rate_limit?.remaining === 0 || /rate limit/i.test(message))) ? 'rate_limited' : status === 401 ? 'authentication_failed' : status === 403 ? 'access_restricted' : status === 404 ? 'not_found_or_no_access' : status === 422 ? 'invalid_query_or_scope' : status >= 500 ? 'upstream_failed' : 'request_failed';
  return new GitHubReadError(code, message, { http_status: status, ...details });
}
async function boundedText(response, maximum) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maximum) { await response.body?.cancel(); throw new GitHubReadError('response_too_large', `Response exceeds ${maximum} bytes`); }
  const chunks = []; let bytes = 0;
  for await (const part of response.body || []) {
    bytes += part.length;
    if (bytes > maximum) throw new GitHubReadError('response_too_large', `Response exceeds ${maximum} bytes`);
    chunks.push(Buffer.from(part));
  }
  return Buffer.concat(chunks).toString('utf8');
}
export function unwrapConnector(result) {
  if (result?.isError) throw new GitHubReadError('connector_failed', result.structuredContent?.error || 'Connected GitHub tool failed');
  let data = result?.structuredContent ?? result;
  if (data?.structuredContent && !data.repositories && !data.issues && !data.comments) data = data.structuredContent;
  if (typeof data?.content === 'string') {
    try { return JSON.parse(data.content); } catch { throw new GitHubReadError('unexpected_connector_data', 'Expected original JSON, received text'); }
  }
  return data;
}
// A host supplies callTool(name, args); standalone Node never extracts connector credentials.
export function createGitHubConnector(callTool) {
  if (typeof callTool !== 'function') throw new Error('callTool must be a function');
  return (kind, p) => {
    if (kind === 'repositories') return callTool('mcp__codex_apps__github_search_repositories', { query: p.query, page: p.page, per_page: p.per_page });
    if (kind === 'issues') {
      if (p.page > 1) throw new GitHubReadError('connector_pagination_unavailable', 'Connected issue search does not expose page; use REST for continuation');
      return callTool('mcp__codex_apps__github_search_issues', { query: p.query, topn: p.per_page });
    }
    if (kind === 'code') {
      if (p.page > 1) throw new GitHubReadError('connector_pagination_unavailable', 'Connected code search does not expose page');
      return callTool('mcp__codex_apps__github_search', { query: p.query, ...(p.repo ? { repository_name: p.repo } : {}), topn: p.per_page });
    }
    if (kind === 'repository') return callTool('mcp__codex_apps__github_get_repo', { repository_full_name: p.repo });
    if (kind === 'issue') return callTool('mcp__codex_apps__github_fetch', { url: `${parseRepository(p.repo).url}/issues/${p.number}` });
    if (kind === 'comments') return callTool('mcp__codex_apps__github_fetch_issue_comments', { repo_full_name: p.repo, issue_number: p.number });
    throw new Error(`Unknown connector operation: ${kind}`);
  };
}
function repoSummary(r) {
  return { ...pick(r, ['id','name','description','default_branch','archived','disabled','fork','visibility','language','stargazers_count','forks_count','open_issues_count','created_at','updated_at','pushed_at','size']), full_name: r.full_name || r.repository_full_name, url: r.html_url || r.display_url, license: r.license ? { key: r.license.key, spdx_id: r.license.spdx_id, name: r.license.name } : null, topics: r.topics ?? null };
}
function issueSummary(i) {
  return { ...pick(i, ['id','title','state','state_reason','created_at','updated_at','closed_at','comments','body','author_association']), number: i.number || i.issue_number, url: i.html_url || i.url, author: i.user?.login ?? null, kind: i.pull_request ? 'pull_request' : 'issue', labels: i.labels?.map(x => typeof x === 'string' ? x : x.name) ?? null };
}
function commentSummary(c) {
  return { ...pick(c, ['id','body','created_at','updated_at','author_association']), url: c.html_url || c.url, author: c.user?.login ?? null };
}
function alternatives(kind, p) {
  if (kind === 'repositories') return [{ tool: 'github_search_repositories', arguments: { query: p.query, page: p.page || 1, per_page: p.per_page || 10 } }];
  if (kind === 'issues') return [{ tool: 'github_search_issues', arguments: { query: p.query, topn: p.per_page || 10 } }];
  if (kind === 'issue') return [{ tool: 'github_fetch_issue', arguments: { repository_full_name: p.repo, issue_number: p.number } }, { tool: 'github_fetch_issue_comments', arguments: { repo_full_name: p.repo, issue_number: p.number } }];
  if (kind === 'code') return [{ action: 'locate', repo: p.repo || 'Select a repository first', hint: 'Repository tree path lookup works anonymously; full code search requires authentication.' }];
  return [{ tool: 'github_fetch', arguments: { url: p.url } }];
}

export class GitHubClient {
  constructor(options = {}) {
    this.token = options.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
    this.authSource = options.token ? 'supplied' : process.env.GH_TOKEN ? 'GH_TOKEN' : process.env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : 'anonymous';
    this.fetch = options.fetch ?? globalThis.fetch;
    // connector(kind, parameters) may call the existing host GitHub tools. It is optional.
    this.connector = options.connector;
    this.timeoutMs = integer(options.timeoutMs, 20000, 100, 60000);
    this.maxBytes = integer(options.maxBytes, 8 * 1024 * 1024, 1024, 32 * 1024 * 1024);
    this.apiVersion = options.apiVersion || '2026-03-10';
    this.gate = Promise.resolve(); this.lastSearch = 0; this.rates = new Map(); this.secondaryUntil = 0;
    this.searchIntervalMs = integer(options.searchIntervalMs, this.token ? 2100 : 6100, 0, 60000);
  }
  capabilities() {
    return { status: 'configured', authenticated: Boolean(this.token), auth_source: this.authSource, api_version: this.apiVersion, connector_available: Boolean(this.connector), read_only: true, code_search: this.token ? 'authentication_present_permissions_unverified' : this.connector ? 'connected_default_branch_search_available_local_rest_needs_auth' : 'authentication_required', anonymous_fallbacks: ['repository/issue REST search','pinned public raw files via Git refs','local git tree/source lookup'], rate_limits_seen: Object.fromEntries(this.rates) };
  }
  async request(route, params = {}, { raw = false, publicRaw = false } = {}) {
    const previous = this.gate; let release;
    this.gate = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const url = new URL(route, API);
      const host = publicRaw ? 'raw.githubusercontent.com' : 'api.github.com';
      if (url.protocol !== 'https:' || url.hostname !== host) throw new Error('Only GitHub API or public raw host is accepted');
      for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, String(value));
      const resource = url.pathname.startsWith('/search/code') ? 'code_search' : url.pathname.startsWith('/search/') ? 'search' : 'core';
      const cached = this.rates.get(resource);
      if (!publicRaw && cached?.remaining === 0 && Date.parse(cached.reset_at) > Date.now()) throw new GitHubReadError('rate_limited', 'GitHub quota exhausted; no repeated request made', { rate_limit: cached, url: url.href });
      if (!publicRaw && this.secondaryUntil > Date.now()) throw new GitHubReadError('rate_limited', 'GitHub secondary cooldown active; queued requests stopped', { retry_at: new Date(this.secondaryUntil).toISOString(), url: url.href });
      if (resource === 'search' || resource === 'code_search') {
        await wait(Math.max(0, this.searchIntervalMs - (Date.now() - this.lastSearch))); this.lastSearch = Date.now();
      }
      const headers = { 'User-Agent': 'AI-work-system-github-read/1', Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': this.apiVersion };
      if (this.token && !publicRaw) headers.Authorization = `Bearer ${this.token}`;
      for (let attempt = 0; ; attempt++) {
        let response;
        try { response = await this.fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' }); }
        catch (error) { throw new GitHubReadError(/Timeout|Abort/.test(error.name) ? 'timeout' : 'network_failed', 'GitHub request failed', { url: url.href, cause: error.name }); }
        const limits = rate(response.headers);
        if (limits.resource) this.rates.set(limits.resource, limits);
        const text = await boundedText(response, this.maxBytes);
        let data = text;
        if (!raw && !publicRaw) {
          try { data = JSON.parse(text); } catch { throw new GitHubReadError('unexpected_response', 'GitHub returned non-JSON', { http_status: response.status, url: url.href }); }
        }
        if (response.status >= 500 && attempt === 0) { await wait(500); continue; }
        if (!response.ok) {
          const failure = apiError(response.status, typeof data === 'string' ? { message: `HTTP ${response.status}` } : data, { url: url.href, rate_limit: limits });
          if (failure.code === 'rate_limited' && limits.remaining !== 0) this.secondaryUntil = Date.now() + Math.max(60, limits.retry_after_seconds || 60) * 1000;
          throw failure;
        }
        return { data, url: url.href, http_status: response.status, rate_limit: limits, link: response.headers.get('link'), etag: response.headers.get('etag'), retrieved_at: now(), transport: publicRaw ? 'public_raw' : 'github_rest' };
      }
    } finally { release(); }
  }
  async search(kind, { query, repo, page = 1, per_page = 10, sort, order } = {}) {
    if (!['repositories','issues','code'].includes(kind)) throw new Error('Search kind must be repositories, issues or code');
    if (typeof query !== 'string' || !query.trim()) throw new Error('Search query is required');
    page = integer(page, 1, 1, 1000); per_page = integer(per_page, 10, 1, 100);
    if ((page - 1) * per_page >= 1000) throw new Error('GitHub search exposes at most 1000 results; narrow the query');
    if (repo) repo = parseRepository(repo).full_name;
    const p = { query, repo, page, per_page, sort, order };
    if (kind === 'code' && !this.token && !this.connector) return { status: 'authentication_required', query, kind, items: [], evidence_level: 'none', alternatives: alternatives(kind, p) };
    let response; let failed;
    try {
      if (kind === 'code' && !this.token) throw new GitHubReadError('authentication_required', 'Local REST code search requires authentication; trying existing host connector');
      response = await this.request(`/search/${kind}`, { q: kind === 'code' && repo ? `${query} repo:${repo}` : query, page, per_page, sort, order });
    }
    catch (error) {
      failed = error.toJSON?.() || { message: error.message };
      if (!this.connector) return { ...failed, query, kind, items: [], evidence_level: 'none', alternatives: alternatives(kind, p) };
      try {
        const data = unwrapConnector(await this.connector(kind, p));
        response = { data: { ...data, items: data[kind] || data.items || data.results || [] }, transport: 'connected_github', retrieved_at: now() };
      } catch (error) { return { status: error.code || 'connector_failed', query, kind, items: [], evidence_level: 'none', primary_failure: failed, connector_failure: error.toJSON?.() || { message: error.message } }; }
    }
    const data = response.data;
    if (!Array.isArray(data.items)) throw new GitHubReadError('unexpected_response', 'Search did not contain items');
    const mapped = kind === 'repositories' ? data.items.map(repoSummary) : kind === 'issues' ? data.items.map(issueSummary) : data.items.map(i => {
      const url = i.html_url || i.url;
      const pinned = /\/blob\/([a-f0-9]{40})\//i.exec(url || '')?.[1] ?? null;
      return { name: i.name || i.path?.split('/').at(-1), path: i.path, blob_sha: i.sha ?? null, commit_sha: pinned, url, repository: i.repository?.full_name || repo || null, text_matches: i.text_matches ?? null };
    });
    const total = data.total_count ?? null;
    const next = total == null ? null : page * per_page < Math.min(total, 1000) ? page + 1 : null;
    return { status: data.incomplete_results ? 'partial' : 'ok', kind, query, page, per_page, total_count: total, incomplete_results: data.incomplete_results ?? null, search_ceiling: 1000, next_page: next, pagination_known: total != null, retrieved_at: response.retrieved_at, evidence_level: 'search_results', transport: response.transport, rate_limit: response.rate_limit ?? null, ...(failed ? { primary_failure: failed } : {}), items: mapped };
  }
  async repository(repo, { includeRelease = false } = {}) {
    const r = parseRepository(repo); let response; let failed;
    try { response = await this.request(r.api); }
    catch (error) {
      failed = error.toJSON?.() || { message: error.message };
      // Search has an independent rate resource; it can still supply original metadata.
      const found = await this.search('repositories', { query: `${r.name} in:name user:${r.owner}`, per_page: 10 });
      const exact = found.items?.find(x => x.full_name?.toLowerCase() === r.full_name.toLowerCase());
      if (!exact) return { status: 'unavailable', repository: r.full_name, failure: failed, search_status: found.status, alternatives: alternatives('repository', { url: r.url }) };
      response = { data: exact, transport: 'repository_search_fallback', retrieved_at: found.retrieved_at };
    }
    const summary = repoSummary(response.data);
    // summary input already normalized during search fallback.
    if (response.transport === 'repository_search_fallback') Object.assign(summary, response.data);
    const maintenance = { archived: summary.archived, disabled: summary.disabled, pushed_at: summary.pushed_at, updated_at: summary.updated_at, days_since_push: summary.pushed_at ? Math.floor((Date.now() - Date.parse(summary.pushed_at)) / 86400000) : null, interpretation: 'Push/release dates are observations; they do not establish maturity or suitability.' };
    let release = null; let release_status = 'not_requested';
    if (includeRelease) {
      try { const v = await this.request(`${r.api}/releases/latest`); release = pick(v.data, ['tag_name','name','html_url','published_at','prerelease','draft']); release_status = 'read'; }
      catch (error) { release_status = error.code || 'failed'; }
    }
    return { status: 'ok', repository: summary, maintenance, latest_release: release, release_status, evidence_level: 'repository_metadata', transport: response.transport, retrieved_at: response.retrieved_at, primary_failure: failed ?? null, rate_limit: response.rate_limit ?? null };
  }
  async resolveRef(repo, ref = 'HEAD') {
    const r = parseRepository(repo); safeRef(ref);
    if (/^[a-f0-9]{40}$/i.test(ref)) return { sha: ref, transport: 'provided_commit', verified: false };
    try { const response = await this.request(`${r.api}/commits/${segment(ref)}`); return { sha: response.data.sha, transport: 'github_rest', verified: true }; }
    catch (error) {
      if (error.code === 'authentication_failed') throw error;
      try {
        const refs = ref === 'HEAD' ? ['HEAD'] : [ref.startsWith('refs/') ? ref : `refs/heads/${ref}`, ...(ref.startsWith('refs/') ? [] : [`refs/tags/${ref}`, `refs/tags/${ref}^{}`])];
        const result = await run('git', ['ls-remote', '--', `${r.url}.git`, ...refs], { timeout: this.timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
        const rows = result.stdout.trim().split('\n').map(x => x.trim().split(/\s+/)).filter(x => /^[a-f0-9]{40}$/i.test(x[0]));
        const branch = rows.find(x => x[1] === `refs/heads/${ref}` || x[1] === ref);
        const selected = branch || rows.find(x => x[1]?.endsWith('^{}')) || rows[0];
        if (!selected) throw new Error('Ref not found');
        return { sha: selected[0], transport: 'git_ls_remote', verified: true, primary_failure: error.toJSON?.() ?? null };
      } catch { throw new GitHubReadError('ref_unresolved', 'Could not pin ref using API or git; supply a full commit SHA', { repository: r.full_name, ref }); }
    }
  }
  async file(repo, filePath, { ref = 'HEAD', start_line = 1, max_lines = 200, max_chars = 16000, needle } = {}) {
    const r = parseRepository(repo); sourcePath(filePath);
    start_line = integer(start_line, 1, 1, 10000000); max_lines = integer(max_lines, 200, 1, 10000); max_chars = integer(max_chars, 16000, 1, 1000000);
    const resolved = await this.resolveRef(repo, ref); let response; let failure;
    try { response = await this.request(`${r.api}/contents/${encodePath(filePath)}`, { ref: resolved.sha }, { raw: true }); }
    catch (error) {
      failure = error.toJSON?.();
      if (error.code === 'authentication_failed') throw error;
      response = await this.request(`https://raw.githubusercontent.com/${r.full_name}/${resolved.sha}/${encodePath(filePath)}`, {}, { publicRaw: true });
    }
    const text = response.data;
    if (typeof text !== 'string' || text.includes('\u0000')) throw new GitHubReadError('binary_or_unexpected_content', 'Expected UTF-8 text source');
    const lines = text.split('\n'); const matches = [];
    if (start_line > lines.length) throw new GitHubReadError('invalid_line_range', 'start_line exceeds file length', { total_lines: lines.length, start_line });
    if (needle) for (let index = 0; index < lines.length; index++) if (lines[index].includes(needle)) matches.push(index + 1);
    if (needle && matches.length && start_line === 1) start_line = Math.max(1, matches[0] - 4);
    const chosen = lines.slice(start_line - 1, start_line - 1 + max_lines);
    let content = ''; let returned = 0;
    for (const line of chosen) { const next = `${returned ? '\n' : ''}${line}`; if (content.length + next.length > max_chars) break; content += next; returned++; }
    // A long individual line can be continued with a larger max_chars.
    const charTruncated = returned < chosen.length;
    const end = start_line + returned - 1;
    const url = `${r.url}/blob/${resolved.sha}/${encodePath(filePath)}`;
    return { status: charTruncated ? 'partial' : 'ok', repository: r.full_name, path: filePath, requested_ref: ref, commit_sha: resolved.sha, ref_resolution: resolved, source_url: url, url: returned ? `${url}#L${start_line}${returned > 1 ? `-L${end}` : ''}` : url, evidence_level: 'source_text', transport: response.transport, retrieved_at: response.retrieved_at, rate_limit: response.rate_limit, primary_failure: failure ?? null, total_lines: lines.length, total_chars: text.length, start_line, end_line: returned ? end : null, returned_lines: returned, returned_chars: content.length, truncated: charTruncated || start_line > 1 || end < lines.length, next_start_line: end < lines.length ? end + 1 : null, ...(needle ? { needle, matching_lines: matches } : {}), content };
  }
  async locate(repo, { ref = 'HEAD', path_query = '', limit = 100, local } = {}) {
    const r = parseRepository(repo); limit = integer(limit, 100, 1, 5000);
    let tree; let resolved; let response; let serverTruncated = false;
    if (local) {
      const absolute = path.resolve(local);
      const remote = await run('git', ['-C', absolute, 'remote', 'get-url', 'origin'], { windowsHide: true, timeout: this.timeoutMs });
      if (parseRepository(remote.stdout.trim()).full_name.toLowerCase() !== r.full_name.toLowerCase()) throw new Error('Local origin must match requested GitHub repository');
      const commit = await run('git', ['-C', absolute, 'rev-parse', '--verify', `${safeRef(ref)}^{commit}`], { windowsHide: true, timeout: this.timeoutMs });
      resolved = { sha: commit.stdout.trim(), transport: 'local_git', verified: true };
      const listing = await run('git', ['-C', absolute, 'ls-tree', '-r', '-z', '--full-tree', resolved.sha], { windowsHide: true, timeout: this.timeoutMs, maxBuffer: this.maxBytes });
      tree = listing.stdout.split('\0').filter(Boolean).map(row => { const m = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(row); return m ? { mode: m[1], type: m[2], sha: m[3], path: m[4] } : null; }).filter(Boolean);
      response = { transport: 'local_git', retrieved_at: now() };
    } else {
      resolved = await this.resolveRef(repo, ref);
      try { response = await this.request(`${r.api}/git/trees/${resolved.sha}`, { recursive: '1' }); tree = response.data.tree; serverTruncated = response.data.truncated; }
      catch (error) { return { ...error.toJSON(), repository: r.full_name, commit_sha: resolved.sha, items: [], evidence_level: 'none', alternatives: [{ action: 'locate', option: '--local PATH', hint: 'Use an existing read-only clone; no automatic bulk clone' }] }; }
    }
    if (!Array.isArray(tree)) throw new GitHubReadError('unexpected_response', 'Tree did not contain paths');
    const matched = tree.filter(x => x.type === 'blob' && x.path.toLowerCase().includes(path_query.toLowerCase()));
    return { status: serverTruncated ? 'partial' : 'ok', repository: r.full_name, commit_sha: resolved.sha, path_query, evidence_level: 'repository_tree_paths', transport: response.transport, retrieved_at: response.retrieved_at, server_truncated: Boolean(serverTruncated), total_paths_returned_by_server: tree.length, matched_paths: matched.length, output_truncated: matched.length > limit, items: matched.slice(0, limit).map(x => ({ ...x, url: `${r.url}/blob/${resolved.sha}/${encodePath(x.path)}` })), ...(serverTruncated ? { next: 'Fetch non-recursive subtrees; recursive API exceeded GitHub limits.' } : {}) };
  }
  async issue(repo, number, { comments = true, page = 1, per_page = 100, max_pages = 3 } = {}) {
    const r = parseRepository(repo); number = integer(number, undefined, 1, 100000000); page = integer(page, 1, 1, 1000000); per_page = integer(per_page, 100, 1, 100); max_pages = integer(max_pages, 3, 1, 10);
    let response; let primaryFailure;
    try { response = await this.request(`${r.api}/issues/${number}`); }
    catch (error) {
      primaryFailure = error.toJSON?.();
      if (!this.connector) return { ...primaryFailure, repository: r.full_name, number, evidence_level: 'none', alternatives: alternatives('issue', { repo: r.full_name, number }) };
      response = { data: unwrapConnector(await this.connector('issue', { repo: r.full_name, number })), transport: 'connected_github', retrieved_at: now() };
    }
    const result = { status: 'ok', repository: r.full_name, issue: issueSummary(response.data), evidence_level: 'issue_body', transport: response.transport, retrieved_at: response.retrieved_at, primary_failure: primaryFailure ?? null, comments: [], comments_status: comments ? 'pending' : 'not_requested', comments_complete: false, next_comments_page: null };
    if (!comments) return result;
    try {
      if (response.transport === 'connected_github') {
        const data = unwrapConnector(await this.connector('comments', { repo: r.full_name, number }));
        const rows = data.comments || data;
        if (!Array.isArray(rows)) throw new GitHubReadError('unexpected_connector_data', 'Comments tool did not return a comments array');
        result.comments = rows.map(commentSummary); result.comments_status = 'read';
        result.comments_complete = result.issue.comments != null && rows.length >= result.issue.comments;
        result.comments_pagination = 'connector_all_pages';
      } else {
        for (let i = 0; i < max_pages; i++) {
          const got = await this.request(`${r.api}/issues/${number}/comments`, { page: page + i, per_page });
          if (!Array.isArray(got.data)) throw new GitHubReadError('unexpected_response', 'Comments response must be an array');
          result.comments.push(...got.data.map(commentSummary));
          const more = Boolean(got.link?.includes('rel="next"'));
          result.next_comments_page = more ? page + i + 1 : null;
          if (!more) { result.comments_complete = page === 1; break; }
        }
        result.comments_status = 'read';
      }
    } catch (error) { result.status = 'partial'; result.comments_status = error.code || 'failed'; result.comments_failure = error.toJSON?.() || { message: error.message }; }
    if (result.comments_complete) result.evidence_level = 'issue_body_and_comments';
    else result.status = 'partial';
    result.consistency_note = 'Issue and comments are fetched separately; concurrent edits can change counts. Missing connector dates remain null.';
    return result;
  }
}
export const createGitHubClient = options => new GitHubClient(options);
export const githubSearch = (options, client = new GitHubClient()) => client.search(options.kind || 'repositories', options);
export const githubReadRepository = (options, client = new GitHubClient()) => client.repository(options.repo, options);
export const githubReadFile = (options, client = new GitHubClient()) => client.file(options.repo, options.path, options);
export const githubReadIssue = (options, client = new GitHubClient()) => client.issue(options.repo, options.number, options);
export const githubLocate = (options, client = new GitHubClient()) => client.locate(options.repo, options);

const HELP = `Read-only GitHub research CLI (Node 22+)\n  capabilities\n  search --kind repositories|issues|code --query TEXT [--page 1 --per-page 10]\n  repo --repo OWNER/NAME [--include-release]\n  file --repo OWNER/NAME --path PATH [--ref HEAD --start-line 1 --max-lines 200 --max-chars 16000 --needle TEXT]\n  locate --repo OWNER/NAME [--path-query TEXT --ref HEAD --limit 100 --local CLONE_PATH]\n  issue --repo OWNER/NAME --number N [--no-comments --page 1 --per-page 100 --max-pages 3]\n  issue-snapshot --repo OWNER/NAME --number N --issue-json FILE [--comments-json FILE]\nAll commands: [--out FILE]. Authentication: existing GH_TOKEN or GITHUB_TOKEN. Tokens are never CLI arguments.\nSearch results are leads, not original-source reading. Full code search requires authentication.\n`;
export async function main(argv = process.argv.slice(2)) {
  const [command = 'help', ...args] = argv; const opt = {};
  const flags = new Set(['include-release','no-comments']);
  const allowed = new Set(['kind','query','page','per-page','sort','order','repo','ref','path','start-line','max-lines','max-chars','needle','path-query','limit','local','number','max-pages','issue-json','comments-json','out']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || (!flags.has(key) && !allowed.has(key))) throw new Error(`Unknown option: ${args[i]}`);
    if (flags.has(key)) opt[key.replaceAll('-', '_')] = true;
    else { if (args[i + 1] == null || args[i + 1].startsWith('--')) throw new Error(`Missing option value: ${args[i]}`); opt[key.replaceAll('-', '_')] = args[++i]; }
  }
  if (command === 'help' || command === '--help') { console.log(HELP); return; }
  const client = new GitHubClient(); let result;
  if (command === 'capabilities') result = client.capabilities();
  else if (command === 'search') result = await client.search(opt.kind || 'repositories', opt);
  else if (command === 'repo') result = await client.repository(opt.repo, { includeRelease: opt.include_release });
  else if (command === 'file') result = await client.file(opt.repo, opt.path, opt);
  else if (command === 'locate') result = await client.locate(opt.repo, opt);
  else if (command === 'issue') result = await client.issue(opt.repo, opt.number, { ...opt, comments: !opt.no_comments });
  else if (command === 'issue-snapshot') {
    if (!opt.issue_json) throw new Error('--issue-json is required');
    const read = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    const issue = await read(opt.issue_json); const comments = opt.comments_json ? await read(opt.comments_json) : null;
    const snapshotClient = new GitHubClient({ fetch: async () => { throw new Error('snapshot only'); }, connector: async kind => kind === 'issue' ? issue : comments });
    result = await snapshotClient.issue(opt.repo, opt.number, { comments: Boolean(comments) });
    if (result.issue.number !== Number(opt.number) || !result.issue.url?.startsWith(`${parseRepository(opt.repo).url}/issues/${opt.number}`)) throw new Error('Issue snapshot does not match requested repository/number');
    result.transport = 'saved_connector_snapshot'; result.retrieved_at = null; result.normalized_at = now();
    result.snapshot_files = [path.resolve(opt.issue_json), ...(opt.comments_json ? [path.resolve(opt.comments_json)] : [])];
    result.consistency_note += ' Saved snapshots are not a live re-fetch; original retrieval time must be kept by the caller.';
  } else throw new Error(`Unknown command: ${command}`);
  const output = JSON.stringify(result, null, 2);
  if (opt.out) { const dest = path.resolve(opt.out); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, output + '\n', 'utf8'); }
  console.log(output);
  if (!['ok','partial','configured'].includes(result.status)) process.exitCode = 2;
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(JSON.stringify(error.toJSON?.() || { status: 'error', message: error.message })); process.exitCode = 1; });

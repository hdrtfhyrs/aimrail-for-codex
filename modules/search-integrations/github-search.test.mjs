import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, createGitHubConnector, parseRepository, unwrapConnector } from './github-search.mjs';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const limitHeaders = resource => ({ 'x-ratelimit-resource': resource, 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now()/1000) + 300) });
const repository = 'octokit/plugin-throttling.js';
const commit = 'eb4215edcd97f20ade800b18d964bf798e0d70b7';

test('core quota exhaustion does not disable the independent search quota', async () => {
  const requests = [];
  const client = new GitHubClient({ searchIntervalMs: 0, fetch: async url => {
    requests.push(url.pathname);
    return url.pathname.startsWith('/search/') ? json({ total_count: 1, incomplete_results: false, items: [{ full_name: repository, name: 'plugin-throttling.js', archived: false, pushed_at: '2026-10-01T14:09:46Z' }] }) : json({ message: 'API rate limit exceeded' }, 403, limitHeaders('core'));
  }});
  const got = await client.repository(repository);
  assert.equal(got.status, 'ok'); assert.equal(got.transport, 'repository_search_fallback');
  await assert.rejects(client.request('/repos/octokit/rest.js'), { code: 'rate_limited' });
  assert.equal(requests.length, 2);
});

test('secondary rate limit stops queued API work, rather than only delaying one request', async () => {
  let count = 0;
  const client = new GitHubClient({ searchIntervalMs: 0, fetch: async () => { count++; return json({ message: 'You have exceeded a secondary rate limit.' }, 403, { 'retry-after': '60' }); }});
  const settled = await Promise.allSettled([client.request('/repos/a/b'), client.request('/search/issues', { q: 'failure' })]);
  assert.equal(count, 1); assert.ok(settled.every(x => x.status === 'rejected' && x.reason.code === 'rate_limited'));
});

test('failed API file reads fall back to raw at the same supplied commit; token is not forwarded', async () => {
  const calls = [];
  const client = new GitHubClient({ token: 'test-secret-never-output', fetch: async (url, options) => {
    calls.push({ url: url.href, headers: options.headers });
    return url.hostname === 'api.github.com' ? json({ message: 'API rate limit exceeded' }, 403, limitHeaders('core')) : new Response('first\nsecondary cooldown\nthird\n');
  }});
  const got = await client.file(repository, 'src/index.ts', { ref: commit, max_lines: 2 });
  assert.equal(got.transport, 'public_raw'); assert.equal(got.commit_sha, commit);
  assert.equal(got.next_start_line, 3); assert.equal(got.truncated, true);
  assert.equal(calls[1].headers.Authorization, undefined); assert.ok(!JSON.stringify(got).includes('test-secret'));
  assert.ok(calls[1].url.includes(commit));
});

test('issue comment pagination reports continuation and does not claim full discussion', async () => {
  const client = new GitHubClient({ fetch: async url => url.pathname.endsWith('/comments') ? json([{ id: 1, body: 'first page' }], 200, { link: '<https://api.github.com/next>; rel="next"' }) : json({ number: 629, body: 'issue body', comments: 2, html_url: 'https://github.com/octokit/plugin-throttling.js/issues/629' }) });
  const got = await client.issue(repository, 629, { per_page: 1, max_pages: 1 });
  assert.equal(got.status, 'partial'); assert.equal(got.comments_complete, false); assert.equal(got.next_comments_page, 2);
  assert.equal(got.issue.body, 'issue body');
});

test('connected issue and comments use structuredContent, preserving unknown dates', async () => {
  const client = new GitHubClient({ fetch: async () => { throw Error('offline'); }, connector: async kind => kind === 'issue' ? { structuredContent: { content: JSON.stringify({ number: 629, title: 'queue failure', body: 'full body', comments: 1 }) } } : { structuredContent: { comments: [{ id: 7, body: 'maintainer reply', created_at: null }] } } });
  const got = await client.issue(repository, 629);
  assert.equal(got.evidence_level, 'issue_body_and_comments'); assert.equal(got.comments[0].created_at, null);
});

test('connected code search preserves commit SHA from indexed source links', async () => {
  let call;
  const connector = createGitHubConnector(async (name, args) => { call = { name, args }; return { structuredContent: { results: [{ path: 'src/index.ts', url: `https://github.com/${repository}/blob/${commit}/src/index.ts`, text_matches: [{ fragment: 'secondary' }] }] } }; });
  const client = new GitHubClient({ token: '', connector });
  const got = await client.search('code', { query: 'secondary', repo: repository });
  assert.equal(got.items[0].commit_sha, commit); assert.equal(got.transport, 'connected_github');
  assert.equal(call.args.repository_name, repository); assert.equal(call.args.query, 'secondary');
  assert.equal(got.pagination_known, false);
});

test('connector issue search does not silently repeat page one for page two', async () => {
  const client = new GitHubClient({ searchIntervalMs: 0, fetch: async () => { throw Error('offline'); }, connector: createGitHubConnector(async () => { throw Error('must not call'); }) });
  const got = await client.search('issues', { query: 'repo:octokit/plugin-throttling.js rate', page: 2 });
  assert.equal(got.status, 'connector_pagination_unavailable');
});

test('oversized upstream responses are bounded before parsing or output', async () => {
  const client = new GitHubClient({ maxBytes: 1024, fetch: async () => new Response('x'.repeat(1025)) });
  await assert.rejects(client.request('/repos/a/b'), { code: 'response_too_large' });
});

test('temporary upstream server failure is retried once; access failure is not', async () => {
  let count = 0;
  const client = new GitHubClient({ fetch: async () => ++count === 1 ? json({ message: 'Unavailable' }, 503) : json({ full_name: repository }) });
  assert.equal((await client.request('/repos/octokit/plugin-throttling.js')).data.full_name, repository); assert.equal(count, 2);
  count = 0;
  const denied = new GitHubClient({ fetch: async () => { count++; return json({ message: 'Forbidden' }, 403); } });
  await assert.rejects(denied.request('/repos/a/b'), { code: 'access_restricted' }); assert.equal(count, 1);
});

test('invalid repository/path and false successful connector envelopes are rejected', async () => {
  assert.throws(() => parseRepository('../repo'));
  assert.throws(() => parseRepository('https://evil.example/a/b'));
  assert.throws(() => unwrapConnector({ isError: true, content: [{ text: 'Action completed.' }] }), { code: 'connector_failed' });
  const client = new GitHubClient({ fetch: async () => { throw Error('must not fetch'); } });
  await assert.rejects(client.file(repository, '../secret', { ref: commit }));
});

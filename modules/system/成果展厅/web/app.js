// 成果展厅前端：读取本机成果登记，按“先看成品 → 怎么用怎么学 → 做到哪里”呈现。
const app = document.getElementById('app');
const q = document.getElementById('q');
const KIND = { page: '网页', image: '图片', media: '音视频', pdf: 'PDF', code: '代码', text: '文稿', data: '数据', other: '文件' };
const LANG = { mjs: 'javascript', js: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript', py: 'python', ps1: 'powershell', psm1: 'powershell', sh: 'bash', bat: 'dos', cmd: 'dos', css: 'css', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', json: 'json', jsonl: 'json', md: 'markdown', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', sql: 'sql' };
let items = null;
let project = '';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (u) => { const r = await fetch(u); return r.json(); };
const raw = p => '/raw/' + p.split('/').map(encodeURIComponent).join('/');
const base = p => p.split('/').pop();
const extOf = p => (/\.([^.\/]+)$/.exec(p) || [])[1]?.toLowerCase() || '';
const statusClass = s => /未|待|缺|部分|尚|候选|未登记|观察/.test(s || '') ? 'part' : /已|完成|交付|实测|落地|通过/.test(s || '') ? 'done' : '';
const statusText = s => ({ delivered: '已交付', archived: '存档', verified: '已实测', pending: '待续接' }[s] || s || '未登记');
// 状态只取第一句作标签，完整原文放悬停提示和“做到哪里”。
const statusShort = s => { const t = statusText(s); const f = t.split(/[；;。：:]/)[0]; return f.length > 14 ? f.slice(0, 13) + '…' : f; };
const statusTag = s => `<span class="st ${statusClass(statusText(s))}" title="${esc(statusText(s))}">${esc(statusShort(s))}</span>`;
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n > 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';

function parseHash() {
  const h = location.hash.slice(1) || '/';
  const i = h.indexOf('?');
  const p = decodeURIComponent(i < 0 ? h : h.slice(0, i));
  const qs = i < 0 ? '' : h.slice(i + 1);
  const params = new URLSearchParams(qs || '');
  if (p.startsWith('/d/')) return { view: 'detail', ref: p.slice(3), params };
  if (p.startsWith('/f/')) return { view: 'file', path: p.slice(3), params };
  return { view: 'home', params };
}
window.addEventListener('hashchange', route);
q.addEventListener('input', () => { if (parseHash().view !== 'home') location.hash = '#/'; else renderHome(); });
route();

async function route() {
  const r = parseHash();
  window.scrollTo(0, 0);
  if (r.view === 'detail') return renderDetail(r.ref, r.params);
  if (r.view === 'file') return renderFile(r.path, r.params);
  return renderHome();
}

// ---------- 首页 ----------
async function renderHome() {
  if (!items) items = await api('/api/items');
  const projects = [...new Set(items.map(i => i.project))];
  const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = items.filter(i => (!project || i.project === project) &&
    words.every(w => [i.title, i.summary, i.look, i.project, i.status].join(' ').toLowerCase().includes(w)));
  let html = `<div class="home"><div class="chips">
    <button class="chip ${project ? '' : 'on'}" data-p="">全部 ${items.length}</button>
    ${projects.map(p => `<button class="chip ${p === project ? 'on' : ''}" data-p="${esc(p)}">${esc(p)} ${items.filter(i => i.project === p).length}</button>`).join('')}
  </div>`;
  let day = '';
  for (const i of list) {
    if (i.date !== day) { day = i.date; html += `<div class="day">${esc(day || '未标日期')}</div>`; }
    html += `<a class="card ${i.thumb ? 'has-thumb' : ''}" href="#/d/${encodeURIComponent(i.ref)}"><div>
      <h3>${esc(i.title)}</h3><p class="sum">${esc(i.summary || i.look)}</p>
      <div class="meta">${statusTag(i.status)}${project ? '' : `<span class="dotsep">${esc(i.project)}</span>`}</div></div>
      ${i.thumb ? `<img class="thumb" loading="lazy" src="${raw(i.thumb)}" alt="">` : ''}</a>`;
  }
  if (!list.length) html += `<p class="muted pad">没有匹配的成果。</p>`;
  app.innerHTML = html + '</div>';
  app.querySelectorAll('.chip').forEach(b => b.onclick = () => { project = b.dataset.p; renderHome(); });
}

// ---------- 单个成果 ----------
async function renderDetail(ref, params) {
  app.innerHTML = '<p class="muted pad">正在打开成果……</p>';
  const d = await api('/api/item?ref=' + encodeURIComponent(ref));
  if (d.error) { app.innerHTML = `<p class="pad">${esc(d.error)}：${esc(ref)}</p>`; return; }
  document.title = d.title + ' · 成果展厅';
  const tab = params.get('tab') || 'show';
  const current = params.get('f') || d.firstShow;
  const line = params.get('L');
  const setParams = (o) => {
    const p = new URLSearchParams({ tab, f: current, ...(line ? { L: line } : {}), ...o });
    for (const [k, v] of [...p]) if (!v) p.delete(k);
    location.hash = `#/d/${encodeURIComponent(ref)}?${p}`;
  };
  const hasLearn = d.guide || d.files.concat(d.links).some(f => f.kind === 'code');
  app.innerHTML = `<div class="detail">
    <a class="back" href="#/">← 全部成果</a><span class="crumb">${esc(d.project)}</span>
    <div class="head"><h1>${esc(d.title)}</h1>
      <div class="meta">${statusTag(d.status)}<span class="dotsep">${esc(d.date)}</span></div>
      <p class="sum clamp" title="点击展开">${esc(d.summary)}</p></div>
    <section class="figure" id="fig" hidden></section>
    <div class="tabs">
      <button class="tab ${tab === 'show' ? 'on' : ''}" data-t="show">成品</button>
      <button class="tab ${tab === 'learn' ? 'on' : ''}" data-t="learn">怎么用 · 怎么学${hasLearn ? '' : '（文稿类）'}</button>
      <button class="tab ${tab === 'status' ? 'on' : ''}" data-t="status">做到哪里</button>
    </div>
    <div class="grid"><div id="main"></div><aside class="side" id="side"></aside></div></div>`;
  app.querySelector('.head .sum')?.addEventListener('click', e => e.currentTarget.classList.toggle('clamp'));
  app.querySelectorAll('.tab').forEach(b => b.onclick = () => setParams({ tab: b.dataset.t, L: '' }));
  renderFigure(document.getElementById('fig'), d);
  renderSide(document.getElementById('side'), d, current, (p, L) => setParams({ tab: 'show', f: p, L: L || '' }));
  const main = document.getElementById('main');
  if (tab === 'learn') return renderLearn(main, d, (p, L) => setParams({ tab: 'show', f: p, L: L || '' }));
  if (tab === 'status') return renderStatus(main, d);
  return viewer(main, current, line, (p, L) => setParams({ tab: 'show', f: p, L: L || '' }), current === d.firstShow && current !== d.entry ? '实际成品' : current === d.entry ? '成果说明' : '');
}

function renderSide(el, d, current, open) {
  const order = { page: 0, media: 1, image: 2, text: 3, pdf: 4, code: 5, data: 6, other: 7 };
  const files = [...d.files].sort((a, b) => order[a.kind] - order[b.kind] || a.rel.localeCompare(b.rel, 'zh'));
  const li = (f, label) => `<li><button class="${f.path === current ? 'on' : ''}" data-p="${esc(f.path)}" data-l="${f.line || ''}"><span class="k">${KIND[f.kind] || '文件'}</span><span class="n">${esc(label || f.rel || f.name)}${f.path === d.firstShow ? '<span class="first-tag">先看</span>' : ''}</span></button></li>`;
  const pinned = new Set([d.firstShow, d.entry]);
  const rest = files.filter(f => !pinned.has(f.path));
  const links = d.links.filter(f => !pinned.has(f.path));
  let html = `<section><h4>文件</h4><ul class="flist">
    ${d.firstShow !== d.entry ? li({ path: d.firstShow, kind: kindGuess(d.firstShow) }, base(d.firstShow)) : ''}
    ${li({ path: d.entry, kind: 'text' }, '成果说明')}</ul>
    ${links.length ? `<div class="grp">其他目录里的成品</div><ul class="flist">${links.map(f => li(f, f.name)).join('')}</ul>` : ''}
    ${rest.length ? `<div class="grp">成果目录 · ${rest.length}</div><ul class="flist">${rest.map(f => li(f)).join('')}</ul>` : ''}</section>`;
  el.innerHTML = html;
  el.querySelectorAll('button[data-p]').forEach(b => b.onclick = () => open(b.dataset.p, b.dataset.l));
}
function kindGuess(p) {
  const e = extOf(p);
  if (['html', 'htm'].includes(e)) return 'page';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(e)) return 'image';
  if (['mp4', 'webm', 'mp3', 'wav', 'ogg', 'm4a'].includes(e)) return 'media';
  if (['md', 'txt'].includes(e)) return 'text';
  return LANG[e] ? 'code' : 'other';
}

// ---------- 单个文件 ----------
async function renderFile(p, params) {
  document.title = base(p) + ' · 成果展厅';
  const dir = p.split('/').slice(0, -1).join('/');
  app.innerHTML = `<div class="detail"><a class="back" href="#/">← 全部成果</a>
    <div class="head"><h1>${esc(base(p))}</h1><div class="meta"><span>${esc(dir)}</span></div></div>
    <div class="grid"><div id="main"></div><aside class="side" id="side"></aside></div></div>`;
  const open = (np, L) => { location.hash = `#/f/${encodeURIComponent(np)}${L ? '?L=' + L : ''}`; };
  viewer(document.getElementById('main'), p, params.get('L'), open);
  const info = await api('/api/file?path=' + encodeURIComponent(dir));
  if (info.files) {
    document.getElementById('side').innerHTML = `<section><h4>同目录文件</h4><ul class="flist">${info.files.slice(0, 200).map(f => `<li><button class="${f.path === p ? 'on' : ''}" data-p="${esc(f.path)}"><span class="k">${KIND[f.kind]}</span><span class="n">${esc(f.rel)}</span></button></li>`).join('')}</ul></section>`;
    document.querySelectorAll('#side button[data-p]').forEach(b => b.onclick = () => open(b.dataset.p));
  }
}

async function viewer(el, p, line, open, label = '') {
  const kind = kindGuess(p);
  el.innerHTML = `<div class="viewer"><div class="vbar"><span class="vname" title="${esc(p)}">${label ? `<span class="vlabel">${esc(label)}</span>` : ''}${esc(base(p))}</span>
    <span class="vact"><button class="linkbtn" id="cp">复制路径</button><a href="${raw(p)}" target="_blank">新窗口打开 ↗</a></span></div><div class="vbody" id="vb"></div></div>`;
  el.querySelector('#cp').onclick = async (ev) => {
    try { await navigator.clipboard.writeText(p.replace(/\//g, '\\')); ev.target.textContent = '已复制'; setTimeout(() => ev.target.textContent = '复制路径', 1500); } catch {}
  };
  const vb = el.querySelector('#vb');
  if (kind === 'page') { vb.innerHTML = `<iframe class="page" src="${raw(p)}"></iframe>`; return; }
  if (kind === 'image') { vb.innerHTML = `<div class="imgwrap"><img src="${raw(p)}" alt="${esc(base(p))}"></div>`; return; }
  if (kind === 'media') { vb.innerHTML = `<div class="imgwrap">${/mp3|wav|ogg|m4a/.test(extOf(p)) ? `<audio controls src="${raw(p)}"></audio>` : `<video controls style="max-width:100%" src="${raw(p)}"></video>`}</div>`; return; }
  if (extOf(p) === 'pdf') { vb.innerHTML = `<iframe class="page" src="${raw(p)}"></iframe>`; return; }
  const info = await api('/api/file?path=' + encodeURIComponent(p));
  if (info.error) { vb.innerHTML = `<p class="pad">${esc(info.error)}</p>`; return; }
  if (info.text === undefined) { vb.innerHTML = `<p class="pad muted">这个文件类型无法在页面内显示（${fmtSize(info.size)}），请用“新窗口打开”。</p>`; return; }
  const e = info.ext.slice(1);
  if (e === 'md') { vb.innerHTML = `<article class="prose">${md(info.text)}</article>`; wireLinks(vb, p, open); runMermaid(vb); return; }
  if (e === 'txt' && looksLikeProse(info.text)) { vb.innerHTML = prose(info.text); return; }
  vb.innerHTML = codeView(info.text, e, line);
  scrollToLine(vb);
}

function md(text) {
  if (!window.marked) return `<pre>${esc(text)}</pre><p class="note">离线：Markdown 渲染库未加载，显示原文。</p>`;
  return marked.parse(text, { gfm: true });
}
function looksLikeProse(t) {
  const s = t.slice(0, 5000);
  const cjk = (s.match(/[一-鿿]/g) || []).length;
  const codey = (s.match(/[{}<>=;]|^\s*[-*#|]/gm) || []).length;
  return cjk / Math.max(1, s.length) > 0.35 && codey < s.length / 120;
}
function prose(t) {
  const paras = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const chars = (t.match(/[一-鿿]/g) || []).length;
  return `<article class="prose"><p class="stat">全文 ${chars} 个汉字 · ${paras.length} 段</p>${paras.map(l => `<p>${esc(l)}</p>`).join('')}</article>`;
}

// 本机文件链接在展厅内打开；图片改走只读原文件地址。
function resolveLocal(href, from) {
  if (!href || /^(https?:|mailto:|data:|#|javascript:)/i.test(href)) return null;
  let h = href.replace(/^<|>$/g, '');
  try { h = decodeURI(h); } catch {}
  let L = '';
  const m = /^(.*?\.[A-Za-z0-9]{1,6}):(\d+(?:-\d+)?)$/.exec(h);
  if (m) { h = m[1]; L = m[2]; }
  h = h.replace(/\\/g, '/');
  let abs;
  if (/^[A-Za-z]:\//.test(h)) abs = h;
  else if (/^\/[A-Za-z]:\//.test(h)) abs = h.slice(1);
  else {
    const parts = from.split('/').slice(0, -1);
    for (const seg of h.split('/')) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
    abs = parts.join('/');
  }
  return { path: abs, L };
}
function wireLinks(root, from, open) {
  root.querySelectorAll('a[href]').forEach(a => {
    const r = resolveLocal(a.getAttribute('href'), from);
    if (!r) { a.target = '_blank'; return; }
    a.href = 'javascript:void 0';
    a.title = r.path;
    a.onclick = (ev) => { ev.preventDefault(); open(r.path, r.L); };
  });
  root.querySelectorAll('img[src]').forEach(img => { const r = resolveLocal(img.getAttribute('src'), from); if (r) img.src = raw(r.path); });
}
let mermaidReady;
async function runMermaid(root) {
  const blocks = root.querySelectorAll('code.language-mermaid, .mermaid-src');
  if (!blocks.length) return;
  // 图源先放在 data 属性里，占位期间容器为空；不能用透明字色占位，Mermaid 的 HTML 标签会继承它。
  blocks.forEach(c => { const div = document.createElement('div'); div.className = 'mermaid'; div.dataset.src = c.textContent; (c.closest('pre') || c).replaceWith(div); });
  const nodes = [...root.querySelectorAll('.mermaid[data-src]')];
  try {
    mermaidReady ||= import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs').then(m => {
      const dark = matchMedia('(prefers-color-scheme: dark)').matches;
      m.default.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: dark
        ? { primaryColor: '#22362e', primaryBorderColor: '#8cc4ad', primaryTextColor: '#ebe9e2', lineColor: '#8d8b83', secondaryColor: '#272824', tertiaryColor: '#1d1e1b', textColor: '#ebe9e2', fontSize: '14px' }
        : { primaryColor: '#e6f0eb', primaryBorderColor: '#2f5d50', primaryTextColor: '#1c1c1a', lineColor: '#8a8880', secondaryColor: '#f5f4ef', tertiaryColor: '#ffffff', textColor: '#1c1c1a', fontSize: '14px' } });
      return m.default;
    });
    const mm = await mermaidReady;
    nodes.forEach(n => { n.textContent = n.dataset.src; n.removeAttribute('data-src'); });
    await mm.run({ nodes });
  } catch { nodes.forEach(d => d.outerHTML = `<pre>${esc(d.dataset.src || d.textContent)}</pre>`); }
}

// 代码：先整体高亮，再按行切开（跨行的注释/字符串要在行尾关闭、下一行重开）。
function highlightLines(text, lang) {
  let html;
  try { html = window.hljs && text.length < 400000 && lang ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value : esc(text); }
  catch { html = esc(text); }
  const lines = []; const stack = []; let cur = '';
  for (const tok of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (!tok) continue;
    if (tok === '\n') { lines.push(cur + '</span>'.repeat(stack.length)); cur = stack.join(''); }
    else if (tok.startsWith('<span')) { stack.push(tok); cur += tok; }
    else if (tok === '</span>') { stack.pop(); cur += tok; }
    else cur += tok;
  }
  lines.push(cur);
  return lines;
}
function codeView(text, ext, line, start = 1, end = Infinity) {
  const all = highlightLines(text, LANG[ext]);
  const [a, b] = String(line || '').split('-').map(Number);
  const lo = a || 0, hi = b || a || 0;
  let rows = '';
  for (let i = Math.max(1, start); i <= Math.min(all.length, end); i++)
    rows += `<tr class="${i >= lo && i <= hi ? 'hl' : ''}" ${i === lo ? 'id="hl-start"' : ''}><td class="ln">${i}</td><td class="src hljs">${all[i - 1] || ' '}</td></tr>`;
  return `<div class="code"><table>${rows}</table></div>`;
}
function scrollToLine(root) { const t = root.querySelector('#hl-start'); if (t) setTimeout(() => t.scrollIntoView({ block: 'center' }), 50); }

// ---------- 一图看懂 ----------
// 优先级：展示.json 的总览图 → 目录里的总览/结构/流程图片 → 代码依赖图（自动）→ 文档结构图（自动）。
const figCache = new Map();
async function overviewOf(d) {
  if (figCache.has(d.ref)) return figCache.get(d.ref);
  const g = d.guide && !d.guide._error ? d.guide : null;
  let fig = null;
  if (g?.总览图) {
    fig = /\.(png|jpe?g|webp|gif|svg)$/i.test(g.总览图)
      ? { img: /^[A-Za-z]:[\\/]/.test(g.总览图) ? g.总览图.replace(/\\/g, '/') : d.directory + '/' + g.总览图, label: '总览图' }
      : { mermaid: g.总览图, label: '总览图' };
  }
  if (!fig) {
    const img = d.files.find(f => f.kind === 'image' && /总览|整体|结构|流程|架构/.test(f.name));
    if (img) fig = { img: img.path, label: img.name };
  }
  if (!fig) {
    const code = d.files.concat(d.links).filter(f => f.kind === 'code' || (f.kind === 'page' && d.files.some(x => x.kind === 'code')));
    if (code.length >= 2) { const m = await depGraph(code.slice(0, 25)); if (m) fig = { mermaid: m, label: '代码怎样连接 · 自动生成', auto: true }; }
  }
  if (!fig) {
    const info = await api('/api/file?path=' + encodeURIComponent(d.entry));
    const m = info.text ? headingTree(d.title, info.text) : null;
    if (m) fig = { mermaid: m, label: '内容结构 · 自动生成', auto: true };
  }
  figCache.set(d.ref, fig);
  return fig;
}
async function renderFigure(el, d) {
  const fig = await overviewOf(d);
  if (!fig) return;
  el.hidden = false;
  el.classList.toggle('auto', !!fig.auto);
  el.innerHTML = `<div class="fighead"><span class="figtag">一图看懂</span><span class="figsrc">${esc(fig.label)}</span>${askBtn(d, '这张总览图')}</div>
    ${fig.img ? `<img src="${raw(fig.img)}" alt="总览图">` : `<pre><code class="language-mermaid">${esc(fig.mermaid)}</code></pre>`}`;
  wireAsk(el);
  if (fig.mermaid) runMermaid(el);
}
const lbl = s => String(s).replace(/[*`#\[\]()<>{}|"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 18);
function headingTree(title, text) {
  const hs = []; let fence = false;
  for (const l of text.split(/\r?\n/)) {
    if (/^\s*```/.test(l)) fence = !fence;
    const m = !fence && /^(#{1,3})\s+(.+)/.exec(l);
    if (m) hs.push({ lv: m[1].length, t: lbl(m[2]) });
  }
  const top = hs.filter(h => h.lv === 1).length <= 1 ? 2 : 1;
  const mains = hs.filter(h => h.lv === top);
  if (mains.length < 2) return null;
  let out = `%%{init: {"flowchart": {"nodeSpacing": 14, "rankSpacing": 70}}}%%\nflowchart LR\n  R["${lbl(title)}"]\n`, n = 0, cur = null, kids = 0;
  for (const h of hs) {
    if (n > 36) break;
    if (h.lv === top) { cur = 'n' + (++n); kids = 0; out += `  R --> ${cur}["${h.t}"]\n`; }
    else if (h.lv === top + 1 && cur && kids < 4) { kids++; out += `  ${cur} --> n${++n}["${h.t}"]\n`; }
  }
  return out + '  classDef hub fill:#2f5d50,color:#fff,stroke:none,font-weight:bold\n  class R hub\n';
}
async function depGraph(files) {
  const nodes = files.map((f, i) => ({ id: 'f' + i, path: f.path, name: f.rel || f.name }));
  const byBase = new Map(nodes.map(n => [base(n.path).replace(/\.[^.]+$/, ''), n]));
  const edges = new Set(); const routes = new Map(); const calls = []; const ext = new Map();
  for (const n of nodes) {
    const info = await api('/api/file?path=' + encodeURIComponent(n.path));
    const t = info.text || '';
    for (const m of t.matchAll(/(?:from\s*|import\s*\(\s*|require\s*\(\s*|<script[^>]*src=|<link[^>]*href=)['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      const local = byBase.get(base(spec).replace(/\.[^.]+$/, ''));
      if ((spec.startsWith('.') || !spec.includes(':')) && local && local !== n) edges.add(`${n.id} --> ${local.id}`);
      else if (!spec.startsWith('.') && !spec.startsWith('http')) { const k = spec.replace(/^node:/, '').split('/')[0]; ext.set(k, (ext.get(k) || new Set()).add(n.id)); }
    }
    for (const m of t.matchAll(/^\s*(?:from\s+\.?(\w+)\s+import|import\s+(\w+))/gm)) { const local = byBase.get(m[1] || m[2]); if (local && local !== n) edges.add(`${n.id} --> ${local.id}`); }
    for (const line of t.split('\n')) {
      for (const m of line.matchAll(/['"`](\/api\/[\w\-/]*)/g)) {
        if (/pathname|app\.(get|post)|route|@app/.test(line)) routes.set(m[1], n.id); else calls.push([n.id, m[1]]);
      }
    }
  }
  let out = 'flowchart LR\n' + nodes.map(n => `  ${n.id}["${lbl(n.name)}"]`).join('\n') + '\n' + [...edges].map(e => '  ' + e).join('\n') + '\n';
  const seen = new Set();
  calls.forEach(([from, r]) => { const to = routes.get(r); if (to && to !== from && !seen.has(r)) { seen.add(r); out += `  ${from} -- "${r}" --> ${to}\n`; } });
  [...ext.entries()].slice(0, 6).forEach(([k, users], i) => { out += `  x${i}(["${lbl(k)}"])\n`; users.forEach(u => out += `  ${u} -.-> x${i}\n`); });
  return edges.size || seen.size ? out : null;
}

// “就这里提问”：把成果与位置复制下来，粘贴到任意对话里接着问。
function askBtn(d, where) { return `<button class="ask" data-q="${esc(`关于成果「${d.title}」（${d.ref}）的${where}：`)}">就这里提问</button>`; }
function wireAsk(root) {
  root.querySelectorAll('.ask').forEach(b => b.onclick = async (ev) => {
    ev.stopPropagation();
    try { await navigator.clipboard.writeText(b.dataset.q); b.textContent = '已复制，去对话里粘贴提问'; }
    catch { b.textContent = '复制失败：' + b.dataset.q; }
    setTimeout(() => b.textContent = '就这里提问', 2500);
  });
}

// ---------- 怎么用 · 怎么学 ----------
async function renderLearn(el, d, open) {
  const g = d.guide;
  const box = document.createElement('div');
  box.className = 'viewer learn';
  el.appendChild(box);
  if (g && !g._error) {
    // 图在前、字在后：每块先给图或一行结论，详细文字折叠，问到再展开。
    let html = '';
    if (g.一句话) html += `<p class="lead">${inline(g.一句话)}</p>`;
    const imgs = (g.截图 || []).map(s => /^[A-Za-z]:[\\/]/.test(s) ? s.replace(/\\/g, '/') : d.directory + '/' + s);
    if (imgs.length) html += `<div class="shots">${imgs.map(s => `<img src="${raw(s)}" alt="">`).join('')}</div>`;
    if (g.流程图) html += `<h2>怎样运转 ${askBtn(d, '运转流程图')}</h2><pre><code class="language-mermaid">${esc(g.流程图)}</code></pre>`;
    if (g.怎么用?.length) html += `<h2>怎么用 ${askBtn(d, '用法')}</h2><ol class="steps">${g.怎么用.map(s => `<li>${inline(s)}</li>`).join('')}</ol>`;
    if (g.技术?.length) html += `<h2>用了哪些技术 ${askBtn(d, '技术选择')}</h2><div class="techs">${g.技术.map(t => `<details class="tech"><summary>${esc(t.名称)}</summary>${inline(t.为什么 || t.作用 || '')}</details>`).join('')}</div>`;
    if (g.学习路径?.length) html += `<h2>沿一个真实功能读源码</h2><div id="path"></div>`;
    if (g.动手试试?.length) html += `<h2>动手试试</h2>${g.动手试试.map(t => `<details class="try"><summary>${inline(t.改哪里)}</summary><dl><dt>怎么改</dt><dd>${inline(t.怎么改)}</dd><dt>预期看到</dt><dd>${inline(t.预期)}</dd>${t.恢复 ? `<dt>改坏了怎么恢复</dt><dd>${inline(t.恢复)}</dd>` : ''}</dl></details>`).join('')}`;
    if (g.踩过的坑?.length) html += `<details class="more"><summary>实际踩过的坑（${g.踩过的坑.length}）</summary><ul>${g.踩过的坑.map(s => `<li>${inline(s)}</li>`).join('')}</ul></details>`;
    box.innerHTML = html || '<p class="muted">展示.json 里还没有内容。</p>';
    wireAsk(box);
    runMermaid(box);
    const holder = box.querySelector('#path');
    if (holder) for (const step of g.学习路径) {
      const file = /^[A-Za-z]:[\\/]/.test(step.文件 || '') ? step.文件.replace(/\\/g, '/') : d.directory + '/' + (step.文件 || '');
      const card = document.createElement('div');
      card.className = 'stepcard';
      holder.appendChild(card);
      api('/api/file?path=' + encodeURIComponent(file)).then(info => {
        // 优先按函数名现找行号：代码改了，学习路径仍指向同一段；找不到才用写死的“行”。
        const range = (info.text && step.函数 && fnRange(info.text, [].concat(step.函数))) || step.行 || '';
        const where = `${base(file)}${range ? ' 第' + range + '行' : ''}`;
        card.innerHTML = `<div class="sh"><b>${esc(step.标题 || base(file))}</b>${step.说明 ? `<details><summary class="muted">为什么这样写</summary>${inline(step.说明)}</details>` : ''}<div class="meta" style="margin-top:6px"><button class="linkbtn open">${esc(where)} · 打开完整文件</button>${askBtn(d, `${where}（${step.标题 || ''}）`)}</div></div><div class="snip"></div>`;
        card.querySelector('.open').onclick = () => open(file, range);
        wireAsk(card);
        if (info.text === undefined) { card.querySelector('.snip').innerHTML = `<p class="pad muted">${esc(info.error || '无法显示')}</p>`; return; }
        const [a, b] = String(range).split('-').map(Number);
        card.querySelector('.snip').innerHTML = a ? codeView(info.text, info.ext.slice(1), '', a, b || a + 30) : codeView(info.text, info.ext.slice(1), '', 1, 40);
      });
    }
    return;
  }
  // 没有展示.json：自动列出源码与函数目录，至少能从成品跳到代码。
  const code = d.files.concat(d.links).filter(f => f.kind === 'code');
  if (!code.length) {
    box.innerHTML = `<h2>这份成果是文稿/研究类</h2><p>直接阅读“成品”页即可；需要拍板或使用的内容见“做到哪里”。</p>${g?._error ? `<p class="note">展示.json 解析失败：${esc(g._error)}</p>` : ''}`;
    return;
  }
  box.innerHTML = `<p class="note">这份成果还没写学习路径（成果目录里的 展示.json），下面是自动生成的源码目录：点函数名直接跳到对应行。</p><div id="auto"></div>`;
  const holder = box.querySelector('#auto');
  for (const f of code.slice(0, 30)) {
    const info = await api('/api/file?path=' + encodeURIComponent(f.path));
    if (info.text === undefined) continue;
    const outline = outlineOf(info.text, info.ext.slice(1));
    const sec = document.createElement('section');
    sec.innerHTML = `<h2 style="font-size:15px"><button class="linkbtn" data-l="">${esc(f.rel || f.name)}</button> <span class="muted" style="font-size:12px;font-weight:400">${info.text.split('\n').length} 行</span></h2>
      ${outline.length ? `<details><summary class="muted">${outline.length} 个函数/类，点开看目录</summary><ul>${outline.map(o => `<li><button class="linkbtn" data-l="${o.line}">${esc(o.name)}</button> <span class="muted">第${o.line}行${o.note ? ' · ' + esc(o.note) : ''}</span></li>`).join('')}</ul></details>` : '<p class="muted">未识别出函数。</p>'}`;
    sec.querySelectorAll('button').forEach(b => b.onclick = () => open(f.path, b.dataset.l));
    holder.appendChild(sec);
  }
}
// 按函数名找出源码中的行范围：从声明（含紧贴的上方注释）到下一个顶层声明之前。
function fnRange(text, names) {
  const lines = text.split('\n');
  const isTop = l => /^(export\s+)?(async\s+)?function\b|^(export\s+)?(const|let|class)\s+\w+|^\s*(async\s+)?def\s|^class\s|^\/\/ -{3,}/.test(l);
  let lo = Infinity, hi = 0;
  for (const name of names) {
    const re = new RegExp(`^(export\\s+)?(async\\s+)?(function\\s*\\*?\\s*${name}\\b|(const|let)\\s+${name}\\s*=|class\\s+${name}\\b|def\\s+${name}\\b)`);
    const start = lines.findIndex(l => re.test(l));
    if (start < 0) continue;
    let s = start; while (s > 0 && /^\s*(\/\/|#)/.test(lines[s - 1])) s--;
    let e = start + 1; while (e < lines.length && !isTop(lines[e])) e++;
    while (e > start + 1 && !lines[e - 1].trim()) e--;
    lo = Math.min(lo, s + 1); hi = Math.max(hi, e);
  }
  return hi ? `${lo}-${hi}` : '';
}
function outlineOf(text, ext) {
  const res = []; const lines = text.split('\n');
  const pats = ext === 'py' ? [/^\s*(?:async\s+)?def\s+(\w+)/, /^\s*class\s+(\w+)/]
    : /ps1|psm1/.test(ext) ? [/^\s*function\s+([\w-]+)/i]
    : [/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/, /^\s*(?:export\s+)?class\s+(\w+)/, /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/];
  lines.forEach((l, i) => {
    for (const p of pats) { const m = p.exec(l); if (m) { const prev = (lines[i - 1] || '').trim(); res.push({ name: m[1], line: i + 1, note: /^(\/\/|#)/.test(prev) ? prev.replace(/^(\/\/|#)\s*/, '').slice(0, 60) : '' }); break; } }
  });
  return res.slice(0, 80);
}
const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

// ---------- 做到哪里 ----------
function renderStatus(el, d) {
  el.innerHTML = `<div class="statusgrid">
    <section class="sbox"><h4>状态</h4><p class="big">${statusTag(d.status)}</p><p>${esc(statusText(d.status))}</p></section>
    <section class="sbox"><h4>实际验证到哪 · 还缺什么</h4><p>${esc(d.boundary || '未登记')}</p></section>
    <section class="sbox"><h4>接下来</h4><p>${esc(d.next || '未登记')}</p></section>
  </div>
  <details class="more sref"><summary>编号、目录与依据</summary><dl>
    <dt>成果编号</dt><dd><code>${esc(d.ref)}</code></dd>
    <dt>成果目录</dt><dd><code>${esc(d.directory)}</code></dd>
    ${d.evidence?.length ? `<dt>依据</dt><dd><ul>${d.evidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul></dd>` : ''}
  </dl></details>`;
}

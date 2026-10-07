#!/usr/bin/env node
import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
// 成果展厅：把各项目已登记的成果直接呈现给用户（正文全文、网页实机、图片、源码与学习路径）。
// 只读、仅监听 127.0.0.1；数据来自 Documents/项目/*/成果/成果登记.json，不另建成果数据库。
import http from 'node:http';
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const PROJECTS_DIR = _publicPath("$projects");
const STATE_PATH = _publicDataPath("成果展厅/showcase-state.json");
const PREFERRED_PORT = 47830;
const IDLE_MS = 8 * 3600 * 1000;

// 可读范围：用户文档与AI系统自身代码/技能；会话原文与凭据类文件不开放。
const ALLOW_ROOTS = [
  _publicPath("$projects"),
  _publicPath("$system"),
  _publicPath("$codex/context"),
  _publicPath("$plugins"),
  path.join(HOME, '.codex', 'prompts'),
  path.join(HOME, '.codex', 'skills'),
  path.join(HOME, '.agents'),
].map(p => norm(p));
const DENY_NAME = /(^\.env|auth\.json$|token|secret|credential|cookie|password|\.pem$|\.key$|id_rsa)/i;
const DENY_DIR = /[\\/](node_modules|\.git|sessions|__pycache__)([\\/]|$)/i;

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.jsonl', '.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.ps1', '.psm1', '.sh', '.bat', '.cmd', '.css', '.html', '.htm', '.yaml', '.yml', '.toml', '.ini', '.csv', '.tsv', '.xml', '.svg', '.sql', '.log', '.mermaid', '.mmd']);
const CODE_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.ps1', '.psm1', '.sh', '.bat', '.cmd', '.css', '.sql']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);
const MEDIA_EXT = new Set(['.mp4', '.webm', '.mp3', '.wav', '.ogg', '.m4a']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

function norm(p) { return path.resolve(String(p)).replace(/\\/g, '/'); }
function allowed(p) {
  const n = norm(p);
  const low = n.toLowerCase();
  if (DENY_DIR.test(n) || DENY_NAME.test(path.basename(n))) return false;
  return ALLOW_ROOTS.some(r => low === r.toLowerCase() || low.startsWith(r.toLowerCase() + '/'));
}
const out = v => console.log(JSON.stringify(v, null, 2));
const opt = (args, key) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };

// ---------- 成果数据 ----------
async function projects() {
  const names = await readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []);
  const list = [];
  for (const d of names) {
    if (!d.isDirectory()) continue;
    const reg = path.join(PROJECTS_DIR, d.name, '成果', '成果登记.json');
    if (existsSync(reg)) list.push({ name: d.name, root: norm(path.join(PROJECTS_DIR, d.name)), registry: norm(reg) });
  }
  return list;
}

const previewCache = new Map();
async function firstLook(file) {
  try {
    const s = await stat(file);
    const key = file + ':' + s.mtimeMs;
    if (previewCache.has(key)) return previewCache.get(key);
    const raw = (await readFile(file, 'utf8')).slice(0, 6000);
    const ext = path.extname(file).toLowerCase();
    let text = raw;
    if (ext === '.html' || ext === '.htm') text = raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
    text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '').split(/\r?\n/).map(l => l.trim())
      .filter(l => l && !/^(#|<!--|---|\||```|>?\s*$)/.test(l) && !/^[-*]\s*$/.test(l))
      .join(' ').replace(/\*\*|`|\[|\]\([^)]*\)|\]\(<[^>]*>\)/g, '').replace(/\s+/g, ' ').slice(0, 160);
    const v = { text, mtime: s.mtimeMs };
    previewCache.set(key, v);
    return v;
  } catch { return { text: '', mtime: 0 }; }
}

async function walk(dir, depth = 0, acc = [], limit = 400) {
  if (depth > 3 || acc.length >= limit) return acc;
  const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (!allowed(full)) continue;
    if (it.isDirectory()) await walk(full, depth + 1, acc, limit);
    else if (acc.length < limit) {
      const s = await stat(full).catch(() => null);
      if (s) acc.push({ path: norm(full), name: it.name, rel: norm(full).slice(norm(dir).length + 1), size: s.size, mtime: s.mtimeMs, kind: kindOf(full) });
    }
  }
  return acc;
}
function kindOf(p) {
  const e = path.extname(p).toLowerCase();
  if (e === '.html' || e === '.htm') return 'page';
  if (IMAGE_EXT.has(e)) return 'image';
  if (MEDIA_EXT.has(e)) return 'media';
  if (e === '.pdf') return 'pdf';
  if (CODE_EXT.has(e)) return 'code';
  if (e === '.md' || e === '.txt') return 'text';
  if (TEXT_EXT.has(e)) return 'data';
  return 'other';
}

// 首页缩略图：成果目录顶层的实际截图/总览图（图片优先展示）。
const thumbCache = new Map();
async function thumbOf(dir) {
  const s = await stat(dir).catch(() => null);
  if (!s || !s.isDirectory()) return '';
  const key = dir + ':' + s.mtimeMs;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const names = (await readdir(dir).catch(() => [])).filter(n => /\.(png|jpe?g|webp|gif|svg)$/i.test(n));
  names.sort((a, b) => (/总览|整体|结构|流程|实图|截图|预览|效果/.test(b) ? 1 : 0) - (/总览|整体|结构|流程|实图|截图|预览|效果/.test(a) ? 1 : 0));
  let pick = names[0] ? norm(path.join(dir, names[0])) : '';
  if (!pick && existsSync(path.join(dir, '展示.json'))) {
    try { const g = JSON.parse(await readFile(path.join(dir, '展示.json'), 'utf8')); if (g.总览图 && /\.(png|jpe?g|webp|gif|svg)$/i.test(g.总览图)) pick = norm(path.isAbsolute(g.总览图) ? g.总览图 : path.join(dir, g.总览图)); } catch {}
  }
  thumbCache.set(key, pick);
  return pick;
}

async function allItems() {
  const result = [];
  for (const p of await projects()) {
    let reg;
    try { reg = JSON.parse(await readFile(p.registry, 'utf8')); } catch { continue; }
    for (const e of reg.entries || []) {
      const entryPath = norm(path.join(p.root, '成果', e.entry));
      const look = await firstLook(entryPath);
      const dateMatch = /^(\d{4}-\d{2}-\d{2})/.exec(e.directory || '');
      const dir = norm(path.join(p.root, '成果', e.directory || path.dirname(e.entry)));
      result.push({
        ref: e.ref, project: p.name, title: e.title, summary: e.summary, status: e.status,
        boundary: e.boundary, next: e.next, entry: entryPath, directory: dir,
        date: dateMatch ? dateMatch[1] : (look.mtime ? new Date(look.mtime).toISOString().slice(0, 10) : ''),
        mtime: look.mtime, look: look.text, evidence: e.evidence || [], thumb: await thumbOf(dir),
      });
    }
  }
  result.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.mtime - a.mtime);
  return result;
}

// 从成果正文里找出指向本机文件的链接（真正的成品常在别的目录）。
function localLinks(text, baseDir) {
  const found = new Map();
  const add = (raw) => {
    let p = raw.trim().replace(/^<|>$/g, '');
    if (/^(https?:|mailto:|#|data:)/i.test(p)) return;
    try { p = decodeURI(p); } catch {}
    let line;
    const m = /^(.*?\.[A-Za-z0-9]{1,6}):(\d+)(?:-\d+)?$/.exec(p);
    if (m) { p = m[1]; line = Number(m[2]); }
    const abs = /^[A-Za-z]:[\\/]/.test(p) ? norm(p) : norm(path.join(baseDir, p));
    if (!existsSync(abs) || !allowed(abs)) return;
    if (!found.has(abs)) found.set(abs, { path: abs, name: path.basename(abs), kind: kindOf(abs), line });
  };
  for (const m of text.matchAll(/\]\(\s*(<[^>]+>|[^)\s]+)/g)) add(m[1]);
  for (const m of text.matchAll(/`([A-Za-z]:[\\/][^`\n]+?\.[A-Za-z0-9]{1,6})`/g)) add(m[1]);
  return [...found.values()];
}

async function itemDetail(ref) {
  const items = await allItems();
  const item = items.find(i => i.ref === ref);
  if (!item) return null;
  const files = existsSync(item.directory) && (await stat(item.directory)).isDirectory() ? await walk(item.directory) : [];
  let entryText = '';
  try { entryText = await readFile(item.entry, 'utf8'); } catch {}
  const links = localLinks(entryText, path.dirname(item.entry)).filter(l => !files.some(f => f.path === l.path) && l.path !== item.entry);
  let guide = null;
  const guidePath = path.join(item.directory, '展示.json');
  if (existsSync(guidePath)) { try { guide = JSON.parse(await readFile(guidePath, 'utf8')); guide._path = norm(guidePath); } catch (e) { guide = { _error: String(e.message) }; } }
  return { ...item, files, links, guide, firstShow: pickFirst(item, files, links, guide) };
}

// “先看”：用户最该先看到的实际成品。显式指定优先，其次网页/正文/图片，最后才是说明文。
function pickFirst(item, files, links, guide) {
  if (guide?.先看) {
    const p = /^[A-Za-z]:[\\/]/.test(guide.先看) ? norm(guide.先看) : norm(path.join(item.directory, guide.先看));
    if (existsSync(p) && allowed(p)) return p;
  }
  const pool = [...links, ...files];
  const score = f => {
    const n = f.name;
    if (f.kind === 'page') return 50;
    if (f.kind === 'text' && /正文|原稿|全文|章|成稿/.test(n)) return 45;
    if (f.kind === 'image' && /预览|截图|效果|画面/.test(n)) return 40;
    if (f.kind === 'media') return 35;
    return 0;
  };
  const best = pool.map(f => [score(f), f]).filter(x => x[0] > 0).sort((a, b) => b[0] - a[0])[0];
  return best ? best[1].path : item.entry;
}

async function fileInfo(p) {
  const abs = norm(p);
  if (!allowed(abs)) return { error: '该路径不在展厅可读范围内', path: abs };
  const s = await stat(abs).catch(() => null);
  if (!s) return { error: '文件不存在', path: abs };
  if (s.isDirectory()) return { path: abs, dir: true, files: await walk(abs, 2) };
  const ext = path.extname(abs).toLowerCase();
  const info = { path: abs, name: path.basename(abs), ext, size: s.size, mtime: s.mtimeMs, kind: kindOf(abs) };
  if (TEXT_EXT.has(ext) && s.size <= 4 * 1024 * 1024) info.text = await readFile(abs, 'utf8');
  else if (TEXT_EXT.has(ext)) info.text = (await readFile(abs, 'utf8')).slice(0, 4 * 1024 * 1024) + '\n\n……（文件超过4MB，仅显示前段；完整文件见原路径）';
  if (info.text !== undefined) info.links = localLinks(info.text, path.dirname(abs));
  return info;
}

// ---------- 服务 ----------
async function serve(port) {
  let last = Date.now();
  const web = path.join(HERE, 'web');
  const server = http.createServer(async (req, res) => {
    last = Date.now();
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) { res.writeHead(403); res.end('Forbidden'); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end('只读展厅'); return; }
    const url = new URL(req.url, 'http://x');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const json = (v, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(v)); };
    try {
      if (url.pathname === '/health') return json({ app: 'showcase', pid: process.pid });
      if (url.pathname === '/api/items') return json(await allItems());
      if (url.pathname === '/api/item') { const d = await itemDetail(url.searchParams.get('ref')); return d ? json(d) : json({ error: '没有这个成果编号' }, 404); }
      if (url.pathname === '/api/file') return json(await fileInfo(url.searchParams.get('path') || ''));
      if (url.pathname.startsWith('/raw/')) {
        // 路径式地址：网页成品里的相对资源（css/js/图片）能自然解析到同目录。
        const abs = norm(decodeURIComponent(url.pathname.slice(5)));
        if (!allowed(abs)) { res.writeHead(403); res.end('不在可读范围'); return; }
        const s = await stat(abs).catch(() => null);
        if (!s || !s.isFile()) { res.writeHead(404); res.end('文件不存在'); return; }
        const ext = path.extname(abs).toLowerCase();
        const type = MIME[ext] || (TEXT_EXT.has(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
        // 成品网页由这个响应头放进无同源权限的沙箱（不用 iframe 的 sandbox 属性：部分内嵌浏览器会直接拦截），读不到展厅接口。
        if (ext === '.html' || ext === '.htm') res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-popups allow-forms allow-modals');
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': s.size });
        if (req.method === 'HEAD') { res.end(); return; }
        res.end(await readFile(abs));
        return;
      }
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.join(web, name);
      if (!norm(file).startsWith(norm(web) + '/') || !existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain; charset=utf-8' });
      res.end(await readFile(file));
    } catch (e) { json({ error: String(e.message) }, 500); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actual = server.address().port;
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify({ port: actual, pid: process.pid, url: `http://127.0.0.1:${actual}/`, started: new Date().toISOString() }, null, 2));
  setInterval(() => { if (Date.now() - last > IDLE_MS) process.exit(0); }, 60000).unref();
  return actual;
}

async function running() {
  try {
    const st = JSON.parse(await readFile(STATE_PATH, 'utf8'));
    const r = await fetch(`http://127.0.0.1:${st.port}/health`, { signal: AbortSignal.timeout(1200) });
    const b = await r.json();
    return b.app === 'showcase' ? st : null;
  } catch { return null; }
}

async function ensure() {
  const cur = await running();
  if (cur) return cur;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 150));
    const st = await running();
    if (st) return st;
  }
  throw Error('展厅服务未能启动；可前台运行 node showcase.mjs serve 查看报错');
}

function openBrowser(url) {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

// ---------- 命令行 ----------
const HELP = `成果展厅（只读，本机127.0.0.1）
  start                     启动（已在运行则复用），打印地址
  open [--ref REF] [--file 绝对路径] [--no-browser]
                            在用户默认浏览器打开：首页 / 某个已登记成果 / 某个文件
  url  [--ref REF] [--file 绝对路径]   只返回地址，不打开浏览器（给带浏览器面板的宿主用）
  list [--limit N]          列出最近成果（编号、标题、先看）
  status | stop | serve [--port N]
交付时：成果登记后执行 open --ref <登记返回的deliverable编号>；未登记的过程成品用 open --file。
目录里放 展示.json 可指定“先看”、使用步骤、流程图和源码学习路径，格式见 使用说明.md。`;

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.shift() || 'help';
  const pageUrl = (base) => {
    const ref = opt(args, '--ref');
    const file = opt(args, '--file');
    if (ref) return `${base}#/d/${encodeURIComponent(ref)}`;
    if (file) return `${base}#/f/${encodeURIComponent(norm(file))}`;
    return base;
  };
  if (cmd === 'serve') { const port = await serve(Number(opt(args, '--port')) || PREFERRED_PORT).catch(() => serve(0)); console.log(`成果展厅：http://127.0.0.1:${port}/`); return; }
  if (cmd === 'start') { out(await ensure()); return; }
  if (cmd === 'url' || cmd === 'open') {
    const file = opt(args, '--file');
    if (file && !allowed(file)) throw Error('该文件不在展厅可读范围（Documents 与 AI 系统代码目录），或属于凭据类文件');
    const ref = opt(args, '--ref');
    if (ref && !(await allItems()).some(i => i.ref === ref)) throw Error(`成果登记里没有 ${ref}；先用 deliverables.mjs register 登记，或改用 --file`);
    const st = await ensure();
    const url = pageUrl(st.url);
    if (cmd === 'open' && !args.includes('--no-browser')) openBrowser(url);
    out({ url, opened: cmd === 'open' && !args.includes('--no-browser') });
    return;
  }
  if (cmd === 'list') {
    const limit = Number(opt(args, '--limit')) || 15;
    const items = (await allItems()).slice(0, limit);
    out(items.map(i => ({ ref: i.ref, date: i.date, project: i.project, title: i.title, status: i.status })));
    return;
  }
  if (cmd === 'status') { out((await running()) || { running: false }); return; }
  if (cmd === 'stop') {
    const st = await running();
    if (st) { try { process.kill(st.pid); } catch {} }
    out({ stopped: !!st });
    return;
  }
  console.log(HELP);
}

main().catch(e => { console.error(JSON.stringify({ error: e.message })); process.exit(1); });

#!/usr/bin/env node
import {publicPath as _publicPath, publicURL as _publicURL, publicDataPath as _publicDataPath} from "../public-paths.mjs";
// 真实成品截图：用本机 Edge（DevTools 协议）打开页面，等加载完再截图。
// 比 msedge --screenshot 可靠：那个快捷参数不绘制独立进程的 iframe，网页成品会截成空白。
// 用法：node screenshot.mjs --url URL --out 绝对路径.png [--width 1360] [--height 1000] [--wait 9000] [--full]
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1]; };
const url = opt('--url'), out = opt('--out');
if (!url || !out) { console.log('用法：node screenshot.mjs --url URL --out 绝对路径.png [--width 1360] [--height 1000] [--wait 9000] [--full]'); process.exit(1); }
const width = Number(opt('--width', 1360)), height = Number(opt('--height', 1000)), wait = Number(opt('--wait', 9000));
const EDGE = process.env.AI_BROWSER_EXECUTABLE || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
if (!EDGE) throw Error('未找到 Edge 或 Chrome');

const port = 9333 + Math.floor(Math.random() * 500);
const profile = _publicDataPath(`成果展厅/screenshots/profile-${port}`);
const browser = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--window-size=${width},${height}`, '--hide-scrollbars', '--no-first-run', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  let targets;
  for (let i = 0; i < 60 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(250); } }
  const page = targets?.find(t => t.type === 'page');
  if (!page) throw Error('浏览器调试端口未就绪');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(wait);
  const params = { format: 'png' };
  if (args.includes('--full')) {
    const m = await send('Page.getLayoutMetrics');
    const s = m.result.cssContentSize || m.result.contentSize;
    params.clip = { x: 0, y: 0, width, height: Math.min(s.height, 12000), scale: 1 };
    params.captureBeyondViewport = true;
  }
  const shot = await send('Page.captureScreenshot', params);
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log(JSON.stringify({ out, url, width, height: params.clip?.height || height }));
  ws.close();
} finally {
  browser.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

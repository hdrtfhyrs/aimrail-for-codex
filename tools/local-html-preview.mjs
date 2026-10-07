#!/usr/bin/env node
// Read-only, single-artifact localhost preview. No directory or arbitrary-path route.
import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const command = args.shift() || 'help';
const option = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
const artifactArg = option('--file');
const artifact = artifactArg ? path.resolve(artifactArg) : undefined;
const storeDir = path.resolve(process.env.AI_PREVIEW_HOME || path.join(process.env.AI_WORK_HOME || path.join(process.cwd(),'workspace'),'.cache','previews'));
const statePath = artifact ? path.join(storeDir, createHash('sha256').update(artifact.toLowerCase()).digest('hex').slice(0, 16) + '.json') : undefined;
const out = value => console.log(JSON.stringify(value, null, 2));
const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function saved() { try { return JSON.parse(await readFile(statePath, 'utf8')); } catch { return null; } }
async function live(state) {
  if (!state?.url || !state.healthUrl?.startsWith('http://127.0.0.1:')) return false;
  try { const response = await fetch(state.healthUrl, {signal: AbortSignal.timeout(1000)}); const body = await response.json(); return body.instance === state.instance; } catch { return false; }
}

async function serve() {
  if (!artifact || path.extname(artifact).toLowerCase() !== '.html') throw Error('--file must name one .html artifact');
  const info = await stat(artifact);
  if (!info.isFile() || info.size > 20 * 1024 * 1024) throw Error('Preview requires one HTML file up to 20 MiB');
  const snapshot = await readFile(artifact);
  const instance = randomBytes(16).toString('hex');
  const base = '/' + instance;
  const ttl = Number(option('--ttl') || 7200);
  if (!Number.isFinite(ttl) || ttl < 60 || ttl > 86400) throw Error('--ttl must be 60..86400 seconds');
  let state;
  const server = http.createServer((req, res) => {
    const expectedHost = `127.0.0.1:${state.port}`;
    if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)) { res.writeHead(403); res.end('Forbidden'); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=()');
    if (req.url === `${base}/stop` && req.method === 'POST') { res.writeHead(200, {'Content-Type':'application/json'}); res.end('{"stopped":true}'); server.close(); setTimeout(() => process.exit(0), 200).unref(); return; }
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); res.end('Read-only preview'); return; }
    let body;
    if (req.url === `${base}/health`) { res.setHeader('Content-Type','application/json'); body = JSON.stringify({instance, bytes:snapshot.length}); }
    else if (req.url === `${base}/`) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
      body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(path.basename(artifact))} · 本机预览</title><style>html,body{margin:0;width:100%;height:100%;}iframe{border:0;width:100%;height:100%;display:block;}</style><iframe title="作品预览" sandbox="allow-scripts" allow="autoplay" src="${base}/content"></iframe></html>`;
    } else if (req.url === `${base}/content`) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'");
      body = snapshot;
    } else { res.writeHead(404); res.end('Only the explicitly selected HTML artifact is available'); return; }
    res.writeHead(200);
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  state = {file:artifact, pid:process.pid, port, instance, url:`http://127.0.0.1:${port}${base}/`, healthUrl:`http://127.0.0.1:${port}${base}/health`, startedAt:new Date().toISOString(), expiresAt:new Date(Date.now()+ttl*1000).toISOString(), mode:'single-file-sandboxed-snapshot', bytes:snapshot.length};
  await mkdir(storeDir,{recursive:true});
  await writeFile(statePath,JSON.stringify(state,null,2),'utf8');
  setTimeout(() => { server.close(); process.exit(0); }, ttl*1000).unref();
}

try {
  if (command === 'help' || !['start','serve','status','stop'].includes(command)) {
    out({usage:'node local-html-preview.mjs start|status|stop --file ABS_HTML [--ttl SECONDS]', purpose:'指定自包含HTML的只读、sandbox localhost预览；不提供任意本地文件访问', lifecycle:'默认2小时自动退出；start重复调用复用存活快照；改文件后stop再start；无开机常驻'});
  } else if (!artifact) throw Error('--file ABS_HTML is required');
  else if (command === 'serve') await serve();
  else if (command === 'status') { const state=await saved(); out({running:await live(state), ...(state||{})}); }
  else if (command === 'stop') {
    const state=await saved();
    if (await live(state)) { await fetch(state.url+'stop',{method:'POST',signal:AbortSignal.timeout(2000)}); out({stopped:true,file:artifact}); }
    else out({stopped:false,running:false,file:artifact});
  } else {
    const state=await saved();
    if (await live(state)) out({running:true,reused:true,...state});
    else {
      const ttl=option('--ttl')||'7200';
      // Validate first, so a bad file reports a concrete error instead of silently failing in the child.
      if (path.extname(artifact).toLowerCase()!=='.html' || !(await stat(artifact)).isFile()) throw Error('Select an existing .html file');
      const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'serve','--file',artifact,'--ttl',ttl],{detached:true,windowsHide:true,stdio:'ignore'});
      child.unref();
      let ready;
      for(let i=0;i<100;i++) { await new Promise(r=>setTimeout(r,50)); const next=await saved(); if(next?.pid===child.pid && await live(next)) {ready=next;break;} }
      if(!ready) throw Error('Preview service did not become ready; run serve in the terminal for diagnostics');
      out({running:true,reused:false,...ready});
    }
  }
} catch(error) { console.error(JSON.stringify({error:error.message})); process.exitCode=1; }

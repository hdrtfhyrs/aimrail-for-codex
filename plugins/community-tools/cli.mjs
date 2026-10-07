import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ProxyAgent } from './npm/node_modules/undici/index.js';

const root = dirname(fileURLToPath(import.meta.url));
const [command = 'help', ...args] = process.argv.slice(2);
const ctxEntry = join(root, 'npm/node_modules/ctx7/dist/index.js');
const openEntry = join(root, 'npm/node_modules/@jackwener/opencli/dist/src/main.js');
const stateRoot = process.env.COMMUNITY_TOOLS_STATE_DIR || join(process.env.AI_WORK_HOME || fileURLToPath(new URL('../../workspace/', import.meta.url)), 'community-tools');
const python = process.env.COMMUNITY_TOOLS_PYTHON || join(root, process.platform === 'win32' ? 'bilibili-venv/Scripts/python.exe' : 'bilibili-venv/bin/python');

function run(executable, argv, env = {}) {
  const child = spawn(executable, argv, { shell: false, stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}

async function jina(argv) {
  const target = argv.shift();
  if (!target) throw new Error('Usage: jina <public-http(s)-URL> [--out <file>] [--timeout-ms <ms>] [--max-chars <chars>]');
  const url = new URL(target);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('A public HTTP(S) URL without embedded credentials is required');
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--out', '--timeout-ms', '--max-chars'].includes(argv[i]) || argv[i+1] === undefined) throw new Error('Unknown or incomplete option: ' + argv[i]);
    options[argv[i]] = argv[i+1];
  }
  const timeout = Number(options['--timeout-ms'] ?? 45000);
  const maximum = Number(options['--max-chars'] ?? 0);
  if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 120000 || !Number.isInteger(maximum) || maximum < 0) throw new Error('Invalid timeout or max-chars');
  const headers = { Accept: 'text/plain', 'X-Return-Format': 'markdown' };
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  try {
    const response = await fetch('https://r.jina.ai/' + url.href, { headers, signal: AbortSignal.timeout(timeout), ...(dispatcher ? { dispatcher } : {}) });
    const content = await response.text();
    if (!response.ok) throw new Error(`Jina HTTP ${response.status}: ${content.slice(0, 800)}`);
    const shown = maximum ? content.slice(0, maximum) : content;
    const receipt = { source: url.href, reader: 'https://r.jina.ai/', fetchedAt: new Date().toISOString(), status: response.status, fullChars: content.length, returnedChars: shown.length, truncated: shown.length < content.length, authentication: 'anonymous', cookies: 'not-used', boundary: 'Remote public-page extraction; not a browser session, not proof of complete or current source content' };
    if (options['--out']) {
      await mkdir(dirname(options['--out']), { recursive: true });
      await writeFile(options['--out'], shown, 'utf8');
      await writeFile(options['--out'] + '.receipt.json', JSON.stringify(receipt, null, 2) + '\n', 'utf8');
      console.log(JSON.stringify({ ...receipt, savedTo: options['--out'] }, null, 2));
    } else {
      console.log(shown);
      console.error(JSON.stringify(receipt));
    }
  } finally { if (dispatcher) await dispatcher.close(); }
}

try {
  switch (command) {
    case 'ctx7': {
      if (args[0] && !['library', 'docs', 'whoami', '--version', '-v', '--help', '-h'].includes(args[0])) throw new Error('Use library/docs/whoami/help/version. Setup and login are not part of this read-only adapter.');
      const state = join(stateRoot, 'context7');
      run(process.execPath, [ctxEntry, ...args], { CTX7_TELEMETRY_DISABLED: '1', XDG_CONFIG_HOME: join(state,'config'), XDG_STATE_HOME: join(state,'state'), XDG_CACHE_HOME: join(state,'cache'), USERPROFILE: join(state,'home'), HOME: join(state,'home') });
      break;
    }
    case 'bili': run(python, ['-X', 'utf8', join(root, 'bili-local.py'), ...args], { COMMUNITY_TOOLS_STATE_DIR: stateRoot }); break;
    case 'opencli': run(process.execPath, [openEntry, ...args]); break;
    case 'jina': await jina([...args]); break;
    case 'status': {
      const ctx = JSON.parse(await readFile(join(root,'npm/node_modules/ctx7/package.json'),'utf8'));
      const open = JSON.parse(await readFile(join(root,'npm/node_modules/@jackwener/opencli/package.json'),'utf8'));
      const biliMetadata = await promisify(execFile)(python, ['-X', 'utf8', '-c', "from importlib.metadata import version; print(version('bilibili-cli'))"], { encoding: 'utf8' });
      const biliVersion = biliMetadata.stdout.trim();
      console.log(JSON.stringify({ root, node: process.version, context7: { version: ctx.version, entry: ctxEntry, mode: 'CLI; anonymous documentation; telemetry disabled; isolated state' }, bilibili: { version: biliVersion, python, installed: existsSync(python), entry: join(root,'bili-local.py'), credentialConfigured: existsSync(join(stateRoot,'bilibili/credential.json')), browserCookieExtraction: 'disabled-by-wrapper', mode: 'read-only; login requires user interactive terminal' }, opencli: { version: open.version, entry: openEntry, mode: 'CLI installed; runtime connection state must be read with opencli daemon status; Browser Bridge not connected by this installation' }, jina: { mode: 'anonymous public reader; current-shell proxy respected', entry: 'jina' } },null,2));
      break;
    }
    case 'help': case '--help': case '-h':
      console.log(`Community reading tools\nnode "${fileURLToPath(import.meta.url)}" status\n  ctx7 library <name> <question> --json\n  ctx7 docs </org/library[/version]> <question> --json\n  bili search <keywords> --type video --max 5 --json\n  bili video <BV-ID> --subtitle-timeline --comments --json\n  opencli --help | list | <site> --help\n  jina <public-URL> --out <file> [--max-chars 40000] [--timeout-ms 45000]\nBilibili adapter disables browser-cookie extraction. Login must be done by the user in an interactive terminal. OpenCLI browser-backed commands need Browser Bridge and the correct Chrome profile.`);
      break;
    default: throw new Error('Unknown command: ' + command);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }

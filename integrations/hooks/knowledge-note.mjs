import {integrationPath} from '../paths.mjs';
// 只给本地导航；AI结合完整任务自行看目录、查找并读原件。
// 缓存仅用于去重，不保存或决定任务授权。
import fs from 'node:fs';
import path from 'node:path';
import {knowledgeNavigation} from '../context/knowledge.mjs';

const defaultSeen = integrationPath("integrations/context/knowledge-seen");
const clean = value => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 180);

function stateFile(input, options) {
  // 匿名工具事件不使用父缓存：不能证明当前消费者是谁。
  const event = input.hook_event_name || 'UserPromptSubmit';
  if (['PreToolUse', 'PostToolUse'].includes(event) && !input.agent_id) return null;
  const session = clean(input.session_id);
  if (!session) return null;
  return path.join(options.knowledgeSeenDir || defaultSeen,
    `${clean(options.host || input.host || 'codex')}-${session}-${clean(input.agent_id || 'root')}.json`);
}
function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function saveState(file, state) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state));
    fs.renameSync(temporary, file);
  } catch {} // 去重失败允许再次召回，不影响实际工作。
}
function toolFailed(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.isError === 'boolean') return value.isError;
    for (const key of ['exit_code', 'exitCode', 'exitCodeValue']) {
      if (typeof value[key] === 'number') {
        if (value[key] === 1 && isRipgrepNoMatch(value)) return false;
        return value[key] !== 0;
      }
    }
  }
  if (value && typeof value === 'object') {
    if (value.is_error === true || value.status === 'failed') return true;
    // 不递归解释业务JSON的error字段：预期拒绝测试和源码并不是工具故障。
    return false;
  }
  const text = String(value || '');
  const exit = text.match(/^(?:Process exited with code|Exit code\s*[:=])\s*(-?\d+)\s*$/im);
  if (exit) return Number(exit[1]) !== 0;
  // 只有独立诊断行才用于没有结构化状态的旧宿主。
  if (/^\s*(?:EACCES|EPERM|ERROR_ACCESS_DENIED)\s*:/mi.test(text)
    || /^\s*(?:Access is denied\.?|Permission denied\.?)\s*$/mi.test(text)) return true;
  return /^(?:[A-Za-z][^:\n]{0,100}:\s*)?(?:missing tensor\b|CUDA out of memory\b|[\w.]+(?:Error|Exception):|Error\s*\[|Error:|Traceback \(most recent call last\):)/mi.test(text);
}

function isRipgrepNoMatch(value) {
  if (typeof value?.exit_code !== 'number' || value.exit_code !== 1) return false;
  if (typeof value.stderr === 'string' && value.stderr.trim()) return false;
  const output = String(value.output ?? '');
  if (/^\s*(?:ParserError:|[\w.]+(?:Error|Exception):|Error\s*\[|Error:|Traceback \(most recent call last\):|rg(?:\.exe)?:)/mi.test(output)) return false;
  const command = value.command;
  if (!Array.isArray(command)) return false;
  const index = command.findIndex(part => String(part).toLowerCase() === '-command');
  if (index < 0 || index + 1 >= command.length) return false;
  const script = command.slice(index + 1).map(String).join(' ').trim();
  const statements = [];
  let start = 0, quote = null;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (quote === "'") {
      if (ch === "'" && script[i + 1] === "'") { i++; continue; }
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '`') { i++; continue; }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === ';') { statements.push(script.slice(start, i)); start = i + 1; continue; }
    // Only this simple PowerShell separator form is interpreted. A pipeline,
    // redirection, control operator, newline, or uncertain quoting stays failed.
    if ('|&<>\r\n'.includes(ch)) return false;
  }
  if (quote !== null) return false;
  statements.push(script.slice(start));
  const final = statements.at(-1)?.trim() || '';
  return /^rg(?:\.exe)?(?:\s|$)/i.test(final);
}

function transcriptItem(fd, size, id) {
  const needle = Buffer.from(`"${id}"`, 'utf8');
  const chunkSize = 1024 * 1024;
  const scanLimit = 8 * 1024 * 1024;
  const lineLimit = 2 * 1024 * 1024;
  const deadline = Date.now() + 75;
  const scanFloor = Math.max(0, size - scanLimit);
  let end = size, bytesRead = 0;
  while (end > scanFloor && Date.now() <= deadline) {
    const start = Math.max(0, end - chunkSize);
    const length = end - start;
    bytesRead += length;
    if (bytesRead > 12 * 1024 * 1024) return null;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    let at = buffer.lastIndexOf(needle);
    while (at >= 0) {
      const absolute = start + at;
      // Read just the containing JSONL row; event outputs can make rows larger than a chunk.
      let rowStart = absolute, rowEnd = absolute + needle.length;
      const scanSize = 64 * 1024;
      while (rowStart > 0) {
        if (Date.now() > deadline) return null;
        const from = Math.max(0, rowStart - scanSize), n = rowStart - from;
        bytesRead += n;
        if (bytesRead > 12 * 1024 * 1024) return null;
        const part = Buffer.alloc(n); fs.readSync(fd, part, 0, n, from);
        const newline = part.lastIndexOf(0x0a);
        if (newline >= 0) { rowStart = from + newline + 1; break; }
        rowStart = from;
        if (absolute - rowStart > lineLimit) { rowStart = absolute + 1; break; }
      }
      while (rowEnd < size) {
        if (Date.now() > deadline) return null;
        const n = Math.min(scanSize, size - rowEnd);
        bytesRead += n;
        if (bytesRead > 12 * 1024 * 1024) return null;
        const part = Buffer.alloc(n); fs.readSync(fd, part, 0, n, rowEnd);
        const newline = part.indexOf(0x0a);
        if (newline >= 0) { rowEnd += newline; break; }
        rowEnd += n;
        if (rowEnd - absolute > lineLimit) { rowEnd = absolute; break; }
      }
      if (rowStart <= absolute && rowEnd >= absolute + needle.length && rowEnd - rowStart <= lineLimit) {
        bytesRead += rowEnd - rowStart;
        if (bytesRead > 12 * 1024 * 1024 || Date.now() > deadline) return null;
        const row = Buffer.alloc(rowEnd - rowStart);
        fs.readSync(fd, row, 0, row.length, rowStart);
        try {
          const record = JSON.parse(row.toString('utf8'));
          if (record.payload?.item?.id === id) return record.payload.item;
        } catch {}
      }
      at = buffer.lastIndexOf(needle, at - 1);
    }
    end = start;
  }
  return null;
}

export function enrichToolResponse(input) {
  // Some CLI/local shell paths expose only PowerShell's formatted error record.
  // Require the command diagnostic + Line/caret layout; quoted source excerpts
  // and ordinary successful content are not interpreted as failure statuses.
  if (input.hook_event_name === 'PostToolUse' && input.tool_name === 'Bash'
    && typeof input.tool_response === 'string'
    && /^\s*[A-Za-z]+-[A-Za-z]+:\s*[^\n]*\r?\n\s*Line\s*\|/m.test(input.tool_response)
    && /^\s*\d+\s*\|/m.test(input.tool_response)
    && /^\s*\|\s*[~^]+/m.test(input.tool_response)) {
    return {...input,tool_response:{isError:true,output:input.tool_response}};
  }
  if (input.hook_event_name !== 'PostToolUse' || typeof input.tool_response !== 'string' || !input.transcript_path || !input.tool_use_id) return input;
  // 本次宿主只给聚合文字；按精确调用ID取已完成原记录的状态，不从业务文字猜退出码。
  try {
    const source = String(input.transcript_path).replace(/^\\\\\?\\/, '');
    const fd = fs.openSync(source, 'r');
    let item;
    try { item = transcriptItem(fd, fs.fstatSync(fd).size, input.tool_use_id); }
    finally { fs.closeSync(fd); }
    if (item && typeof item.exit_code === 'number') {
      return {...input, tool_response: {exit_code: item.exit_code, status: item.status,
        command: item.command, stderr: item.stderr,
        output: item.aggregated_output ?? item.formatted_output ?? input.tool_response}};
    }
  } catch {} // 格式/原件不可读时保留已知诊断后备，不改权限和原输出。
  return input;
}
function failureQuery(input) {
  // 只提取文字结果；不把图像、音频等二进制内容送给索引。
  const strings = [], queue = [input.tool_response];
  const invocationFields = new Set(['command', 'commands', 'cmd', 'argv', 'arguments',
    'commandinput', 'commandline', 'invocation', 'invocationinput', 'toolinput',
    '命令', '命令输入', '命令参数', 'status', 'type', 'id', 'toolname', 'tooluseid', 'callid']);
  for (let count = 0; queue.length && count < 100; count++) {
    const item = queue.shift();
    if (typeof item === 'string') strings.push(item.slice(-16000));
    else if (item && typeof item === 'object') {
      for (const [key, value] of Object.entries(item)) {
        const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
        if (invocationFields.has(normalizedKey) || ['data', 'image_url', 'audio_url', 'blob'].includes(key)) continue;
        queue.push(value);
      }
    }
  }
  const response = strings.join('\n');
  const lines = response.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/);
  const diagnostics = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Actual leading diagnostics, not rg file:line source excerpts or warnings.
    if (!/^\s*(?:missing tensor\b|CUDA out of memory\b|[\w.]*(?:Error|Exception)(?:\s*\[[^\]]+\])?\s*:|Error\s*[:\[]|[A-Za-z]+-[A-Za-z]+:\s*(?:$|.+))/i.test(line)) continue;
    let diagnostic = line.trim();
    if (/^(?:ParserError|Exception|[A-Za-z]+-[A-Za-z]+):/i.test(diagnostic)) {
      // PowerShell 7 puts the cause under its line/caret display. Preserve the
      // message, without mounting the echoed source command or underline.
      const details = [];
      for (const next of lines.slice(i + 1, i + 9)) {
        if (/^\s*(?:[\w.]+(?:Error|Exception)|[A-Za-z]+-[A-Za-z]+):/i.test(next)) break;
        const detail = next.match(/^\s*\|\s+(.+?)\s*$/)?.[1];
        if (detail && !/^[~^\s-]+$/.test(detail)) details.push(detail);
      }
      if (details.length) diagnostic += ' ' + details.join(' ');
    }
    diagnostics.push(diagnostic);
  }
  // 实际诊断优先，运行器/临时目录名不能压过报错本身。
  if (diagnostics.length) return [...new Set(diagnostics)].join('\n').slice(0, 2000);
  return response.trim() ? response.trim().slice(-2000)
    : `${input.tool_name || 'unknown tool'}: failed without diagnostic; exit=${input.tool_response?.exit_code ?? 'unknown'}`;
}
function trace(input, options, result) {
  const file = options.knowledgeTraceFile || process.env.KNOWLEDGE_PROBE_LOG;
  if (!file) return;
  try { fs.appendFileSync(file, JSON.stringify({event: input.hook_event_name,
    session: input.session_id, agent: input.agent_id || null, source: input.source || null,
    items: result.items?.map(item => item.id) || [], characters: result.text.length,
    reason: result.reason, contextGeneration: result.contextGeneration, responseShape: result.responseShape}) + '\n'); } catch {}
}

export function readKnowledgeNote(input, saved = {}, options = {}) {
  const event = input.hook_event_name || 'UserPromptSubmit';
  // User correction: no automatic keyword-selected cards, including failures.
  // Existing failure diagnostics remain exported for the recovery owner.
  if (event === 'PostToolUse' || event === 'PreToolUse') return '';
  const file = stateFile(input, options), old = loadState(file);
  const state = {policy: 'manual-discovery', navigationSent: old.policy === 'manual-discovery' && Boolean(old.navigationSent),
    contextGeneration: old.contextGeneration || 0};
  if (event === 'SessionStart') { state.navigationSent = false; state.contextGeneration++; }
  const navigation = state.navigationSent ? '' : knowledgeNavigation({maxChars: 320});
  const commit = finalText => {
    if (navigation && String(finalText || '').includes(navigation)) state.navigationSent = true;
    saveState(file, state);
  };
  saveState(file, state);
  if (typeof options.knowledgeEmissionObserver === 'function') options.knowledgeEmissionObserver({text: navigation, emitted: [], commit});
  else commit(navigation);
  trace(input, options, {text: navigation, items: [], reason: navigation ? 'local-navigation' : 'already-navigated', contextGeneration: state.contextGeneration});
  return navigation;
}

export {toolFailed as isFailedToolResponse, failureQuery as failureDiagnostics,
  isRipgrepNoMatch as isExpectedRipgrepNoMatch};

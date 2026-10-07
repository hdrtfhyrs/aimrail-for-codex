import {integrationPath} from '../paths.mjs';
// 研究开局扩搜：AI明确调用 start 后，后台执行；读取或编辑技能不启动搜索。
// 中英文、多角度、不限站点的搜索，结果在下一次hook事件送到上下文。
// 依据：01a10ab1读了该技能仍只发site:确认式查询；Anthropic技能指南“易漏步骤交脚本”。
// 铺开的广度由explore实际结果决定，不是研究完成标准；AI据此继续补搜、读原文和判断。
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {retrievalPrompt} from './task-retrieval-context.mjs';
import {readGoalFrame} from './goal-continuity.mjs';
import {readContext} from '../context/project-context.mjs';

const DIR = process.env.RESEARCH_PACKET_DIR || integrationPath("integrations/context/recall-cache/research");
const EXPLORE = integrationPath("plugins/search-tools/cli.mjs");
const clean = v => String(v || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
const key = (host, session) => path.join(DIR, `${clean(host)}-${clean(session)}`);
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const write = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive: true}); const t = file + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(value)); fs.renameSync(t, file); };
const promptHash = last => createHash('sha256').update(JSON.stringify([last.prompt, last.frame, last.attachments])).digest('hex').slice(0, 16);

export function researchNavigation() {
  return `任务需要找办法、认识陌生对象、比较路线或旧前提受质疑时，当前AI直接结合完整目标选多样查询并实际搜索，不等用户另说“搜”。第一次广收标题/链接：node "${EXPLORE}" explore --goal "当前用途与问题" --queries-file "AI形成的查询数组JSON" --mode topic；旧--terms仍可给叫法。先用这批标题打开思路，联系用户目标联想新的办法，做一轮AI初判后再自由选读原文或续搜；程序不挑固定前几项，也不要求读完所有目录。candidates取标题/详情，read取原文，expand沿作者扩展。后台同源：node "${fileURLToPath(import.meta.url)}" start --host codex或claude --session 真实ID --goal "问题" --queries-file "查询JSON" --mode topic。具体做法沿现用evidence-research。`;
}

// Each hook is a separate process. Acquire a short exclusive lease before
// checking or committing a packet, so parallel tool reads cannot all emit it.
function acquire(file) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  try { if (Date.now() - fs.statSync(file).mtimeMs > 60000) fs.unlinkSync(file); } catch {}
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    let released = false;
    return () => { if (released) return; released = true; try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(file); } catch {} };
  } catch { return null; }
}

function attachmentMaterial(prompt) {
  const root = path.resolve(integrationPath("workspace/attachments"));
  const refs = [...String(prompt).matchAll(/(?:[A-Za-z]:[\\/])[^\r\n]+?\.(?:txt|md)(?=\s*$)/gm)].slice(0, 3);
  return refs.flatMap(([ref]) => {
    try {
      const file = fs.realpathSync(ref.trim()), relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative) || fs.statSync(file).size > 256000) return [];
      const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      // Final delivery text is often at the end of a pasted conversation.
      return [{source: file, totalChars: text.length, truncated: text.length > 8000,
        text: text.length > 8000 ? text.slice(0, 1500) + '\n[中段未展开]\n' + text.slice(-6500) : text}];
    } catch { return []; }
  });
}

// UserPromptSubmit：记下最近一条用户原话和当前分支，供后续开局扩搜作目标。
export function rememberPrompt(input, saved, host, prompt) {
  if (input.agent_id || !prompt?.trim()) return;
  try {
    const message = retrievalPrompt({...input, prompt});
    const frame = readGoalFrame(saved || {});
    write(key(host, input.session_id) + '.prompt.json', {prompt: message,
      frame: frame ? {name: frame.name, goal: frame.goal, conditions: frame.conditions, source: frame.source, branch: frame.branch, project:frame.project, revision:frame.revision} : null,
      attachments: attachmentMaterial(prompt), at: Date.now()});
  } catch {}
}

// 显式启动；在途或尚未交回的同请求防重复，交回后允许续页。
export function startResearchPacket(input, host, request) {
  if(!request?.goal?.trim()||!request?.terms?.trim()&&!request?.queries?.length) throw new Error('明确提供研究goal及terms或queries才能启动');
  if(request.queries&&(!Array.isArray(request.queries)||request.queries.some(q=>typeof q!=='string'))) throw new Error('queries必须是实际查询字符串数组');
  if (!['tools','topic','obstacle'].includes(request.mode || 'tools')) throw new Error('mode 必须为 tools、topic 或 obstacle');
  request={...request,mode:request.mode || 'tools'};
  if (!input.session_id || input.agent_id) return false;
  let release;
  try {
    const base = key(host, input.session_id), last = read(base + '.prompt.json');
    if (!last?.prompt) return false;
    release = acquire(base + '.start.lock');
    if (!release) return false;
    const goalHash = promptHash(last) + '-' + createHash('sha256').update(JSON.stringify(request)).digest('hex').slice(0, 12);
    const prior = read(base + '.packet.json');
    if(prior?.goalHash===goalHash && (prior.status==='running'&&Date.now()-prior.startedAt<5*60*1000 || prior.status==='ready'&&!prior.delivered)) return false;
    const runId = randomUUID();
    let frame=last.frame, frameOrigin='user-message-time-background';
    try {
      const saved=readContext(input,{host,compact:true,includeDiscovery:false});
      const current=readGoalFrame(saved || {});
      if(current) { frame={name:current.name,goal:current.goal,conditions:current.conditions,source:current.source,branch:current.branch,project:current.project,revision:current.revision}; frameOrigin='current-binding-at-explicit-start'; }
    } catch {} // The AI's explicit question remains authoritative if background cannot be refreshed.
    write(base + '.job-' + runId + '.json', {...last, frame, frameOrigin, runId, goalHash, request});
    write(base + '.packet.json', {runId, goalHash, promptHash: promptHash(last), explicit: true, status: 'running', startedAt: Date.now(), delivered: false});
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', base, runId], {detached: true, stdio: 'ignore', windowsHide: true}).unref();
    return true;
  } catch { return false; } finally { release?.(); }
}

// 下一次可注入事件：结果已就绪且未送达时给出正文块。
export function pendingResearchPacket(input, host) {
  if (!input.session_id || input.agent_id) return null;
  const file = key(host, input.session_id) + '.packet.json', release = acquire(file + '.delivery.lock');
  if (!release) return null;
  const packet = read(file);
  if (!packet?.explicit || packet.delivered || packet.status === 'running' || !packet.text) { release(); return null; }
  const last = read(key(host, input.session_id) + '.prompt.json');
  if (packet.runId && last && promptHash(last) !== packet.promptHash) { release(); return null; }
  return {text: packet.text, cancel: release, commit(finalText) {
    try {
      const current = read(file);
      if (current?.goalHash === packet.goalHash && current?.runId === packet.runId && finalText.includes(packet.text))
        write(file, {...current, delivered: true, deliveredAt: Date.now()});
    } finally { release(); }
  }};
}

function format(result, goal, resultFile) {
  const rows=(result.candidate_titles||result.all_candidates||[...(result.candidates_repos_packages||[]),...(result.candidates_pages||[])])
    .map(c=>`- ${c.title||c.name} [${c.kind}] ${c.url}`);
  const failed=(result.failed_queries_for_builtin_search||[]).join('；');
  const coverage=(result.term_coverage || []).map(x=>`${x.term}：本轮${x.current_queries}项、${x.current_with_results}项有结果、${x.deferred}项未执行`).join('；');
  const next=result.catalog?.next;
  const continuation=next?`\n标题目录尚未全部显示，继续：node "${EXPLORE}" candidates --goal ${JSON.stringify(goal)} --offset ${next.offset} --max-chars ${next.max_chars}（参数为数据，实际shell调用按宿主正确引用）`:'\n本次标题窗口已显示当前目录全部项目。';
  return `广度标题收集：${result.summary||''}\n目标：${goal}\n实际叫法覆盖：${coverage}\n完整线索及查询原件：${resultFile}\n标题目录持久原件：${result.catalog?.state_file||'沿结果文件取得'}\n下面按收集顺序显示，未按热门、命中次数或词面挑前几项；先取得候选全景再分辨和读原文。\n${rows.join('\n')}${continuation}${failed?'\n失败查询可换独立入口：'+failed:''}`;
}

async function run(base, runId) {
  const file = base + '.packet.json', packet = read(file) || {};
  const last = runId ? read(base + '.job-' + runId + '.json') : read(base + '.prompt.json');
  if (!last || runId && packet.runId !== runId) return;
  const publish = value => {
    const release = acquire(base + '.start.lock');
    if (!release) return;
    try { const current = read(file); if (current?.runId === packet.runId && current?.goalHash === packet.goalHash) write(file, {...current, ...value}); }
    finally { release(); }
  };
  try {
    if (!last.request) throw new Error('缺少AI明确形成的研究问题，不能把原话或附件路径自动当主题');
    const generated={goal:last.request.goal,terms:String(last.request.terms||'').split(/[,，;；]/).map(x=>x.trim()).filter(Boolean),queries:last.request.queries||[],origin:'explicit-research-request'};
    const goal = generated.goal, list = generated.terms;
    const out = await new Promise((resolve, reject) => {
      const options=['max-queries','dispatch-ms','max-chars','engines','sources'].flatMap(flag=>last.request[flag]?['--'+flag,String(last.request[flag])]:[]);
      if(!last.request['max-chars']) options.push('--max-chars','4000');
      if(generated.queries.length) {const queriesFile=base+'.queries-'+runId+'.json';write(queriesFile,generated.queries);options.push('--queries-file',queriesFile);}
      const child = spawn(process.execPath, [EXPLORE,'explore','--goal',goal,...(list.length?['--terms',list.join(',')]:[]),'--mode',last.request.mode||'tools',...(last.request.error?['--error',last.request.error]:[]),...options], {windowsHide: true});
      let stdout = '', stderr = '';
      child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
      const timer=setTimeout(()=>{child.kill();reject(Error('explore超时'));},Math.max(180000,Number(last.request['dispatch-ms']||45000)+60000));
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(Error(stderr.slice(0, 300) || 'explore退出' + code)); });
    });
    const result = JSON.parse(out);
    const resultFile=base+'.result-'+runId+'.json';
    write(resultFile,result);
    publish({status: 'ready', finishedAt: Date.now(), goal, goalOrigin: generated?.origin || 'current-message-only-fallback', terms: list,
      mode:result.mode,resultFile,
      sourceMaterial: {branch: last.frame?.branch || null,frameOrigin:last.frameOrigin,revision:last.frame?.revision ?? null,promptChars:last.prompt.length, attachments: (last.attachments || []).map(({source,totalChars,truncated}) => ({source,totalChars,truncated}))},
      text: format(result, goal, resultFile), delivered: false});
  } catch (error) {
    publish({status: 'failed', finishedAt: Date.now(), text: `研究开局扩搜这次失败：${error.message}。可直接运行 node "${EXPLORE}" explore --goal "目标" --terms "叫法" 补跑。`, delivered: false});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv[2] === 'run') await run(process.argv[3], process.argv[4]);
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv[2] !== 'run') {
  try {
    if (process.argv[2] !== 'start') throw new Error('用法：start --host codex --session ID --goal "研究问题" --terms "叫法1,叫法2" [--mode topic|tools|obstacle] [--error "报错"]');
    const args = process.argv.slice(3), opts = {};
    for (let i=0;i<args.length;i+=2) {
      if(!['--host','--session','--goal','--terms','--queries-file','--mode','--error','--max-queries','--dispatch-ms','--max-chars','--engines','--sources'].includes(args[i])||!args[i+1]) throw new Error('启动参数无效');
      opts[args[i].slice(2)] = args[i+1];
    }
    if (!opts.session || !['codex','claude'].includes(opts.host)) throw new Error('须提供真实 session 与 host');
    const {host,session,...request}=opts;
    if(request['queries-file']) {request.queries=JSON.parse(fs.readFileSync(request['queries-file'],'utf8'));delete request['queries-file'];}
    const started=startResearchPacket({session_id:session},host,{...request,mode:opts.mode||'tools',error:opts.error||''});
    process.stdout.write(JSON.stringify({started, note:started?'后台研究已启动；后续hook送回结果':'未启动：已有同目标任务、缺少会话原话或启动锁忙；必要时使用search-tools直接explore'})+'\n');
  } catch(error) { process.stderr.write(error.message+'\n'); process.exitCode=1; }
}

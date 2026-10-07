// Copyright 2026 Pi Agent Desktop local workbench contributors.
// Schema-level, session-scoped tool discovery. This is NOT a sandbox or
// lazy extension-code import: only tools already enabled by the host are indexed.

const CAPABILITIES = [
  { pattern: /^document_(read|search)$/, category: "本地文档", terms: "文档 PDF Word Excel PPT DOCX XLSX PPTX 读取正文 检索 本地 document office" },
  { pattern: /^(agent|agent_batch|agent_models|agent_message|agent_events|agent_swarm|agent_hierarchy|agent_file_list|agent_file_info|run_background)$/, category: "多智能体", terms: "子代理 集群 并行 多方案 探索 分层 深度研究 后台 swarm delegate agents hierarchy" },
  { pattern: /^(web_search|web_search_advanced|community_search|browser_web_search)$/, category: "联网搜索", terms: "联网搜索 网上查 网上找 网上有哪些 网上有什么 网上资料 互联网查 网络查 网页搜索 搜索网页 搜索引擎 查网上 查网络 查资料 搜集资料 资料调研 推荐有哪些 好用的 工具 方案 search web search" },
  { pattern: /^(search_papers)$/, category: "论文检索", terms: "论文 文献 学术研究 学术论文 查论文 找论文 搜论文 论文检索 研究文献 paper scholarly" },
  { pattern: /^(web_fetch|fetch_url|browser_web_fetch)$/, category: "网页抓取", terms: "抓网页 获取网页 读取网页 网页内容 打开网页原文 读取原文 读原文 网页全文 网页链接 页面内容 fetch url" },
  { pattern: /^(browser|browser_session)$/, category: "浏览器操作", terms: "浏览器 打开网页 点击 填写 登录 截图 渲染 browser playwright" },
  { pattern: /^(lsp_|ast_search$|code_rewrite$|code_overview$)/, category: "代码理解", terms: "代码 定义 引用 诊断 重构 LSP AST coding" },
  { pattern: /^memory_(search|read|status|forget|restore|write)$|^scratchpad$/, category: "记忆", terms: "记忆 历史 偏好 笔记 查找 memory recall" },
  { pattern: /^(cron_create|cron_list|cron_delete)$/, category: "定时任务", terms: "定时 提醒 周期 计划 cron schedule" },
];

function capabilityFor(name) {
  return CAPABILITIES.find((group) => group.pattern.test(name));
}

// Keep Pi's core filesystem/command tools and task-control tools in the prompt.
// Task/target status and result tools are recognized by their semantic name so
// new control tools do not disappear into the on-demand catalog.
function isAlwaysOn(name) {
  const normalized = name.toLowerCase();
  if (["agent", "agent_batch", "agent_models", "agent_hierarchy", "agent_swarm", "agent_message", "agent_events", "workflow_record"].includes(normalized)) return true;
  if (["read", "write", "edit", "bash", "powershell", "grep", "find", "ls", "resolve_plan_review", "exit_plan_mode", "get_goal", "create_goal", "update_goal", "delete_goal", "set_goal_budget", "todo_list"].includes(normalized)) return true;
  const parts = normalized.split(/[_-]+/);
  const stateActions = new Set(["status", "cancel", "stop", "result", "results", "output", "inspect", "list", "wait"]);
  if ((parts.includes("task") || parts.includes("target")) && parts.some((part) => stateActions.has(part))) return true;
  return /^(?:agent|task|target)_(?:status|cancel|stop|result|results|output|inspect|list|wait)$/.test(normalized);
}

function queryScore(query, candidate) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 0;
  const name = candidate.name.toLowerCase();
  // Exact tool names and explicit tool-name tokens beat broad purpose matches.
  if (normalized === name) return 10_000;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const explicitName = new RegExp(`(?:^|[^a-z0-9_])${escapedName}(?:$|[^a-z0-9_])`).test(normalized);
  if (explicitName) return 5_000;
  if (normalized.includes("_") && /[a-z0-9]+_[a-z0-9_]+/.test(normalized)) return 0;

  const queryText = normalized.replace(/_/g, " ");
  const queryHas = (...phrases) => phrases.some((phrase) => queryText.includes(phrase));
  const searchTool = /^(web_search|web_search_advanced|community_search|browser_web_search)$/.test(name);
  const fetchTool = /^(web_fetch|fetch_url|browser_web_fetch)$/.test(name);
  const paperTool = name === "search_papers";
  const localIntent = queryHas("本地", "文件", "目录", "文件夹", "记忆", "笔记", "历史记录", "代码库", "项目里");
  const exactPaperIntent = queryHas("论文", "文献", "学术研究", "学术文章");
  const fetchIntent = queryHas("原文", "全文", "网页内容", "网页链接", "网页页面", "读取网页", "读网页", "打开网页", "抓网页", "获取网页");
  const webSearchIntent = !localIntent && !exactPaperIntent && !fetchIntent && (
    (queryHas("新闻", "资讯") && queryHas("查", "搜", "找", "最新", "最近")) ||
    queryHas("联网", "网上", "网络", "互联网", "在线", "网页搜索", "搜索引擎", "查资料", "找资料", "搜资料", "资料调研", "web search", "search the web") ||
    ((queryHas("插件", "工具", "方案") && queryHas("推荐", "有哪些", "有什么", "好用")) ||
    /(?:网上|网络|互联网|网页).{0,12}(?:查|搜|找|有|推荐)|(?:查|搜|找).{0,12}(?:网上|网络|互联网|网页)/.test(queryText))
  );
  if (name === "community_search" && queryHas("知乎", "贴吧", "论坛", "社区", "reddit", "hugging face", "huggingface", "v2ex", "linux.do")) return 160;
  if (localIntent && (searchTool || fetchTool || paperTool)) return 0;
  let intent = 0;
  if (/^document_(read|search)$/.test(name) && !webSearchIntent && queryHas("文档", "pdf", "word", "excel", "ppt", "docx", "xlsx", "document", "office")) intent += 100;
  if (paperTool && exactPaperIntent && !localIntent) intent += 140;
  if (fetchTool && fetchIntent && !localIntent) intent += 130;
  if (searchTool && webSearchIntent) intent += 110;
  if (searchTool && name === "web_search") intent += webSearchIntent ? 5 : 0;
  if (searchTool && name === "browser_web_search") intent -= webSearchIntent ? 2 : 0;
  if (fetchTool && queryHas("抓网页", "获取网页", "读取网页", "网页内容", "fetch", "web fetch") && !localIntent) intent += 100;
  if (fetchTool && name === "web_fetch" && fetchIntent) intent += 3;
  if (name === "agent_models" && queryHas("模型目录", "可用模型", "模型清单", "模型列表", "model catalog", "available models")) intent += 120;
  if (name === "agent_batch" && queryHas("并行批量代理", "批量代理", "代理批次", "agent batch", "parallel agents")) intent += 120;
  if (name === "agent" && queryHas("子代理", "委派代理", "委托代理", "调用代理", "subagent", "delegate agent")) intent += 120;

  if (intent) return intent;
  const haystack = `${candidate.name} ${candidate.category} ${candidate.terms} ${candidate.description}`.toLowerCase();
  if (haystack.includes(queryText)) return 50;
  const purpose = String(candidate.description ?? "").toLowerCase();
  const category = String(candidate.category ?? "").toLowerCase();
  const purposeHasChinese = /[\u3400-\u9fff]/.test(purpose);
  if (purposeHasChinese && category && (queryText.includes(category) || category.includes(queryText))) return 15;
  const words = normalized.match(/[a-z0-9]+/g) ?? [];
  return words.reduce((score, word) => score + (haystack.includes(word) ? 1 : 0), 0);
}

export default function capabilityLoader(pi) {
  // Only names enabled by Pi before this extension scopes schemas may become
  // searchable. An installed-but-disabled package or a CLI-excluded tool is
  // never made callable merely because its metadata is discoverable.
  let catalog = new Map();
  let initiallyActive = new Set();
  const loaderNames = ["search_capabilities", "load_capability"];

  pi.registerTool({
    name: "search_capabilities",
    label: "搜索可用能力",
    description: "按任务检索本会话初始允许的工具；默认将匹配工具schema加入当前上下文，下一轮即可调用。activate:false仅浏览。只返回中文用途和简介，不执行工具、不安装、不扩权、不扫描或上传文件；禁用插件不在可激活范围。",
    promptSnippet: "Core collaboration tools are already available; proactively discover optional tools when they benefit the task",
    promptGuidelines: ["Use search_capabilities to find task-specific tools instead of guessing a tool name or installing a package."],
    parameters: { type: "object", properties: {
      query: { type: "string", description: "Task or capability, Chinese or English" },
      limit: { type: "integer", minimum: 1, maximum: 8 },
      activate: { type: "boolean", description: "默认 true；设为 false 时只浏览，不更改当前工具schema集合" },
    }, required: ["query"] },
    async execute(_id, params) {
      const candidates = [...catalog.values()]
        .map((item) => ({ ...item, score: queryScore(params.query, item) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        .slice(0, params.limit ?? 5)
        .map(({ name, category, description }) => ({ name, category, description }));
      // Empty searches are observational only: never alter the active schema set.
      const shouldActivate = params.activate !== false && candidates.length > 0;
      if (shouldActivate) {
        const active = new Set(pi.getActiveTools());
        for (const { name } of candidates) {
          // Catalog is a session-start snapshot of the host's initial allow-list.
          if (initiallyActive.has(name) && catalog.has(name)) active.add(name);
        }
        pi.setActiveTools([...active]);
      }
      const names = shouldActivate ? candidates.map(({ name }) => name) : [];
      const note = shouldActivate
        ? "Matched schemas are now available in context for the next turn; tools are not executed, installed, or granted new permissions."
        : "Browsing only; no tool schemas were activated. Discovery is not authorization.";
      return { content: [{ type: "text", text: JSON.stringify({ matches: candidates, activated: names, note }) }], details: { matches: candidates, activated: names } };
    },
  });

  pi.registerTool({
    name: "load_capability",
    label: "按需启用或收起能力",
    description: "将检索到的工具定义加入当前模型上下文，或在不需要时收起。不会安装插件、读取文件或启动模型请求；调用仍经过现有权限检查。",
    parameters: { type: "object", properties: {
      names: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
      action: { type: "string", enum: ["activate", "release"] },
    }, required: ["names"] },
    async execute(_id, params) {
      const names = [...new Set(params.names)];
      const unknown = names.filter((name) => !initiallyActive.has(name) || !catalog.has(name));
      if (unknown.length) throw new Error(`Capability not enabled in this session: ${unknown.join(", ")}`);
      const active = new Set(pi.getActiveTools());
      for (const name of names) {
        if (params.action === "release") active.delete(name);
        else active.add(name);
      }
      for (const name of loaderNames) active.add(name);
      pi.setActiveTools([...active]);
      return { content: [{ type: "text", text: `${params.action === "release" ? "收起" : "启用"}工具定义：${names.join("、")}。这不会安装/卸载插件；实际调用仍受原权限规则约束。` }], details: { names, action: params.action ?? "activate" } };
    },
  });

  pi.on("session_start", () => {
    const active = pi.getActiveTools();
    initiallyActive = new Set(active);
    catalog = new Map(pi.getAllTools()
      .filter((tool) => initiallyActive.has(tool.name) && !loaderNames.includes(tool.name) && !isAlwaysOn(tool.name))
      .map((tool) => {
        const group = capabilityFor(tool.name);
        return [tool.name, {
          name: tool.name,
          category: group?.category ?? "其他能力",
          terms: group?.terms ?? tool.name.replace(/[_-]+/g, " "),
          description: String(tool.description ?? "").slice(0, 300),
        }];
      }));
    // Respect strict --tools / --no-tools sessions: do not activate any loader
    // that the host did not include in its initial active tool list.
    if (!loaderNames.every((name) => initiallyActive.has(name))) return;
    // Core filesystem, task-control, and goal tools deliberately stay visible.
    const focused = active.filter((name) => !catalog.has(name));
    pi.setActiveTools(focused);
  });
}

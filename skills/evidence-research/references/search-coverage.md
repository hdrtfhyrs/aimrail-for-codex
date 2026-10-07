# 搜索范围、标题目录与接续

广度发现先大量收集标题、来源和链接，再由AI分辨与展开。搜索程序保留供应方实际返回的全部候选；不以星数、排名、命中次数或字面重合筛选和突出少量项目。标题按收集顺序显示，详细摘要、发现查询、日期与星数留在持久原件，按需读取。

`explore_search`、本机CLI、百度MCP兼容入口及显式后台共用 `plugins/search-tools/`。AI可直接给queries数组；terms只保留原叫法，不再一律拼推荐、替代、awesome。两者进入同一持久状态；广度入口分别取得相关中英文引擎的页面，成功取得一个引擎不会代替另一个引擎。引擎名单只描述本实现支持的接口；B站站内、内置web、作者站点及其他可用入口由AI按任务继续扩展。`engines` 和 `sources` 可按当前用途指定。

`max_queries` 是可选的本轮网页请求预算，省略时不按固定条数截断，也没有原来的200条上限。`dispatch_ms` 默认45000，只控制这轮继续派发请求的时间；未派发项及失败状态保存并交回，不能当成已搜。请求超时、供应方限流和不可读页面分别保留，实际遇阻时换独立入口。`search_next` 给同目标续搜参数，正常接续不用 `reset`，后台也不再自动重置状态。

网页解析保留当前响应中的所有有效标题。发现下一页链接或DDG翻页表单时，`pagination.next_request` 用于实际接续；没有观察到控件仅表示本响应未提供接续，不能宣称领域已搜全。`search_public` / `baidu_search` 的 `count` 只作供应方页大小提示，不截取已解析结果。

GitHub不指定星数排序，每页100项，单查询最多1000项；`incomplete_results` 与返回上限交回AI，由AI结合任务换叫法、拆问题或換来源。npm使用文档允许的每页250项并按`from`续页，搜索不使用人气权重；MCP注册表按返回的`metadata.nextCursor`续页；Tavily无分页搜索接口，单响应最多20项，明确报告供应方上限。这些是接口批次或服务边界，不是只考虑前N项的业务规则。原证：[GitHub搜索](https://docs.github.com/en/rest/search/search)、[npm搜索接口](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md#get-v1search)、[MCP Registry API](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/openapi.yaml)、[Tavily搜索](https://docs.tavily.com/documentation/api-reference/endpoint/search)。

第一次默认只交紧凑标题目录与少量接续状态；标题用于激发多种办法，AI联系目标做一轮初判后自由选读原文或补搜，不必读完所有目录。详细请求诊断保存在完整原件；需要时传diagnostics=true或CLI --diagnostics。返回的 `candidate_titles` 是本次紧凑标题窗口，`catalog.total` 是完整收集数量；`catalog.next` 给未显示部分的无损续读。`max_chars` 默认24000，只控制上下文展示，不限制候选取得和保存；窗口容不下一条完整记录时返回`required_chars`，提高显示预算，不裁掉标题。后台默认用4000字符标题窗口以适应hook投递，并附完整目录入口；不得以短展示为候选边界。

CLI用法：

```powershell
node "plugins/search-tools/cli.mjs" explore --goal "要达成的结果与当前研究问题" --terms "业内叫法,国内叫法,新发现名称" --mode topic
node "plugins/search-tools/cli.mjs" candidates --goal "同一goal" --max-chars 24000
node "plugins/search-tools/cli.mjs" candidates --goal "同一goal" --offset 目录给出的数字 --max-chars 24000
node "plugins/search-tools/cli.mjs" candidates --goal "同一goal" --details --ids "AI选定的候选ID"
node "plugins/search-tools/cli.mjs" expand --url "已确认有用的来源URL" --goal "同一goal"
```

原文扩展提取到的全部链接均保存，不再先排序后只保存40条。标题窗口与全量线索放在`CODEX_HOME/context/recall-cache/search-explore/`，未配置CODEX_HOME时为用户`.codex/`下同一相对位置；旧系统临时缓存可读入。相关段落仅作为详情，是否值得追读由AI判断。

当前已运行MCP进程仍可能保有旧模块和工具元数据。新启动的兼容入口读取正式源码及新配置；当前工作直接用CLI读取现用代码，不为修改搜索重启桌面或中断其他任务。保存或读回目录只证明线索可取得，网络分页和长期少漏查效果仍由后续真实工作说明。

查询数组可由AI保存为UTF-8 JSON，内容例如 ["agent research query planning implementation", "研究智能体 搜索 阅读 分工"]；这是可按任务改写的示例，不是固定必搜词。CLI explore支持--queries-file，MCP explore_search支持queries数组，后台start同样接收--queries-file并在任务开始时保存查询内容。程序保证调用发生后执行给出的有效查询；工具存在本身不能保证宿主模型主动调用。
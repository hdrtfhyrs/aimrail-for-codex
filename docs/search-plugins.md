# 搜索、社区读取与来源接续

<!-- bilingual-navigation -->
简体中文 · [English](en/search-plugins.md) · [中文首页](../README.zh-CN.md)

这些模块把“找到线索”和“读到原文”分开保存。模型给出用途、叫法和实际查询，程序收集各来源返回的候选，记录分页和未执行请求。模型再决定读哪些原文；正文、主帖、回复与字幕各自带覆盖范围，登录、验证和失败也直接返回。

| 入口 | 可以完成什么 | 依赖 |
| --- | --- | --- |
| plugins/search-tools/cli.mjs、server.mjs | 百度、360、Bing、DuckDuckGo 搜索；GitHub、npm、MCP 注册表、可选 Tavily 的目录发现；候选保存、分页、正文分段读取、来源链接扩展 | 该目录 npm 依赖 |
| plugins/baidu-search-mcp/index.repaired.mjs | 使用旧 MCP 工具名 baidu_search、fetch_url，同时提供广度发现与候选读取 | 同级 search-tools |
| plugins/community-tools/cli.mjs | Context7 库文档、B站 CLI、OpenCLI 透传、Jina 公共正文后备读取 | 该目录 npm 子目录；B站还需要 Python 环境 |
| modules/search-integrations/github-search.mjs | GitHub 仓库、issue、评论、源码文件、提交固定的文件读取和本地 git 定位 | Node.js；本地 clone 定位还需 git |
| modules/search-integrations/domestic-search.mjs | V2EX、LINUX DO、知乎、贴吧、CSDN 搜索和主帖读取，接受宿主已有来源续读 | search-tools |
| modules/search-integrations/international-search.mjs | Hacker News、Reddit、公开 Discourse 搜索、主帖和回复树读取 | Node.js；公开网页后备使用 search-tools |
| modules/search-integrations/bilibili-collection.mjs | B站发现、视频简介、评论、可取得字幕、已有结果接续和来源包导出 | search-tools |

公开副本保留现用通用实现。原用户缓存、账号、Cookie、对话、日志、安装包与虚拟环境没有复制。商业业务生产链没有纳入。B站的通用来源导出改名为 toSourcePacket、source-packet/v1 和 --source-output；视频读取、评论、字幕及缺失部分接续保持原实现。

## 安装

从仓库根目录执行。完整社区工具组合使用 Node.js 22.19 或更高版本；Python B站适配器使用 Python 3.10 或更高版本。仅使用 GitHub 适配器时无需 npm 依赖。

~~~sh
npm ci --prefix plugins/search-tools --ignore-scripts --no-audit --no-fund
npm ci --prefix plugins/community-tools/npm --ignore-scripts --no-audit --no-fund
~~~

B站 Python 环境在 Windows PowerShell 中可这样安装：

~~~powershell
& ./plugins/community-tools/restore.ps1 -PythonExe python
~~~

restore.ps1 安装社区 npm 依赖、创建 bilibili-venv 并按锁定清单安装 Python 包。已有凭据目录留在工作区。脚本不注册开机或登录任务，也不进行登录或启动浏览器。

Linux/macOS 可手动创建环境：

~~~sh
python3 -m venv plugins/community-tools/bilibili-venv
plugins/community-tools/bilibili-venv/bin/python -m pip install -r plugins/community-tools/bilibili-requirements.lock.txt
~~~

Python 清单来自现用环境，Windows 专属包附有平台条件。公开副本未重新安装依赖或运行网络入口，因此这些跨平台调整属于源码适配；实际平台的包可用性、浏览器连接和站点访问结果需以使用时输出为准。

OpenCLI 的浏览器功能还需要其 Browser Bridge 与所选 Chrome/Chromium profile。依赖安装不等于浏览器已连接。--ignore-scripts 跳过上游安装钩子；缺少平台适配器时按 [OpenCLI 上游说明](https://github.com/jackwener/opencli)安装对应资源。第三方工具源码通过各自的包管理器安装，仓库没有打包这些安装副本。

## 保存目录与配置

AI_WORK_HOME 指向用户自己的工作目录。搜索状态默认保存到 AI_WORK_HOME/search-explore，社区账号与工具状态默认保存到 AI_WORK_HOME/community-tools。未设置 AI_WORK_HOME 时，各入口使用通过源码相对定位的仓库根 workspace，和系统其它入口共用默认工作区。公开副本不会读取原 Codex 搜索缓存，也不自动迁移旧临时缓存。

| 变量 | 用途 |
| --- | --- |
| AI_WORK_HOME | 通用数据与状态工作区 |
| SEARCH_TOOLS_STATE_DIR | 单独指定搜索候选与查询进度目录 |
| COMMUNITY_TOOLS_STATE_DIR | 单独指定 Context7 和 B站凭据状态目录 |
| COMMUNITY_TOOLS_PYTHON | 已安装 B站依赖的 Python 可执行文件；默认取插件旁的 bilibili-venv |
| DOMESTIC_SEARCH_CORE | 国内论坛和 B站收集模块的搜索核心覆盖路径；默认相对引用仓库内 core.mjs |
| INTERNATIONAL_SEARCH_CORE | 国际论坛的搜索核心覆盖路径；默认相对引用仓库内 core.mjs |
| GITHUB_TOKEN 或 GH_TOKEN | GitHub 读取认证；广度目录发现读取 GITHUB_TOKEN，GitHub 专用适配器同时支持 GH_TOKEN |
| TAVILY_API_KEY | 可选 Tavily 来源 |
| REDDIT_ACCESS_TOKEN、REDDIT_USER_AGENT | Reddit 官方 OAuth 数据读取 |
| HTTPS_PROXY、HTTP_PROXY | 搜索目录发现与 Jina 后备读取的代理配置；支持小写形式 |

例如在 Windows PowerShell 中设置工作区：

~~~powershell
$env:AI_WORK_HOME = 'D:/AI-Workspace'
~~~

各程序的代理实现不同：explore.mjs 的目录请求读取环境代理，并在 Windows 上后备读取系统代理；Jina 使用当前进程环境代理。核心网页请求与独立论坛/GitHub 的原生 fetch 不因此自动共享这些代理设置，需由其运行环境或 JavaScript 注入的 fetch 实现提供相应网络能力。不要把“已经配置代理”当作所有来源都能访问的证明。

CLI 使用 --out 或 --output 时按指定位置写文件。搜索状态保留全部已收到候选；max_chars 只限制显示窗口。工作目录中的查询、私人来源文件与凭据属于使用者的数据，不应提交到公开仓库。

## 从发现到原文

下面命令均从仓库根目录执行。查询文件可放在自己的 AI_WORK_HOME 中，内容为字符串数组：

~~~json
["personal knowledge base open source", "中文 知识库 语义搜索 实践"]
~~~

先通过实际查询发散发现：

~~~sh
node plugins/search-tools/cli.mjs explore --goal "寻找可持续维护的知识库实现" --queries-file queries.json --mode topic
node plugins/search-tools/cli.mjs candidates --goal "寻找可持续维护的知识库实现" --max-chars 16000
~~~

如果也要使用 GitHub/npm 等结构化目录，传 --terms。目录查询使用 terms；queries 用于网页引擎。因此仅传 --queries-file 不会自动把每个句子转成 GitHub 仓库目录检索。

~~~sh
node plugins/search-tools/cli.mjs explore --goal "寻找可持续维护的知识库实现" --terms "knowledge base,知识库" --queries-file queries.json --mode tools
node plugins/search-tools/cli.mjs candidates --goal "寻找可持续维护的知识库实现" --details --offset 0 --max-chars 16000
~~~

默认中文查询分别派给百度和360，英文查询分别派给 Bing 和 DuckDuckGo；--engines、--sources 可明确覆盖。自动目录来源包含 GitHub，tools 模式还包含 npm；工具用途满足原实现的 MCP 相关条件时加入 MCP 注册表，配置 Tavily key 时加入 Tavily。

同一 goal 再执行会接续来源页和剩余查询。--reset 清空这个 goal 的收集状态并重新开始。程序保留请求超时、供应方上限、未观察到下一页控件及调用者预算造成的范围缺口；这些情况不表示主题已搜全。

根据返回的 catalog.next 继续浏览标题。--ids 可展开模型选定的候选详情。标题和摘要是线索，采用技术结论时继续读原文：

~~~sh
node plugins/search-tools/cli.mjs read --url https://example.org/article --max-length 12000
node plugins/search-tools/cli.mjs read --url https://example.org/article --offset 12000 --max-length 12000
node plugins/search-tools/cli.mjs expand --url https://github.com/example/project --goal "寻找可持续维护的知识库实现"
~~~

expand 保存来源提到的全部可解析链接，再按字符预算返回标题窗口。GitHub 仓库优先读公开 README 的 raw 文件。read 返回提取方法、日期来源、最终链接、总字符数、next_offset 和实际失败状态。它不执行站点 JavaScript，动态内容和二进制 PDF 需要相应宿主读取器。

单独查看搜索引擎页面：

~~~sh
node plugins/search-tools/cli.mjs search --query "知识库 实践" --engine so --count 20
~~~

count 是供应方页大小提示，原实现保留该页解析到的全部结果。将返回的 pagination.next_request 保存为 JSON，然后带原 engine 续页：

~~~sh
node plugins/search-tools/cli.mjs search --query "知识库 实践" --engine so --page-request-file next-page.json
~~~

## MCP 接入

这是 stdio MCP 服务器。将仓库的实际绝对路径放到宿主配置的 args；下例中的 /absolute/path 必须替换为自己的路径。环境变量写在宿主自己的配置中；仓库只提供空值示例。

~~~json
{
  "mcpServers": {
    "search-tools": {
      "command": "node",
      "args": ["/absolute/path/aimrail-for-codex/plugins/search-tools/server.mjs"],
      "env": {
        "AI_WORK_HOME": "/absolute/path/my-workspace"
      }
    }
  }
}
~~~

工具名是 search_public、read_source、explore_search、expand_source、read_candidates。兼容旧百度名称时改用 plugins/baidu-search-mcp/index.repaired.mjs，其工具名为 baidu_search、fetch_url，并保留后三个发现与候选工具。兼容入口可接 --max-result=20、--fetch-content-count=0、--max-content-length=6000；其实际搜索与正文读取仍由同级 search-tools 完成。

宿主注册方式由宿主决定。本次没有改动使用者的 Codex、Claude 或浏览器配置，也没有建立真实账号连接。

## GitHub、论坛和 B站

GitHub CLI 提供仓库、issue、评论、源码和树定位，源码文件读取会解析 ref 并保留提交依据：

~~~sh
node modules/search-integrations/github-search.mjs search --kind repositories --query "knowledge base"
node modules/search-integrations/github-search.mjs repo --repo OWNER/NAME --include-release
node modules/search-integrations/github-search.mjs file --repo OWNER/NAME --path README.md --ref HEAD
node modules/search-integrations/github-search.mjs issue --repo OWNER/NAME --number 1
node modules/search-integrations/github-search.mjs locate --repo OWNER/NAME --path-query search --local /path/to/clone
~~~

代码搜索需要认证，匿名仓库和 issue 搜索、公开文件及本地 git 定位是不同入口。JavaScript 的 createGitHubConnector(callTool) 可接宿主已有 GitHub connector；单独运行 Node CLI 不会继承宿主账号，也不会抽取连接器凭据。issue-snapshot 可规范化已有来源 JSON，但保存快照不等于实时重新读取。

国内论坛按站点输出主帖、附言、回复数量、日期来源和下一页：

~~~sh
node modules/search-integrations/domestic-search.mjs sites
node modules/search-integrations/domestic-search.mjs search --query "知识库" --sites v2ex,linuxdo,csdn
node modules/search-integrations/domestic-search.mjs read --url https://www.v2ex.com/t/123456
~~~

国际论坛区分索引发现与官方帖子读取：

~~~sh
node modules/search-integrations/international-search.mjs search --source hn --query "knowledge base" --sort date
node modules/search-integrations/international-search.mjs search --source discourse --site python --query "packaging"
node modules/search-integrations/international-search.mjs read --url https://news.ycombinator.com/item?id=123456
~~~

Reddit 要有已授权的 OAuth token 和真实 user agent；没有凭据会返回相应状态与后备路径。Discourse 默认支持其官方论坛、Python、Hugging Face、Rust、Julia；JavaScript 配置可添加公开论坛 origin。

论坛受限时，host-request 生成宿主待办。已有宿主读取结果可通过 --fallback-file 和 --host-only true 回填，不重复请求受限网络入口。回填必须匹配请求的具体帖子或回复，且是实际原文，不能使用搜索摘要冒充正文：

~~~sh
node modules/search-integrations/domestic-search.mjs host-request --action read --url https://www.v2ex.com/t/123456
node modules/search-integrations/domestic-search.mjs read --url https://www.v2ex.com/t/123456 --host-only true --fallback-file host-source.json
node modules/search-integrations/international-search.mjs read --url https://news.ycombinator.com/item?id=123456 --host-only true --fallback-file host-source.json
~~~

输出保留宿主页面证据层级及未读范围。代码没有自动接管浏览器、导出 Cookie 或解决验证。

B站模块返回简介、当前页评论和能取得的字幕，同时标明没有观看视频音画：

~~~sh
node modules/search-integrations/bilibili-collection.mjs search --query "知识库 教程" --output discovery.json
node modules/search-integrations/bilibili-collection.mjs read --url BVxxxxxxxxxx --comment-limit 20 --max-parts 1 --output video.json --source-output source.json
node modules/search-integrations/bilibili-collection.mjs resume --from video.json --output resumed.json
node modules/search-integrations/bilibili-collection.mjs convert --from video.json --output source.json
~~~

将 BVxxxxxxxxxx 换成实际 BV 号。resume 保留成功部分，仅补缺失字幕或其它未取得部分；宿主实际原文还可通过 --host-file 和 --host-only true 接入。输出保留原始来源、已读范围和未达项。

## 社区工具 CLI

~~~sh
node plugins/community-tools/cli.mjs ctx7 library react "effects cleanup" --json
node plugins/community-tools/cli.mjs ctx7 docs /facebook/react "effects cleanup" --json
node plugins/community-tools/cli.mjs bili search "知识库" --type video --max 5 --json
node plugins/community-tools/cli.mjs bili video BVxxxxxxxxxx --subtitle-timeline --comments --json
node plugins/community-tools/cli.mjs opencli list
node plugins/community-tools/cli.mjs jina https://example.org/article --out article.md --max-chars 40000
~~~

Context7 入口允许 library、docs、whoami、帮助与版本，不执行 setup 或 login。B站包装器允许读取命令，关闭浏览器 Cookie 抽取；本人在交互终端执行 bili login 时可进行二维码登录，凭据留在自己的状态目录。Jina 按 URL 读取公共页面并保存正文与 receipt，记载截断和获取时间。

OpenCLI 是上游命令透传，其功能不限于读取，具体动作由调用者选择。这里的论坛、GitHub 和 B站来源适配器是只读实现；它们不授权 OpenCLI 的其它写入动作。第三方连接条件按上游维护。

## 许可与实际交付层级

本项目自有搜索实现、兼容入口、来源适配器和包装脚本按仓库 MIT 公开。依赖包保留自己的许可，安装后的第三方实现没有改署名。

[search-tools 依赖说明](../plugins/search-tools/THIRD-PARTY.md)、[社区工具依赖说明](../plugins/community-tools/THIRD-PARTY.md)和[百度兼容入口说明](../plugins/baidu-search-mcp/README.md)列出原来源与许可。OpenCLI、bilibili-cli 是 Apache-2.0；bilibili-api-python 是 GPL-3.0-or-later，其许可不被仓库 MIT 覆盖。第三方 LICENSE 文件保留原文。

本次完成了现用源码提取、公开路径和状态目录适配、依赖声明、来源转换去业务化及文档。保留了原有通用测试源码供维护者参考，没有新建或运行测试，也没有安装依赖、请求真实账号、启动 MCP 或验证长期连接。站点限制、供应方额度、动态页面、评论分页与字幕可用性仍由实际运行结果说明。


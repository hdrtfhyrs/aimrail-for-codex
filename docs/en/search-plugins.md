# Search, community reading, and source continuation

[English home](../../README.md) · [中文](../search-plugins.md)

These modules save discovery leads separately from original source text. The model supplies the purpose, terminology, and actual queries. Programs collect candidates returned by each source and record pagination and requests not executed. The model then decides which sources to read. Article text, main posts, replies, and subtitles each carry their own coverage information; login requirements, verification, and failures are also returned directly.

| Entry point | Capabilities | Dependencies |
| --- | --- | --- |
| `plugins/search-tools/cli.mjs`, `server.mjs` | Baidu, 360, Bing, and DuckDuckGo search; catalog discovery through GitHub, npm, the MCP registry, and optional Tavily; candidate persistence, pagination, segmented source reading, and source-link expansion. | npm dependencies in that directory. |
| `plugins/baidu-search-mcp/index.repaired.mjs` | Uses legacy MCP names `baidu_search` and `fetch_url`, while also providing broad discovery and candidate reading. | Sibling `search-tools`. |
| `plugins/community-tools/cli.mjs` | Context7 library documentation, Bilibili CLI, OpenCLI command forwarding, and Jina fallback reading of public source text. | Its npm subdirectory; Bilibili also needs a Python environment. |
| `modules/search-integrations/github-search.mjs` | GitHub repositories, issues, comments, source files, commit-pinned file reading, and local git location. | Node.js; local-clone location also requires git. |
| `modules/search-integrations/domestic-search.mjs` | Search and main-post reading for V2EX, LINUX DO, Zhihu, Tieba, and CSDN; accepts existing host sources for continuation. | `search-tools`. |
| `modules/search-integrations/international-search.mjs` | Search, main posts, and reply-tree reading for Hacker News, Reddit, and public Discourse forums. | Node.js; public-web fallback uses `search-tools`. |
| `modules/search-integrations/bilibili-collection.mjs` | Bilibili discovery, video descriptions, comments, obtainable subtitles, continuation from existing results, and source-packet export. | `search-tools`. |

The public copy retains the general implementation in use. Original user caches, accounts, Cookies, conversations, logs, installation packages, and virtual environments were not copied. Commercial business-production pipelines are excluded. Bilibili's general source export was renamed to `toSourcePacket`, `source-packet/v1`, and `--source-output`; video reading, comments, subtitles, and continuation of missing portions retain the original implementation.

## Installation

Run from the repository root. The complete community-tool combination requires Node.js 22.19 or later; the Python Bilibili adapter requires Python 3.10 or later. The GitHub adapter alone needs no npm dependencies.

~~~sh
npm ci --prefix plugins/search-tools --ignore-scripts --no-audit --no-fund
npm ci --prefix plugins/community-tools/npm --ignore-scripts --no-audit --no-fund
~~~

On Windows PowerShell, install the Bilibili Python environment with:

~~~powershell
& ./plugins/community-tools/restore.ps1 -PythonExe python
~~~

`restore.ps1` installs community npm dependencies, creates `bilibili-venv`, and installs Python packages according to the locked list. Existing credential directories remain in the workspace. The script does not register startup or login tasks, log in, or launch a browser.

On Linux/macOS, create the environment manually:

~~~sh
python3 -m venv plugins/community-tools/bilibili-venv
plugins/community-tools/bilibili-venv/bin/python -m pip install -r plugins/community-tools/bilibili-requirements.lock.txt
~~~

The Python list comes from the environment in use, with platform conditions on Windows-only packages. The public copy did not reinstall dependencies or run network entry points, so these cross-platform changes are source adaptations. Actual package availability, browser connections, and site-access results on a platform must be determined from output during use.

OpenCLI's browser functions also require its Browser Bridge and the selected Chrome/Chromium profile. Installing dependencies does not establish a browser connection. `--ignore-scripts` skips upstream installation hooks. If a platform adapter is missing, install the corresponding resources according to the [OpenCLI upstream instructions](https://github.com/jackwener/opencli). Third-party source is installed through its own package managers; this repository does not bundle those installation copies.

## Storage and configuration

`AI_WORK_HOME` points to your own working directory. Search state defaults to `AI_WORK_HOME/search-explore`; community account and tool state defaults to `AI_WORK_HOME/community-tools`. If `AI_WORK_HOME` is unset, entry points locate the repository root relative to the source and use its `workspace`, sharing the default workspace with other system entry points. The public copy does not read the original Codex search cache or automatically migrate old temporary caches.

| Variable | Purpose |
| --- | --- |
| `AI_WORK_HOME` | General data and state workspace. |
| `SEARCH_TOOLS_STATE_DIR` | Separate directory for search candidates and query progress. |
| `COMMUNITY_TOOLS_STATE_DIR` | Separate directory for Context7 and Bilibili credential state. |
| `COMMUNITY_TOOLS_PYTHON` | Python executable with Bilibili dependencies installed; defaults to `bilibili-venv` beside the plugin. |
| `DOMESTIC_SEARCH_CORE` | Search-core override for Chinese forum and Bilibili collection modules; defaults to a relative reference to repository `core.mjs`. |
| `INTERNATIONAL_SEARCH_CORE` | Search-core override for international forums; defaults to a relative reference to repository `core.mjs`. |
| `GITHUB_TOKEN` or `GH_TOKEN` | GitHub read authentication; broad catalog discovery reads `GITHUB_TOKEN`, while the dedicated GitHub adapter also supports `GH_TOKEN`. |
| `TAVILY_API_KEY` | Optional Tavily source. |
| `REDDIT_ACCESS_TOKEN`, `REDDIT_USER_AGENT` | Official Reddit OAuth data reading. |
| `HTTPS_PROXY`, `HTTP_PROXY` | Proxy configuration for search-catalog discovery and Jina fallback reading; lowercase forms are supported. |

For example, set the workspace in Windows PowerShell:

~~~powershell
$env:AI_WORK_HOME = 'D:/AI-Workspace'
~~~

Proxy implementations differ between programs. Catalog requests in `explore.mjs` read environment proxies and fall back to the system proxy on Windows. Jina uses the current process's environment proxy. Core web requests and native `fetch` in the standalone forum/GitHub modules do not automatically share those proxy settings; their runtime environment or a JavaScript-injected `fetch` implementation must provide the corresponding network capability. Configuring a proxy does not establish access to every source.

CLI `--out` or `--output` writes to the specified location. Search state retains every received candidate; `max_chars` limits only the displayed window. Queries, private source files, and credentials in your working directory are your data and should not be committed to the public repository.

## From discovery to original text

Run all commands below from the repository root. A query file can live in your `AI_WORK_HOME`; its contents are a string array. This example includes an English query and a Chinese query for Chinese-language practice:

~~~json
["personal knowledge base open source", "中文 知识库 语义搜索 实践"]
~~~

Begin broad discovery with actual queries:

~~~sh
node plugins/search-tools/cli.mjs explore --goal "Find a maintainable knowledge-base implementation" --queries-file queries.json --mode topic
node plugins/search-tools/cli.mjs candidates --goal "Find a maintainable knowledge-base implementation" --max-chars 16000
~~~

To also use structured catalogs such as GitHub/npm, pass `--terms`. Catalog requests use `terms`; web engines use `queries`. Passing only `--queries-file` does not automatically turn every sentence into a GitHub repository-catalog search.

~~~sh
node plugins/search-tools/cli.mjs explore --goal "Find a maintainable knowledge-base implementation" --terms "knowledge base,知识库" --queries-file queries.json --mode tools
node plugins/search-tools/cli.mjs candidates --goal "Find a maintainable knowledge-base implementation" --details --offset 0 --max-chars 16000
~~~

By default, Chinese queries are sent separately to Baidu and 360, and English queries separately to Bing and DuckDuckGo. `--engines` and `--sources` provide explicit overrides. Automatic catalog sources include GitHub; `tools` mode also includes npm. The MCP registry is included when the tool purpose satisfies the original implementation's MCP-related conditions. Tavily is included when its key is configured.

Repeating the same `goal` continues source pages and remaining queries. `--reset` clears that goal's collection state and starts again. The program preserves coverage gaps caused by request timeouts, provider limits, unobserved next-page controls, and caller budgets. Those conditions do not mean the topic has been exhaustively searched.

Follow the returned `catalog.next` to continue browsing titles. `--ids` expands details for model-selected candidates. Titles and summaries are leads; read the original source before adopting technical conclusions:

~~~sh
node plugins/search-tools/cli.mjs read --url https://example.org/article --max-length 12000
node plugins/search-tools/cli.mjs read --url https://example.org/article --offset 12000 --max-length 12000
node plugins/search-tools/cli.mjs expand --url https://github.com/example/project --goal "Find a maintainable knowledge-base implementation"
~~~

`expand` saves all parseable links mentioned by a source, then returns a title window according to the character budget. GitHub repositories prioritize the raw file for the public README. `read` returns extraction method, date source, final URL, total character count, `next_offset`, and actual failure status. It does not execute site JavaScript; dynamic content and binary PDFs require an appropriate host reader.

To inspect a search-engine page independently:

~~~sh
node plugins/search-tools/cli.mjs search --query "知识库 实践" --engine so --count 20
~~~

Here the Chinese query means “knowledge-base practice.” `count` is a provider page-size hint; the original implementation retains all results parsed from that page. Save the returned `pagination.next_request` as JSON, then continue with the original engine:

~~~sh
node plugins/search-tools/cli.mjs search --query "知识库 实践" --engine so --page-request-file next-page.json
~~~

## MCP integration

This is a stdio MCP server. Put the actual absolute repository path in your host configuration's `args`; replace `/absolute/path` below with your path. Set environment variables in your own host configuration. The repository provides empty-value examples only.

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

Tool names are `search_public`, `read_source`, `explore_search`, `expand_source`, and `read_candidates`. For legacy Baidu names, use `plugins/baidu-search-mcp/index.repaired.mjs` instead. It exposes `baidu_search` and `fetch_url` while retaining the latter three discovery/candidate tools. The compatibility entry point accepts `--max-result=20`, `--fetch-content-count=0`, and `--max-content-length=6000`; actual search and source reading still come from sibling `search-tools`.

The host determines registration. This release did not change users' Codex, Claude, or browser configuration or establish real account connections.

## GitHub, forums, and Bilibili

The GitHub CLI provides repositories, issues, comments, source, and tree location. Source-file reading resolves `ref` and retains the commit evidence:

~~~sh
node modules/search-integrations/github-search.mjs search --kind repositories --query "knowledge base"
node modules/search-integrations/github-search.mjs repo --repo OWNER/NAME --include-release
node modules/search-integrations/github-search.mjs file --repo OWNER/NAME --path README.md --ref HEAD
node modules/search-integrations/github-search.mjs issue --repo OWNER/NAME --number 1
node modules/search-integrations/github-search.mjs locate --repo OWNER/NAME --path-query search --local /path/to/clone
~~~

Code search needs authentication. Anonymous repository/issue search, public files, and local git location are separate entry points. JavaScript `createGitHubConnector(callTool)` can attach a host's existing GitHub connector. Running the Node CLI alone does not inherit the host account or extract connector credentials. `issue-snapshot` can normalize existing source JSON, but saving a snapshot is not a fresh live read.

Chinese forums return main posts, addenda, reply counts, date provenance, and next pages by site:

~~~sh
node modules/search-integrations/domestic-search.mjs sites
node modules/search-integrations/domestic-search.mjs search --query "知识库" --sites v2ex,linuxdo,csdn
node modules/search-integrations/domestic-search.mjs read --url https://www.v2ex.com/t/123456
~~~

The Chinese query above means “knowledge base.” International forums distinguish index discovery from official post reading:

~~~sh
node modules/search-integrations/international-search.mjs search --source hn --query "knowledge base" --sort date
node modules/search-integrations/international-search.mjs search --source discourse --site python --query "packaging"
node modules/search-integrations/international-search.mjs read --url https://news.ycombinator.com/item?id=123456
~~~

Reddit requires an authorized OAuth token and a real user agent. Missing credentials return the corresponding status and fallback route. Discourse supports its official forum, Python, Hugging Face, Rust, and Julia by default; JavaScript configuration can add public forum origins.

When a forum is restricted, `host-request` generates a host action request. Existing host reading results can be supplied with `--fallback-file` and `--host-only true`, avoiding another request to the restricted network entry point. Supplied content must match the requested specific post or reply and be actual original text. Search summaries cannot substitute for source text:

~~~sh
node modules/search-integrations/domestic-search.mjs host-request --action read --url https://www.v2ex.com/t/123456
node modules/search-integrations/domestic-search.mjs read --url https://www.v2ex.com/t/123456 --host-only true --fallback-file host-source.json
node modules/search-integrations/international-search.mjs read --url https://news.ycombinator.com/item?id=123456 --host-only true --fallback-file host-source.json
~~~

Output preserves the evidence level of the host page and unread scope. The code does not automatically take over a browser, export Cookies, or solve verification challenges.

The Bilibili module returns descriptions, comments on the current page, and obtainable subtitles while explicitly stating that video visuals and audio were not watched:

~~~sh
node modules/search-integrations/bilibili-collection.mjs search --query "知识库 教程" --output discovery.json
node modules/search-integrations/bilibili-collection.mjs read --url BVxxxxxxxxxx --comment-limit 20 --max-parts 1 --output video.json --source-output source.json
node modules/search-integrations/bilibili-collection.mjs resume --from video.json --output resumed.json
node modules/search-integrations/bilibili-collection.mjs convert --from video.json --output source.json
~~~

The Chinese query means “knowledge-base tutorial.” Replace `BVxxxxxxxxxx` with a real BV identifier. `resume` preserves successful portions and fills only missing subtitles or other portions not obtained. Actual host source text can also be supplied through `--host-file` and `--host-only true`. Output retains original sources, read coverage, and unmet requirements.

## Community tools CLI

~~~sh
node plugins/community-tools/cli.mjs ctx7 library react "effects cleanup" --json
node plugins/community-tools/cli.mjs ctx7 docs /facebook/react "effects cleanup" --json
node plugins/community-tools/cli.mjs bili search "知识库" --type video --max 5 --json
node plugins/community-tools/cli.mjs bili video BVxxxxxxxxxx --subtitle-timeline --comments --json
node plugins/community-tools/cli.mjs opencli list
node plugins/community-tools/cli.mjs jina https://example.org/article --out article.md --max-chars 40000
~~~

The Context7 entry point permits `library`, `docs`, `whoami`, help, and version; it does not run `setup` or `login`. The Bilibili wrapper permits reading commands and disables extraction of browser Cookies. You can perform QR-code login yourself by running `bili login` in an interactive terminal; credentials stay in your own state directory. Jina reads public pages by URL and saves source text and a receipt recording truncation and retrieval time.

OpenCLI forwards upstream commands, and its functions are not limited to reading. The caller selects the specific action. This repository's forum, GitHub, and Bilibili source adapters are read-only implementations; they do not authorize other OpenCLI write actions. Third-party connection requirements follow upstream maintenance.

## Licensing and actual delivery level

Author-owned search implementations, compatibility entry points, source adapters, and wrapper scripts are published under the repository's MIT license. Dependencies retain their own licenses, and installed third-party implementations have not been reattributed.

[search-tools dependency notes](../../plugins/search-tools/THIRD-PARTY.md), [community-tool dependency notes](../../plugins/community-tools/THIRD-PARTY.md), and [Baidu compatibility entry point](../../plugins/baidu-search-mcp/README.md) list original sources and licenses. OpenCLI and bilibili-cli use Apache-2.0; bilibili-api-python uses GPL-3.0-or-later, which the repository's MIT license does not cover. Third-party LICENSE files remain in their original form.

This release extracted the source in use, adapted public paths and state directories, declared dependencies, removed business-specific coupling from source conversion, and saved documentation. Existing general test source was retained for maintainers' reference. No tests were created or run, dependencies installed, real accounts requested, MCP server started, or persistent connections verified during this work. Site restrictions, provider quotas, dynamic pages, comment pagination, and subtitle availability must be described by actual runtime results.

# 百度 MCP 名称兼容入口

本入口把旧 baidu_search、fetch_url 工具名接到同级 search-tools 的现用通用实现，同时保留 explore_search、expand_source、read_candidates。先安装 ../search-tools 的依赖，再运行：

~~~sh
node index.repaired.mjs --max-result=20 --fetch-content-count=0 --max-content-length=6000
~~~

此兼容包装与统一搜索实现按仓库 MIT 公开。它沿用过 [caiyili/baidu-search-mcp](https://github.com/caiyili/baidu-search-mcp) 的工具名称及调用参数，但不加载或打包原 npm 包。原上游 baidu-search-mcp 1.0.1 作者为 caiyili，许可为 MIT；[原许可](licenses/upstream-baidu-search-mcp-MIT.txt)保留原文，未改署名。搜索、分页、原文和 MCP 注册用法见 [统一说明](../../docs/search-plugins.md)。


# 第三方依赖

本目录 core.mjs、explore.mjs、cli.mjs、server.mjs 为本项目公开实现，适用仓库 MIT。下列包通过 package-lock.json 和 npm ci 安装，安装源码没有复制到仓库，其许可继续独立适用。版本取自此次现用安装与锁定清单。

| 包 | 锁定版本 | 许可 | 原来源 |
| --- | --- | --- | --- |
| @modelcontextprotocol/sdk | 1.31.0 | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| @mozilla/readability | 0.6.0 | Apache-2.0 | https://github.com/mozilla/readability |
| cheerio | 1.2.0 | MIT | https://github.com/cheeriojs/cheerio |
| https-proxy-agent | 7.0.6 | MIT | https://github.com/TooTallNate/proxy-agents |
| jsdom | 26.1.0 | MIT | https://github.com/jsdom/jsdom |
| node-fetch | 3.3.2 | MIT | https://github.com/node-fetch/node-fetch |

传递依赖的版本与许可记录在 package-lock.json，完整许可正文随安装包保留。没有把这些第三方实现改为本人的 MIT。


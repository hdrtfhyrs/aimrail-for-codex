# 第三方工具与许可

cli.mjs、bili-local.py 和 restore.ps1 是本项目的调用与状态隔离脚本，按仓库 MIT 公开。第三方工具由 npm/Python 包管理器安装，不分发原用户的 node_modules、虚拟环境、浏览器 profile 或凭据。

| 工具 | 此次锁定版本 | 上游作者与来源 | 原许可 |
| --- | --- | --- | --- |
| ctx7 | 0.5.12 | Upstash，[Context7](https://github.com/upstash/context7) | [MIT](licenses/context7-MIT.txt) |
| @jackwener/opencli | 1.8.8 | jackwener，[OpenCLI](https://github.com/jackwener/opencli) | [Apache-2.0](licenses/opencli-Apache-2.0.txt) |
| undici | 7.29.0 | Node.js contributors，[undici](https://github.com/nodejs/undici) | MIT |
| bilibili-cli | 0.6.2 | jackwener，[bilibili-cli](https://github.com/jackwener/bilibili-cli) | [Apache-2.0](licenses/bilibili-cli-Apache-2.0.txt) |
| bilibili-api-python | 17.4.2 | Nemo2011，[bilibili-api](https://github.com/Nemo2011/bilibili-api) | [GPL-3.0-or-later](licenses/bilibili-api-python-GPL-3.0-or-later.txt) |

bilibili-api-python 是 bilibili-cli 的第三方依赖，其 GPL 许可不受仓库根 MIT 覆盖。用户重新分发这些工具或其修改版本时应依据相应上游许可处理；这里保存原 LICENSE 和依赖清单，不改原作者声明。

Python 清单保留现用环境的依赖版本。浏览器 Cookie 提取虽然是上游包的能力，bili-local.py 在本入口将其关闭；本项目没有复制或读取用户浏览器 Cookie。详细安装、状态目录、来源读取与实际未运行边界见 [搜索插件用法](../../docs/search-plugins.md)。


# 来源、依赖与许可

仓库根 MIT 许可证适用于本项目自有实现和文档。依赖包、外部工具、宿主产品及原作者材料继续按其自己的许可使用；它们没有因为被调用而改为本项目 MIT。

| 范围 | 来源与处理 |
|---|---|
| 项目、知识、任务接续与一般系统代码 | 从作者现用通用模块提取；数据路径、目录导航和配置改为公开布局 |
| 搜索与网页原文读取 | 自有代码公开；MCP SDK、Readability、Cheerio、jsdom、node-fetch 等通过 npm 安装，见 [搜索依赖清单](plugins/search-tools/THIRD-PARTY.md) |
| 社区工具包装 | 自有包装代码公开；Context7、OpenCLI、B站工具按各自许可安装，见 [社区工具清单](plugins/community-tools/THIRD-PARTY.md) |
| 技能、宿主角色与钩子 | 自有正文和适配公开；涉及官方技能与运行时的部分按 [技能与宿主说明](docs/skills-and-hosts.md)区分自有内容与外部依赖 |
| 一般模块的 npm/Python 依赖 | 查看 [一般系统模块说明](docs/general-system.md)以及各目录的 package/requirements 清单；依赖安装包不随源码分发 |

社区工具使用的 bilibili-api-python 具有 GPL-3.0-or-later 许可；OpenCLI 和 bilibili-cli 为 Apache-2.0，Context7 为 MIT。有关原许可正文随社区工具声明保留，根 MIT 不覆盖这些许可证。安装和重新分发时以对应版本的上游许可为准。

商业 AI 宿主、账号连接器、浏览器桥接、模型权重和官方插件安装副本不在本仓库中。使用者通过对应产品或包管理器取得，提供自己的访问权限和配置。外部服务的额度、网络和使用条件仍由服务方决定。

检索、SQLite FTS5、embedding、RRF、多来源发现与文件接续等通用方法的使用，不构成对这些方法的原创性声明。研究文档中的原来源继续归原作者；提取通用实现时没有复制私人研究原件、用户对话或账号数据。

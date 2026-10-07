# 代码来源与公开范围

<!-- bilingual-navigation -->
简体中文 · [English](en/source-and-scope.md) · [中文首页](../README.zh-CN.md)

本仓库由作者的个人AI工作系统提取整理，公开整体工作思想、可复用核心、自有通用插件、技能和支持模块。公开文件从独立目录建立，使用通用配置；私人生产目录和历史数据不上传。

| 文件 | 处理方式 |
|---|---|
| `shared-state.mjs`、`knowledge-lifecycle.mjs` | 提取现用实现，保留Markdown原件、并发更新、归档与知识退役逻辑 |
| `project-context.mjs`、`knowledge.mjs`、`knowledge-record.mjs`、`recall.mjs`、`deliverables.mjs` | 提取现用实现，将个人路径、缓存和登记位置改为工作区配置；宿主专用项目目录替换成文件目录适配 |
| `paths.mjs`、`registry-store.mjs`、`project-registry.mjs`、`object-access.mjs`、`resources.mjs`、`bin/ai-work.mjs` | 公开版适配，提供通用路径、空白登记、版本保存和命令入口 |
| `templates/`、`examples/` | 通用工作原则、空白项目结构和虚构示例 |
| `plugins/`、`modules/search-integrations/` | 现用搜索与社区接入源码，保留多来源发现、原文读取与来源扩展逻辑；个人账号、数据和安装依赖排除 |
| `skills/`、`integrations/` | 自有技能、宿主钩子、角色和通用接续模板；来源与宿主条件见专项文档 |
| `modules/system/`、`tools/` | 通用信息、协作、对象资料、运行、存储与展示实现；文件和模块对应关系见专项文档 |

本版没有搬运个人知识内容、原始会话、账户档案、历史缓存和具体业务数据。小说/训练/付费创作生产链、闲鱼托管/订单/key售卖、专属销售与赚钱产品制作链排除。通用的资料收集、运行和存储功能保留，使用者提供自己的数据和服务。

第三方安装副本、商业宿主程序、官方运行时和模型权重不打包；适配代码按来源处理，自有修改与上游许可分开说明。第三方依赖声明见 [第三方声明](../THIRD_PARTY_NOTICES.md)。模块目录的 README 和专项文档说明实际源码范围及依赖。

检索采用公开的中文分词、SQLite FTS5、embedding和RRF等方法；这些算法的存在不构成对它们的原创性声明。原始文档阅读和向量服务能力来自运行时及可选服务，保留各自许可。

核心与相关模块来自作者环境中使用的实现，本公开版包含路径适配和新入口；这不等于已证明任意宿主、操作系统与任务条件下都有效。公开声明区分源码、配置、实际调用与长期运行；具体使用中的问题按有关原件定点修复。

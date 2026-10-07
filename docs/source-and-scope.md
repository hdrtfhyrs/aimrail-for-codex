# 代码来源与公开范围

本仓库由作者的个人AI工作系统提取整理，按本次公开范围保留整体工作思想与可复用核心。公开文件从独立目录建立，使用新的Git历史和通用配置。

| 文件 | 处理方式 |
|---|---|
| `shared-state.mjs`、`knowledge-lifecycle.mjs` | 提取现用实现，保留Markdown原件、并发更新、归档与知识退役逻辑 |
| `project-context.mjs`、`knowledge.mjs`、`knowledge-record.mjs`、`recall.mjs`、`deliverables.mjs` | 提取现用实现，将个人路径、缓存和登记位置改为工作区配置；宿主专用项目目录替换成文件目录适配 |
| `paths.mjs`、`registry-store.mjs`、`project-registry.mjs`、`object-access.mjs`、`resources.mjs`、`bin/ai-work.mjs` | 公开版适配，提供通用路径、空白登记、版本保存和命令入口 |
| `templates/`、`examples/` | 通用工作原则、空白项目结构和虚构示例 |

本版没有搬运个人知识内容、原始会话、账户档案、历史缓存和具体业务数据。安装的插件、技能包、第三方源码及模型权重不在仓库内。依赖这些能力的业务由使用者自行接入。

检索采用公开的中文分词、SQLite FTS5、embedding和RRF等方法；这些算法的存在不构成对它们的原创性声明。原始文档阅读和向量服务能力来自运行时及可选服务，保留各自许可。

核心模块曾在作者环境中使用，本公开版包含路径适配和新入口；这不等于已证明任意宿主、操作系统与任务条件下都有效。实际使用中的问题按有关原件定点修复。

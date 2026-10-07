# Aimrail for Codex

**为 Codex 扩展项目接续、资料研究与协作执行。**

Aimrail 为 Codex 接入完整任务、资料研究、知识召回、技能和通用工具。目标、依据与成果保存为可读取的原件，在换聊天、压缩上下文或更换执行者后继续使用。

Codex 提供模型与工具，Aimrail 提供任务记录、研究方法、共用知识和接入机制。核心是 Node.js CLI，仓库也包含 Claude 与 Pi 的适配入口。

[English](README.md) · **简体中文**

[快速开始](docs/quickstart.md) · [搜索与 MCP](docs/search-plugins.md) · [宿主接入](docs/skills-and-hosts.md) · [完整文档](#文档)

[MIT](LICENSE) · Node.js 24+ · [发布版本](https://github.com/hdrtfhyrs/aimrail-for-codex/releases) · [问题反馈](https://github.com/hdrtfhyrs/aimrail-for-codex/issues)

## 为什么做 Aimrail

持续工作需要保留比聊天历史更多的东西：目标会被补充，来源不断积累，决定有适用条件，后续还可能换一个聊天或执行者来完成任务。

Aimrail 分开保存项目目标、当前完整任务、有效条件、实际进度与成果。AI 将这些原件与新指令一起理解，研究缺少的信息，再把结果保存给下一步使用。

## 核心能力

| 能力 | 提供什么 |
|---|---|
| **项目接续** | 项目与分支原件、聊天归属、上下文融合和文件交接；目标与完成标准独立于进度。 |
| **资料研究** | 中英文搜索、GitHub/npm/MCP 发现、候选保存、分页、原文读取和链接扩展。 |
| **知识与经验召回** | 本地全文检索、可选语义召回、排序融合、原件引用和可恢复的知识退役。 |
| **对象与资源** | 保存职责、条件、来源、工具和账号权益，区分资源声明与实际可用状态。 |
| **协作与执行** | 任务窗口、归属与交接、加锁状态更新、事件队列、执行租约、检查点与重试。 |
| **信息处理** | 来源采集、分析队列、云批次接收和持久接续记录。 |
| **成果与存储** | 成果登记、全文与网页展示、存储适配、快照与限定范围归档。 |

[实现机制](docs/mechanisms.md)进一步说明状态锁、来源覆盖、混合召回和执行恢复，并链接到对应源码。

## 快速开始

文件原件核心需要 **Node.js 24 或更新版本**。在仓库根目录执行：

```powershell
git clone https://github.com/hdrtfhyrs/aimrail-for-codex.git
cd aimrail-for-codex

node bin/ai-work.mjs init --workspace ./workspace --language zh-CN
node bin/ai-work.mjs project init --workspace ./workspace --language zh-CN --name "资料整理工具" --goal "按主题整理资料并保留出处"
node bin/ai-work.mjs projects --workspace ./workspace
```

这些命令创建工作区与项目原件。让 Codex 读取 `workspace/AGENTS.md` 和项目中的目标、任务文件，再沿[完整上手说明](docs/quickstart.md)更新任务、召回资料和生成交接文件。

英文指令使用 `--language en`。两版共用运行代码和持久化协议。

## 按需接入模块

从核心开始，再配置当前工作需要的模块。

| 组件 | 源码 | 配置说明 |
|---|---|---|
| 项目、状态与知识核心 | [src](src/) · [CLI](bin/ai-work.mjs) | [快速开始](docs/quickstart.md) |
| 搜索 MCP 与社区工具包装 | [plugins](plugins/) · [来源读取](modules/search-integrations/) | [搜索配置](docs/search-plugins.md) |
| 技能、钩子、职责与宿主适配 | [skills](skills/) · [integrations](integrations/) | [宿主接入](docs/skills-and-hosts.md) |
| 信息、协作与运行模块 | [modules/system](modules/system/) | [系统配置](docs/general-system.md) |
| 英文技能与任务模板 | [i18n/en](i18n/en/) | [语言说明](docs/en/languages.md) |

模型、外部服务、浏览器和持续运行使用你配置的环境。各指南说明对应依赖与实际入口。

## 文档

| 指南 | 内容 |
|---|---|
| [快速开始](docs/quickstart.md) | 初始化项目、更新任务、召回原件与交接工作 |
| [搜索与 MCP](docs/search-plugins.md) | 搜索渠道、社区工具、来源读取与 MCP 配置 |
| [技能与宿主接入](docs/skills-and-hosts.md) | Codex/Claude/Pi 适配、钩子、自有技能与职责模板 |
| [通用系统模块](docs/general-system.md) | 信息、对象、协作、运行、存储与成果展示 |
| [架构](docs/architecture.md) | 文件布局、模块职责与接入关系 |
| [实现机制](docs/mechanisms.md) | 状态更新、来源覆盖、混合召回与执行恢复 |
| [设计原则](docs/philosophy.md) | 目标、证据、判断、持久保存与协作 |
| [语言说明](docs/en/languages.md) | 英文材料与兼容协议名 |
| [源码与范围](docs/source-and-scope.md) | 公开实现、提取模块与私人数据边界 |

## 常见问题

<details>
<summary>怎样接入 Codex？</summary>

项目与知识核心通过 CLI 调用。自有技能说明研究、协作与接续方法，宿主钩子在配置的事件中取得相关项目原件。沿[宿主接入指南](docs/skills-and-hosts.md)注册当前宿主实际支持的入口。

</details>

<details>
<summary>可以只使用搜索插件或某个模块吗？</summary>

可以。搜索工具、来源读取、自有技能和文件原件核心各有入口。从[模块表](#按需接入模块)选择所需组件，按对应文档配置依赖。

</details>

<details>
<summary>英文材料和私人数据怎样处理？</summary>

仓库包含英文指南、技能与模板。部分持久文件名、状态键和运行输出保留中文以兼容原协议。使用者自己的记录和配置放在被 Git 忽略的工作区，公开仓库只提供空白配置与虚构示例。

</details>

## 参与改进

欢迎提交实际使用问题、用途、文档修正、来源适配和宿主接入改进，中文和英文都可以。通过[问题表单](https://github.com/hdrtfhyrs/aimrail-for-codex/issues/new/choose)提交反馈，修改前可读[贡献说明](CONTRIBUTING.md)。

已发布的变化沿[更新记录](CHANGELOG.md)与[正式版本](https://github.com/hdrtfhyrs/aimrail-for-codex/releases)查看。

## 许可

自有代码和文档使用 [MIT 许可](LICENSE)。第三方依赖和上游技能保留各自许可；本地技能适配只发布作者自己的新增内容。具体边界沿[第三方说明](THIRD_PARTY_NOTICES.md)。

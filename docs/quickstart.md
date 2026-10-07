# 快速开始

<!-- bilingual-navigation -->
简体中文 · [English](en/quickstart.md) · [中文首页](../README.zh-CN.md)

使用 Node.js 24 或更新版本，在仓库根目录执行以下命令。命令不会安装常驻服务、插件或开机/登录触发。

## 创建工作区与项目

```powershell
node bin/ai-work.mjs init --workspace ./workspace
node bin/ai-work.mjs project init --workspace ./workspace --name "资料整理工具" --goal "做一个能按主题整理资料并保留出处的工具"
node bin/ai-work.mjs projects --workspace ./workspace
```

也可以将 `--workspace` 指向任意明确的外部目录。工作区已有文件会保留；同名项目已有原件时，初始化拒绝覆盖。

## 保存一个完整任务

先让AI根据真实交办修改任务JSON。这里使用的 `examples/task-update.json` 是虚构结构示例：

```powershell
$projectDir = (Resolve-Path "./workspace/projects/资料整理工具").Path
$taskFile = (Resolve-Path "./examples/task-update.json").Path
node bin/ai-work.mjs state update --workspace ./workspace --project $projectDir --input $taskFile
node bin/ai-work.mjs context read --workspace ./workspace --project $projectDir --branch source-organizer
```

Linux/macOS终端可将这两个参数换成相应绝对路径。状态接口接受中文字段，也接受 `goal`、`criteria`、`phase`、`owner`、`done`、`next`、`conditions`、`ledger`、`evidence`。后续更新不再给 `create:true`，仅给变化字段。

用户补充或纠正后，AI将新话联系原项目，修改受影响的目标、条件和标准。只报告进度时修改 `done`、`next` 和阶段即可。

## 知识与原件读取

把自己的 Markdown 资料分别放到工作区 `memory/knowledge/`、`memory/experiences/` 和 `memory/errors/`，或在 `knowledge-sources.json` 显式登记其它来源。

```powershell
node bin/ai-work.mjs knowledge overview --workspace ./workspace
node bin/ai-work.mjs knowledge catalog --json --workspace ./workspace
node bin/ai-work.mjs knowledge search --query "换聊天后继续原项目" --json --workspace ./workspace
node bin/ai-work.mjs recall search --query "换聊天后继续原项目" --no-vector --json --workspace ./workspace
```

从返回的ID或原件引用继续 `knowledge read --ref ... --json`。读原件分页时跟随 `nextCursor`，直到指定范围 `complete:true`；一个片段不代表已经读完材料。

向量检索可选。自己启动 Ollama 并准备 embedding 模型后，执行 `recall index --embed`；默认模型名是 `bge-m3`，可以用 `RECALL_EMBED_MODEL` 修改。本命令不自动启动服务或下载模型。

## 对象和资源

```powershell
node bin/ai-work.mjs objects list --workspace ./workspace
node bin/ai-work.mjs objects save --input ./examples/object.json --expected-version 0 --workspace ./workspace
node bin/ai-work.mjs objects read --id local-text-index --workspace ./workspace
node bin/ai-work.mjs resources list --kind resources --workspace ./workspace
```

示例对象并非真实资源。更新已有对象时传当前 `version`。资源更新使用同样的 `--input` 和 `--expected-version`，并明确 `--kind`。

## 成果与交接

将真实产物放到项目的 `成果/` 下。使用 `deliverables --help` 查看登记JSON格式与命令，再按实际结果登记。

```powershell
node bin/ai-work.mjs deliverables --help --workspace ./workspace
node bin/ai-work.mjs handoff --workspace ./workspace --project $projectDir --branch source-organizer --out ./workspace/handoffs/source-organizer.md
```

交接会创建一个新文件，已有文件不会覆盖。接收方读它，再沿引用展开源码、资料和成果；继续修改的状态仍回到项目原件。

## 使用过程中看什么

看AI能否保持完整目标、适用地采用资料、遇阻换办法，并交回实际成果。初始化、检索和状态保存只提供工作依据，不能证明理解或业务已经完成。实际错误带着具体调用与有关原件修复即可。

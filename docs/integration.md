# 接入现有 AI 工具

这个核心可以被任何能读本地文件、执行命令的AI工具使用。先选择一个工作区，再将工作区 `AGENTS.md` 和目标项目入口交给它；模型和外部工具由宿主提供。

## 任务开始时取得材料

先读项目核心，再从项目概况和共享状态找到本轮真正负责的分支。可以直接调用：

```text
node bin/ai-work.mjs context read --workspace ABS_WORKSPACE --project ABS_PROJECT --branch BRANCH_ID
```

需要历史知识时取得目录或候选，按用途读取原件。缺适用办法时，由宿主搜索外部成熟实践；本核心不把已安装工具作为全部候选。

## 保存变化与换人接手

AI判断新消息是补充、纠正还是目标变化，脚本保存更新后的完整任务。任务JSON使用 `state update` 接口。归属明确时可以保存会话绑定：

```text
node bin/ai-work.mjs context bind --workspace ABS_WORKSPACE --host shared --session FULL_SESSION_ID --project ABS_PROJECT --branch BRANCH_ID
```

真实会话ID由宿主提供，不要拿示例ID替代生产身份。需要改变已保存归属时，明确变更原因，并使用 `context rebind`。

新执行者拿到项目、分支、已有成果和交接文件，读取原件后自主继续。资料入口不是接手所有相关分支的授权。

## 自动注入由宿主承担

支持生命周期hook的宿主可以在任务消息到达时读取相同上下文，也可以在压缩或交接后重读。插件和hook的注册格式因宿主而异；本公开版没有复制作者的私人宿主配置，也不会直接改写已有配置。

实际接入中，只注入当前任务所需的核心与导航；全文沿引用按需读取。用户数据所在的工作区应保持私有。

公开的研究与协作技能、宿主钩子、角色模板和接续说明在 `skills/`、`integrations/`；配置前先读 [技能与宿主接入](skills-and-hosts.md)。源码提供实际适配实现，宿主注册仍使用本人的配置，不直接复制生产账户设置。

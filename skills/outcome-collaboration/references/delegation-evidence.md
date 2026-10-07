# 分工判断的依据与边界

拆分有争议时按需展开这里的原证；这是取舍依据，不是固定工序。2026-10-02查得：

- [Anthropic研究系统](https://www.anthropic.com/engineering/multi-agent-research-system)适合多个独立资料方向；模糊委托会重复或漏查，过量代理和更新会相互干扰。大量共享上下文/依赖的编程任务未必适合相同做法，厂商研究自测增益及token比例不能套成本机通用结论。
- [Claude团队官方文档](https://code.claude.com/docs/en/agent-teams)支持独立文件归属和任务依赖，强顺序/同文件工作增加协调成本。其示例人数、定期监看及可选质量hook不作为本地要求；本地重要回报和用户现行授权优先。文档仍称teams实验性，不据阅读启用配置。
- [OpenAI子代理文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)说明独立上下文可将探索日志移出主线，并行写入需处理冲突，代理有额外模型/工具开销；主线保留目标和决定，正式成果仍由执行负责人直接落文件。
- 国内作者[MetaGPT中文教程](https://docs.deepwisdom.ai/main/zh/guide/tutorials/multi_agent_101.html)用重要上游产物触发后续动作。[角色源码](https://github.com/FoundationAgents/MetaGPT/blob/11cdf466d042aece04fc6cfd13b28e1a70341b1f/metagpt/roles/role.py#L399)按关注来源/收件人过滤新消息。借用相关依赖才传的思路，不搬公司角色、逐轮SOP或再造消息平台。
- [MASFT研究v1](https://arxiv.org/html/2503.13657v1)在当时框架、模型与任务样本发现角色越界、重要信息不共享、忽视同伴意见及错误终止等失败；提示或拓扑改善未解决所有问题。支持看实际末端成果，不提供当前模型最佳人数或永久可靠保证。

本地[人数/AI消费者误判](../../../workspace/memory/experiences/goal-context-before-actions.md)保留19创建、旧固定6及图误派网页的原证，长期修法仍待验证；[规则膨胀](../../../workspace/memory/experiences/rule-and-workflow-bloat.md)只有局部减负/投递验证。采用这些边界，本次按账号、文件及分工三个独立成果划归属，由文件负责人整合导航；这是当前输入和写入条件下的安排，不是人数模板。

本轮详细证据、真实采用情况和未达项见[分工改进登记](../../../modules/system/成果/本轮账号与文件整合/分工改进登记/分工改进与试用说明.md)。

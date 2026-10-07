# Pi 宿主扩展与历史技能

这里保留用户自写的两个扩展及其实体实现。`extensions/pi-capabilities.js` 转到 `runtime/capability-loader.js`，后者按当前宿主已启用的工具生成按需能力目录；它不会安装工具，也不会突破宿主的工具范围。`extensions/pi-gpt6-fast.js` 在指定模型与提供方条件下修改请求，`/fast on|off|status` 控制本会话的 priority 请求字段，默认关闭。

Pi 宿主须提供扩展 API，包括命令注册、事件订阅、工具目录和当前会话访问。代码保留原来使用的事件名和模型标识；安装前按当前 Pi 和模型提供方实际支持情况选择。源码存在不能证明某个账户有对应模型、额度或 priority 服务。

`skills/` 中的 adaptive-research、adaptive-workflow 和 problem-solving 保留原 Pi 阶段的通用规则与参考正文。当前 Codex/Claude 的通用规则已由仓库 `skills/evidence-research`、`skills/outcome-collaboration` 等承接。旧正文的模型分层、新闻范围和验证方式属于旧阶段，不应覆盖当前用户条件；它们作为旧宿主适配源码保存，未在本次重新安装运行。

需要旧扩展的使用者将这些源文件放入本人 Pi 扩展目录，或用宿主支持的显式入口加载；不要复制私人 settings、账号连接和历史会话。没有设置开机或登录触发。

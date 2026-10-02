# 跨编码会话影响分析：实现与使用

本次实现对应“状态抽取 → 候选召回 → 关系判断 → 影响分级 → 选择性通知”流程。
核心判断是 A 的变化是否影响 B 的当前工作。相似度只用于召回；实体、依赖、契约和产物提供判断证据。

新增能力：

- 结构化记录目标、读写实体、调用/导入/类型依赖、契约版本及字段、产物版本、分支与工作区。
- 记录变化前后、计划/执行中/完成/取消状态、事件 ID、流版本、有效期和证据位置。
- 按 `hard_conflict`、`breaking_dependency`、`soft_relevance`、`background_only` 分级。
- 独立输出置信程度、启发式分数、严重度、紧迫度和建议动作。分数未经概率校准。
- 分别执行 `interrupt`、`defer`、`store-only`；仅在宿主提供的安全点交付提示，不终止正在执行的工具。
- 支持事件去重、连续版本替代、待处理通知、展示回执和处理确认；交付前检查过期及契约适配。
- 修复跨多个版本的契约检查：v2 有破坏性变化、v3 是兼容更新时，仍能提醒使用 v1 的会话。

可通过 CLI 录入 JSON 文件：

```bash
agentgit impact state --session 接收会话 --file consumer.json
agentgit impact publish --session 生产会话 --file change.json
agentgit impact inbox --session 接收会话 --json
agentgit impact ack 通知ID --session 接收会话
agentgit impact analyze --refresh --json
```

MCP 对应 `agentgit_impact_state`、`agentgit_impact_publish`、`agentgit_impacts` 和
`agentgit_impact_ack`。完整 JSON 示例、字段说明与持久化协议见[英文使用文档](CROSS-SESSION-IMPACT.md)。

普通工具事件与已有契约注册表会自动参与分析。工具写入事件本身不能证明接口破坏，
需要明确发布契约变化或结构化证据。当前实现提供本地精确实体/依赖匹配与词汇召回，
尚未接入 embedding 服务或全程序静态调用图；静态分析器可以通过相同 API 提交依赖。

默认仅考虑最近 30 分钟活动的接收会话。通知缓存有效期为 10 秒，守护进程持续刷新。
正常工具观察可能有一次轮询的延迟；声明已适配的新契约版本会立即使旧缓存失效。
声明会话状态会替换旧依赖；确认通知不会自动修改契约假设。

启用新协议后，Hook 只交付该会话的通知。已获用户授权的跨聊天协调队列只接收紧急影响，
普通相关更新在工具完成或下一轮会话交付。这次更新不会自动开启跨聊天发送。

运行 `node examples/impact/run.mjs` 可验证真实账本中的“返回类型改变 → 调用方收到通知 → 自行适配 → 提醒消失”流程。

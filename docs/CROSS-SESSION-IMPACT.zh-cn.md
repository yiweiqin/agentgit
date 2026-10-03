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
- 机械推导模块耦合图，用它把候选召回从"两两遍历"收窄到"与本次改动有依赖关系模块"。

三层通知只有一套命名：`interrupt` 即 `immediate`，`defer` 即 `defer`，`store-only` 即
`record`。映射只由 `notificationTierOf` 实现一处，投影与 Hook 因此不会对"何时注入"产生分歧。

## 机械模块耦合

`import` 是没人需要声明的依赖，这正是分析器能看见"从未写下自己依赖"的消费方的原因。
模块层完全机械地推导这张图：不调模型，也不需要任何手工标注。

模块边界是路径的纯函数，所以 CLI、MCP、守护进程和 Hook 得到同一个答案：优先取 workspace
包目录（`packages/<名称>/...`、`apps/`、`plugins/` 等），否则取 `src/` 下的一级目录，否则取仓库顶层目录。
耦合边分两类，且刻意分开存放：

| 边 | 来源 | 作用 |
| --- | --- | --- |
| `import` | 解析 `import` / `require` / `from`，并对已扫描文件与 workspace 包名做解析 | 唯一的结构性耦合；唯一参与路由与打分的边 |
| `co-change` | 同一 git 提交中出现过的模块对 | 次级信号；不计入度数、核心模块分与路由 |

`co-change` 被四道围栏限制，因为两个人碰巧在同一次提交里改过的两个模块之间没有任何声明的依赖，
把它当作耦合就是让"文件重叠"的误报换个名字回来。核心模块只按 import 度数排序，`agentgit modules`
只读地列出它们。

路由把候选池从"每个会话 × 每次变化"收窄到"与本次改动有依赖关系的模块"。`moduleRouting` 取
`off`（两两遍历的基线）、`one-hop`（默认）或 `transitive`，`moduleHops`（默认 2）限制传递跳数。
路由无法定位的候选、以及共享契约或产物的候选，永远不会被丢掉，所以 import 解析不出来的仓库会退化成
基线而不是漏报。把 `moduleRouting` 设为 `off` 就是消融。

产生的 `module_coupling` 证据永远是未确认的，因此它最强只能到达 `defer`；单靠一条机械依赖边
永远不能中断。在写入口，`preflight` 只在本来会给出 `allow` 的那条分支上参考同一判据，并且要求
本次改动带接口证据（`symbol::` 实体、具名契约，或牵涉契约的文件）。消费者模块正在改动 → 抬升
`review`；我们依赖的模块正在改动 → 抬升 `wait`。**模块重叠本身永远不构成证据**——这条规则只有
一处实现 `isStructuralModuleCoupling`，没有真实 import 的模块重叠不产生任何输出。

用 `agentgit modules [<模块>] [--json]` 或 MCP 工具 `agentgit_modules` 只读地查看这张图；
后者还能把某个路径解析到它所属的模块。

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

# 任务状态、契约与定向通知的有效性实验

目的：检验及时提醒能否减少真实产物的后续改写，并保留声明缺失、声明错误和不采用提醒时的失败结果。这里不构建调用图，不修改生产判定规则，不调用模型 API。

先读 [实验协议](PROTOCOL.md) 和 [固定计划](plan.json)。运行结果见 [实测报告](results/REPORT.md)。这是受控脚本回放；自主 agent 的净效率仍需后续随机配对实验验证。

从仓库根目录运行：

```bash
# 完整矩阵：11 场景 × 3 时点 × 7 臂 = 231 次任务执行
node examples/impact-effectiveness/run.mjs --out /tmp/impact-new-run

# 冒烟：字段更名、金额单位两个场景，共 14 次执行
node examples/impact-effectiveness/run.mjs --smoke --out /tmp/impact-smoke-new-run

# 不重新执行任务，核对原始结果哈希并独立重算统计
node examples/impact-effectiveness/analyze.mjs /tmp/impact-new-run

# 对已提交结果做完整性与防漏报测试；也可指定刚运行的结果
node --test examples/impact-effectiveness/analysis.test.mjs
IMPACT_RESULTS=/tmp/impact-new-run node --test examples/impact-effectiveness/analysis.test.mjs
```

运行目录必须是新目录，避免覆盖已有证据。`--keep` 保留临时工作区；默认只保存两组完整案例和所有运行的轨迹、账本及哈希。无需服务端或模型凭据，Node 版本要求与项目一致。退出码：0 机制门槛通过；1 已测量但未达标；2 无法测量或证据不一致。

各臂含义：git-final 为最终测试，record-only 只记录，targeted 提前通知并采用，targeted-half 按预定单元交替采用，targeted-ignore 收到但忽略，delayed-targeted 工作写完才通知，git-each 每完成一个工作项就测试。`targeted-half` 不表示实测 agent 采用率。

本实验包含真实的 Git 三方合并、真实的 Node 行为测试、既有契约注册表与结构化契约两条输入路径、既有交付处理器 hub.mjs 和通知回执。调度及消费者修复策略由脚本控制，后台投影同步调用，不能代表真实 daemon 延迟、模型推理、并发竞争、声明维护或阅读成本。这里不测完整 hook.mjs 分发器的成本，也不评价模块路由的召回收益。

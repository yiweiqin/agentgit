# AgenticGit 产品目标（GitHub 版）

日期：2026-09-23。性质：**要照着干的产品目标**，不是研究设计，也不承诺学术口径的自我克制。
上游依据：`AgenticGit_产品定位与Git能力对照_2026-09-23.md`。
已有资产：`04_协调插件/coord_ledger.py`（只读仪表，45 tests）、`04_协调插件/dsh-coord-governor/`（治理插件，163 tests）、`05_实验/`。

---

## 0. 一句话

> **Git 是马路，AgenticGit 是红绿灯。**
> 给每个 coding agent 发一张任务身份证，在它动手之前告诉它：**现在能不能写，谁会挡你，你是不是在重复别人的活。**

英文线索：`AgenticGit — Preemptive Coordination for Coding Agents, Built on Git.`
副标语（README 首屏用）：**Your agents don't know about each other. AgenticGit makes them.**

---

## 1. 产品是什么（先把形态定死）

**一个 npm 包 + 一个本地守护进程 + 一个 MCP server + 一个网页看板。** 装在 Git 仓库里，长在 Git 上，不改 Git 的对象格式。

```
npx agentgit demo            # 30 秒，零配置，零 API key，直接看到红绿灯拦下一次踩踏
npx agentgit init            # 认领当前仓库，建立协调账本
npx agentgit up              # 起本地守护进程 + 看板 localhost:7777
npx agentgit run <agent>     # 包住任意 agent CLI，自动分配 worktree + 任务身份
```

三件事必须成立，否则产品不成立：

1. **零安装可看**：`npx agentgit demo` 不依赖用户的仓库、不依赖任何模型 API。
2. **单命令接入**：`agentgit init` 之后，Cursor / Claude Code / Codex 通过 MCP 立刻能调用协调工具。
3. **不打断既有流程**：worktree、commit、PR、CI 全部保留，AgenticGit 只在它们之间加一层。

**明确不做**：不做新的版本库，不做 agent 框架，不做云端服务，快速路径里不调用大模型（判定必须是确定性的、毫秒级）。

---

## 2. 目标用户与"我为什么要装"

| 用户 | 现状 | 装完得到什么 |
|---|---|---|
| 一人开 4–8 个 agent 会话的独立开发者 | 会话之间互相不知道，回过神来发现两份一样的实现 | 开工前就被提示"这个活别人在干" |
| 小团队，每人跑多个 agent | 人工协调跟不上，review 靠运气 | 契约变更自动通知到下游调用点 |
| 已经用 worktree + CI 的熟手 | 隔离和门禁都够，缺的是**执行中**的可见性 | 一个看板看到所有在飞任务和未提交成果 |

**反面用户（不要讨好）**：一个人一个 agent 慢慢写的人。对他额外开销就是纯亏，README 里直接劝退，这反而是可信度。

---

## 3. 核心武器：Preflight 判决（这是产品的门面）

agent 在**写入之前**调用一次 `preflight`，拿到一个判决码。这是整个产品最容易被记住、最容易截图、最容易做成 GIF 的部件。

| 判决 | 含义 | agent 该做什么 |
|---|---|---|
| `allow` | 没人和你抢，基线是新的 | 直接写 |
| `reuse` | 有人正在做同一件事 | 别重复造，改成复用/消费 |
| `refresh` | 你的上下文过期了，契约已经变了 | 重新读，再动手 |
| `replan` | 你的计划和另一个在飞任务冲突 | 改计划 |
| `wait` | 生产者正在落地你依赖的契约 | 先写替身，或等 |
| `review` | 破坏性契约冲突 | 停下来等人或走高风险审批 |

**传播口径**：*HTTP status code 之于网络，preflight 之于 agent 写代码。*

判决必须附带 `reason`、`version`、`ttl`——可解释、可过期，否则 agent 会学会无视它。

---

## 4. 五个噱头功能（每个都要能在一个命令里演出来）

### 4.1 碰撞雷达（Collision Radar）
看板上实时显示"谁正在改哪个文件/符号"，重复目标的卡片会变红并连线。
**演示**：两个 agent 同时改 `auth.py`，第二个的卡片在雷达上撞上第一个。

### 4.2 契约账本（Contract Ledger）
把导出的接口、schema、配置、业务不变量登记成**带版本号**的契约。契约一变，所有还在按旧版本写的调用点被点名。
**演示**：A 把 `resolveIdentity()` 改成 async，B 的下一行同步调用被 `refresh` 拦下，看板弹出"B 的 2 处假设已过期"。
**关键词**：*stale assumption（过期假设）*——这是最有新鲜感的卖点。

### 4.3 幽灵合并（Ghost Merge）
后台持续在临时集成树上预合并 + 跑契约测试。**文本没冲突但行为会坏**的组合，在真正合并之前就报出来。
**演示**：`agentgit prepare` 输出"merge clean / tests fail / blame: T-12 × T-19"。

### 4.4 协调债务评分（Coordination Debt）
`agentgit status` 打一个数，README 可以挂 badge。

```
Coordination Debt  37 / 100   ▲ +12 since yesterday
  in-flight collisions      3
  stale assumptions        12
  unprotected contracts     5
  unclaimed writes          8
```

**传播口径**：*给你的 agent 团队装一个"技术债仪表盘"。* 分数会掉到 0，这是产品最上瘾的地方。

### 4.5 任务级考古（`agentgit why`）
`agentgit why src/auth.ts:42` → 这行是谁的任务、为了什么目标、哪个契约版本、由哪个 agent 落的。
**传播口径**：*blame 告诉你谁改的，why 告诉你为什么。*

---

## 5. 技术形态

### 5.1 仓库结构

```
agentgit/
├── packages/
│   ├── core/       账本、胶囊、租约、契约、策略、判决（宿主无关，从 dsh-coord-governor 抽出）
│   ├── cli/        agentgit init|up|run|demo|status|why|prepare|handoff
│   ├── mcp/        stdio MCP server，暴露协调工具
│   ├── adapters/   cursor hooks / codex hooks / claude-code / generic git hooks
│   └── board/      本地网页看板（localhost:7777）
├── examples/
│   └── demo/       脚本化的双 agent 踩踏场景，`agentgit demo` 的数据源
└── playground/     模板仓库，给用户 fork 后一键复现
```

**关键重构**：`dsh-coord-governor` 现在是 DSH Cordis 插件。把 `ledger.ts` / `policy.ts` / `store.ts` / `types.ts` / `governor.ts` 提升为 `core`（不 import 任何宿主包），DSH 插件降级成 `adapters` 之一。**换宿主只换接线，不换实现**——这是把研究资产变成产品资产的那一刀。

### 5.2 数据落地

```
.agentgit/
├── config.json          项目协调规则、忽略路径、契约源
├── contracts/           版本化契约（可读的 JSON/YAML，进 Git 一起提交）
├── events/*.jsonl       append-only 事件流，按机器分片，避免多机写冲突
└── state/               从事件流推导出的看板视图（不进 Git）
```

账本**进 Git**（契约和事件），推导状态**不进 Git**。这样跨机器靠 `fetch` 就能共享协调视图，不需要云端。

### 5.3 接入矩阵

| 宿主 | 接入方式 | 优先级 |
|---|---|---|
| Cursor | `.cursor/hooks.json`（preToolUse / afterFileEdit / preCompact） | P0 |
| Claude Code | MCP + hooks | P0 |
| Codex | `.codex-plugin/plugin.json` hooks | P0 |
| 任意 agent | `agentgit run <cmd>` 包装 + `AGENTGIT_TASK` 环境变量 | P0 |
| 纯 Git | `pre-commit` / `pre-push` hooks + `agentgit check` | P1 |

### 5.4 MCP 工具表

| 工具 | 作用 |
|---|---|
| `preflight` | 写入前判决（六态） |
| `claim` / `release` | 文件/符号/契约的带租期软预约 |
| `publish_contract` | 登记或升级契约版本 |
| `reconcile` | 动作后拿真实 diff 对账声明 |
| `board` | 拉取在飞任务与争用视图 |
| `why` | 任务级考古 |
| `handoff` | 压缩/交接时导出的最小上下文包 |

---

## 6. 里程碑（照着做）

### M0 · 抽内核（2 天）
把宿主无关部分从 `dsh-coord-governor` 抽到 `packages/core`，**不改行为**，163 个测试原样跑过。
产出：`core` 可独立 `node --test`，DSH 插件变成一层薄 adapter。

### M1 · Demo 发射台（1 周）★ 最关键
`npx agentgit demo` 在临时仓库里脚本化两个 agent 的踩踏：先让它们重复实现，再由 preflight 拦下第二次；最后打印债务分。
要求：**离线、确定性、15 秒内结束、退出码可判断**。
产出：一段能直接进 README 首屏的终端录屏。

### M2 · 真接入（1.5 周）
`agentgit init` 认领仓库；`agentgit up` 起守护进程；MCP server 上线 `preflight`/`claim`/`reconcile`/`board`；Cursor 与 Claude Code 接线跑通。

### M3 · 契约与过期假设（1.5 周）
`contracts/` 数据格式定稿；契约变更检测；`refresh` 判决真实生效；`agentgit stale` 列出全部过期假设。

### M4 · 看板与债务分（1 周）
`board` 网页版上线：在飞任务、碰撞雷达、债务分。README badge 生成器。

### M5 · 幽灵合并与考古（1 周）
`agentgit prepare` 后台预合并 + 契约测试；`agentgit why` 打通任务级归属。

### M6 · 传播（2 天）
README、GIF、`agentgit-playground` 模板仓库、发布贴（V2EX / 掘金 / Reddit r/LocalLLaMA / HN / X）。

**顺序纪律**：M1 没做完不要碰 M2。没有"零配置可看"的 demo，GitHub 上没人会走到第二步。

---

## 7. 成功标准（产品口径）

| 层级 | 指标 | 目标 |
|---|---|---|
| 传播 | `npx agentgit demo` 独立运行次数 | 首月 5k |
| 传播 | GitHub stars | 首月 1k |
| 激活 | demo → `agentgit init` 转化 | > 15% |
| 留存 | 两周后仍在用的仓库 | 观察，不设硬指标 |
| 产品价值 | 账本里真实记录的"被拦下的陈旧写入 / 被去重的重复任务" | 每个活跃仓库 ≥ 3 |

**一个必须能在 demo 里看到的数字**："本次运行避免了 1 次重复实现、2 次陈旧写入。" 用户要的是一句话能讲给同事的价值。

---

## 8. 传播点清单（读 README 的人记住这几句就够）

1. Git 是马路，AgenticGit 是红绿灯。
2. `preflight` 判决六态：allow / reuse / refresh / replan / wait / review。
3. 过期假设（stale assumption）：契约变了，你的 agent 还在按旧版本写。
4. 幽灵合并：文本没冲突，行为会坏——提前告诉你。
5. 协调债务分：给 agent 团队的技术债仪表盘。
6. `blame` 告诉你谁改的，`why` 告诉你为什么。
7. 不改 Git，不改你的 agent，只加一层。

---

## 9. README 首屏草稿

> # AgenticGit
>
> **Git is the road. AgenticGit is the traffic light.**
>
> 你开了四个 agent 会话。它们互相不知道对方存在。半小时后你有两份一样的实现、三处按旧接口写的调用，以及一个文本干净但测试挂了的合并。
>
> Git 和 worktree 能隔离工作目录、能保存快照。它们不负责在**任务还没做完的时候**告诉你：这块地有人在种，这个契约刚刚变了。
>
> AgenticGit 在 Git 之上维护一份协调账本。agent 动手之前问一句，拿到一个判决：
>
> ```
> $ agentgit preflight --task T-19 --file src/auth.py --symbol resolveIdentity
> refresh   reason: contract auth.identity v3 (was v2) published by T-12
>           2 call sites in this task still assume synchronous
>           ttl: 5m
> ```
>
> 三十秒看到效果：
>
> ```
> npx agentgit demo
> ```
>
> 不改 Git，不改你的 agent，零 API key。MIT。

---

## 10. 已知风险与降级方案

| 风险 | 降级方案 |
|---|---|
| 误阻塞让 agent 频繁卡住 | 默认只给建议，`review` 之外不硬拦；判决带 TTL |
| 用户嫌多装一个东西 | 一切从 `npx` 起步，不要求全局安装、不要求账号 |
| 实体抽取不准，假报警多 | v1 只在**符号级精确匹配 + 契约版本**上判定，不做模糊语义猜测 |
| 多机顺序写冲突 | 事件按机器分片；契约靠 Git 合并，不靠实时服务 |
| 被说"这只是 supervisor + 任务板" | 不与它辩论；用 demo 里的 `refresh` 和幽灵合并说话——那是它们给不出的判决 |
| 研究口径被批"主张过度" | 产品与论文分家：研究文档继续克制，README 只管可用与好懂 |

---

## 11. 立即开始的三个动作

1. 建 `agentgit` 公开仓库（MIT），拉 `packages/core` 骨架，把 `dsh-coord-governor` 的 163 测试跑进去。
2. 写 `examples/demo/` 的双 agent 踩踏脚本，先把**终端输出**做出来，界面之后再美化。
3. 用 demo 输出反向定死 `preflight` 的 JSON schema——schema 一旦冻结，CLI、MCP、看板都能并行开工。

> 后续所有取舍服从一条：**能不能让一个陌生人在 30 秒内看到红绿灯拦下一次踩踏。** 不能的，往后排。

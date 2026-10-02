# 项目总览

这是本项目的唯一总览：我们为谁做、怎么取舍、已经有什么、下一步做什么。

安装与日常使用见 [README.zh-cn.md](README.zh-cn.md)；各实验的判据与实测数字见
[docs/EXPERIMENTS.md](docs/EXPERIMENTS.md)；跨窗口协同的完整链路（分层、数据流、每个模块
干什么）见 [docs/ARCHITECTURE.zh-cn.md](docs/ARCHITECTURE.zh-cn.md)。

---

## 1. 这是什么，给谁用

AgenticGit 是一个 Codex 插件，为**共享同一个仓库的编码 agent** 提供一层协调。

问题不在 Git 的能力，而在它的时序。Git 会在两个分支**都做完之后**告诉你它们动了同一行；
它不会告诉你两个 agent *此刻*在做同一件事，或者其中一个正在改的接口，另一个已经照着写好代码了。
这类事故都能干净地合并，然后在运行时炸、在评审时炸，或者永远不炸——最后一种最糟。

它每次只回答一句话：**这件事是不是已经有人在做，它脚下的地是不是还在动。**

### 对开发者

- 装完就用，不需要为插件本身做额外配置；
- 每条判定都带 `reason` 和可执行的下一步，判定错了推翻它的成本很低；
- 它只报告，从不阻止写入，从不替你 merge，从不重写历史。

### 对投资人

三个可检验的产品面，都能在产品里直接看到，而不是只存在于文档里：

| 面向 | 产品事实 | 在哪里可见 |
|---|---|---|
| 可解释性 | 每条判定带理由与下一步，判定本身不依赖模型调用 | 每次 `preflight` 的返回；`agentgit graph --explain` |
| 可见性 | 跨 session 的共享账本，单个 session 看不到的争用能被报告 | `.agentgit/events/*.jsonl`；`agentgit up` 看板 |
| 可测量的效应 | 判定命中率与阻塞成本同时公布，不单报收益 | [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md) |

---

## 2. 我们怎么对待学术

这一节是硬约束，后续所有取舍以此为准。

1. **学术不是交付物。** 只有能转成产品行为的结论才进入本仓库。论文、预注册、标注者一致性统计、
   文献矩阵都不在这里维护。
2. **引用学术结论只用于两件事：界定"我们不做什么"，以及选定"机械判据"。**
   - 界定不做：已有工作表明靠阻塞换可靠性，会把绝大多数干净改动一起卡住；所以我们不做写入拒绝，
     只做报告。
   - 选定判据：符号级、语法级的判定不需要模型也能达到高精度；所以我们把结构化证据作为主判据，
     词法相似度只作辅助信号。
3. **不引用未经核对的二手效果数字。** 摘要级结论不得作为设计依据，也不得写进面向用户的说法里。
4. **留在仓库里的试验脚本必须有一条机械理由**：判据由代码算出而非人工挑选，并且它守着一条产品
   行为。`docs/EXPERIMENTS.md` 与 `examples/real/` 属于这一类，保留它们是因为它们守着 arm
   差异性这一行为，不是因为它们像论文。（`playground/` 下另有一份更细的工作稿，
   `.gitignore` 有意不把它随仓库发布，所以它不在这条清单里。）

---

## 3. 我们已经有的机制

这六件事是产品的底子，改造时不要破坏：

- **外置的持久账本。** `.agentgit/events/*.jsonl`，append-only，跨 session、跨窗口、跨托管存活。
  单个 session 只能看到自己，跨会话的争用只有账本能回答。
- **判定算在上下文之外。** 状态在仓库里，不在某个会话的上下文窗口里，所以它不受那个窗口约束；
  上下文被压缩也不会抹掉它。
- **解释不需要模型。** `agentgit graph --explain <commit>` 从账本直接回答，离线可用。
- **检查点只暂存本任务的路径。** `git add -A` 会顺手带走同一工作树里另一个 agent 的未提交改动，
  所以检查点只暂存本任务写过的路径，任何别的路径都卷不进来。
- **脊不需要人守着终端。** 会话启动时 `spine.mjs` 自己确保这个工作区有一个 daemon 在跑：
  端口由内核分配，pid 与端口落进 `state/daemon.json` 作为单例依据，`agentgit up` 读它并复用。
  否则"某个人恰好开着一个终端"会变成推送层能不能用的前提。
- **插件提议，用户决定。** 宿主明令 `create_thread` 只能由用户明确请求触发，所以插件永远
  不能自己开一个对话窗口。它做的是"每个工作区问一次"，并明确写着没有得到同意前什么都不建；
  答不答、答什么，都记在 `state/desktop.json` 里，所以它既不会重复问，也不会悄悄替你做主。
- **两条新的入口，同一份纪律。** 一个**还没启用**的 git 仓库也会被问一次，但记录写在机器级
  `~/.agentgit/offers.json`（`AGENTGIT_HOME` 可覆盖），因为一个未启用的仓库没有 `.agentgit`
  可写，而为记住"问过"就在每个仓库里建一个，正是上面那条"不撒状态"要避免的事。**`/agentgit`**
  是唯一不是提问的形态：用户在第一句话里输入它，本身就是宿主要求的那个明确请求，所以插件照着做
  ——初始化工作区、把当前对话置顶、用面板展示提交图；启用前的提交沿用既有归属链，从不重写历史。

---

## 4. 对外的三条硬承诺

这三条既是产品哲学，也是与"闸门式"方案的分界线。前两条由
[packages/core/tests/git.test.ts](packages/core/tests/git.test.ts) 的 `describeProtected` 守住。

1. **从不拒绝写入。** 判定是 advisory 的：它报告看到了什么、给出下一步，然后停下。
   这也是实验臂 `A4-gated` 有意**不提供**的原因——在一个没有闸门的产品里，那个臂名会撒谎。
2. **从不替人 merge 或 rebase。** `agentgit reconcile` 打印集成顺序、ghost merge 预览与确切的命令，
   然后停下，从不替任何人解决冲突，也从不重排历史。
3. **从不重写历史。** 不做 amend；任务与 session 归属以 trailer 形式追加到提交上，早于插件的提交
   由次强证据归属并说明是哪一级回答的。

---

## 5. 工程路线

按优先级排列。每一条都对应一个已被独立验证的机制，而不是假说。

| 优先级 | 改造 | 状态 |
|---|---|---|
| P0-1 | 符号级实体抽取，取代词法意图相似度作为主判据 | **已落地**，[packages/core/src/entity.ts](packages/core/src/entity.ts) |
| P0-2 | `WAIT` / `REUSE` 判定回灌竞争任务的 intent 与实体最近触碰序列 | **已落地**，`PreflightResult.replan` |
| P1-3 | 有效并行度与阻塞成本遥测 | **已落地**，`report.parallelism` 与 `report.verdicts`，并在 `status` 与 `brief` 中与判定并列展示 |
| P1-4 | 上下文压缩后重新注入在飞实体与契约假设 | **已落地**（`buildBrief`、MCP `agentgit_brief`、`agentgit brief`），并已由 hook 自动注入：宿主协议 `hookSpecificOutput.additionalContext` 已核实并在 `scripts/hub.mjs` 上落地；推送层现在在运行时也是接上的——`agentgit install` 一次渲染 `hooks.json`、`.mcp.json` 与 `spine.json` |
| P1-5 | 中枢：跨窗口的单一裁决 | **已落地**（`packages/core/src/hub.ts`、daemon 发布、`/api/hub`、`agentgit hub`）。裁决是 append-only 账本事件（`advisory_injected`），默认 advisory，永不阻断 |
| P1-6 | 脊的自动常驻：装完即用，不靠人守着终端 | **已落地**（`plugins/agentgit/scripts/spine.mjs` + `packages/daemon/src/endpoint.ts`）。会话启动时按工作区幂等地拉起一个 detached daemon，端口由内核分配，pid 与端口写进 `state/daemon.json` 作为单例依据；`agentgit up` 先读它并复用 |
| P1-7 | 让插件在没人问的时候也现身：一次性授权的固定任务 + 安静心跳 | **已落地**（`packages/core/src/desktop.ts`、`plugins/agentgit/scripts/desktop.mjs`、`skills/agentgit/references/watch.md`、MCP `agentgit_desktop`、CLI `agentgit desktop`）。插件**不能**自己建任务（宿主把 `create_thread` 留给用户明确请求），所以它只提议一次；你同意后由会话建出 `AgenticGit — <工作区>` 并挂每小时心跳，心跳只在裁决变化时开口，其余时候只记一笔"看过了"。拒绝是终局的，`--reset` 是出口 |
| P1-8 | 两条新的启用入口：未启用的 git 仓库被提议一次（机器级记录），`/agentgit` 直接启用并置顶当前对话 | **已落地**（`packages/core/src/desktop.ts` 的 `shouldOfferInit` / `promptEnablesAgentGit` / `shouldPinOnEnable`、`plugins/agentgit/scripts/desktop.mjs`、MCP `agentgit_desktop` 的 `pinnedThreadId` / `enabled`、CLI `agentgit desktop --decline-init\|--clear-init\|--pin\|--enable`）。未启用的仓库不写自己的目录，记录在 `~/.agentgit/offers.json`；`/agentgit` 是唯一不是提问的形态，因为它本身就是那个明确请求，它只加不删——置顶只记不重写，图直接复用既有提交图 |

### 两条不能松动的设计约束

1. **文件重叠永远不能单独构成"重复"。** 两个任务可以为完全不同的原因改同一个文件，把重叠当作
   同工的证据就是误报。只有共享**符号**才构成可独立成立的结构化证据，这条规则只在
   `entity.ts` 的 `isStructuralDuplicate` 里有一处实现。
2. **判定与环境不可分。** 任何"是否减少重复"的数字都必须与有效并行度 `P` 同时出现。收益若来自
   降低 `P`，那是限流而不是协调。

### P1-4 的自动注入：协议已核实，已接在 hook 上

`track.mjs` 处在**每一次工具调用**的热路径上，它的设计约束是"只追加一行、不做分析、不引入依赖"，所以
中枢的观察与判断都不放在那里。正确的形态是两个脚本，各自承担自己擅长的事：

- `scripts/track.mjs`：只记录，一个账本行，无分析。
- `scripts/hub.mjs`：只读 daemon 写的小投影文件（`state/hub.json`），把已经渲染好的裁决文本通过
  `hookSpecificOutput.additionalContext` 注入会话。它**不读账本**，因此成本不随工作区大小增长；
  有测试删掉 `events/` 目录后断言它仍然工作。

宿主协议不是猜的：Codex 官方 hooks 文档明确 `SessionStart` / `UserPromptSubmit` / `PreToolUse` /
`PostToolUse` 支持返回 `{"hookSpecificOutput":{"hookEventName":"<事件>","additionalContext":"..."}}`，
且本机安装的宿主（`codex-cli 0.155.0-alpha.16`）二进制中存在 `hookSpecificOutput`、`additionalContext`、
`permissionDecision`、`permissionDecisionReason`、`updatedInput` 这些字段。

### 中枢为什么是 daemon 加一个函数，而不是一个常开的 agent 会话

会话会休眠，判断一旦休眠中枢就没了；而且每次判断都花模型调用，成本随写入次数线性增长。所以中枢被拆成
两层：**脊**（daemon，常驻、确定性、无模型调用）持续观察并发布裁决；**脑**（任何窗口按需调用
`agentgit_hub_resolve`）只在脊判定为 `ambiguous` 时被叫醒。裁决落成账本事件，所以 kill 掉 daemon
不丢任何已作出的裁决，重启后可从事件流重建（`packages/daemon/tests/hub.test.ts` 守住这一条）。

权威档是 **A（建议性）**：中枢算出统一结论并广播，窗口自行决定听不听。这与产品的三条硬承诺一致，
也因为宿主目前**不支持** `PreToolUse` 的 `permissionDecision: "ask"`（文档原文：parsed but not
supported yet），权威档在通道上唯一可用的形式会是硬 `deny`，那就等于把产品变成写入拒绝器。

### 守住这些行为的测试

判定与回灌由 [packages/core/tests/preflight.test.ts](packages/core/tests/preflight.test.ts) 与
[packages/core/tests/entity.test.ts](packages/core/tests/entity.test.ts) 守住，跨语言契约由
[packages/core/tests/interop.test.ts](packages/core/tests/interop.test.ts) 守住，arm 差异与消融由
[packages/cli/tests/ab.test.ts](packages/cli/tests/ab.test.ts) 与
[packages/core/tests/arm.test.ts](packages/core/tests/arm.test.ts) 守住。

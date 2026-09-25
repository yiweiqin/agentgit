# 05_实验 / harness：E1/E3 臂编排 runner

`arm_runner.py` 是 `preregistration.md` §5 的实验编排器。它把「计划 → 隔离的轮次 → 账本 → 判定」串起来，并把这套决定**实验含义**的逻辑做成纯函数，因此不需要机器就能离线校验。

它补上的缺口：在它之前，`harness/` 只有一次性的 `remote_*.sh` 探针、`synth_stream.py`、`xcheck_e0.py`、`eval_e2.py`——没有任何东西能驱动一次并发扫描，或收集一个臂的账本。§9 把这件事记为「E1/E3 本机不可做」的阻塞之一。

## 命令

```powershell
cd 05_实验\harness

# 校验计划并列出它定义的每一个 run（不需要机器）
python arm_runner.py expand   --plan plans/e3-skeleton.json

# 把机器将要收到的东西全部渲染出来（不需要机器）
python arm_runner.py dry-run  --plan plans/e3-skeleton.json --out ..\results\E3\staging

# 汇总已收集的轮次并施加冻结判定（不需要机器）
python arm_runner.py report   --results ..\results\E3

# 在实验机上驱动计划（需要 DSH_SSH_HOST / DSH_SSH_PASSWORD）
python arm_runner.py run      --plan plans/e3-skeleton.json --results ..\results\E3

# 回归测试（96 项，无需机器）
python -m unittest discover -s tests -v

# 插件与 round-driver 对真实宿主 .d.ts 的类型校验（无需机器）
cd ..\..\04_协调插件\dsh-coord-governor; npm run typecheck
```

退出码沿用本仓的三值约定：`0` 全部达标；`1` 已测量但有判定被触发（**是结果**，触发迭代器）；`2` 无法测量（**是故障**）。

## 两种拓扑，为什么必须是两种

| 拓扑 | 一个轮次怎么跑 | 能跑哪些臂 |
|---|---|---|
| `in-process-multi-session` | 起**一个** `dsh` 进程，由挂载的 `round-driver` 在同一个 `ctx.agents` 里开出 N 个会话 | 全部 `A0`–`A4` |
| `multi-process` | 每个会话一个 `dsh` 进程，各自独立 worktree + `DSH_HOME` | 只有 `A0`/`A1`/`A2` |

原因就是评审 [R4.3](..\..\顶会审稿意见_2026-09-23.md)：`ledgerScope: 'cross-session'` 的实现是 `governor.ts#visibleContention` 读**本实例内存**里的事件表（`#scopedEvents`）。账本文件只追加、**从不回读**，所以共享同一账本目录的 N 个**进程**互相看不见——treatment 根本不会触发，跑出来的空结果同时兼容「治理没用」和「接线坏了」。

因此 `arm_runner.py` 在 `multi-process` 下**拒绝** `A3`/`A4`（exit 2），而不是给出一个看似合理的零。

### 进程内拓扑怎么实现跨会话

不是新机制。`dsh-agent-loop` 的 `Config.agents` 文档写着「agents created or resumed at plugin startup」，`dsh-base` 的 bundle patch 把它留空并注明「**raw overlays may create agents**」。支持的做法是让一个轮次的每个会话都通过**同一个** `ctx.agents` 注册表创建，于是同一个 `GovernorRuntime` 服务全部会话，跨会话可见性是真的。

实现落在 [`04_协调插件/dsh-coord-governor/src/round-driver.ts`](../../04_协调插件/dsh-coord-governor/src/round-driver.ts)：

- 读轮次 spec（每个会话一条 `{label, sessionId, cwd, prompt}`）；
- `ctx.agents.create({ sessionId, meta: { cwd }, agentOptions })` × N；
- `agent.send(createUserMessage(...), 'next-turn', true)` 然后 `await agent.whenIdle()`；
- `Promise.allSettled`（一个会话失败不得取消兄弟会话，否则分母会被静默缩小）；
- 全部 `dispose()` 后写 done marker；**由轮次脚本发 SIGTERM**，因为会话日志是压缩刷盘的，从进程内 `process.exit` 会截断证据。

它遵守 `message.ts` 立下的**免运行期导入**纪律：所有 `@deepseek-ai/*` 都是 `import type`（被 Node 类型擦除），用户消息由 `./message.ts` 本地构造——否则路径挂载的插件会让宿主出现两份 request-extension 注册表，每次模型调用都死于 `REQUEST_EXTENSION`。

这条驱动已通过 typecheck（对着 vendor 里 241 个真实 `.d.ts`，`tsc` 0 错误），覆盖 `ctx.agents.create` / `agent.send` / `whenIdle` / `handle.dispose` / `createUserMessage` 全部签名。

## runner 冻结的规则（不是可调参数）

| 规则 | 取值 | 理由 |
|---|---|---|
| 分析单位 | **轮次**，不是 run | §5.7 把轮次作为随机效应 |
| 主指标 | 冗余落地率 = Σ(每组落地数−1) ÷ 落地总数 | 意图分组来自**计划声明的构造真值**，不来自检测器，也不来自实体重叠（§4 硬约束 H9） |
| 落地判定 | 退出码 0 **且** worktree diff 非空 | 机械规则；对错不由 harness 判定。进程内拓扑下由轮次脚本从各 worktree 计算并 append（driver 没有 git 视角） |
| 每次会话隔离 | 独立 worktree + 独立 `DSH_HOME` | §7 |
| 账本路径 | **目录**，不是 `.jsonl` | `store.ts#ledgerFilePath` 与 `coord_ledger.py#ledger_path` 对 `.jsonl` 的理解不同，一侧会读到空 |
| `A0` 不挂 governor | overlay 里没有 governor 行 | `A0` = 插件根本不挂载；`A2-inert` = 挂了但不动。两者若都挂，`A1−A2` 就不再隔离记录成本（`remote_verify_fix.sh` 的 A0 也是无 overlay） |
| `E-K4` 阈值 | P 均值降 >15%，或并行时长占比降 >25% | §5.6，跑数前冻结 |
| 治理对比基准 | `A3`/`A4` 对 `A1-instrument`，不对 `A0` | §7：`A0` 分不开观测者效应与干预效应 |

## 在机器上跑通进程内拓扑前，还剩一件事

`arm_runner.py` 只负责起**一个** `dsh` 进程并把 overlay / spec 交给它。它不知道宿主里挂了什么。进程内拓扑需要一个**不含一次性 runner 的 profile**：

- 发布的 `headless` profile 挂的是 `dsh-headless` bundle = `dsh-base` + **一次性 runner**（它启动时消费一个任务，会与 driver 抢会话）；
- 进程内拓扑需要的是「只挂 `dsh-base` 核心」的叶子：`agent`、`agent-loop`（`agents: []`）、`session`、`llm-deepseek`、`fs-sandbox`、`sandbox-policy`、`tools`、`system-prompt` 等，**不挂** `headless-runner` / `headless-startup`。

骨架计划里把它写成 `dsh.profile: "coord-inproc"`。落地方式：在机器上 `$DSH_HOME/profiles/` 下建该 profile，使其 bundle 指向 `@deepseek-ai/dsh-base`（而不是 `dsh-headless`），再把 `cordis.patch.yml` 的 user 层留空（臂一律走 `--patch` overlay，避免臂之间互相污染）。

**这是进程内拓扑唯一尚未在真机验证过的环节**，也是唯一需要真机迭代的部分（本仓历史上仅插件挂载就迭代了 ~50 个 `remote_*.sh` 探针，这个环节的复杂度相当）。driver 本体与 overlay/spec/script 生成都已离线验证。

## `E1/E3` 仍未具备的前置条件（诚实记录）

按依赖顺序，与机器规格无关：

1. **任务包已存在但仍是 `draft`，且尚未跑通一次。** `task-packs/runtime-v0/pack.json` 的 8 个任务、实体与真值一致性都已校验（实体在固定 commit 上机械核对通过），但**没有一个提示词被真正执行过**。冻结它需要：每个任务至少跑通一次并产生落地。`plans/e3-skeleton.json` 的 `status: skeleton` 会让 `run` 拒绝它，`frozen` 的 plan 引用 `draft` 的包也会被拒。
2. **`N` 尚未冻结**（§5.4）：需要 `E1` 的方差做功效分析，再写回预注册。
3. **`I4` 的修法尚未实现**：E2 显示 `A4-gated` 误拒率 0.333（上限 0.05）。不改成「仅在 `duplicate-intent` 时 deny」，`A4` 臂的数据必然违反 H9。
4. **模型凭据 + 录制夹具**：`llm-replay` 是回放而非合成，确定性臂的前置是先用真实 API 录一次夹具。

## 可运行任务包（`runtime-v0`）

E2 的 `task-packs/detection-v1/pack.json`（`coord-taskpack-0.1`）是**纯函数包**：它把 `priorEvents`/`proposals` 直接喂给检测器，从不要求 agent 做任何事，所以它产不出「落地的实现」，也就承载不了主指标。E1/E3 需要的是另一种：**在真实仓库里执行的、意图等价由构造声明的自然语言任务**——`coord-runtime-pack-0.1`。

`task-packs/runtime-v0/pack.json` 有 8 个任务、覆盖四种结构：

| 结构 | 任务 | 说明 |
|---|---|---|
| true-collision | `T-json-helper-lexical` / `T-config-toml-lexical` | 同实体、措辞几乎相同（词法基线应当抓到） |
| semantic-duplicate | `T-json-helper-paraphrase` / `T-config-toml-paraphrase` | 同意图、不同措辞（难例） |
| independent-control | `T-control-config-validation` | **故意与 TOML 任务同实体**——H9 情形：重叠不得当作证据 |
| independent-control | `T-control-logging-handler` / `T-control-views-docstring` | 干净对照，误报下限 |
| hidden-dependency | `T-hidden-cli-config-dump` | 依赖 TOML loader（`dependsOn`），但**不共享任何实体** |

### 真值一致性规则（由校验器强制）

真值在本文件里声明，并且**只与自身核对**：不来自检测器，不来自实体重叠（§4 硬约束 H9）。

- `true-collision` / `semantic-duplicate` 必须与**同组**其他成员**两两共享**至少一个实体（不是并集非空——并集检查是形同虚设的，已修）；
- `independent-control` 必须**独占**自己的 intent group（group 就是「同意图」的声明，与别人同组就是构造上的重复，无论作者本意如何）；但它**可以**与无关任务共享实体，那是必须存在的 H9 对照；
- `hidden-dependency` 不得与任何其他任务共享实体，且必须用 `dependsOn` 具名依赖——能被实体键检测器看到的依赖根本不是隐藏依赖，标成隐藏会抬高 recall 上限，使 `I3` 不可伪证；
- 缺任一结构直接拒绝：**没有对照的包会让「全部报警」拿到满分 recall**。

### 校验命令

```powershell
cd 05_实验
python harness/task_pack.py task-packs/runtime-v0/pack.json --repo "..\03_基准与标注\benchmark\real-history\flask\repo"
```

带 `--repo` 时会用 `git cat-file -e <commit>:<path>` **逐个机械核对**每个声明实体在该固定 commit 上真实存在。实测：8 个实体全部存在。不带 `--repo` 时报告 `entity_verification: unverified`——**「未核对」和「已核对」是两种状态**，混为一谈就是让引用了不存在路径的包发出去、每个任务都因错误的原因失败。

任务文本只存在于包里。plan 用 `"pack": "../../task-packs/runtime-v0/pack.json"` 引用它，而不是复制一份——复制会让「校验所依据的标签」与「会话实际执行的文本」静默漂移。

## 文件

| 文件 | 作用 |
|---|---|
| `arm_runner.py` | 计划 / 渲染 / 对账 / 指标 / 判定 / CLI |
| `task_pack.py` | 可运行任务包的 schema、真值一致性校验、实体机械核对 |
| `tests/test_arm_runner.py` | 68 项回归；含与 `src/config.ts` 的臂清单漂移检查、与 TS `computeParallelism` 的镜像比对 |
| `tests/test_task_pack.py` | 28 项回归；含真实包的实体核对与共调度检查 |
| `plans/e3-skeleton.json` | 骨架计划：引用真实包但 `status: skeleton`，`run` 会拒绝 |
| [`../../04_协调插件/dsh-coord-governor/src/round-driver.ts`](../../04_协调插件/dsh-coord-governor/src/round-driver.ts) | 进程内多会话驱动器 |
| [`../../task-packs/runtime-v0/pack.json`](../../task-packs/runtime-v0/pack.json) | 可运行任务包（draft） |
| `remote.py` | 唯一的 SSH 实现，被 `run` 复用 |

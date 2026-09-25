# AgenticGit

[English](README.md) | **简体中文**

**为共享同一个仓库的编码 agent 提供协调层。**

Git 会告诉你两个分支动到了同一行代码——在两个分支都做完之后。它没法告诉你：两个 agent
*此刻*在做同一件事、其中一个正在改的接口另一个已经照着写好了代码、或者第二个 agent
写了一半的文件马上要被第一个 agent 的提交一起带走。

这三类事故**都能干净地合并**。它们会在运行时炸掉、在评审时炸掉，或者永远不炸——而最后
一种最糟，因为你会一直这么做下去。

AgenticGit 是一个 Codex 插件。它观察一个工作区里正在进行的工作，并在每次写入发生之前回答
一个问题：**这件事是不是已经有人在做，它脚下的地是不是还在动？** 它维护一份关于任务、代码、
契约与验证的账本，把这些以 MCP 工具的形式暴露出来，在对话里渲染一块内联面板，并在
`localhost:7777` 提供一个实时看板。

它还绘制单个工作区的提交图，**每个提交都标注着产生它的那个 Codex 对话**——就是你在桌面端
线程列表里看到的名字，不是 session id。那就是下面 [提交图](#提交图) 一节里描述的面板。

---

## Git 看不见的那件事

两个 agent 被要求给登录加上限流。它们各用自己的话描述这件事，所以文本上没有任何匹配，
Git 也就没有任何可报告的。两份改动都能干净合并。

```
1. Agent A opens a task and writes src/login.py
   A intent: "add rate limiting to the login endpoint so repeated failures back off"

2. Agent B is about to write the same file, for what it thinks is its own reason
   B intent: "add rate limiting to login so repeated failures are throttled"
   verdict : REUSE
   reason  : an in-flight change on file::src/login.py is doing the same thing:
             "add rate limiting to the login endpoint so repeated failures back off"
             (task demo-a, similarity 0.56).

3. Agent A publishes auth.limit v1; agent B records that it is coded against v1
4. Agent A publishes v2 with a breaking signature change
5. Agent B asks again, before writing
   verdict : WAIT
   reason  : task demo-a is still landing auth.limit v2 in src/login.py. Code against
             the published signature and stub the rest, or wait for it to land.
6. Agent A integrates. Agent B asks a third time.
   verdict : REVIEW
   reason  : auth.limit moved to v2 (breaking) and this change touches src/login.py.
             You are coded against v1. Published by task demo-a.
```

没有人被合并冲突拦住，因为自始至终就没出现过合并冲突。第二个 agent 被提醒了三次，
而这三次正巧是答案发生变化的那三个时刻。

你可以自己跑一遍，它会建一个临时仓库，跑完就删掉：

```bash
node examples/collision/run.mjs          # add --keep to inspect the repo it builds
```

这个演示是真的：它在一个真实仓库里、用真实的提交写入一份真实的账本；如果某一步得到的判定
不是它期望的那一个，它会把那一步报告为 `FAIL`。

## 只属于一个任务的检查点

这一部分才是真正容易做错的地方，也是 git 这一层值得拥有独立测试套件的原因：

```
$ agentgit task checkpoint demo-a --path src/login.py
checkpoint 6f713480
  src/login.py

$ git status --short
 M src/config.py
```

Agent B 在同一个工作树里改 config 模块改到一半。它还在那里，还没提交，还是 B 的。
`git add -A && git commit`——这个最显然、也是多数工具会顺手用上的实现——会把它一起带走。
检查点只暂存它自己这个任务写过的路径，并把这些路径写进提交，所以任何别的路径都不可能被卷进来。

它还会写入两个 trailer，提交图就是靠它们知道这个提交是谁做的：

```
AgenticGit-Task: demo-a
AgenticGit-Session: 01a0cc22-20fb-75e2-a990-3a1641734f87
```

为了加上它们，**不会**做 amend，**不会**重写任何历史。早于本插件的提交就是没有 trailer，
于是它由剩下的最强证据来归属。

## 提交图

今天有三个 agent 在这个文件夹里干活。Git 会告诉你改了什么。它不会告诉你**是哪个对话干的**，
而这才是真正被问到的那个问题。

```
$ agentgit graph --limit 6
AgenticGit for "agentgit" — main, 13 commit(s), 1 lane(s)
windows: add rate limiting to login (4), 抽奖弹窗动画 (2), 重构结算逻辑 (1)

  a1b2c3d4 add rate limiting to login        4f wire up the limiter
  9f8e7d6c add rate limiting to login        2f publish auth.limit v1
  5c4b3a29 抽奖弹窗动画                       3f 弹窗进场动画
  2d1c0b9a 重构结算逻辑                       6f split the settlement calculator
  8a7f6e5d 修复排序稳定性                     1f stable sort for equal scores
  4b3a2c1d add rate limiting to login        1f initial limiter stub

in flight:
  add rate limiting to login — 3 uncommitted in .agentgit/worktrees/demo-a
```

第二列的名字就是 Codex 在线程列表里显示的那个对话名；面板用的也是同一个名字。
当没有任何名字被记录下来时，图会按下面的顺序逐级回退，并且**说明是哪一级回答的**：

| 层级 | 它意味着什么 |
|---|---|
| 提交上的 trailer | 创建检查点时记录下的任务与 session |
| `agentgit/<task>` 分支 | 这个提交落在某条任务分支上 |
| 账本 | `.agentgit/events` 里任务到 session 的映射 |
| 线程名 | `~/.codex/session_index.jsonl` 里的 `thread_name` |
| 第一条提问 | 从该 session 的 rollout 里读取，用于 Codex 从未命名的 session |
| 任务 id，然后是 session id | 始终可取，所以任何一个节点都不会没有名字 |
| Git 作者 | 用于完全不带归属信息的提交，通常意味着它早于本插件 |

最后两级无论出现在哪里都会以**斜体**显示。那不是装饰：否则一个猜来的名字和一个记录下来的
名字会长得一模一样，而两者之间的区别正是这张图的全部价值。

任意一行都可以追问，而且回答不需要模型：

```
$ agentgit graph --explain a1b2c3d4
a1b2c3d4  wire up the limiter

window : add rate limiting to login  (index)
task   : demo-a
session: 01a0cc22-20fb-75e2-a990-3a1641734f87
when   : 2026-09-24T09:12:44.000Z

what it was for, in the agent's own words:
  add rate limiting to the login endpoint so repeated failures back off

changed (4):
  src/login.py
  src/limiter.py
  tests/test_limiter.py
  docs/auth.md

ledger:
  2026-09-24T09:02:10.000Z  file_write         src/limiter.py
  2026-09-24T09:11:58.000Z  lifecycle_validated  released 2 lease(s)

notes:
  - The window name is the conversation name Codex recorded for this session.
  - One session is recorded for this task. A task can span several windows, and this
    commit names only the first.
```

在支持渲染 MCP Apps 的宿主里，同一张图就是一块实时面板：向它要 `agentgit_ui`，只要面板开着
它就会轮询，所以另一个窗口里新做出的提交会自己出现，不需要任何人再问一次。每一行都可以点击，
“Quick answer”离线跑上面那段解释，“Ask in conversation”则把问题交给 agent，并把选中的提交
一并放进它的上下文里。

除了插件本身，面板不需要任何额外配置。当它没出现时，有两件事值得知道：

- UI 放在哪里由宿主决定。Codex 桌面端给 MCP Apps 一个侧边栏页签，也支持画中画；
  而一个什么都不渲染的宿主，仍然能拿到每个工具的文字结果。
- 提交图是只读的、基于 `git log`，所以即使在一个本插件从未记录过任何东西的仓库上它也能工作。
  它只是会按分支、线程名或作者来归属，并且会说明这一点。

`agentgit up` 也会把面板当作一个页面提供，在 `http://localhost:7777/panel`，与它读取的
`/api/graph`、`/api/explain` 两个 JSON 接口并列。

```bash
npx agentgit status          # what is in flight
npx agentgit graph           # the commit graph, attributed to conversations
npx agentgit up              # live board on http://localhost:7777, panel at /panel
```

## 安装

需要 **Node 22.19 或更新**（各个包是直接由 Node 运行的 TypeScript）以及 **git**。
Codex 必须支持本地插件和 MCP server。

```bash
git clone https://github.com/yiweiqin/agentgit.git
cd agentgit
npm install
node packages/cli/src/main.ts install          # link the plugin, write hooks and MCP config
node packages/cli/src/main.ts doctor           # every check must say "ok"
```

`install` 只做 Codex 无法替本地插件做的四件事，别的不做：

1. 把 `~/plugins/agentgit` 链接到这个检出目录，这样对该目录的修改是即时生效的；
2. 生成带绝对路径的 `hooks.json` 和 `.mcp.json`，因为 Codex 不做命令替换，在 Windows 上也
   不解析相对路径；
3. 把 `agentgit` 这一条加入 `~/.agents/plugins/marketplace.json`，同时保留其它所有条目
   和 marketplace 自己的名字；
4. 递增 cachebuster，因为 Codex 按版本号缓存插件，改了东西而版本号没变就是不可见的。

然后启用它，两种方式都行：

```bash
codex plugin add agentgit@personal                 # the marketplace route
node packages/cli/src/main.ts install --enable     # or write the config.toml block for you
```

`--enable` 只改 `~/.codex/config.toml` 里的一个表，其它每一个字节——包括注释——都不动。
如果 `plugins` 已经是行内表（inline table），它会拒绝而不是去猜，因为往那个文件里追加一个
`[plugins."x"]` 段会产生非法 TOML，而 Codex 会拒绝启动、把原因抛在离症状好几行的地方。

要撤销：`node packages/cli/src/main.ts uninstall --disable`。

## 它自己做哪些，绝不替你做哪些

这条分界就是产品的安全边界，它在 `packages/core/src/git.ts` 里由两个测试守着：一个在满是
另一个 agent 工作的树里提交一个文件，另一个扫描每个源文件、查找受保护操作的 git 调用。

| 自动进行——只增不改、可撤销 | 绝不自动——只描述，不执行 |
|---|---|
| 创建任务分支与工作树 | `merge`、`rebase` |
| 提交限定在某个任务范围内的检查点 | `reset --hard`、`restore`、`clean` |
| 记录租约、假设、契约版本 | `branch -D`、`push` |
| 往 `.git/info/exclude` 里为 `.agentgit/` 加一行 | 任何重写历史的操作 |

当一次合并该发生时，`agentgit reconcile` 会打印集成顺序、ghost merge 预览以及确切的命令——
然后停下。它从不替你解决冲突，也从不重排任何人的历史。一个因为某个启发式规则这么说就去合并的
agent，不该被要求任何人去信任。

ghost merge（`git merge-tree --write-tree`）可以安全地在每次看板刷新时运行，因为它把结果写进对象
数据库，不碰任何分支、不碰工作目录。但一棵干净的树只会被报告为干净，仅此而已：**文本上的干净
不等于行为上的正确**，`reconcile` 会在输出里这么写，而不是暗示别的。

## 我们不声称什么

- 它不预防冲突。它是在改道还很便宜的时候告诉你冲突正在到来，这是一件不同、也更谦逊的事。
- 重复工作的判定是对意图文本做的一次相似度判断，阈值和原因字符串都写在每个回答里。它有时会判错；
  它被设计成推翻起来很便宜，而且每一次判定都被记录下来，所以你能看到它为什么这么判。
- 演示是一次走查，不是基准测试。它断言它被造出来要产生的那三个判定，对这三类事故在真实仓库里
  的发生频率不声称任何东西。
- 下面的 A/B 跑是一个用脚本化 agent 搭的夹具。它表明机制可用、各实验臂确有差异。它不是效应量。
- `examples/real/run.mjs` 里的 before/after 报告是**一个**案例，所以它不是频率。同一批样本上的频率
  是实验 4 · Git 互补性所统计的东西，两者被有意分开。
- 当那份报告说 git 能干净合并时，请读它写明的路径。在 `reversed` 重建路径上，只有当两处改动占据
  文件中不重叠的区域时才能得到干净合并——所以那里的干净合并是预期结果，而不是"git 有多瞎"的新发现。
  在 `anchored` 路径上，两份补丁应用在同一个基线上，答案就是该案例自己的答案。

## 可调的旋钮

这些判定都是启发式，所以每一个都是旋钮——而一个对某些人的仓库注定会判错的产品，欠用户的就是
旋钮、默认值，以及为什么选这个默认值。这三样都在一条命令里：

```
$ agentgit config
settings  (0 changed from the default)

  arm
    value   : A3-advisory  (default)
    means   : record cross-session, report what was seen, offer next actions (default)
    effect  : Which experimental arm this workspace runs: what is recorded, and whether this
              session can see other sessions at all.
    caution : A non-default arm makes this workspace incomparable with one running another arm...

  duplicateIntentThreshold
    value   : 0.42  (default)
    effect  : How similar two agents' own words for their intent must be before their work is
              called the same. This is the number behind the REUSE verdict.
    caution : Too low and unrelated work is flagged as duplicate, which is how a team learns to
              ignore the tool. The matcher is lexical, so two agents describing one job in
              different words score low no matter where this is set: raising it hides the miss
              rather than fixing it.
```

用 `agentgit config <setting> <value>` 设置某一项；这个值会在写入任何东西之前先被校验，而被拒绝
的设置会让文件保持原样。`--json` 把同样这些字段给工具用；`agentgit status`、`agentgit board`、
`doctor` 和内联面板都会打印出它们展示的数字是由哪个 arm 产生的。

`arm` 是最有意思的一项，它是这个实验的分析单元：

| arm | 它做什么 |
|---|---|
| `A3-advisory`（默认） | 跨 session 记录，报告看到了什么，并给出下一步动作 |
| `A1-instrument` | 跨 session 记录并作判定，但不给任何下一步动作 |
| `A4-session-only` | 记录，但只看得到本 session |
| `A0-baseline` | 什么都不记录，什么都看不到，永远 allow |

有两个研究用的臂是被**有意不提供**的。`A4-gated` 会拒绝写入，而这个产品从不拒绝——它只报告它
看到的，并把命令交到你手上——所以按名字指定它会被拒绝，并附上这个理由，而不是被悄悄降级。
`A2-inert` 和 `A4-detect-only` 也不提供：在一个没有闸门的产品里，它们与 `A0-baseline` 和
`A1-instrument` 逐字节相同，而一个行为配两个臂名会让这些标签失去意义。

## A/B 实验，以及怎么读它

```bash
node examples/ab/run.mjs                      # about half a minute
node examples/ab/run.mjs --compliance 0,0.25,0.5,0.75,1
```

它为每个臂各建一个临时仓库，把同一个六轮双 agent 场景通过真实 CLI 跑一遍，并报告代码在一次真实
ghost merge 中发生了什么——而不是账本对自己的看法。

```
what each arm knew, and what it said
------------------------------------
  A0-baseline       b-agent verdicts: allow x6
                    usable next actions: 0/6   ledger events written: 0
  A4-session-only   b-agent verdicts: allow x6
                    usable next actions: 0/6   ledger events written: 12
  A1-instrument     b-agent verdicts: reuse x3, replan x2, allow x1
                    usable next actions: 0/6   ledger events written: 12
  A3-advisory       b-agent verdicts: reuse x3, replan x2, allow x1
                    usable next actions: 5/6   ledger events written: 12

outcome by arm and obedience rate
---------------------------------
  arm                obey   dup closed   indep stopped   untouched   files left in conflict
  A0-baseline       0      0/3          0/2             1/1         5
  A0-baseline       1      0/3          0/2             1/1         5
  A4-session-only   0.5    0/3          0/2             1/1         5
  A1-instrument     1      0/3          0/2             1/1         5
  A3-advisory       0.5    1/3          1/2             1/1         3
  A3-advisory       1      3/3          2/2             1/1         0
```

十二行里只展示六行；其余重复的是同样的两种形态。

请按这个顺序读它，因为诚实的读法不是好听的那种：

1. **最后一行是算术，不是证据。** 一个臂在每个 agent 都服从时关掉了全部三处重复，这展示的是
   “服从”这个词的含义。夹具没法发现这个。
2. **携带信息的是 `obey 0.5` 那一行**——关掉一处重复、三个文件仍在冲突——而且只有当服从率是真实的
   时候它才有信息量。这里没有人测过一个真实 agent 的服从率，而那个服从率是唯一能把这个变成效应量的东西。
3. **两个消融都塌回了基线，原因各不相同。** `A4-session-only` 写下了全部 12 个事件却看不到它们，
   所以它六次都回答 `allow`。`A1-instrument` 什么都看得到、也说出了 `reuse` 和 `replan`，但它不提供
   任何下一步动作，所以同样什么都没变。产品需要的是共享账本**和**一个可执行的下一步；只有其中任一个，
   五个文件仍然全部冲突。
4. **`untouched` 是地板，不是细节。** 有一轮里第二个 agent 动的是第一个从未碰过的实体，任何服从率下
   任何臂都不允许干预。如果这个数字动了，说明某个检测器在没人踩的地面上开火了，而重复那一列也就
   无法解读了。
5. **`indep stopped` 是成本那一侧。** 那些轮次里，两个 agent 出于真正不同的原因共享同一个实体。
   产品在那里说的是 `REPLAN`，意思是拆分这个实体或者约定一个顺序——是一次延期，不是损失——而这个数字
   被印在重复那一列旁边，因为一个靠"什么都别做"来关掉重复的工具，单看重复那一列会显得一模一样。

服从只施加在那些带有可用下一步动作的判定上。那是一个假设，也是它把 instrument 臂和默认臂区分开的东西；
如果它错了，该被怀疑的是 `A1-instrument` 那一行，而不是别的行。

## 四个实验，跑在这台机器自己的历史上

上面的演示是一次走查：它证明机制能跑，对这三类事故发生在你身上的频率则什么都没说。
为此还有第二组脚本，跑在 `~/.codex/sessions` 里真实的 session 记录上，判据是从补丁体中机械计算
出来的，而不是手工挑选的。每个实验回答一个问题，它们按顺序读——可见性、影响、克制、非冗余：

| | 这个实验，以及它回答的问题 | 它报告的那一个数字 |
|---|---|---|
| 1 | **检测保真度**——它看得见吗？在真实历史上，它多久开口一次、开口时有多准？ | 精确率与召回率，永远与 `entityVisibleCeiling` 并列 |
| 2 | **干预影响**——听了它有帮助吗？如果被提醒的 agent 服从了，结果好多少？ | 在服从率 0.5 那一行上，被关掉的重复数量的下降 |
| 3 | **告警经济性**——它会狼来了吗？在没有任何碰撞的一天里，它一天开口多少次？ | 每 N 个 session 小时一条建议，以及零次拒绝 |
| 4 | **Git 互补性**——git 有可能看见吗？对这几个案例，git 当时会开口吗？ | 零冲突的案例数，以及两个时间戳之间的差 |

它们每一个都带一个不许动的对照，并且写明了什么值算失败。完整的记述——它建立在其上的那个比方、
实测得到的数字、before/after 背后的两条重建路径、沙箱约束，以及发表前做过哪些删减——在
[`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md)（中文版见
[`playground/EXPERIMENTS.zh-cn.md`](playground/EXPERIMENTS.zh-cn.md)）。

```bash
node examples/real/cases.mjs    # scan the pool: candidates, and the three concurrency windows
node examples/real/run.mjs      # one real case, as a before/after report
```

`cases.mjs` 的范围取自这些 session 记录——它报告的工作区就是这些 session 记录过的每一个目录，
所以源码里不含任何一台机器上的路径。当样本池里混有临时目录时，用 `--workspaces a,b` 收窄。

`run.mjs` 把仓库克隆到一个临时目录，把两个真实 session 回放到写入发生的那一刻，把同一个问题同时
交给 `preflight()` 和 `git merge-tree`，并把两个答案并排渲染出来。它会打印一个内容 token；
把整行粘贴进一条 Codex 回复，报告就会在对话里渲染出来。如果没有案例符合条件，或者产品的判定是
`allow`，它会以非零退出而不是硬造一个案例出来——沉默是一个发现，不是一次演示。

## 目录结构

```
packages/core       the ledger, contracts, leases, preflight verdicts, rollout ingestion, git,
                    the commit graph and the session-name resolver
packages/board      the inline panel fragment and the standalone page, from one view
packages/app        the MCP App panel: one self-contained document, its CSS and its runtime
packages/cli        agentgit status | board | graph | panel | app | preflight | why | reconcile | task | config | up | install
packages/mcp        the stdio MCP server: agentgit_preflight, agentgit_task, agentgit_graph, the panel resource
packages/daemon     the live board on localhost:7777, one page per workspace, SSE
plugins/agentgit    the Codex plugin: manifest, hook wiring, the track.mjs fast path, the skill
examples/collision  the two-agent walkthrough above
examples/ab         the A/B run: the same scenario under two arms, with an obedience dial
examples/real       the experiments below, run over this machine's own session transcripts
docs                EXPERIMENTS.md, and the reasoning behind the numbers it reports
```

hook 脚本是唯一处在每一次工具调用热路径上的东西，所以它是一个单进程、除 Node 标准库之外没有任何
依赖，并且只往工作区的事件分片里追加一行。其它一切——看板、面板、判定——都从这些事件派生，
可以随时丢掉再重建。

session 记录会和工具调用一起被采纳，因为 hook 看不到一条 shell 命令动了什么。采纳会与 hook 流去重：
同一次写入被记录两次，会把每一个碰撞计数按两个流都看到的那部分比例抬高，数字就不再有任何意义。

## 测试

```bash
npm test          # 547 tests: runs lint:encoding first, then core, board, app, cli, mcp, daemon
npm run test:py   #  45 tests: the Python ledger, checked against the same fixtures
npm run typecheck
```

`npm test` 以 `npm run lint:encoding` 开头，只要有任何一个文本文件带 UTF-8 BOM 或 CRLF 行尾
就会失败。这不是洁癖：BOM 会让 `json.loads` 拒绝一个看起来完全正确的插件清单，而一个 CRLF 的检出
会让提交上去的账本每一行都产生 diff。用 `node scripts/strip-bom.mjs` 修复。

在 Windows 上你可能还会看到类似
`[agentgit tests] could not remove C:\...\Temp\agentgit-git-xxxx: EPERM` 的一行。那是清理杂务，
不是测试结果：这些套件会在临时目录里建真实仓库，而操作系统的文件扫描器可能在最后一条断言早已通过之后，
仍然握住一棵刚建出来的 `.git` 树的句柄几秒钟。清理逻辑会重试、清掉 git 留下的只读对象文件，
然后选择报告而不是抛出，因为一个一次性的临时目录不是关于这个产品的证据。它被打印出来，
是为了让一个**永远**删不掉的目录仍然可见。

值得知道的是那几个 arm 测试，因为一个臂很容易以一种恰好产生"看起来合理"的结果的方式出错：
`packages/core/tests/arm.test.ts` 用两个臂驱动同一份账本，如果判定结果相同就失败。
`packages/cli/tests/ab.test.ts` 跑 A/B 夹具，如果各臂不再有差异、如果消融臂不再记录、或者如果
没人踩过的地面被扰动，就失败。`packages/cli/tests/hooks.test.ts` 把 hook 自己那份 arm 表的副本
钉在 core 的版本上，因为 hook 无法 import 这个库，而一份漂移的副本会悄悄在一个已经关掉的工作区里
继续记录。

MIT 许可。

# 04_协调插件：以 hook 插件实现治理 agent（v0.1）

本目录实现 `01_问题定义与定位/痛点_速度与上下文失配.md` 中"代行 Git 工作流中人类调和职责的治理 agent"。

**设计决策（2026-09-15，用户提出）**：不构建完整的独立 agent 系统，改为**宿主 hook 插件**。这个选择比"省钱"重要得多，理由见 §1。

---

## 1. 为什么插件不只是"更便宜"，而是**方法上必要的**

框架的核心量是

\[
  B(t)=\int_0^t\max\big(0,\lambda(\tau)-R(\tau)\big)\,d\tau
\]

即**未被调和的变更积压**。§10.3 的实测已经证明：

> **\(B(t)\) 在原理上不可由 Git 历史观测。** 未调和的变更按定义不在 commit 图里。

于是出现一个死结：**要研究失配，就需要一个能观测 \(\lambda_{\text{produced}}\) 的通道；而所有基于仓库历史的数据源，在构造上只能看到 \(\lambda_{\text{merged}}\)。**

而这个死结有一个自然的解：

> **治理 agent 本身，就是唯一能观测 \(\lambda_{\text{produced}}\) 的通道。**

因为治理 agent 必须在变更发生**当时**干预——它必须知道"这个 session 正要改这个文件"。它天然就拿到了观测位。

**结论：插件的记录功能不是为治理服务的附带产品；治理与观测是同一个工件的两个面。** 这直接补上了 §9 第 6 项（唯一硬瓶颈）与 R2/R3 两条反驳。

### 1.1 两个模式，缺一不可（研究效度要求）

| 模式 | 行为 | 用途 |
|---|---|---|
| **instrument（只读）** | 只记录，不干预、不改仓库 | 测量**基线**与**失效态** |
| **governor（治理）** | 记录 + 干预（归属、查重、排序） | 作为 treatment，抬高 \(R\) |

**必须分离**，否则出现观测者效应：如果记录与干预同时开启，"有记录的一期"和"没记录的一期"不可比，H4/H5 的效应量无法解释。

已实现的 v0.1 **只有 instrument 模式**，并且 `report` 会主动声明 `instrumentation_only_no_governance_applied`，测试 `test_report_declares_that_it_applied_no_governance` 守住这一点。

### 1.2 顺带回答了 R4「用 AI 治理 AI 是循环论证」

评审意见原话：*"Your governor is an LLM with the same bounded context that caused the problem."*

答：**治理 agent 不靠更大的上下文，靠外置的持久账本。** 上下文有界限制的是**同时推理的内容量**，不限制**持久化的关系表**。账本落在仓库里（`.coord-ledger/`），跨 session、跨开发者、跨托管存活；任何 session 都能读到"这个实体被谁改过"。

插件的形态恰恰把这一点做实了：它是个 hook，运行在某个 session 里，**但它的状态不在那个 session 的上下文里**。这正是它不受同一个上下文窗口约束的原因。

---

## 2. 已实现（v0.1）：`coord_ledger.py`

只读仪表，`stdlib` 依赖为零（hook 环境不能假设装了包）。

```
python coord_ledger.py record --ledger .coord-ledger --event file_write \
    --session "$CODEX_SESSION_ID" --task T-101 --entity flask/app.py

python coord_ledger.py report --ledger .coord-ledger
python coord_ledger.py report --ledger .coord-ledger --json
```

账本 = `.coord-ledger/events.jsonl`，**append-only**；capsule 视图由事件流**推导**（不是快照），因为 \(B(t)\) 需要"在时间 t 上成立"这一信息，而快照表达不了。

### 2.1 实测输出（多开发者 × 多会话失效场景）

```
capsules (tasks)  : 2
open (= backlog)  : 0
integrated        : 1
decayed (stale/abandoned): 1
contested entities: 1
writes after context loss: 2
top contested entities:
  file::flask/app.py: tasks=2 sessions=2 touches=4
```

四个信号都是框架直接需要的：

- **`contested entities`** —— 同一实体被 2 个 task、2 个 session 触碰 4 次。这是"重复实现/无主变更"的**真值**：任何单个 session 只能看到自己的触碰，这个跨会话视角**只有账本能提供**；
- **`writes after context loss`** —— **这是 H3（质 vs 量）的探针**。计的是"该 session 已经上下文压缩之后，仍然发出的写入"；
- **`open (= backlog)`** —— \(B(t)\) 当前值；
- **`decayed`** —— stale/abandoned，即**未集成而被关闭的浪费**，必须与积压分开报（否则一波放弃会让积压看起来在缩小——这个坑已写进测试）。

### 2.2 已实现 vs 未实现

| 项 | 状态 |
|---|---|
| 事件记录（CLI + stdin hook JSON） | ✅ |
| capsule 推导、状态机（ISCC lifetime 词表） | ✅ |
| \(B(t)\) 时间序列重建 | ✅ |
| \(\lambda_{\text{produced}}\) / 集成速率 | ✅（窗口过短时**主动拒报**） |
| 跨会话实体争用（符号级 vs 路径级） | ✅ |
| 45 个回归测试 | ✅ |
| **hook 接线（`hooks.json` / `.codex-plugin`）** | ❌ **未做** |
| **有效并行度 \(P\)**（H5 的分母） | ❌ **未做，必须补** |
| 治理/干预逻辑 | ❌ 未做（按 §1.1 应后置） |

---

## 3. hook 接线设计（未实现，待确认宿主）

### 3.1 宿主两选一

| 宿主 | 配置文件 | hook 形态 |
|---|---|---|
| Cursor | `.cursor/hooks.json` | `command` 脚本，JSON 走 stdin/stdout，可 `failClosed` |
| Codex | `<plugin>/.codex-plugin/plugin.json` | `hooks` 映射到会话事件，可调 `mcp_tool` |

本仓库的脚本与宿主无关（纯 stdin JSON → stdout），**换宿主只换接线，不换实现**。

### 3.2 事件映射

| 宿主事件 | 记录为 | 作用 |
|---|---|---|
| `sessionStart` | `session_started` | 建立 session 归属 |
| 任务认领（首个 prompt） | `task_registered` | **开 capsule**；登记 `scope.entities` |
| `afterFileEdit` / `postToolUse` | `file_write` | 触碰计数 + 实体抽取 |
| **`preCompact`** | **`context_compacted`** | **见 §3.3** |
| `stop` / `sessionEnd` | `session_ended` | 封口 |

### 3.3 `preCompact` 是本设计的关键发现

上下文压缩**就是**"上下文有界"这一机制的**具体、带时间戳的观测点**。在此之前，"上下文有限"只是一个解释性说法；挂上 `preCompact` 之后：

- 每次丢失发生的时间可测；
- 丢失**之后**的写入可单独计数（`writes_after_context_loss`）；
- 于是「同等 \(\lambda/R\) 下，agent 变更是否比人类变更产生更高不可解释度」（**H3**）从主张变成可做的比较。

**我的判断：这是本框架里最可能出论文的一张图**——把"不可解释度/返工"对"距上次上下文丢失的写入数"回归。

### 3.4 一个必须修的上游缺口

`context_compacted` **不在 ISCC v0.1 的事件枚举里**（v0.1 只有 `task_registered | file_read | file_write | command | test | review | decision`）。

即：**ISCC v0.1 无法记录它自己框架的根因。** 这是实现过程中发现的真实缺口，不是变通。处理方式：

- v0.1 期间：本账本作为**扩展**记录之，并在任何写作中声明（`report` 的 guards 里已写）；
- 需要 `iscc-0.2`：把"产生该变更时的上下文状态"纳入 provenance——因为一个在上下文丢失后产生的变更，其 provenance **本身就不同**，这与"改了什么"同等重要。

测试 `test_context_compacted_is_not_in_iscc_v01` 守着这个缺口：一旦它失效，说明 v0.2 已落地，README 需同步。

---

## 4. 测试与运行

```powershell
cd 04_协调插件
python -m unittest discover -s tests -v      # 45 tests
```

测试保护的性质（都是测量有效性的前提，不是代码整洁度问题）：

- **不可归属的事件必须被拒**（无 `session_id` → 报错，不写盘）。一条无法归属的变更不是证据；
- **\(B(t)\) 必须精确重建**（它是 Git 拿不到、而承载论文核心经验主张的量）；
- **符号级与路径级争用必须可区分**——否则"同一目标被反复触碰"会与"同一文件里的无关编辑"混为一谈（守卫 `LF` 的效度）；
- **上下文丢失前后的写入必须分开**——这是 H3 的探针；
- **速率在过短窗口下必须拒报**——首版 e2e 曾报出 `λ=5625/h`（一段 1 秒内写完的事件），已修并加回归测试；
- **`report` 必须声明未施加治理，并带 observation-effect 与 H9 警告**。

---

## 5. 已知限制

1. **有效并行度 \(P\) 未测量。** 没有它，任何 \(R\) 的改善都无法与"只是限流了"区分（主文档 §34 的 \(\tau_{parallel}\)、H5）。**这是下一个必须补的仪表。**
2. **观测者效应未量化。** 记录本身可能改变行为；已在 guards 中声明，但需要"记录开/治理关"的对照期实测。
3. **实体抽取质量未验证。** `scope.entities` 来自 hook，未被人工核对；符号级争用的假阳性率未知。
4. **争用是筛查信号，不是结论。** 重叠频次本身**永远不能**作为协调失败的证据（与硬约束 H9 一致，已写入 guards）。
5. hook 接线与治理逻辑均未实现；本目录目前只是**仪表**。

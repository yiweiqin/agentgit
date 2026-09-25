# E2 检测准确率报告

**日期**：2026-09-15
**任务包**：`task-packs/detection-v1/pack.json`（8 个案例：5 碰撞 / 3 独立对照）
**结论**：**检测器在 advisory 用法下满足冻结门槛，但 recall 完全是"实体重叠"的产物，意图匹配器在最难的语义重复上贡献为零；一旦用作准入门控（A4），误拒率 0.333，是 H9 上限 0.05 的 6.7 倍。**

原始证据：`eval.json`。

---

## 1. 结果

| 臂 | 判定 | precision | recall | 对照被标记率 | **误拒率** |
|---|---|---|---|---|---|
| `A1-instrument` | **MET** | 0.800 | 0.800 | 0.333 | 0.000 |
| `A3-advisory` | **MET** | 0.800 | 0.800 | 0.333 | 0.000 |
| `A4-gated` | **MISSED（触发 I4）** | 0.800 | 0.800 | 0.333 | **0.333** |

**结构性上限**：`entityVisibleCeiling = 0.800`。5 个碰撞里只有 4 个与其他在飞工作共享实体，因此**任何**实体键检测器的 recall 上限就是 0.8。实测 `recallWithinCeiling = 1.000`——**可达的碰撞全部被找到，唯一漏掉的是构造上不可达的那一个**。

## 2. 逐案例

| 案例 | 真值类型 | 重叠 | 标记 | 判定依据 | 意图相似度 |
|---|---|---|---|---|---|
| `p-lexical-near-duplicate` | true-collision | 是 | 是 | `duplicate-intent` | 0.750 |
| `p-identifier-dup` | true-collision | 是 | 是 | `duplicate-intent` | 0.643 |
| `p-semantic-different-words` | semantic-duplicate | 是 | 是 | **`cross-task-conflict`** | **0.286** |
| `p-semantic-different-words-shared-identifier` | semantic-duplicate | 是 | 是 | **`cross-task-conflict`** | **0.083** |
| `p-control-untouched-file` | independent-control | 否 | 否 | `no-contention` | — |
| `p-control-same-entity-different-purpose` | independent-control | 是 | **是（误报）** | `cross-task-conflict` | 0.000 |
| `p-hidden-dependency` | hidden-dependency | 否 | 否（漏） | `no-contention` | — |
| `p-control-different-entity-close-words` | independent-control | 否 | 否 | `no-contention` | — |

## 3. 这张表说明了什么（关键诊断）

**recall 不是"理解"换来的，是"重叠"换来的。** 两个语义重复案例（0.286 / 0.083）都远低于 `duplicateIntentThreshold = 0.42`，它们是靠实体重叠被标成 `cross-task-conflict` 的，不是靠意图匹配被识别为 `duplicate-intent`。

推论有三条，都指向 `I3`：

1. **意图匹配器在难例上是 0 贡献**。目前唯一被判为 `duplicate-intent` 的两个案例，都是措辞几乎相同或共享标识符的"易例"（0.750 / 0.643）。C1（语义重复）在 `task-packs` 里就是为这条准备的。
2. **precision = 0.800 是任务包成分的巧合，不是能力的体现**。它是"凡是重叠就报警"这一策略在 3 个对照上的产物。真实仓库里"同一文件、不同目的"的一对多关系远比本包密集，所以 0.800 不能外推。
3. **A4 的误拒率 0.333 是 H9 硬约束的直接违反**。被拒的是 `flask/config.py` 上一个与在飞工作**目的无关**的改动（相似度 0.000）。按总纲，重叠**本身永远不能**作为协调失败的证据；把它用作拒绝理由，就是把 H9 明令禁止的推断写进了执行路径。

因此 `I4` 的正确修法不是"调高阈值"——**阈值在 0.42 时 precision 就已经 0.8，调高只会掉 recall**——而是**要求意图证据才允许拒绝**：`A4-gated` 只在 `duplicate-intent`（即相似度越过阈值）时 deny，在仅有 `cross-task-conflict` 时降级为 advisory。这条修改既保住 recall（可达碰撞仍被 advisory 覆盖），又把 `falseRejectionRate` 压到 0。**它是 I4 的假设，尚未验证。**

## 4. E2 抓到的两个真实缺陷

E2 的价值不只是给出数字，它在跑通的过程中暴露了两个**静默**缺陷——都不会让测试变红，只会让 E3 的数字无法解释。

### 4.1 治理器看不见"第一次"碰撞（严重）

`decideWrite` 的输入取自 `buildContention`，而它按定义**只保留被 ≥2 个 task/session 触碰过的实体**。但提案本身正要成为"第二个触碰者"，所以实体在决策时刻只有**一个**触碰者 → 被过滤掉 → `competing.length === 0` → **判定为无争用**。

后果：治理器对每个实体的**第一次**重复完全静默，只从**第二次**重复起才开始工作。E3 的主指标是重复落地率，也就是说这个缺陷会**恰好在被测量的那批事件上关掉 treatment**。

修复：新增 `entityTouches`（不按 ≥2 过滤）用于**决策**；`buildContention`（保留过滤）继续用于**报告**的争用统计。两者语义不同且都是对的，混用才是错的——代码里已写明这条边界。

> 这个缺陷是 E2 用"每个碰撞只有一个先行触碰者"的包测出来的，而那正是真实第一次碰撞的样子。E0 的合成流覆盖不到它，因为 E0 的争用是"多触碰者"构造的。

### 4.2 任务包的真值标签可以是假的

第一版包里，`p-hidden-dependency` 与 `p-control-different-entity-close-words` 被**声明**为"不与在飞工作重叠"，但它们的路径实际上已被其他 task 写过——所以前者根本不是隐藏依赖（它 plainly 可见），后者根本不是独立对照。

修复：**重叠不再声明，改由 `priorEvents` 推导**，并在派生前做一致性校验——声明为"隐藏依赖"却重叠、或声明为"碰撞"却零重叠，一律**拒绝评分并报错**。声明可以是错的，推导不会。

> 这两个缺陷合起来说明为什么 E2 必须先于 E3：一个能把"第一次碰撞"漏掉、又能拿假真值评分的检测器，会让 E3 的零结果同时兼容"检测器没工作"和"治理没用"两种解释，而两者需要完全相反的后续动作（`I6` vs `I3`）。

## 5. 与预注册门槛的对照

门槛冻结于 `../preregistration.md` §4：recall ≥ 0.60、precision ≥ 0.80、误拒率 ≤ 0.05。

| 门槛 | A1/A3 | A4 |
|---|---|---|
| recall ≥ 0.60 | 0.800 ✓ | 0.800 ✓ |
| precision ≥ 0.80 | 0.800 ✓（**恰好压线**） | 0.800 ✓ |
| 误拒率 ≤ 0.05 | 0.000 ✓ | 0.333 ✗ → **I4** |

**precision 恰好等于门槛，不是好消息**：它意味着任何一个更难的任务包都会让它跌破。E2 的结论应记为"**在 advisory 用法下勉强达标，且达标方式（纯重叠）不可外推**"。

## 6. 测试状态

| 套件 | 结果 |
|---|---|
| TypeScript（`node --test`） | **176 pass / 0 fail** |
| Python（`unittest`） | **45 tests OK** |
| E0 门 | PASS（64 项比较，exact match rate 1.0000） |
| E2 门 | 按设计退出码 **1**（已测量，A4 未达门槛 → 记录 I4） |

E2 脚本用三值退出码区分三件事：`0` 全部达标；`1` 已测量但未达标（**是结果，触发迭代器**）；`2` 无法测量（**是故障**）。把"未达标"和"崩溃"混为一谈会训练我们忽略它的失败。

## 7. 未完成

- **puppet 会话尚未接入**：本报告用的是**构造任务包**直接喂给检测器（纯函数），不是真实 agent 会话产生的变更。`preregistration.md` §4 要求"用脚本化 puppet 会话确定性地产生构造好的变更"，这一步依赖远程机。
  因此当前结论的适用范围是**检测器逻辑**，不是**端到端检测行为**——后者还包含意图文本如何从真实工具调用中提取（`adapter.ts` 的 `extractIntent`），那是另一个可能失败的环节。
- 真实仓库密度下的 precision 未知：本包只有 8 个案例，且"同实体不同目的"的对照只有 1 个。

# Gate A 标注手册 v1.1（Flask 真实历史试点·冻结版）

本手册是 `../../GateA标注与基准规范.md` 在「真实历史并行变更流」上的操作化版本。上位规范定义构念；本手册定义**在本试点的标注包里，每条标签具体看什么字段、什么算证据、什么不算**。

冻结日期：2026-09-14。对应 `packet_version = 1.1`。修改规则见 `preregistration.md` 与 `adjudication_log.md`。

> **v1.0 → v1.1 变更**：新增 §3.9 `LF`（可理解性侵蚀）标签，标签集由 8 类扩为 9 类，标注包随之重建（`packet_version` 1.0 → 1.1）。
> 变更理由、影响范围与重标要求见 `adjudication_log.md` 的 **D3** 条。变更时标注尚未开始，因此无既有标签需要重标。

---

## 1. 标注单位与可见信息

一个标注单位 = 一个 scenario = 一个标注包文件（`packets/<scenario_id>.json`）。

标注包只有两个视图，且必须按顺序使用：

| 视图 | 字段 | 可用标签 |
|---|---|---|
| 预测前视图 | `prediction_view` | 全部八类，但 `BC`/`AC`/`RI`/`ID` 在此阶段通常只能给出风险性判断 |
| 结果视图 | `result_view` | `BC`、`AC`、`RI`、`ID`，以及所有标签的修订 |

**`phase_1` 必须在看到 `result_view` 之前完成并锁定。** 锁定后再看结果视图，把新增或修订写入 `phase_2`，不要覆盖 `phase_1`。

## 2. 证据引用语法

每条标签的 `evidence` 是字符串数组，每个元素是一个**指向标注包的路径**或一个显式的缺失标记：

```text
prediction_view.tasks.A.acceptance_criteria[0].text
prediction_view.change_sets.B.diff_hunks[3].lines
prediction_view.shared_entities.symbols[1]
result_view.merge_replay.textual_conflict_observed
result_view.repair_or_revert_history[0].sha
packet_missing:prediction_view.tasks.A.acceptance_criteria
```

规则：

- 路径必须能在对应标注包中解析成功，`validate_annotations.py` 会逐条校验；
- `packet_missing:` 只能用于**标注包中确实标记为不可得**的字段（例如 `agent_context_summary.status = "unavailable"`）。用它来指代一个其实存在的字段属于无效标注；
- 不允许写自然语言描述代替路径。可以在路径之外**追加**说明，但路径必须存在。格式：`<path> :: <说明>`。

## 3. 标签操作化定义

### 3.1 `TC` 文本冲突

- **看**：`result_view.merge_replay.textual_conflict_observed`、`merge_replay.auto_tree` 与 `result_view.merge_replay.manual_tree_difference`。
- **算**：三方合并产生冲突标记，或自动合并树与开发者实际提交树不一致且差异可由变更组合解释。
- **不算**：仅仅修改了同一个文件、同一文件的不同位置。
- 本试点已知背景：80 个 PR-like merge row 的自动合并树与实际树全部相同。因此 `TC = no` 是**预期结果**，不是标注失误；`TC = yes` 需要指出具体冲突证据。

### 3.2 `BC` 行为冲突

- **看**：`prediction_view.tasks.*.acceptance_criteria`、`prediction_view.pre_change_test_state`、`result_view.post_integration_tests`、`result_view.repair_or_revert_history`。
- **算**（至少一项，对应 H4）：
  1. 合并后原有测试失败且可归因于两个变更的组合；
  2. 新增验收测试失败；
  3. API / schema / 协议契约被破坏；
  4. 后续修复或回滚提交明确撤销或重写了其中至少一个变更。
- **不算**：测试未运行、代码风格差异、作者主观不喜欢。
- **关键**：若 `result_view.post_integration_tests.status = "not_executed"`，则本标签最多只能给 `uncertain`（除非有第 4 类后续修复证据）。**不得因为「没有测试失败」而判 `no`**，那会把「未测量」当成「未发生」。

### 3.3 `AC` 架构冲突

- **看**：`prediction_view.change_sets.*.touched_symbols`、`shared_entities`、`result_view.repair_or_revert_history`、`prediction_view.tasks.*.acceptance_criteria` 中的项目约束。
- **算**（至少一项）：静态架构 / lint 规则失败；维护者在审查或后续提交中明确指出违反架构约束；依赖图出现被项目规范禁止的边；同一资源的所有权或初始化责任出现两个互不兼容的实现。
- **不算**：不同设计风格、作者偏好、「我觉得这样更清晰」。
- 没有项目级约束证据时记 `uncertain`，不得直接记 `yes`。

### 3.4 `RT` 重复任务

- **看**：`prediction_view.tasks.A/B.description_text` 与 `acceptance_criteria`。
- **算**：两个任务的验收条件实质重叠，完成一个会满足另一个的大部分核心验收条件。
- **不算**：都改同一个文件、都包含「加测试」、共享领域词汇。
- 建议同时填 `overlap_ratio`（核心验收条件交集 / 并集）。该值是辅助证据，不是自动阈值。
- **本试点的现实约束**：Flask PR 通常**没有声明式验收条件**。若 `acceptance_criteria_status = "not_declared"`，必须记 `uncertain`，并在 `notes` 中说明缺什么才能判定，**不得**用 PR 标题相似度替代验收条件比较。

### 3.5 `RI` 重复实现

- **看**：`prediction_view.change_sets.A/B.diff_hunks` 与 `touched_symbols`，以及 `result_view.repair_or_revert_history`。
- **算**：两个变更实现同一能力，最终只保留一份，或其中一份被删除、回滚、重构为另一份的调用方。
- 与 `RT` 相互独立：任务描述不同但实现目标重叠 → 只有 `RI`；任务重复但一方失败 → 只有 `RT`。

### 3.6 `CC` 概念冲突

- **看**：`touched_symbols`、契约 / schema / 文档类文件、`acceptance_criteria`。
- **算**：两个变更对同一规范概念、业务状态或接口语义使用不一致的名称、类型、生命周期或约束，导致维护者无法把它们视为同一抽象。
- **不算**：仅变量名不同。必须说明两者是否代表同一概念。

### 3.7 `UA` 无归属产物

- **看**：`change_sets.*.files`、`provenance`、`agent_context_summary`。
- **算**：文件、代码片段、生成物或配置无法映射到有效任务、标注者或生命周期状态，且场景结束时仍未被明确接受、废弃或解释。
- **不算**：提交信息简短。
- **关键**：本试点 `agent_context_summary.status = "unavailable"`，因此「无法映射到某个 agent」在本试点**不可判定**。若仅因缺少 agent 归属而怀疑 UA，记 `uncertain` 并注明 `packet_missing:prediction_view.agent_context_summary`。

### 3.8 `ID` 集成债务

- **看**：`result_view.repair_or_revert_history`、`result_view.post_integration_tests`、`result_view.integration_outcome`。
- **算**：变更没有立即导致合并失败，但后续必须付出可观测返工、回滚、人工重构或额外验证成本。
- **必须附成本证据**（H3）：额外修改行数、额外人工时间、额外测试轮次、回滚次数或延迟天数，至少一项数值。填写位置：`phase_2.cost_evidence.<annotator>`。
- 没有数值成本证据时，只能记 `possible_ID`，**不得**记 `yes`。
- 本试点的成本证据主要来自 `repair_or_revert_history` 中被判定为返工的提交。若该列表为空，通常应记 `no` 或 `possible_ID`，并在 `notes` 中说明观察窗口。

### 3.9 `LF` 可理解性侵蚀

- **看**：**`prediction_view.repeated_touch_evidence`**（这是本标签的主证据块）、
  `prediction_view.change_sets.A/B.touched_symbols`、`prediction_view.tasks.*.acceptance_criteria`、
  `result_view.repair_or_revert_history.entries`。
  **不要**把 `prediction_view.shared_entities` 当作本标签的证据来源——本试点的
  `shared_entities.symbols` 在所有 7 个候选上均为空（两个 PR 没有任何共同符号），它只是筛选信号。
- **先看结论字段**：`repeated_touch_evidence.lf_judgeable_from_this_packet`。
  若为 `false`，说明本包**结构上无法**建立符号级反复触碰证据，此时：
  - 若你认为该处确有意图侵蚀 → 记 `uncertain`，并在 `notes` 中引用
    `repeated_touch_evidence.lf_judgeability_verdict` 说明缺什么；
  - 只有在 `lf_judgeable_from_this_packet = true` 时才可能给出 `LF = yes` 或 `LF = no`。
- **算**（至少一项，且必须在符号级成立）：
  1. 同一实体在观察窗口内被 **3 个及以上不同变更**触碰，且这些变更归属于不同任务；
  2. 该实体的当前形态包含**无法由任一任务验收条件解释**的部分（例如两套并存且无一处被声明废弃的实现路径）；
  3. 后续历史中对该实体的修改（`repair_or_revert_history.entries[*].subject`）无法归属到任何在案任务。
- **不算**：
  - 两个变更共享同一路径或符号——**`shared_entities` 是筛选信号，不是本标签证据**；仅凭它就判 `LF = yes` 属于无效标注（H9）；
  - **用路径级代理凑够"三次触碰"**：`repeated_touch_evidence` 中的 follow-up 计数只统计"改过含有该符号的**文件**"的 merge，
    同一个文件上的 merge 可能改的是完全无关的符号。因此
    `distinct_touch_count_upper_bound_path_proxy ≥ 3` **不构成**本标签证据；
  - 文件被改动行数多、提交次数多；
  - 每次修改都能清晰归属到不同任务且各自语义完整。
- **与冲突类标签的关系（必须遵守）**：`LF` 与 `TC`/`BC`/`AC` 用不同证据、回答不同问题。**`TC = no` 或 `BC = no` 不能推出 `LF = no`**；本试点的 `TC` 已知几乎全为 `no`（80 个 merge row 自动树全部一致），因此若用 `TC = no` 反推 `LF = no`，本标签会被系统性清零。
- **本试点现实约束**：Flask 候选只提供**一对** PR 的上下文，且观察窗口受 `merge_rows.jsonl` 覆盖范围限制（见 `repair_or_revert_history.window_truncated_by_data`）。若窗口不足或无法建立"反复触碰"，必须记 `uncertain` 并在 `notes` 中写明缺什么才能判定；**不得**因为"证据不足"而记 `no`。
- **标签地位**：探索性标签，边界尚未经验证。一致性不达标时必须降级或撤销（对应主文档 H6 的否决条款）。

## 4. 置信度

| 取值 | 含义 |
|---|---|
| `high` | 证据完整、无需推断；另一个标注者读同样的证据应得到同一结论 |
| `medium` | 证据存在但需要一步推断 |
| `low` | 主要靠启发式或缺失信息 |

`value = null` 时 `confidence` 必须为 `null`。`high` 必须伴随非空证据（H1）。

## 5. 标注流程

1. 打开标注包，只读 `prediction_view`；
2. 独立填写 `phase_1.annotator_A`（或 `B`）的全部九类标签；
3. 将 `phase_1.locked_at` 记为 UTC 时间戳，此后不得回头修改 `phase_1`；
4. 阅读 `result_view`，填写 `phase_2`（含 `cost_evidence`）；
5. 两名标注者**在完成一致性计算之前不得交流**；
6. 运行 `python validate_annotations.py` 确认没有硬约束违规；
7. 运行 `python inter_rater.py` 得到逐标签一致性、阈值判定与裁决队列；
8. 只对分歧样本走第三方裁决，写入 `adjudication_log.md`。

## 6. 禁止事项

- 不得阅读 `adjudication.md`、`strict_candidate_adjudication.md`、`screening_report.json` 或任何筛选器初审意见（H7）；
- 不得把「证据缺失」记成 `no`；
- **不得用 `TC = no`、`BC = no` 或 `AC = no` 反推 `LF = no`**；
- **不得仅凭 `shared_entities` 的路径/符号重叠判 `LF = yes`**（H9）；
- 不得删除模糊例；
- 不得在 `evidence` 里引用标注包之外的来源（如直接去 GitHub 网页看 PR 讨论）——所有可用证据必须已在标注包内；
- 不得为了让一致性好看而在标注后修改手册。

## 7. 有效性威胁（必须在论文中报告）

1. **代理威胁（本版已按主场景重述）**：本研究的锚定场景是「单开发者 × 多 agent 会话」，而本试点用的是**不同人类作者的并行 PR**。两者在两点上可比：任务都由人显式声明，协调者都是人；但有两点不可比且必须报告——(a) 多会话场景的下游是**同一个人的多个会话**，本试点是**不同人**的 PR，因此不共享会话历史、也不会发生同一个人在不同会话里重复交代同一件事；(b) 完全没有 agent 上下文、提示、重试与失败轨迹，因此 `UA` 在本试点不可判定。**本试点只能支持"并行变更流的协调可判定性"，不能支持"多会话 agent 开发的协调可判定性"。**
2. **任务文本威胁**：Flask PR 缺少声明式验收条件，`RT`/`CC` 的判定证据天然稀薄，可能导致这两个标签一致性偏低，而这种偏低**部分来自数据源，而非构念本身**。
3. **结果证据威胁**：本试点无法离线运行完整测试套件，`BC` 多数只能给 `uncertain`。因此 `BC` 的一致性问题可能反映的是证据不足，不是标注者分歧。
4. **负控聚集威胁**：7 个候选初审均为负控，正例缺失会使 κ 类指标在极端边际分布下不稳定，故同时报告 AC1。**该威胁对 `LF` 尤为严重**：见下条。
5. **`LF` 场景结构威胁（新增，v1.1）**：`LF` 的判定条件之一是"同一实体被 3 个及以上不同变更触碰"，但本试点的样本单位是**一对** PR，且观察窗口受 `merge_rows.jsonl` 覆盖范围限制。这意味着即使某个候选确实存在意图侵蚀，本试点也可能**无法在包内建立"反复触碰"的证据链**，从而只能记 `uncertain`。因此 `LF` 在本试点的低一致性或高 `uncertain` 比例，**首先应被解释为样本结构限制，而不是构念不可判定**；`uncertain` 超过 30%（G5）时，正确动作是补场景，而不是撤销标签。同时必须报告 `LF` 与 `TC`/`BC` 是否高度共现——若共现，说明它没有独立构念。
6. **规模威胁**：n = 7，只做可行性判定，不做推断统计。

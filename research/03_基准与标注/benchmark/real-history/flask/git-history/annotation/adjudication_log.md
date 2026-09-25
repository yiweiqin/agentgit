# 裁决日志（Flask 真实历史试点）

本文件是 `preregistration.md` 指定的「分歧、裁决和手册修改记录」（Gate A 交付物之一，
见 `../../GateA标注与基准规范.md` §9）。它同时承担两个职责：

1. **分歧裁决记录**：`inter_rater.py` 生成的 `adjudication_queue.jsonl` 中的每一条，都必须在这里留下裁决记录；
2. **预注册变更记录**：任何对手册、门槛或统计口径的改动，必须在标注开始后**追加**在此，并说明哪些已标注样本需要重标。

规则（来自 `preregistration.md` H6/H8 与 §7）：

- 两名标注者在一致性计算完成之前不得讨论样本；裁决只能由第三方裁决者做；
- 禁止简单多数表决：裁决必须写出**分歧来源**（证据缺失／定义边界／标签域理解不同／标注失误）；
- `uncertain` 是合法取值，不得为了抬升一致性而删除模糊例；
- 本文件与 `adjudication.md`、`strict_candidate_adjudication.md` 的地位完全不同：后两者是单研究者对**筛选候选**的初审意见，
  按 H7 不得作为标注真值，也不得在标注完成前提供给标注者阅读。

---

## 1. 预注册变更

冻结基线：`annotation_manual.md` v1.0、`packet_version = 1.0`、预注册日期 2026-09-14。
下表中每一行都是对冻结基线的偏离；「需要重标的样本」一栏必须写明确，不允许写「无影响」。

| 编号 | 日期 | 变更内容 | 触发原因 | 生效版本 | 需要重标的样本 | 已标注且未重标的样本 |
|---|---|---|---|---|---|---|
| D1 | 2026-09-14 | 预注册 §6 的「标注者对层面的 bootstrap」实现为**场景（脚本单元）层面的重采样**（10000 次，种子 20260914） | 本试点只有 2 名标注者，标注者层面的重采样退化为单一抽样单元，无法产生分布 | `inter_rater.py` v1.0 | 无（统计口径变更，不影响任何标签的取值） | 无（标注尚未开始） |
| D2 | 2026-09-14 | **标注开始前必须补充正例候选**；不允许在全部负例的候选集上开始标注 | `inter_rater.py` 在「双方对某标签全部填同一个值」时给出数学上**未定义**的 κ / α / AC1（脚本内合成检查见 `tests/test_annotation_pipeline.py::test_all_negative_sheet_agrees_but_cannot_claim_a_gate`）：此时原始一致率恒为 1.0，但没有任何一致性统计量可报告，门槛判定必然 `not_evaluable`。预注册 §6 只预期了「κ 被流行率压低」，未覆盖「统计量彻底未定义」 | 待定（需先扩充候选集） | 无（本条目在标注开始前生效，无旧样本） | 无 |
| D3 | 2026-09-14 | **标签集由 8 类扩为 9 类，新增探索性标签 `LF`（可理解性侵蚀）**；`packet_version` 1.0 → 1.1；标注包与空白标注表全部重建（哈希变化）；新增硬约束 **H9**；预注册 §3 分层、G3、§6 共现检查、§7 规则 5 同步更新；`inter_rater_report` 新增「`LF` 独立性检查」小节 | 原标签集只能覆盖**升级为冲突**的重复修改（TC/BC/AC），而主文档 §2.1 的第一条现象是「同一处被反复修改后无人知道其意义」——它在**行为兼容、无任何冲突**时同样发生，原 8 类标签在此情形下会全部判 `no`，即把「未冲突」误读为「未被侵蚀」。该缺口由 `01_问题定义与定位` 的构念审计发现，对应主文档新增 H6 与 §33 新增 `M_legibility` 维度（此前 `CC` 也缺失于 §11.1/§24/§33 三处，同一轮修复） | `annotation_manual.md` v1.1、`packet_version = 1.1`、`preregistration.md` v1.1 | **无**（变更时 `labels_v1.blank.jsonl` 中所有标签仍为 `null`，标注尚未开始） | 无 |

D1 必须在论文中声明：报告出的置信区间反映的是**场景抽样**不确定性，而不是标注者抽样不确定性；
在 n = 7 的场景数下该区间只用于显示不确定性宽度，不具备推断意义。

D2 的处理顺序：先用现有筛选脚本（`extract_candidates.py` / `screening_report.py` / `replay_merges.py`）
扩大候选池并保留正例（历史上确实出现过后继修复或回滚的候选），再冻结新的标注包版本，然后才开始双人标注。
**不得**先用全部负例标注、再回头把「全负例导致统计量未定义」解释成「ACCD 不存在」。

D3 的三项必须同时成立才算这次变更有效，缺一项即视为预注册违规：

1. **重建后无残留旧哈希**：`annotation/packets/index.json` 的 `packet_version` 为 `1.1`，且
   `labels_v1.blank.jsonl` 中每条记录的 `packet_sha256` 与重建后的包一一对应；任何旧哈希残留都意味着
   标注表与标注包已经脱钩；
2. **`LF` 不进入核心标签判定**：它只出现在预注册 §3 的探索层，且 `inter_rater.py` 不把它计入核心门槛；
3. **`LF` 必须接受独立性检验**：`inter_rater_report.md` §5 的共现矩阵中，若
   `LF_yes_without_any_conflict = 0`，必须按预注册 §6 与主文档 H6 的否决条款撤销或并入冲突类维度，
   **不得**在论文里把它作为独立贡献报告。

D3 已知的未完成项（必须在 Gate A 结束前处理，否则不得声称 `LF` 已被校准）：

1. **本候选集上 `LF` 完全不可判定（已实测）。** 重建标注包后，
   `prediction_view.repeated_touch_evidence.lf_judgeable_from_this_packet` 在**全部 7 个候选上均为 `false`**：

   | scenario | verdict | 说明 |
   |---|---|---|
   | flask-pr-5516-pr-5514 | `no_symbol_level_evidence_available` | 两个 patch 均未抽出可枚举的符号 |
   | flask-pr-5754-pr-5723 | `no_symbol_level_evidence_available` | 同上 |
   | flask-pr-5757-pr-5723 | `no_symbol_level_evidence_available` | 同上 |
   | flask-pr-5797-pr-5723 | `path_proxy_reaches_threshold_but_symbol_level_unestablished` | 仅路径级代理够 3 次 |
   | flask-pr-5812-pr-5808 | `path_proxy_reaches_threshold_but_symbol_level_unestablished` | 同上 |
   | flask-pr-5818-pr-5808 | `path_proxy_reaches_threshold_but_symbol_level_unestablished` | 同上 |
   | flask-pr-5898-pr-5808 | `path_proxy_reaches_threshold_but_symbol_level_unestablished` | 同上 |

   根因：**没有任何一个候选的两个 PR 触碰同一个符号**（`repeated_touch_evidence.symbols_touched_by_both_packet_changes` 全部为空，
   且 `shared_entities.symbols` 在全 7 个候选上均为空）。因此"同一实体被 3+ 个变更触碰"在符号级无法成立，
   只有路径级代理能达到 3 次——而路径级代理明确**不构成** `LF` 证据（手册 §3.9、H9）。
   该事实由回归测试 `tests/test_annotation_pipeline.py::test_lf_is_not_judgeable_in_this_candidate_set` 固定：
   未来扩充候选池使 `LF` 变得可判定时，该测试会失败并强制同步更新本条记录。

2. **`03_基准与标注/benchmark/gateA-pilot/scenarios.jsonl` 尚未包含 `LF` 场景**，因此 `LF` 目前没有任何合成校准证据。

3. **`LF` 的可判定性受样本结构限制**：本试点每个样本只是一对 PR，
   `prediction_view.repeated_touch_evidence` 中的 follow-up 计数是**路径级代理**，不能证明符号级反复触碰
   （见 `annotation_manual.md` §7 威胁 5）。因此 `LF` 的高 `uncertain` 比例**首先**应归因于样本结构，
   而不是构念不可判定；修复方式是补充能提供多次触碰证据的候选，而不是撤销标签。

**由 1 与 2 得出的操作结论**：在当前候选集上开始标注，`LF` 将 7/7 只能记 `uncertain`；
这会把 `LF` 的一致性推到 G5 不可评估，且不能产生任何关于 H6 的证据。
因此**扩充候选池（D2）与补 `LF` 校准场景应合并为同一次动作**，而不是分两步。
这两项完成前，不允许声称"`LF` 已被校准"或"`LF` 已可判定"。

## 2. 分歧裁决记录

当前状态：**无待裁决分歧**。`adjudication_queue.jsonl` 为空，因为 `labels_v1.blank.jsonl`
中尚无任何标签被两名标注者同时填写（见 `inter_rater_report.md` 的 `not_yet_computable` 状态）。

每条裁决使用以下格式，逐条追加（不要用一张表格挤在一起，裁决理由需要完整文字）：

```text
### A-001 · <scenario_id> · <label>
- 阶段：phase_2
- annotator_A：value=<...>, confidence=<...>, 关键证据：<packet 路径>
- annotator_B：value=<...>, confidence=<...>, 关键证据：<packet 路径>
- 分歧类型：证据缺失 | 定义边界 | 标签域理解不同 | 标注失误
- 第三方裁决：value=<...>, confidence=<...>
- 裁决理由：<说明为什么其中一方（或双方）的推断不能成立，必须引用手册条款>
- 手册影响：无 | 触发 D 编号 <...>
```

禁止事项：

- 不得写「按多数意见」「折中取另一值」而没有理由；
- 不得在裁决中引入标注包之外的证据（例如直接去 GitHub 看 PR 讨论）；
- 不得因为某标签一致性难看而修改手册（那属于 §7 停止与降级规则，必须先记录再重标）。

## 3. 手册版本历史

| 版本 | 冻结日期 | 变更摘要 | 对应变更编号 |
|---|---|---|---|
| v1.0 | 2026-09-14 | 初始冻结版本；八类标签操作化定义、证据引用语法、置信度与流程 | — |
| v1.1 | 2026-09-14 | 新增 §3.9 `LF`（可理解性侵蚀）操作化定义，含「不得仅凭 `shared_entities` 判定」与「不得由 `TC/BC/AC` 的 `no` 反推」两条约束；§5 流程与 §6 禁止事项同步更新为九类标签；§7 有效性威胁按主场景重写，并新增「`LF` 场景结构威胁」 | D3 |

## 4. 门槛降级记录

`preregistration.md` §7 规定：某标签一致性持续偏低时必须**先收缩定义或降级为探索性标签**，而不是删除样本。
`inter_rater.py` 会在 `inter_rater_report.md` 的 G3 行给出 `retained_confirmatory` / `downgrade_required` / `downgrade_recommended`。
每一次实际降级都必须在此登记：

| 标签 | 原层级 | 降级后 | 依据（α、原始一致率、uncertain 占比） | 报告编号 |
|---|---|---|---|---|
| （待标注完成后填写） | | | | |

# Gate A 双人标注一致性报告（Flask 真实历史试点）

- 生成时间（UTC）：2026-09-15T12:59:27.947266Z
- 标注表：`D:\AI小工具制作\AI原生变更协调研究\03_基准与标注\benchmark\real-history\flask\git-history\annotation\labels_v1.blank.jsonl`（SHA-256 `23ec87b1cfbb13b9e77286cbe32ef50da7c5b3230eb27c7124465d7b00f496c9`）
- 标注包索引：`annotation/packets/index.json`
- 统计口径：`annotation/preregistration.md` §6；门槛：同文件 §5
- bootstrap：10000 次、种子 `20260914`，按**场景**重采样（见下方偏离说明）

**状态：`not_yet_computable`；是否允许声称 Gate A 结果：`false`**

未通过项（在全部通过之前，本试点不得表述为「已获得可接受的标注一致性」）：

- 标注表中没有任何一个标签被两名标注者同时填写；本脚本不会用缺失值代替阴性，因此不计算任何一致性数值。

## 1. 计数

- 场景数：7
- 已双人填写的标签对：0
- 仍缺至少一方填写的标签对：63
- 分歧标签对：0
- 已裁决分歧：0

## 2. phase_1 逐标签指标

| 标签 | 可用场景 | 原始一致率 | Cohen's κ (yes vs rest) | Krippendorff α (nominal) | Gwet AC1 | α 95% 区间 | uncertain 占比 | high 子集一致率 |
|---|---|---|---|---|---|---|---|---|
| TC | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| BC | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| AC | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| RT | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| RI | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| CC | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| LF | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| UA | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| ID | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

α 未定义的原因（**未定义不等于一致性好，也不等于一致性差**）：

- `TC`：no_units_with_two_or_more_ratings
- `BC`：no_units_with_two_or_more_ratings
- `AC`：no_units_with_two_or_more_ratings
- `RT`：no_units_with_two_or_more_ratings
- `RI`：no_units_with_two_or_more_ratings
- `CC`：no_units_with_two_or_more_ratings
- `LF`：no_units_with_two_or_more_ratings
- `UA`：no_units_with_two_or_more_ratings
- `ID`：no_units_with_two_or_more_ratings

## 3. phase_2 逐标签指标

| 标签 | 可用场景 | 原始一致率 | Cohen's κ (yes vs rest) | Krippendorff α (nominal) | Gwet AC1 | α 95% 区间 | uncertain 占比 | high 子集一致率 |
|---|---|---|---|---|---|---|---|---|
| TC | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| BC | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| AC | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| RT | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| RI | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| CC | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| LF | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| UA | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| ID | 0 | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

α 未定义的原因（**未定义不等于一致性好，也不等于一致性差**）：

- `TC`：no_units_with_two_or_more_ratings
- `BC`：no_units_with_two_or_more_ratings
- `AC`：no_units_with_two_or_more_ratings
- `RT`：no_units_with_two_or_more_ratings
- `RI`：no_units_with_two_or_more_ratings
- `CC`：no_units_with_two_or_more_ratings
- `LF`：no_units_with_two_or_more_ratings
- `UA`：no_units_with_two_or_more_ratings
- `ID`：no_units_with_two_or_more_ratings

## 4. 门槛判定（以 phase_2 为最终标签集）

未做门槛判定：当前没有任何一个标签被两名标注者同时填写，评估门槛会把「未测量」当成「未达标」，因此本报告不做该推断。

## 5. `LF` 独立性检查（预注册 §6 v1.1 要求）

当前无法判定：`not_yet_computable_no_agreed_LF_yes`（尚无双方一致判为 `LF = yes` 的样本）。

> `LF_yes_without_any_conflict` is the only cell that shows LF is not a restatement of TC/BC/AC. If it is zero while `LF_yes_with_conflict` is non-zero, the preregistration requires merging or withdrawing LF rather than reporting it as an independent dimension.

## 6. 裁决队列

当前无分歧样本，`annotation/adjudication_queue.jsonl` 为空文件。

注意：无分歧可能是真实一致，也可能是双方都未真正使用标签空间（例如统一填 `uncertain`）。判定时必须结合上面各标签的 `uncertain` 占比与 high 子集计数一起读。

## 7. 方法与偏离说明

- 原始一致率在两名标注者都填写了值的场景上计算；缺一方填写的场景计为 missing，不计为阴性。
- Cohen's κ 使用预注册的二元化：`yes` 为阳性，`no`/`uncertain`/`possible_ID` 为阴性；`possible_ID` 因此在二元分析中为阴性，其在三分分析中的信息由 α 与 AC1 保留。
- Krippendorff α 由一致矩阵计算（名义度量），允许只被一方评分的单元存在。
- Gwet AC1 作为流行率不敏感的对照指标与 κ 同时报告，两者均呈现，不做选择性报告。
- α / κ / AC1 在边际分布退化（例如全部标签都是同一个值）时**数学上未定义**；本报告把它们记为 `n/a` 并给出原因，绝不把「未定义」写成「一致性高」。
- 结果视图依赖性是预注册要求：phase_1 与 phase_2 的分数必须同时报告。
- `LF` 与 `TC`/`BC`/`AC` 用不同证据：本报告单独给出共现矩阵（§5），因为「行为兼容但语义归属被稀释」在定义上不依赖任何冲突发生。

## 8. 有效性威胁（本报告不得越界声称）

- 场景数 n = 7，任何区间只用于显示不确定性宽度，不具备推断意义；不得报告 p 值或效应量。
- 本报告只描述**标注可判定性**，不描述 ACCD 的发生率，也不构成「ACCD 不存在」的证据。
- 人类并行 PR 是多 agent 并行任务的代理；`agent_context_summary` 不可得，`UA` 在本试点不可判定。
- `post_integration_tests.status = not_executed`，`BC` 多数只能为 `uncertain`；`BC` 的低一致性可能来自证据缺失而非构念分歧。
- 候选集以负控为主，极端边际分布会同时压低 κ 与 α；AC1 作为流行率不敏感的对照值一并报告。

## 9. 偏离与待登记事项

- 预注册 §6 写的是「标注者对层面的 bootstrap」。本试点只有 2 名标注者，标注者层面的重采样退化为单一抽样单元，因此实现为**场景（脚本单元）层面的重采样**；该替换必须登记到 `adjudication_log.md` 的「预注册变更」小节，并在论文中声明区间反映的是场景抽样不确定性。
- 本脚本生成报告不代表标注已完成；在两名标注者独立完成 phase_1/phase_2 之前，报告状态恒为`not_yet_computable` 或 `partial_no_claim`。
- `LF` 的可判定性受样本结构限制：本试点每个样本只是一对 PR，`prediction_view.repeated_touch_evidence` 中的 follow-up 计数是**路径级代理**，不能证明符号级反复触碰。`LF` 的高 `uncertain` 比例可能来自该限制而非构念不可判定（手册 §7 威胁 5）。

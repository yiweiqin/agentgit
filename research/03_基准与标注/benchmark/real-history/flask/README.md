# Flask 真实历史候选集

该目录由 `extract_candidates.py` 从公开 GitHub API 提取 Flask 仓库最近一小段已合并 PR 的元数据，用于筛选 Gate A 的真实候选场景。

## 重要边界

- `pull_requests.jsonl` 只包含 PR 元数据和文件路径，不包含源代码；
- `overlap_candidates.jsonl` 是按时间重叠或文件路径交集筛出的初筛候选对；
- `annotation_status=unannotated_candidate` 表示尚未人工判断；
- 时间重叠或文件重叠不等于语义冲突、重复任务或集成债务；
- **候选集目前以负控为主，这会阻断统计**：若两名标注者对某标签全部填同一个值，Krippendorff α、Cohen's κ 与
  Gwet AC1 都**数学上未定义**（不是「低」，而是无法计算），原始一致率会虚高为 1.0，门槛判定必然 `not_evaluable`。
  该问题与其处理决定登记在 `git-history/annotation/adjudication_log.md` 的 D2 条；**在补充正例候选之前不应开始正式标注**；
- `adjudication.md` 记录当前唯一候选对的人工初审结果；该样本因缺少并行生命周期和语义依赖被排除；
- `retrieval_log.md` 记录 GitHub 匿名 API 配额耗尽导致的分页扩展失败；
- `extract_git_merge_candidates.py` 从本地 Git 提交图提取 PR-like merge candidate，不依赖 GitHub REST API；
- `git-history/` 保存提交图筛选结果、排除记录和 manifest，不包含源代码文件；
- `git-history/screening_report.json` 区分全部路径候选、时间重叠候选和时间+生产路径候选；
- `git-history/temporal_candidates.jsonl`、`temporal_production_overlap_candidates.jsonl` 保存更严格的未标注候选子集；
- `git-history/strict_candidate_adjudication.md` 记录 7 个时间重叠候选的初审和负控处理；
- `git-history/replay_merges.py` 在本地提交图上重放三方合并并比较自动合并树与实际合并树；
- `git-history/merge_replay.jsonl`、`merge_replay_summary.json` 保存重放结果；
- `git-history/make_annotation_queue.py` 生成双人独立标注的空白队列；
- `git-history/annotation_queue.jsonl` 预填提交图证据但不含任何 ACCD 真值；
- 注意：`make_annotation_queue.py` + `annotation_queue.jsonl` 是**已被取代**的早期队列（Round 2）。当前权威的标注入口是
  `build_annotation_packets.py` → `annotation/packets/` + `annotation/labels_v1.blank.jsonl`（Round 3），
  它带双视图、证据路径校验和哈希绑定；正式标注请使用后者，不要用前者。
- `git-history/download_candidate_patches.py` 从公开 PR patch URL 下载候选变更并记录哈希；
- `git-history/candidate_patches/` 保存候选 patch 证据；这是**唯一权威**的候选 patch 存放处，哈希固定在 `candidate_patch_manifest.json`，并被 `build_annotation_packets.py` 读取；
- 根目录的 `patches/`（pr-6096 / pr-6133）属于更早一轮、只含一个初筛候选对的提取结果，被 `adjudication.md` 引用，与上表候选集不重合；
- `git-history/candidate_patch_manifest.json` 记录下载状态和 SHA-256；
- `git-history/scenario-flask-5812-5808.json` 固化一个包含共同祖先、两条 head、patch 哈希和空白标签的完整候选 scenario；
- 必须补充任务描述、验收条件、完整变更上下文和结果视图后，才能进入双人标注；
- `git-history/build_annotation_packets.py` 生成**可执行的标注任务**：每个候选一个自包含标注包
  （`git-history/annotation/packets/<scenario_id>.json`），含 `prediction_view` 与 `result_view` 两个视图，
  标注包内不含任何 ACCD 真值，且字节级确定性（无构建时间戳），因此 `packets/index.json` 里固定的 SHA-256 可被标注表引用；
- `git-history/annotation/labels_v1.blank.jsonl` 是与标注包哈希绑定的空白标注表，`annotation_status` 全为
  `awaiting_two_independent_annotators`；实际标注时另存为 `labels_v1.jsonl`，不要覆盖空白表；
- `git-history/validate_annotations.py` 校验预注册 §4 的硬约束（H1–H5、H7、H9）与证据路径可解析性，并检测标注包漂移，
  它只判机械合法性，**不判标签对错**；
- `git-history/inter_rater.py` 计算逐标签一致性（原始一致率、Cohen's κ 二元化、Krippendorff α 名义、
  Gwet AC1、场景级 bootstrap 区间），执行 §5 的 G1–G7 门槛判定，生成第三方裁决队列，并单独给出 `LF` 与 `TC`/`BC`/`AC` 的**共现矩阵**；
  它**在门槛全过之前不允许声称 Gate A 结果**（`claim_allowed=false`）；
- `git-history/annotation/annotation_manual.md` 当前为 **v1.1**（九类标签，`packet_version = 1.1`），新增 §3.9 `LF`（可理解性侵蚀）；
  v1.0 → v1.1 的变更与影响登记在 `adjudication_log.md` 的 **D3**；
- `git-history/annotation/adjudication_log.md` 记录分歧裁决、预注册变更与标签降级；
- `git-history/annotation/inter_rater_report.md`（与人读的配套 `inter_rater_report.json`）是一致性报告交付物，
  当前为 `not_yet_computable`（尚无双人填写的标签对）；
- `git-history/tests/test_annotation_pipeline.py` 是校验器与一致性脚本的回归测试，证明它们**真的会拒绝**非法标注；
- 数据使用应继续遵守 Flask 仓库的许可证和 GitHub API 条款。

## 标注流程（可执行）

在 `git-history/` 目录下执行。第 1 步只需在重建候选集时运行，它会给标注包重新打哈希，**已经开始的标注必须作废并重做**。

```powershell
# 1) 生成/重建标注包与空白标注表
python build_annotation_packets.py

# 2) 两名标注者各自独立填写：复制 labels_v1.blank.jsonl 为 labels_v1.jsonl
#    先只读 prediction_view 填 phase_1 并写 locked_at，再看 result_view 填 phase_2

# 3) 机械约束与证据路径校验（不判标签对错）
python validate_annotations.py --labels annotation/labels_v1.jsonl

# 4) 一致性、门槛判定与裁决队列
python inter_rater.py --labels annotation/labels_v1.jsonl

# 5) 回归测试：证明校验器和一致性脚本会真的拒绝非法标注
python tests/test_annotation_pipeline.py
```

标注完成前，第 4 步的状态恒为 `not_yet_computable` 或 `partial_no_claim`，且 `claim_allowed=false`。

### 在当前候选集上开始标注会发生什么（必读）

重建后的 7 个标注包全部满足 `prediction_view.repeated_touch_evidence.lf_judgeable_from_this_packet = false`：
**没有任何一个候选的两个 PR 触碰同一个符号**（`shared_entities.symbols` 在全 7 个候选上均为空）。
因此 `LF` 在符号级无法判定，7/7 只能记 `uncertain`。

这不是 `LF` 的构念缺陷，而是候选集的结构限制（详见 `annotation/adjudication_log.md` 的 D3 条目 1 与
`annotation/annotation_manual.md` §7 威胁 5）。由此得出的操作顺序是：

1. **先把 D2 与 D3 合并处理**：扩充候选池时，必须同时选入能提供**多次触碰同一符号**证据的候选，
   否则 `LF`/H6 这条线拿不到任何证据；
2. 再重建标注包（哈希会变）、重新冻结，然后才开始双人标注；
3. `LF` 是探索性标签，**不进入**核心标签（`BC`/`RT`/`RI`）的成败判定；若
   `inter_rater_report.md` §5 的共现矩阵显示 `LF_yes_without_any_conflict = 0`，必须按预注册 §6 撤销或并入冲突类维度。

## 重放

在联网环境中运行：

```powershell
python 03_基准与标注/benchmark/real-history/flask/extract_candidates.py
```

输出的 `manifest.json` 记录提取时间、样本数量和数据状态。重复运行会更新元数据时间和候选文件；正式实验应将某次运行的 manifest 固定并计算文件哈希。

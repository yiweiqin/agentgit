# AI 原生变更协调研究（资料索引）

本目录汇总了「开发者以多个 agent 会话并行修改同一代码库，导致代码冲突、重复实现、工作区污染与分支合并困难」这一观察，逐步迭代为学术化问题定义、研究假设、研究目标与可验证评价框架的全部材料。

**当前状态：proposal-ready，尚未 paper-ready**（详见 `01_问题定义与定位/目标完成度审计.md`）。已完成问题模型、ACCD **五维**构念（含新增 `M_legibility`）、ISCC 设计、研究假设 **H1–H6**、实验协议、标注手册 **v1.1（9 类标签）**、合成校准集与部分相关工作原文核对；尚未完成真实数据集、人工标注一致性、可运行检测器、在线治理实验与统计效应。**其中 `LF`/H6 这条线目前没有任何数据证据**：现有 7 个候选上 `LF` 全部不可判定。

**2026-09-25 更新**：第二轮相关工作检索使 ISCC 的两处原贡献被 2026 年的独立工作占居（详见 `02_相关工作与文献/相关工作证据矩阵.md` 第二版）。主张已按 `01_问题定义与定位/研究主张收窄与重述_2026-09-25.md` 收窄——**独立可辩护的主张收缩为三类**：失效态不可由仓库历史观测（测量学）、\(\lambda/R\) 失配与代码层归属稀释（理论）、非退化并行度下的治理（实证）。**引用或撰写相关工作前，请先读证据矩阵第九节「自伤性证据」**。

## 目录结构

```text
01_问题定义与定位/      问题定义、研究定位与完成度审计（主文档）
02_相关工作与文献/      文献证据矩阵、原文摘录与原文 PDF/文本
03_基准与标注/          Gate A 标注规范、数据采集计划与 benchmark 资产
04_协调插件/            治理 agent 的插件实现 + 分析侧仪表（观测 λ_produced 与 B(t) 的唯一通道）
05_实验/                预注册、任务包、臂编排、分析与原始结果（E0–E7）
```

`03_基准与标注/benchmark/` 下有三条并行的资产线，角色不同，不要混用：

```text
benchmark/
├── gateA-pilot/                 合成校准集：只验证「格式与标签本体自洽」，不含人工真值
├── iscc-v0.1/                   ISCC 最小数据契约：只验证 schema，不做语义判定
└── real-history/flask/          真实历史候选：从公开 Flask 仓库筛选出的并行变更候选
    ├── (根目录)                 Round 1：GitHub REST API 提取的 PR 元数据与唯一初筛候选对
    ├── patches/                 Round 1 的候选 patch（pr-6096 / pr-6133）
    └── git-history/             Round 2/3：本地提交图筛选、merge-tree 重放、标注包与标注流程
        ├── candidate_patches/   ★ 唯一权威 patch 存放处（10 个，SHA-256 固定在 manifest）
        ├── annotation/          ★ 标注工作目录（手册、预注册、标注包、标注表、报告、裁决日志）
        └── tests/               校验器与一致性脚本的回归测试
```

## 资产状态（权威 / 废弃 / 证据）

同一件事存在多份文件时，以下为准；标「已废弃」的仅为历史留存，不要在正式流程中引用。

| 资产 | 角色 | 状态 |
|---|---|---|
| `git-history/candidate_patches/` + `candidate_patch_manifest.json` | 候选 patch 与其 SHA-256 | **权威**，被 `build_annotation_packets.py` 读取 |
| `git-history/annotation/packets/` + `index.json` | 双视图标注包与冻结哈希 | **权威**，字节级确定性，重建会作废已有标注 |
| `git-history/annotation/labels_v1.blank.jsonl` | 空白标注表 | **权威**（实际标注另存为 `labels_v1.jsonl`） |
| `git-history/annotation/annotation_manual.md`、`preregistration.md` | 标注手册 **v1.1** 与预注册 | **已冻结**，修改必须记入 `adjudication_log.md`（v1.0 → v1.1 的变更见 D3） |
| `git-history/{build_annotation_packets,validate_annotations,inter_rater}.py` | 标注包生成、机械校验、一致性计算 | **权威**，标注流程的三个入口 |
| `git-history/make_annotation_queue.py` + `annotation_queue.jsonl` | Round 2 的空白工作队列 | 已废弃，被 `build_annotation_packets.py` 链条取代；其 `patch_paths` 已改指 `candidate_patches/` |
| `flask/patches/`（pr-6096 / pr-6133） | Round 1 唯一初筛候选对的 patch | 历史证据，被 `adjudication.md` 引用 |
| `flask/repo/` | Flask partial clone（含 `.git`） | 外部数据源，非本项目的版本控制 |
| `git-history/annotation/adjudication_queue.jsonl` | 待裁决分歧队列 | 由 `inter_rater.py` 生成；当前为空（尚无双人填写的标签对） |

被引用为「初审意见」的 `adjudication.md`、`strict_candidate_adjudication.md`、`screening_report.json`
按预注册 H7 **不得**作为标注真值，也不得在标注完成前提供给标注者阅读。

## 01_问题定义与定位

| 文件 | 内容 |
|---|---|
| `AI原生版本控制研究问题.md` | 主研究文档（44 节）。研究定位与**主场景定义（§1.1：单开发者 × 多 agent 会话）**、核心问题与根因、MVP 原型、形式化对象模型、RQ1–RQ4 与 H1–H6、基准两条轨道、统计分析计划、有效性威胁、ACCD 统一构念与五维测量模型（含 `M_legibility`）、因果估计对象、消融矩阵、Gate A–D 阶段门、审稿风险清单 |
| `痛点方案候选与顶会达标检验.md` | **痛点迭代的五版候选方案**（TCBL / LE / ACCD-ISCC / 覆盖缺口 / 会话来源）与逐维度顶会达标检验：10 维判据 + 三档判定规则、横向比较矩阵、推荐组合策略、判定所依据的实测事实与复现命令 |
| `痛点综合方案与评委会预演.md` | **合成后的单一痛点**（失效分类法的不完备性与意图稀释）：学术表达（中英）、形式化与定义域命题、测量与 kill criteria、**4 位审稿人 + AC 的逐条预演**（含每条反驳能否被现有证据挡住）、预测评审结论、翻盘所需的工作与最低初稿门槛 |
| `痛点_速度与上下文失配.md` | ★ **当前总纲（2026-09-15 用户选定）**：以**速度–上下文失配**为机制根因（\(\lambda\) 变更到达速率 vs \(R\) 调和能力）、以**代行 Git 人类调和职责的治理 agent** 为制品、以"用 AI 治理 AI"为立场。含形式化（调和队列模型）、RQ/H1–H5、Kill criteria、评委预演，以及 **§10 的实测基线标定**（含"失效态不可由 Git 历史观测"这一测量学结论）和 **§4.1 的插件形态** |
| `研究主张收窄与重述_2026-09-25.md` | ★ **主张层修订案（2026-09-25）**：基于第二轮相关工作检索（MPAC 已完整占据五层抽象、Claim Plane 确认性研究自报 96.7% 序列化、When Agents Coordinate 报告指定协调者无效、The Specification Gap 报告冲突报告无增量收益），逐条处置 15 项主张（撤回 8 / 收窄 5 / 强化 2），给出重构后的三项贡献（中英）、新的一页式摘要、三条对抗性证据的应答草稿、主张分级表与连带修改清单。**与总纲并存，不推翻框架，只修订可声称范围** |
| `04_协调插件/coord_ledger.py` + `tests/` + `README.md` | **分析侧仪表（参考实现，45 tests）**：观测 \(\lambda_{\text{produced}}\)、\(B(t)\)、跨会话实体争用、上下文丢失后的写入数。**只读、不施加治理**。是新插件的**契约来源**：`tests/interop.test.ts` 直接读取其常量，两侧一旦漂移即测试失败 |
| `04_协调插件/dsh-coord-governor/` | **治理 agent 本体（DSH 原生 Cordis 插件，163 tests）**：`instrument`（只记录）与 `governor`（干预）**可独立开关**——混在一起则观测者效应与治理效应无法分离。含 observer 半边（写入意图、post-execute、compaction）与 governor 半边（`agent/pre-step` 注入 advisory、`tools/pre-execute` deny/ask），以及**有效并行度 \(P\)** 仪表（`parallelism.mean` + `parallelFraction`，即 H5 的分母、防 K4） |
| `05_实验/preregistration.md` | **预注册（跑数据前冻结）**：主指标（重复落地率）、副指标（**必须同时报 \(P\)**）、样本量两阶段冻结规则、停止规则、`E-K4` 触发阈值。含**编号消歧**：本仓有两套 `H1–H9` 与两个不同的 `K4`，本文只指向总纲 |
| `05_实验/harness/synth_stream.py` + `05_实验/analysis/xcheck_e0.py` + `05_实验/results/E0/` | **E0 仪表校验（合成流部分已通过）**：合成事件流带**构造真值**（真值来自规划，不由分析器产生），两侧分析器读同一账本逐字段互校，再对真值校验。64 项比较 exact match rate = 1.0000 |
| `git-history/estimate_lambda_R.py` + `lambda_R_baseline.json` | **§10 实测资产**：从 Flask 提交图估 \(\lambda_{\text{merged}}\)（0.172/day）与 \(W\) 下界（0.222h）。**不能观测失效态**——这正是它最有价值的结论 |
| `研究定位决策记录.md` | 定位修正记录：把命题从 "AI-native replacement for Git" 收敛为 "AI-native change coordination plane on top of Git"，明确研究范围内外边界与标题候选 |
| `目标完成度审计.md` | 逐项要求 × 证据 × 状态 × 缺口表；区分「当前可以声称」与「当前不能声称」的主张；列出 8 项完成条件 |

## 02_相关工作与文献

| 路径 | 内容 |
|---|---|
| `相关工作证据矩阵.md` | **第二版（2026-09-25）**：50+ 条文献，按「与本项目哪一处主张竞争」重新组织（写入前协调 / 语义冲突检测消解 / 失效经验与基准 / agent 专用版本控制 / 来源归属 / 上下文有界性 / 经典冲突预测）。按 L1–L3 分级标注核对程度，并**单列第九节「自伤性证据」**（三条对 ISCC 不利但必须正面处理的实验结果）、更新后的差异化能力矩阵，以及**已不可主张**的新颖性表述清单 |
| `相关工作原文证据摘录.md` | **第二版（2026-09-25）**：新增 11 篇 L1 原文证据（Claim Plane ×2、ATM、STORM、MPAC、SCF、Before the Pull Request、When Agents Coordinate、The Specification Gap、AI Agent PRs on GitHub、AgenticFlict），含章节级引文与具体数字；原有 ConflictLens / SWE-agent / ChatDev 页码级摘录保留。另记录检索通道可用性（DBLP 被反爬、S2 限流）与待补读清单 |
| `原文PDF/` | 4 份原文 PDF（conflictlens、swe-agent、chatdev、symbolic-merge） |
| `原文PDF/页面渲染/` | ConflictLens 5 页、SWE-agent 2 页的页面渲染图 |
| `原文文本/` | 3 份 `pdftotext -layout` 提取文本 |

> 注意：`原文PDF/` 为第三方出版物，仅用于本地研究核对，不随研究产出一并再分发。

## 03_基准与标注

| 路径 | 内容 |
|---|---|
| `GateA标注与基准规范.md` | Gate A 标注规范：sample=scenario、预测前/结果双视图、**9 类标签**本体（TC/BC/AC/RT/RI/CC/**LF**/UA/ID）与判定证据、正例/负例/模糊例要求、双人标注与第三方裁决流程、一致性门槛、切分与泄漏控制、Gate A 交付物清单 |
| `GateA真实数据采集计划.md` | 真实历史回放 + 受控 agent 轨迹两条轨道、采样分层维度、真实标签生成顺序、数据质量与伦理约束、采集完成判据 |
| `benchmark/gateA-pilot/` | 合成校准集：8 个最小场景（`synthetic_oracle`）、去真值标注模板、只读验证器 `validate_pilot.py` |
| `benchmark/iscc-v0.1/` | ISCC 最小数据契约：JSON Schema Draft 2020-12、示例 capsule、只读验证器 `validate_iscc.py` |
| `benchmark/real-history/flask/` | Flask 真实历史初筛：PR 元数据、候选对、候选 patch 与 SHA-256、本地提交图筛选、merge-tree 重放、双人标注工作队列、已固化的候选 scenario、双视图标注包（无真值、哈希固定）、机械约束校验器与证据路径校验、一致性/门槛脚本（含裁决队列与预注册变更日志）。目录内各资产的权威/废弃/证据角色见上方「资产状态」表 |

### benchmark/real-history/flask 的边界（重要）

该目录当前**只有候选与负控，没有任何 ACCD 真值**：

- 唯一候选对仅共享 `tests/test_basic.py`，无时间重叠与生产代码实体重叠，已判定为筛选误报负控；
- 80 个 PR-like merge row 的 merge-tree 重放全部为 `auto_clean_same_tree`，说明 Git merge-tree 结果不能作为 ACCD 观测变量；
- 7 个时间重叠候选中仅 2 对共享生产路径，初审仍为不同任务目标，作为负控保留；
- 当前待标注的 7 个场景在 `annotation/labels_v1.blank.jsonl`（双视图标注包链条，**权威**，现为 `packet_version = 1.1` / 手册 v1.1），
  `annotation_queue.jsonl` 是更早的空白队列（**已废弃**），两者 `annotation_status` 均为
  `awaiting_two_independent_annotators`，都还没有任何 ACCD 真值；
- **`LF`（可理解性侵蚀）在这 7 个候选上全部不可判定**：没有任何候选的两个 PR 触碰同一个符号
  （`shared_entities.symbols` 全为空）。因此当前候选集**不能**用于校准 `LF`，也不能为 H6 提供任何证据；
  处理顺序见 `annotation/adjudication_log.md` 的 D2/D3（扩充候选池时须一并选入可提供多次触碰证据的候选）。

## 05_实验

实验阶梯 `E0`–`E7` 的预注册、任务包、臂编排、分析与原始结果。**分层是刻意的**：若现象不存在（E1），任何插件都不可能显效；若仪表不可信（E0），一切数字都无法解释。

```text
05_实验/
├── preregistration.md        主指标、样本量、停止规则、kill 触发（跑数据前冻结）
├── task-packs/               注入真值的任务包（真碰撞 / 语义重复 / 独立对照 / 隐藏依赖）
│   └── detection-v1/pack.json  E2 检测包：8 案例，真值手工撰写，重叠由 priorEvents 推导
├── harness/                  臂编排、worktree 隔离、轮次驱动、结果采集、合成事件流生成
│   └── synth_stream.py       含构造真值的合成事件流（E0 用；真值由规划给出，不由分析器产生）
├── analysis/                 交叉校验与统计脚本
│   ├── xcheck_e0.py          E0 仪表校验门：两侧分析器互校 + 对构造真值校验
│   └── eval_e2.py            E2 检测评估：跑任务包并施加冻结门槛（三值退出码）
└── results/                  原始数据 + 每轮结论 + 迭代日志
    ├── E0/                   E0 证据（报告、JSON 证据、两侧报告、账本与真值）
    └── E2/                   E2 证据（eval.json、报告）
```

**E0 已完成（合成流部分）**：64 项字段比较，exact match rate = 1.0000；两侧分析器与构造真值在
\(\lambda_{\text{produced}}\)、\(B(t)\) 全序列、争用集合（precision/recall = 1.000）、
`writes_after_context_loss` 上逐项一致。E0 抓到三个静默缺陷（派生顺序竞态、`localeCompare` 与 Python
码点排序不一致、账本路径错误被当成空账本），并补齐了有效并行度 \(P\) 仪表。详见
`05_实验/results/E0/report.md`。

**E2 已测量（构造任务包）**：`A1`/`A3` 达标（precision 0.800 / recall 0.800 / 误拒 0.000），
但 **recall 完全来自实体重叠**——两个语义重复难例的意图相似度仅 0.286 / 0.083，低于阈值 0.42，
是靠重叠被标为 `cross-task-conflict` 的。`A4-gated` **误拒率 0.333**（上限 0.05）→ **触发 `I4`**。
E2 同时抓到两个静默缺陷：**治理器看不见每个实体的"第一次"碰撞**（决策误用了按 ≥2 触碰者过滤的争用列表），
以及**任务包真值标签可以是假的**（已改为由 `priorEvents` 推导并拒绝评分不一致的包）。详见
`05_实验/results/E2/report.md`。

**E0 的真实会话交叉校验、E1、E3 尚未开始**，依赖远程实验机（规格与阻塞见
`05_实验/preregistration.md` §9）。

复现 E0 与 E2（在本目录下）：

```powershell
foreach ($s in @("clean","clean-with-reads","ties","kinds")) { python 05_实验/harness/synth_stream.py --out-dir 05_实验/results/E0/synthetic --scenario $s }
python 05_实验/analysis/xcheck_e0.py --root 05_实验/results/E0/synthetic
python 05_实验/analysis/eval_e2.py --pack 05_实验/task-packs/detection-v1/pack.json --out-dir 05_实验/results/E2
```

`eval_e2.py` 用三值退出码：`0` 全部达标；`1` 已测量但未达标（**是结果，触发迭代器**）；`2` 无法测量（**是故障**）。

## 复现命令

在本目录（`D:\AI小工具制作\AI原生变更协调研究`）下执行：

```powershell
python 03_基准与标注/benchmark/gateA-pilot/validate_pilot.py
python 03_基准与标注/benchmark/iscc-v0.1/validate_iscc.py
python 03_基准与标注/benchmark/real-history/flask/extract_candidates.py
```

标注流程（标注包生成 → 校验 → 一致性 → 回归测试）的完整命令见
`03_基准与标注/benchmark/real-history/flask/README.md` 的「标注流程（可执行）」小节。

## 下一步（来自完成度审计）

不再继续扩充理论段落，而是完成一个真实 scenario 的端到端切片：公开仓库基线 → 任务与并行变更提取 → 双人标注 → 标签冻结 → Git-only/ISCC 离线检测 → 错误分析。Flask 试点已完成提交图筛选、patch 固定与 merge-tree 重放，**下一步是执行人工标注**，而不是继续从 merge-tree 自动推断语义真值。

标注侧的可执行件已经就绪（标注包、空白标注表、机械约束校验器、一致性/门槛脚本与裁决日志模板，见
`03_基准与标注/benchmark/real-history/flask/README.md` 的「标注流程（可执行）」），但**在扩充候选集之前不应开始正式标注**：

- 现有 7 个候选初审均为负控；若标注结果也是全负例，则 Krippendorff α、Cohen's κ 与 Gwet AC1
  **数学上未定义**（原始一致率会虚高为 1.0），本试点将无法产出任何一致性统计量，门槛判定必然失败；
- 该风险与其处理决定登记在 `03_基准与标注/benchmark/real-history/flask/git-history/annotation/adjudication_log.md` 的 D2 条；
- **同时还存在第二个独立阻塞（D3）**：重建后全部 7 个候选的
  `prediction_view.repeated_touch_evidence.lf_judgeable_from_this_packet` 均为 `false`
  （没有任何候选的两个 PR 触碰同一符号），因此 `LF` 与主文档 H6 在当前数据上**完全没有证据来源**；
- D2 与 D3 由同一次候选扩充解决，**必须合并为一次动作**：扩充候选池时同时要求
  (a) 历史正例证据、(b) 存在同一符号被 3+ 个不同变更触碰的候选；并补入 `gateA-pilot` 的 `LF` 场景。
  然后重建标注包、重新冻结，才开始双人标注。
- 因此下一步的**第一件事是回到筛选阶段**（`extract_candidates.py` → `screening_report.py` → `replay_merges.py`）
  扩充候选池并保留正例，冻结新的标注包版本后，再让两名标注者独立标注；
- 同时补充 `03_基准与标注/benchmark/gateA-pilot/scenarios.jsonl` 的 `LF` 场景
  （当前 8 个场景里没有任何 `LF` 正例，该缺口已在主文档 §32 与 `目标完成度审计.md` 中标注）。

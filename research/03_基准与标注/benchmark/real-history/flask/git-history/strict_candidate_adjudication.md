# Flask 严格候选对初审

## 审查范围

本表针对本地 Git 提交图筛选出的 7 个分支生命周期时间重叠候选，其中 2 对还共享生产路径。初审只使用提交主题、时间区间、变更路径和可访问 patch；它不是双人 Gate A 标注，也不产生正式语义真值。

## 结果

| 候选对 | 时间重叠 | 共享生产路径 | 初审判断 | 处理 |
|---|---:|---|---|---|
| PR 5516 / PR 5514 | 是 | 无 | 两个 Dependabot 依赖更新，生产实体无交集 | 保留为时间重叠负控 |
| PR 5754 / PR 5723 | 是 | 无 | workflow 安全/文档修改与 macOS 文档修改，路径和任务不同 | 保留为时间重叠负控 |
| PR 5757 / PR 5723 | 是 | 无 | SVG logo 与 macOS 文档修改，路径和任务不同 | 保留为时间重叠负控 |
| PR 5797 / PR 5723 | 是 | 无 | context 测试修改与 macOS 文档修改，路径和任务不同 | 保留为时间重叠负控 |
| PR 5812 / PR 5808 | 是 | `src/flask/sansio/app.py` | context 合并的大型重构与单行类型注解修复，修改位置和任务不同 | 保留为生产路径筛选负控 |
| PR 5818 / PR 5808 | 是 | 无 | context dispatch 修改与类型注解修复，生产路径无交集 | 保留为时间重叠负控 |
| PR 5898 / PR 5808 | 是 | `src/flask/sansio/app.py` | redirect 默认状态码修改与 `select_jinja_autoescape` 类型注解修改，位于不同方法 | 保留为生产路径筛选负控 |

## 已核对的两个生产路径候选

### PR 5812 / PR 5808

- PR 5812 的 patch 在 `src/flask/sansio/app.py` 主要修改 `app_ctx_globals_class` 文档和 `teardown_appcontext` 文档；大量核心变化位于其他 context、templating 和测试文件；
- PR 5808 仅将 `select_jinja_autoescape(self, filename: str)` 修改为 `filename: str | None`；
- 两者在 `app.py` 的修改位置和语义目标不同，没有观察到文本冲突或共同验收目标。

### PR 5898 / PR 5808

- PR 5898 将 `App.redirect` 默认状态码从 302 改为 303，位置约在 `app.py` 的 redirect 方法；
- PR 5808 只修改 `select_jinja_autoescape` 的类型注解；
- 两个方法和任务目标独立，未观察到文本冲突、行为干扰或重复实现。

## 当前标签状态

```text
formal_gateA_labels: not_created
semantic_conflict_ground_truth: not_available
duplicate_task_ground_truth: not_available
integration_debt_ground_truth: not_available
screening_interpretation: all seven are negative-control candidates under available evidence
```

“未观察到”不等于证明不存在。正式研究仍需保留完整任务描述、审查讨论、测试结果和后续修复记录，由两名独立标注者按 Gate A 手册判定。

## 方法论意义

在本小样本中，从 80 个 PR-like merge rows 到 7 个时间重叠对，再到 2 个共享生产路径对，候选数量快速收缩；而 2 个最严格候选仍表现为独立任务。这说明：

1. 候选筛选需要报告每一层分母；
2. 文件和路径交集只能提供筛选信号；
3. 真实并行协作证据需要任务关系、实体影响、审查讨论和结果测试共同支持；
4. 负控应在基准中占有明确位置。

# Flask 候选场景人工初审

## 审查对象

`flask-pr-6096-pr-6133`

- [PR #6096](https://github.com/pallets/flask/pull/6096)：修复 IPv6 解析，修改 `src/flask/app.py`、`src/flask/testing.py` 及测试；
- [PR #6133](https://github.com/pallets/flask/pull/6133)：增加 `app.query` 路由装饰器，修改 `src/flask/sansio/scaffold.py`、`CHANGES.rst` 及 `tests/test_basic.py`。

## 证据

- 两个 PR 的唯一共享文件是 `tests/test_basic.py`；
- #6096 合并时间为 2026-08-11 19:48:41 UTC；
- #6133 创建时间为 2026-08-11 20:17:29 UTC；
- #6133 创建时 #6096 已经合并，时间上不存在 PR 生命周期重叠；
- 两个 patch 的生产代码实体不重叠，测试文件交集不足以证明行为或任务关系；
- #6133 的变更说明是独立新增 HTTP QUERY 路由装饰器，不是对 #6096 的继续实现、替代或修复。

## 初审结论

```text
annotation_status: excluded
exclusion_reason: shared_test_file_without_parallel_lifecycle_or_semantic_dependency
TC: not assessed
BC: not assessed
AC: not assessed
RT: false (based on available task descriptions)
RI: false
CC: false
UA: not assessed
ID: not assessed
```

该样本保留为负控/筛选误报案例，不进入语义冲突真值集。它支持一个重要的数据设计约束：**文件路径交集只能用于候选筛选，不能作为语义冲突、重复任务或集成债务的标签。**

## 对采样器的修正建议

采样器应优先要求以下条件至少满足一项：

1. 两个 PR 的开放生命周期有时间交叠；
2. 一个 PR 明确引用、依赖或回应另一个未合并 PR；
3. 变更基线和后续合并历史能够重建两个并行 head；
4. PR/commit 记录显示一个变更需要对另一个变更进行 rebase、修复或回滚。

单独的共享文件路径不应再触发“真实候选”标签，只能标为 `path_overlap_screening_signal`。

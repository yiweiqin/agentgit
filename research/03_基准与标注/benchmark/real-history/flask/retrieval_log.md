# Flask 元数据提取运行日志

## 2026-09-14

### 第一次运行

- 请求：GitHub REST `pulls?state=closed&sort=updated&direction=desc&per_page=30`；
- 返回的已合并 PR：2 个（#6096、#6133）；
- 初筛候选：1 对（共享 `tests/test_basic.py`）；
- 状态：成功，但样本量不足。

### 分页扩展运行

- 脚本已改为尝试读取 3 页、每页 100 条，并记录筛选分母；
- 运行期间 GitHub 匿名 API 返回 HTTP 403 `rate limit exceeded`；
- 运行在写出扩展结果前终止，因此没有把失败运行当作新数据集；
- `/rate_limit` 查询显示 core remaining=0。

### 结论

当前目录中保留的 `pull_requests.jsonl` 和 `overlap_candidates.jsonl` 只代表第一次成功提取的 2 个 PR 和 1 个初筛对。它们是公开元数据候选，不是真实语义冲突真值。恢复采集时应等待配额重置或使用获得授权的只读 token，并固定新的 `manifest.json` 和文件哈希。

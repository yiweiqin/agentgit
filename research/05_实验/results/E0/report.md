# E0 仪表校验报告（合成事件流部分）

**日期**：2026-09-15
**结论**：**通过**（64 项字段比较，exact match rate = 1.0000）
**范围**：合成事件流。**真实 `session*.jsonl.zstd` 交叉校验未完成**（需远程机上的真实 DSH 会话，见 `../../preregistration.md` §9）。

---

## 1. 为什么先做这一步

`01_问题定义与定位/痛点_速度与上下文失配.md` §10 的测量学结论是：**失效态（\(\lambda>R\)、\(B(t)\) 增长）不可由 Git 历史观测**——未调和的变更按定义不在提交图里。

因此本实验的**唯一观测通道**是插件账本。若这个仪表不可信，E1–E3 的每一个数字都无法解释，而且是**静默**无法解释：错误的仪表只会打印出看起来合理的数字。E0 就是把这件事在跑数据前解决。

## 2. 做法：两条独立的判定

只做"两个实现是否互相一致"是不够的——**两个都错的实现可以互相一致**。所以：

1. **交叉校验**：`coord_ledger.py`（分析侧）与 `dsh-coord-governor`（采集侧）读**同一个 `events.jsonl`**，逐字段比较；
2. **真值校验**：合成场景**先规划、后序列化**，期望值来自规划本身（构造真值），**不由任何分析器产生**。

场景文件由 `harness/synth_stream.py` 生成，事件一律经 `coord_ledger.build_event` 落盘，保证字节形状就是 Python 工具会写出的形状——否则测的是序列化器，不是仪表。

## 3. 结果

```
scenarios          : clean, clean-with-reads, kinds, ties
checks             : 64 field comparisons
exact match rate   : 1.0000
  clean              declared divergences: none
  clean-with-reads   declared divergences: top_contested_entities
  kinds              declared divergences: counts.contested_entities, top_contested_entities
  ties               declared divergences: none
PASS: analyzers agree with each other and with construction truth
```

`clean` 场景（8 task / 3 session / 64 事件 / 8 小时窗口）两侧与构造真值**逐项一致**：

| 量 | 构造真值 | Python | TypeScript |
|---|---|---|---|
| \(\lambda_{\text{produced}}\)/h | 0.9959 | 0.9959 | 0.9959 |
| 集成速率/h | 0.1245 | 0.1245 | 0.1245 |
| 观测窗口/h | 8.033 | 8.033 | 8.033 |
| capsules / open | 8 / 6 | 8 / 6 | 8 / 6 |
| \(B(t)\) 序列 | 10 点，峰值 8 | 一致 | 一致 |
| 争用实体 | 3 | precision 1.000 / recall 1.000 | 同 |
| `writes_after_context_loss` | 6 | 6 | 6 |
| `sessions_with_context_loss` | 3 | 3 | 3 |

原始证据：`xcheck.json`、`python-report-clean.txt`、`ts-report-clean.txt`、`synthetic/*/events.jsonl`、`synthetic/truth.*.json`。

## 4. E0 抓到的三个真实缺陷（这部分才是 E0 的价值）

这三个都不会让任何测试变红，只会让**实验数字静默错误**。

### 4.1 派生顺序依赖到达顺序

`coord_ledger.py` 在 `load_events` 里按 `(timestamp_utc, event_id)` 排序；TS 侧此前**按插入顺序**派生。

后果：一个 `context_compacted` 与一个 `file_write` 若时间戳相同，是否算作"H3 探针里"上下文丢失之后的写入"，取决于运行时先服务了哪个会话。**这不是测量，是竞态。** 多会话并发（E1/E3 的全部场景）会稳定触发。

修复：新增 `sortEvents`（`src/ledger.ts`），派生一律先排序，tie-break 与 Python 同为 `(timestamp_utc, event_id)`；并以"到达顺序无关性"测试钉住。

### 4.2 `localeCompare` ≠ Python 的码点比较

争用实体排序在 TS 侧用 `localeCompare`（ICU 排序），Python 用 `<`（码点）。对含中日韩字符的路径**两者顺序不同**——而本方案的仓库正含中文路径。修复：统一为 `compareCodepoint`。

### 4.3 账本路径错误被静默当成"账本为空"

TS CLI 的 `readLedger` 在文件不存在时返回 `[]`，理由是"没有事件是合法状态"。

第一次 E0 运行证明这是错的：交叉校验传了相对路径，而分析器以另一个工作目录运行，于是它报告 0 capsule / 0 争用 / 0 上下文丢失——**60 个自信而毫无意义的失败**。

修复：`readLedger` 在文件缺失时**报错并打印解析后的绝对路径**。一个错误路径**不能**被表示成一个测量值。这与 `store.ts` 里已记录的"文件名不匹配→Python 报告静默为空"属同一类缺陷。

### 4.4 同时补齐：有效并行度 \(P\) 仪表

`04_协调插件/README.md` 记录 \(P\)（H5 的分母）**未测量**，是"下一个必须补的仪表"。已在 `computeParallelism` 补上：

- `parallelism.mean`：时间加权平均在飞胶囊数（= \(P\)）
- `parallelism.parallelFraction`：窗口内 ≥2 胶囊同时在飞的时间占比（`parallelHours`/窗口）

两者都要报：只报均值会漏掉"均值不变、突发并行被压掉"的限流形态——正是 `K4` 要拦截的。已用"完全串行化"场景测试钉住（`parallelFraction = 0` 而均值不变）。

## 5. 已知且已声明的分歧

| 分歧 | 原因 | 处理 |
|---|---|---|
| `file_read` 被计为实体触碰 | `coord_ledger.py` 计入（`ENTITY_EVENTS`）；插件不计，因为**读不是冲突** | 在 `kinds` / `clean-with-reads` 场景中**测量**并声明；校验脚本会在两侧意外一致时报"声明已过期"，强制复核 |

该分歧目前**惰性**：插件不产生 `file_read`。若将来加入读观测，两侧争用数字会分歧，必须先在 `ENTITY_EVENTS` 上对齐。

`write_settled` 是反向情形（插件记录、Python 无此常量）。Python 的 `load_events` 容忍未知 kind，故分歧不可见——**这本身是风险**，已记录在 `types.ts`。

## 6. 测试状态

| 套件 | 结果 |
|---|---|
| TypeScript（`node --test`） | **163 pass / 0 fail** |
| Python（`unittest`） | **45 tests OK** |
| E0 校验门 | **PASS**（退出码 0） |

## 7. 未完成

- **真实 `session*.jsonl.zstd` 交叉校验**：需要远程机上的真实 DSH 会话（`preregistration.md` §9）。这一半**尚未**完成，因此 E0 目前只能说"合成流上仪表可信"。
- 语义重复检测器仍是关键词/实体级近似；这是 `E2` 存在的理由。

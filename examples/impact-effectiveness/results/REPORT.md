# 提前通知有效性：受控回放实测报告

运行开始：2026-10-03T08:37:02.642Z。生产代码基线：1cf3ee0fc9c2650ec06f4babeb4de0da07ffdfa1。环境：v24.18.0 / linux x64。

**证据等级：脚本任务回放，真实文件写入、真实 Node 校验、真实 AgentGit 账本与 Hook。真实自主 agent 试验数为 0。**

## 结果

11 个构造场景，33 个配对单元，231 次任务执行。机制工程门槛通过。各臂最终文件哈希一致，最终正确性由独立 Node 执行核验。

在依赖与变化声明准确的破坏性场景中，提前提醒且采用使实际改写从 57 次降至 23 次，减少 59.6%。这是给定响应策略下的改写次数变化，不能换算成真实开发效率提升。

### 主分析：声明准确的破坏性变化（12 对）

| 执行方式 | 实际改写 | 过时新写入 | 验证次数 | 失败验证 | 阅读提醒 | 最终通过 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| git-final | 57 | 34 | 24 | 12 | 0 | 12/12 |
| record-only | 57 | 34 | 24 | 12 | 0 | 12/12 |
| targeted | 23 | 0 | 12 | 0 | 12 | 12/12 |
| targeted-half | 39 | 16 | 18 | 6 | 12 | 12/12 |
| targeted-ignore | 57 | 34 | 24 | 12 | 12 | 12/12 |
| delayed-targeted | 57 | 34 | 12 | 0 | 12 | 12/12 |
| git-each | 33 | 10 | 96 | 12 | 0 | 12/12 |

### 全部场景，包含对照、缺证据和错误声明

| 执行方式 | 实际改写 | 过时新写入 | 验证次数 | 失败验证 | 阅读提醒 | 最终通过 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| git-final | 93 | 56 | 51 | 18 | 0 | 33/33 |
| record-only | 93 | 56 | 51 | 18 | 0 | 33/33 |
| targeted | 59 | 22 | 39 | 6 | 18 | 33/33 |
| targeted-half | 75 | 38 | 45 | 12 | 18 | 33/33 |
| targeted-ignore | 93 | 56 | 51 | 18 | 18 | 33/33 |
| delayed-targeted | 93 | 56 | 39 | 6 | 18 | 33/33 |
| git-each | 53 | 16 | 249 | 18 | 0 | 33/33 |

全场景中每项测试改写 53 次，提前提醒改写 59 次；缺声明的场景让提前提醒失去优势。不能仅展示声明准确的子集并宣称通知方案优于频繁测试。

### 每种场景

| 场景 | 真实执行失效 | 最终验证基线改写 | 提前提醒改写 | 每项测试改写 | 提前提醒的紧急通知 | 普通通知 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| field-rename | 是 | 18 | 7 | 10 | 3 | 0 |
| amount-unit | 是 | 18 | 7 | 10 | 3 | 0 |
| sync-to-async | 是 | 18 | 7 | 10 | 3 | 0 |
| shared-adapter | 是 | 3 | 2 | 3 | 3 | 0 |
| compatible-addition | 否 | 0 | 0 | 0 | 0 | 3 |
| unused-field | 否 | 0 | 0 | 0 | 0 | 0 |
| already-adapted | 否 | 0 | 0 | 0 | 0 | 0 |
| no-public-change | 否 | 0 | 0 | 0 | 0 | 0 |
| missing-consumer | 是 | 18 | 18 | 10 | 0 | 0 |
| missing-publisher | 是 | 18 | 18 | 10 | 0 | 0 |
| incorrect-breaking-label | 否 | 0 | 0 | 0 | 3 | 0 |

场景逐一通过实际 Git 三方合并。旧消费者与新生产者合并后的行为正确性由 oracle.json 单独检查：文本合并干净不保证客户端行为正确。

### 检测、打扰与证据缺口

仅评价 targeted 臂的实际紧急交付：TP=12、FP=3、FN=6、TN=12，构造集精确率 80.0%、召回率 66.7%。这些数值受本任务包的场景比例决定，不估计真实项目分布。兼容更新的普通通知不算紧急误报，但阅读仍计费。

无关窗口收到 0 条提醒。缺少声明导致的漏检和错误 breaking 声明导致的误报都保留在分母中。去重和适配后清除通过真实 Hook 与投影检查，具体次数在逐试验数据中。

### 机器成本与尚未测量的成本

| 执行方式 | 协调总耗时 ms | 其中 Hook ms | 验证总耗时 ms | 声明/契约写入 | 提醒字符数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| git-final | 0.0 | 0.0 | 1556.1 | 0 | 0 |
| record-only | 411.2 | 0.0 | 1598.5 | 153 | 0 |
| targeted | 14569.4 | 13967.4 | 1186.9 | 159 | 6873 |
| targeted-half | 14501.5 | 13941.7 | 1401.9 | 157 | 6873 |
| targeted-ignore | 14934.1 | 14328.9 | 1648.4 | 153 | 6873 |
| delayed-targeted | 2613.6 | 2137.4 | 1162.6 | 159 | 6873 |
| git-each | 0.0 | 0.0 | 7543.4 | 0 | 0 |

targeted 每次任务平均协调机器耗时 441.5 ms。Hook 数字包含 hub.mjs 独立处理器的 Node 进程启动，不是安装后完整 hook.mjs 分发器的成本。去重诊断重复调用另记 diagnosticMs，不计产品成本。对全部臂相同安全点进行投影（有协调状态时），没有模拟全事件依赖图；任务只提供契约路径状态，不评价模块路由的召回收益。

记录到的协调、验证、文件写入机器耗时合计：git-final 1566.7 ms，targeted 15773.6 ms，git-each 7564.6 ms。这不含夹具初始化、Git oracle、诊断与留证开销，也不是 agent 端到端工作时间。

这批任务用模板生成很小的文件，实测协调开销远大于文件写入成本；少改文件并没有带来机器时间提速。不能把少改一个小文件直接解释为省下一分钟。净收益条件是：

节省修复次数 × 单次真实修复成本 + 节省验证次数 × 单次验证成本 > 声明维护成本 + 阅读成本 + 协调机器成本。

例如 field-rename/after-2 的实际配对数据见 summary.json 的 paired：在那里节省的改写数是真实测量，真实修复成本和声明维护成本仍需实际会话测量。晚提醒可能避免失败验证，但无法挽回已完成的过时实现；共享适配器场景中，提前提醒的改写收益也显著缩小。

## 判定

| 固定门槛 | 结果 |
| --- | --- |
| allFinalChecksPass | 通过 |
| declaredBreakingRewriteReduction | 通过 |
| correctControlUrgentFalseAlerts | 通过 |
| unrelatedWindowAlerts | 通过 |
| ignoredAndRecordOnlyMatchGitFinalRewrites | 通过 |
| missingEvidenceNotClaimedDetected | 通过 |
| incorrectEvidenceReportedAsFalseAlert | 通过 |
| deduplicatedAndClearedAfterAdaptation | 通过 |

可支持的结论：现有机制在声明准确、及时投递并被采用时能减少这组任务的后续改写；仅记录、忽略或太晚交付不能获得同等收益。适用收益取决于剩余工作量、代码复用结构、测试频率及声明质量。

不能支持的结论：真实 agent 净效率提升已获证明、无需维护声明、所有依赖都可识别、在生产工作区的误报率为零。

## 复现与证据

    node examples/impact-effectiveness/run.mjs --out /tmp/agentgit-impact-new-run
    node examples/impact-effectiveness/analyze.mjs /tmp/agentgit-impact-new-run
    node --test examples/impact-effectiveness/analysis.test.mjs

- manifest.json：计划、源码哈希、环境及结果哈希。
- oracle.json：旧版本通过、干净合并后的真实行为、适配后通过。
- trials.jsonl：所有试验的写入哈希、验证输出、真实通知文本、账本事件。
- summary.json：分组统计及每一对效果，不只保存均值。
- examples/git-final 与 examples/targeted：相同 field-rename/after-2 任务的完整文件和轨迹。缓存中的临时绝对路径仅是运行留证，重新运行请用 runner。

下一步需要真实会话随机配对实验：固定模型与预算，对相同任务只改变通知可见性，同时计入契约声明、阅读、失败任务及最终质量。本次结果只能支持进入这一验证阶段。

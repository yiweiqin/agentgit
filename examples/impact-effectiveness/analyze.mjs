/** Analyze measured writes and independent executable truth, not detector-provided labels. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sum = (rows, field) => rows.reduce((n, row) => n + row.metrics[field], 0)
const round = n => Math.round(n * 1000) / 1000
const pct = n => n === null ? 'n/a' : `${(n * 100).toFixed(1)}%`
const aggregate = rows => ({ runs: rows.length, finalPasses: rows.filter(t => t.finalPass).length,
  ...Object.fromEntries(['artifactWrites', 'rewrites', 'staleWritesAfterChange', 'tests', 'failedTests', 'reviews', 'adaptations',
    'urgentAlerts', 'deferredAlerts', 'unrelatedAlerts', 'notificationChars', 'declarationWrites', 'hookCalls',
    'coordinationMs', 'hookMs', 'validationMs', 'artifactMs', 'diagnosticMs'].map(field => [field, round(sum(rows, field))])) })

export function analyze(plan, oracle, trials, { smoke = false } = {}) {
  const truth = new Map(oracle.map(row => [row.id, row]))
  const pairs = new Map()
  for (const trial of trials) {
    assert.ok(truth.has(trial.scenario), `Missing executable truth for ${trial.scenario}`)
    const pair = pairs.get(trial.pairId) ?? new Map()
    assert.ok(!pair.has(trial.arm), 'Duplicate pair/arm')
    pair.set(trial.arm, trial)
    pairs.set(trial.pairId, pair)
    const writes = trial.trace.filter(event => event.kind === 'write')
    assert.equal(writes.length, trial.metrics.artifactWrites, 'Artifact write counts must reconcile with trace')
    assert.equal(writes.filter(event => event.rewrite).length, trial.metrics.rewrites, 'Rewrites must reconcile with trace')
    assert.equal(writes.filter(event => event.stale).length, trial.metrics.staleWritesAfterChange)
    assert.ok(writes.every(event => event.beforeHash !== event.afterHash), 'No-op writes must not count as rework')
    const checks = trial.trace.filter(event => event.kind === 'validation')
    assert.equal(checks.length, trial.metrics.tests)
    assert.equal(checks.filter(event => !event.pass).length, trial.metrics.failedTests)
    assert.equal(trial.finalPass, checks.at(-1).pass)
    const messages = trial.trace.filter(event => event.kind === 'hook' && !event.diagnostic && event.text)
    assert.equal(messages.length, trial.metrics.reviews)
    assert.equal(messages.reduce((n, event) => n + event.text.length, 0), trial.metrics.notificationChars)
    assert.equal(messages.filter(event => event.who === 'c').length, trial.metrics.unrelatedAlerts)
    assert.equal(messages.filter(event => event.text.includes('; interrupt]')).length, trial.metrics.urgentAlerts)
  }
  const expectedScenarios = smoke ? plan.scenarios.slice(0, 2) : plan.scenarios
  const expectedTimings = smoke ? [2] : plan.changeAfterItems
  const expectedPairs = new Set(expectedScenarios.flatMap(s => expectedTimings.map(t => `${s.id}--after-${t}`)))
  assert.deepEqual(new Set(pairs.keys()), expectedPairs, 'No planned pair may disappear from the denominator')
  for (const pair of pairs.values()) {
    assert.deepEqual([...pair.keys()].sort(), [...plan.arms].sort(), 'Every pair must contain every arm')
    for (const row of pair.values()) assert.deepEqual(row.finalFiles, pair.get('git-final').finalFiles, 'All arms must finish with the same actual artifacts')
  }
  const byArm = Object.fromEntries(plan.arms.map(arm => [arm, aggregate(trials.filter(t => t.arm === arm))]))
  const primary = trials.filter(t => t.group === 'declared-breaking')
  const primaryByArm = Object.fromEntries(plan.arms.map(arm => [arm, aggregate(primary.filter(t => t.arm === arm))]))
  const paired = [...pairs.entries()].map(([id, pair]) => {
    const base = pair.get('git-final'), target = pair.get('targeted'), frequent = pair.get('git-each')
    return { id, scenario: base.scenario, group: base.group, changeAfter: base.changeAfter,
      baselineRewrites: base.metrics.rewrites, targetedRewrites: target.metrics.rewrites,
      frequentTestRewrites: frequent.metrics.rewrites,
      savedRewritesVsFinal: base.metrics.rewrites - target.metrics.rewrites,
      savedRewritesVsFrequent: frequent.metrics.rewrites - target.metrics.rewrites,
      savedTestsVsFinal: base.metrics.tests - target.metrics.tests,
      targetedReviews: target.metrics.reviews, targetedDeclarations: target.metrics.declarationWrites,
      extraCoordinationMsVsFinal: round(target.metrics.coordinationMs),
    }
  }).sort((a, b) => a.id.localeCompare(b.id))
  const target = trials.filter(t => t.arm === 'targeted')
  let tp = 0, fp = 0, fn = 0, tn = 0
  for (const trial of target) {
    const actual = truth.get(trial.scenario).actuallyBreaking
    const predicted = trial.metrics.urgentAlerts > 0
    if (actual && predicted) tp++
    else if (!actual && predicted) fp++
    else if (actual) fn++
    else tn++
  }
  const baselineRewrites = primaryByArm['git-final'].rewrites
  const reduction = baselineRewrites ? (baselineRewrites - primaryByArm.targeted.rewrites) / baselineRewrites : null
  const byScenario = Object.fromEntries(expectedScenarios.map(s => [s.id, {
    actuallyBreaking: truth.get(s.id).actuallyBreaking, cleanGitMerge: truth.get(s.id).cleanGitMerge,
    arms: Object.fromEntries(plan.arms.map(arm => [arm, aggregate(trials.filter(t => t.scenario === s.id && t.arm === arm))])),
  }]))
  const ignoredMatches = [...pairs.values()].every(pair => ['record-only', 'targeted-ignore'].every(arm =>
    pair.get(arm).metrics.rewrites === pair.get('git-final').metrics.rewrites))
  const missing = target.filter(t => t.group === 'missing-evidence')
  const incorrect = target.filter(t => t.group === 'incorrect-evidence')
  const delivered = trials.filter(t => t.metrics.reviews > 0)
  const adopted = trials.filter(t => t.followsNotifications && t.metrics.reviews > 0)
  const gates = {
    allFinalChecksPass: trials.every(t => t.finalPass),
    declaredBreakingRewriteReduction: reduction !== null && reduction >= plan.mechanismGates.declaredBreakingTargetedRewriteReductionAtLeast,
    correctControlUrgentFalseAlerts: target.filter(t => t.group === 'correct-control').every(t => t.metrics.urgentAlerts === 0),
    unrelatedWindowAlerts: trials.every(t => t.metrics.unrelatedAlerts === 0),
    ignoredAndRecordOnlyMatchGitFinalRewrites: ignoredMatches,
    missingEvidenceNotClaimedDetected: smoke ? null : missing.length > 0 && missing.every(t => t.metrics.urgentAlerts === 0 && t.metrics.rewrites > 0),
    incorrectEvidenceReportedAsFalseAlert: smoke ? null : incorrect.length > 0 && incorrect.every(t => !truth.get(t.scenario).actuallyBreaking && t.metrics.urgentAlerts > 0),
    deduplicatedAndClearedAfterAdaptation: delivered.every(t => t.suppressedDuplicates === t.metrics.reviews) && adopted.every(t => t.clearedChecks === t.metrics.reviews),
  }
  return { experiment: plan.experiment, smoke, evidenceLevel: 'controlled-scripted-replay', independentRealAgentTrials: 0,
    trialCount: trials.length, pairCount: pairs.size, scenarioCount: expectedScenarios.length, primaryPairCount: primary.length / plan.arms.length,
    primaryRewriteReduction: reduction, byArm, primaryByArm, byScenario, paired,
    urgentDetection: { tp, fp, fn, tn, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null },
    gates, passed: Object.values(gates).every(value => value === true || (smoke && value === null)),
    limitations: ['Scripted consumer response; no measured autonomous-agent adoption or token savings.',
      'Declared evidence is supplied by the harness; human/agent declaration effort is unmeasured.',
      'Synchronous projection and simulated host safe points; no real daemon polling or concurrent-window race measurement.',
      'Standalone hub.mjs delivery handler, not the installed hook.mjs dispatcher; module-routing recall is not evaluated.',
      'Constructed small tasks, not a representative sample of repositories; timings include process startup.',
      'Three timing conditions are paired sensitivity points, not independent real-world observations.'],
  }
}

export function markdown(summary, manifest) {
  const table = rows => ['| 执行方式 | 实际改写 | 过时新写入 | 验证次数 | 失败验证 | 阅读提醒 | 最终通过 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(rows).map(([arm, r]) => `| ${arm} | ${r.rewrites} | ${r.staleWritesAfterChange} | ${r.tests} | ${r.failedTests} | ${r.reviews} | ${r.finalPasses}/${r.runs} |`)].join('\n')
  const target = summary.byArm.targeted
  const det = summary.urgentDetection
  return `# 提前通知有效性：受控回放实测报告

运行开始：${manifest.startedAt}。生产代码基线：${manifest.gitHead}。环境：${manifest.node} / ${manifest.platform} ${manifest.arch}。

**证据等级：脚本任务回放，真实文件写入、真实 Node 校验、真实 AgentGit 账本与 Hook。真实自主 agent 试验数为 0。**${summary.smoke ? ' 这是冒烟运行，不是完整实验。' : ''}

## 结果

${summary.scenarioCount} 个构造场景，${summary.pairCount} 个配对单元，${summary.trialCount} 次任务执行。${summary.passed ? '机制工程门槛通过' : '存在未通过门槛'}。各臂最终文件哈希一致，最终正确性由独立 Node 执行核验。

在依赖与变化声明准确的破坏性场景中，提前提醒且采用使实际改写从 ${summary.primaryByArm['git-final'].rewrites} 次降至 ${summary.primaryByArm.targeted.rewrites} 次，减少 ${pct(summary.primaryRewriteReduction)}。这是给定响应策略下的改写次数变化，不能换算成真实开发效率提升。

### 主分析：声明准确的破坏性变化（${summary.primaryPairCount} 对）

${table(summary.primaryByArm)}

### 全部场景，包含对照、缺证据和错误声明

${table(summary.byArm)}

全场景中每项测试改写 ${summary.byArm['git-each'].rewrites} 次，提前提醒改写 ${target.rewrites} 次；缺声明的场景让提前提醒失去优势。不能仅展示声明准确的子集并宣称通知方案优于频繁测试。

### 每种场景

| 场景 | 真实执行失效 | 最终验证基线改写 | 提前提醒改写 | 每项测试改写 | 提前提醒的紧急通知 | 普通通知 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
${Object.entries(summary.byScenario).map(([id, row]) => `| ${id} | ${row.actuallyBreaking ? '是' : '否'} | ${row.arms['git-final'].rewrites} | ${row.arms.targeted.rewrites} | ${row.arms['git-each'].rewrites} | ${row.arms.targeted.urgentAlerts} | ${row.arms.targeted.deferredAlerts} |`).join('\n')}

场景逐一通过实际 Git 三方合并。旧消费者与新生产者合并后的行为正确性由 oracle.json 单独检查：文本合并干净不保证客户端行为正确。

### 检测、打扰与证据缺口

仅评价 targeted 臂的实际紧急交付：TP=${det.tp}、FP=${det.fp}、FN=${det.fn}、TN=${det.tn}，构造集精确率 ${pct(det.precision)}、召回率 ${pct(det.recall)}。这些数值受本任务包的场景比例决定，不估计真实项目分布。兼容更新的普通通知不算紧急误报，但阅读仍计费。

无关窗口收到 ${target.unrelatedAlerts} 条提醒。缺少声明导致的漏检和错误 breaking 声明导致的误报都保留在分母中。去重和适配后清除通过真实 Hook 与投影检查，具体次数在逐试验数据中。

### 机器成本与尚未测量的成本

| 执行方式 | 协调总耗时 ms | 其中 Hook ms | 验证总耗时 ms | 声明/契约写入 | 提醒字符数 |
| --- | ---: | ---: | ---: | ---: | ---: |
${Object.entries(summary.byArm).map(([arm, r]) => `| ${arm} | ${r.coordinationMs.toFixed(1)} | ${r.hookMs.toFixed(1)} | ${r.validationMs.toFixed(1)} | ${r.declarationWrites} | ${r.notificationChars} |`).join('\n')}

targeted 每次任务平均协调机器耗时 ${(target.coordinationMs / target.runs).toFixed(1)} ms。Hook 数字包含 hub.mjs 独立处理器的 Node 进程启动，不是安装后完整 hook.mjs 分发器的成本。去重诊断重复调用另记 diagnosticMs，不计产品成本。对全部臂相同安全点进行投影（有协调状态时），没有模拟全事件依赖图；任务只提供契约路径状态，不评价模块路由的召回收益。

记录到的协调、验证、文件写入机器耗时合计：git-final ${(summary.byArm['git-final'].coordinationMs + summary.byArm['git-final'].validationMs + summary.byArm['git-final'].artifactMs).toFixed(1)} ms，targeted ${(target.coordinationMs + target.validationMs + target.artifactMs).toFixed(1)} ms，git-each ${(summary.byArm['git-each'].coordinationMs + summary.byArm['git-each'].validationMs + summary.byArm['git-each'].artifactMs).toFixed(1)} ms。这不含夹具初始化、Git oracle、诊断与留证开销，也不是 agent 端到端工作时间。

这批任务用模板生成很小的文件，实测协调开销远大于文件写入成本；少改文件并没有带来机器时间提速。不能把少改一个小文件直接解释为省下一分钟。净收益条件是：

节省修复次数 × 单次真实修复成本 + 节省验证次数 × 单次验证成本 > 声明维护成本 + 阅读成本 + 协调机器成本。

例如 field-rename/after-2 的实际配对数据见 summary.json 的 paired：在那里节省的改写数是真实测量，真实修复成本和声明维护成本仍需实际会话测量。晚提醒可能避免失败验证，但无法挽回已完成的过时实现；共享适配器场景中，提前提醒的改写收益也显著缩小。

## 判定

| 固定门槛 | 结果 |
| --- | --- |
${Object.entries(summary.gates).map(([name, pass]) => `| ${name} | ${pass === null ? '冒烟未覆盖' : pass ? '通过' : '未通过'} |`).join('\n')}

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
`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const dir = resolve(process.argv[2] ?? '')
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    for (const [file, expected] of Object.entries(manifest.resultHashes)) {
      assert.equal(createHash('sha256').update(readFileSync(join(dir, file))).digest('hex'), expected, `Result modified: ${file}`)
    }
    const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'))
    assert.deepEqual(plan, manifest.plan)
    const trials = readFileSync(join(dir, 'trials.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const summary = analyze(plan, JSON.parse(readFileSync(join(dir, 'oracle.json'), 'utf8')), trials, { smoke: manifest.smoke })
    assert.deepEqual(summary, JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')), 'Reanalysis differs from saved summary')
    console.log(JSON.stringify({ trials: summary.trialCount, hashesVerified: true, reanalysisMatches: true, gates: summary.gates, passed: summary.passed }, null, 2))
    process.exitCode = summary.passed ? 0 : 1
  } catch (error) { console.error(error.stack ?? String(error)); process.exitCode = 2 }
}

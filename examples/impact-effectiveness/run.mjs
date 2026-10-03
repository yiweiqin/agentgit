#!/usr/bin/env node
/** See PROTOCOL.md. Real coordinator + real hooks + executable work; scripted behavior. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, platform, arch } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import {
  acknowledgeImpact, appendEvent, buildEvent, computeImpactReport, ensureWorkspace,
  publishContract, publishImpactProjection, readAllEvents, recordAssumption,
  recordImpactChange, recordImpactSession, toWire,
} from '../../packages/core/src/index.ts'
import { artifact, channels, fixture, validator } from './fixtures.mjs'
import { analyze, markdown } from './analyze.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const planFile = join(here, 'plan.json')
const plan = JSON.parse(readFileSync(planFile, 'utf8'))
const hookFile = join(repo, 'plugins/agentgit/scripts/hub.mjs')
const args = process.argv.slice(2)
const flag = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] }
const out = resolve(flag('--out') ?? join(here, 'results'))
const smoke = args.includes('--smoke')
const keep = args.includes('--keep')
const sha = value => createHash('sha256').update(value).digest('hex')
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const ids = { a: { sessionId: 'window-a', taskId: 'producer' }, b: { sessionId: 'window-b', taskId: 'consumer' }, c: { sessionId: 'window-c', taskId: 'styles' } }
const notifying = arm => arm.startsWith('targeted') || arm === 'delayed-targeted'
const instrumented = arm => !['git-final', 'git-each'].includes(arm)
let scratch

function command(cmd, argv, cwd, input) {
  const result = spawnSync(cmd, argv, { cwd, input, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  if (result.error || result.signal) throw result.error ?? new Error(`Command killed: ${result.signal}`)
  return result
}
function git(cwd, argv) {
  const result = command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...argv], cwd)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}
function initialize(root, data) {
  mkdirSync(join(root, 'consumers'), { recursive: true })
  writeFileSync(join(root, 'producer.mjs'), data.before)
  writeJson(join(root, 'public-spec.json'), data.oldSpec)
  writeFileSync(join(root, 'verify.mjs'), validator)
  writeFileSync(join(root, 'theme.css'), ':root { color: navy; }\n')
}
function verify(root, expected, files) {
  const result = command(process.execPath, ['verify.mjs'], root, JSON.stringify({ expected, files }))
  let body
  try { body = JSON.parse(result.stdout) } catch { throw new Error(`Validator failed: ${result.stderr || result.stdout}`) }
  assert.equal(result.status, body.pass ? 0 : 1, 'Validator exited inconsistently')
  return body
}

/** Verify construction truth and clean Git merge separately from the detector. */
function oracle(scenario) {
  const root = join(scratch, `oracle-${scenario.id}`)
  const data = fixture(scenario)
  initialize(root, data)
  git(root, ['init', '-q', '-b', 'base'])
  git(root, ['config', 'user.name', 'AgentGit experiment'])
  git(root, ['config', 'user.email', 'experiment@example.invalid'])
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'Initial producer and fixed validator'])
  git(root, ['checkout', '-qb', 'consumer'])
  if (scenario.shared) writeFileSync(join(root, 'adapter.mjs'), artifact(scenario, 'adapter', data.oldSpec))
  writeFileSync(join(root, 'consumers/web.mjs'), artifact(scenario, 'web', data.oldSpec))
  const before = verify(root, data.expected, ['consumers/web.mjs'])
  assert.equal(before.pass, true, 'Old client must work against old producer')
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'Consumer using initial published contract'])
  git(root, ['checkout', '-qb', 'producer', 'base'])
  writeFileSync(join(root, 'producer.mjs'), data.after)
  writeJson(join(root, 'public-spec.json'), data.newSpec)
  git(root, ['add', '.'])
  git(root, ['commit', '-qm', 'Upstream change'])
  git(root, ['checkout', '-q', 'consumer'])
  git(root, ['merge', '--no-edit', 'producer'])
  const after = verify(root, data.expected, ['consumers/web.mjs'])
  writeFileSync(join(root, scenario.shared ? 'adapter.mjs' : 'consumers/web.mjs'), artifact(scenario, scenario.shared ? 'adapter' : 'web', data.newSpec))
  const adapted = verify(root, data.expected, ['consumers/web.mjs'])
  assert.equal(adapted.pass, true, 'Updated client must meet the same fixed requirement')
  return { id: scenario.id, cleanGitMerge: true, oldClientBefore: before, oldClientAfter: after, adaptedAfter: adapted, actuallyBreaking: !after.pass }
}

function runTrial(scenario, changeAfter, arm, pairIndex, runIndex) {
  const trialId = `${scenario.id}--after-${changeAfter}--${arm}`
  const root = join(scratch, trialId)
  const data = fixture(scenario)
  initialize(root, data)
  const state = instrumented(arm) ? ensureWorkspace(root) : null
  const trace = []
  const metrics = {
    artifactWrites: 0, rewrites: 0, staleWritesAfterChange: 0, tests: 0, failedTests: 0,
    reviews: 0, adaptations: 0, urgentAlerts: 0, deferredAlerts: 0, unrelatedAlerts: 0,
    notificationChars: 0, declarationWrites: 0, hookCalls: 0,
    coordinationMs: 0, hookMs: 0, validationMs: 0, artifactMs: 0, diagnosticMs: 0,
  }
  const emit = (kind, detail = {}) => trace.push({ sequence: trace.length, kind, ...detail })
  const measure = (key, fn) => { const start = performance.now(); const value = fn(); metrics[key] += performance.now() - start; return value }
  const coordinate = fn => measure('coordinationMs', fn)
  let completed = 0
  let changed = false
  let spec = data.oldSpec
  let initialCandidates = []
  let lateDelivered = false
  let firstNoticeAt = null
  let suppressedDuplicates = 0
  let clearedChecks = 0
  const follows = arm === 'targeted' || arm === 'delayed-targeted' || (arm === 'targeted-half' && pairIndex % 2 === 0)
  const files = () => channels.slice(0, completed).map(channel => `consumers/${channel}.mjs`)
  const project = () => coordinate(() => publishImpactProjection(state))
  function declareConsumer(version) {
    const contracts = scenario.consumerDeclared && !scenario.registry ? [{ name: data.contract, version, ...(scenario.usedParts ? { parts: scenario.usedParts } : {}) }] : []
    coordinate(() => recordImpactSession(state, { goal: 'Build six service clients', phase: 'working', contracts }, ids.b))
    metrics.declarationWrites++
    if (scenario.consumerDeclared && scenario.registry) {
      coordinate(() => recordAssumption(state, { ...ids.b, contract: data.contract, version, source: 'declared', path: null, recordedAt: new Date().toISOString() }))
      metrics.declarationWrites++
    }
  }
  function writeArtifact(file, body, reason) {
    const path = join(root, file)
    const old = existsSync(path) ? readFileSync(path, 'utf8') : null
    if (old === body) return
    measure('artifactMs', () => writeFileSync(path, body))
    metrics.artifactWrites++
    if (old !== null) metrics.rewrites++
    const channel = file === 'adapter.mjs' ? 'adapter' : file.split('/')[1].replace('.mjs', '')
    const stale = changed && body !== artifact(scenario, channel, data.newSpec)
    if (stale) metrics.staleWritesAfterChange++
    emit('write', { file, reason, completed, changed, rewrite: old !== null, stale, beforeHash: old === null ? null : sha(old), afterHash: sha(body) })
  }
  function adapt(reason) {
    metrics.adaptations++
    spec = JSON.parse(readFileSync(join(root, 'public-spec.json'), 'utf8'))
    emit('read-current-spec', { reason, version: spec.version, completed })
    if (scenario.shared && existsSync(join(root, 'adapter.mjs'))) writeArtifact('adapter.mjs', artifact(scenario, 'adapter', spec), reason)
    for (const channel of channels.slice(0, completed)) writeArtifact(`consumers/${channel}.mjs`, artifact(scenario, channel, spec), reason)
    if (state) declareConsumer(spec.version)
  }
  function check(reason, repair = true) {
    metrics.tests++
    const result = measure('validationMs', () => verify(root, data.expected, files()))
    emit('validation', { reason, completed, ...result })
    if (!result.pass) {
      metrics.failedTests++
      if (repair) {
        adapt('validation-failed')
        return check('after-repair', false)
      }
    }
    return result
  }
  function rawHook(who, event, diagnostic = false) {
    if (!diagnostic) metrics.hookCalls++
    const invoke = () => command(process.execPath, [hookFile], root, JSON.stringify({
      hook_event_name: event, session_id: ids[who].sessionId, cwd: root,
      tool_name: 'apply_patch', tool_input: { path: who === 'c' ? 'theme.css' : `consumers/${channels[Math.min(completed, channels.length - 1)]}.mjs` },
    }))
    const result = diagnostic ? measure('diagnosticMs', invoke) : coordinate(() => measure('hookMs', invoke))
    assert.equal(result.status, 0, result.stderr)
    const message = result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext : ''
    emit('hook', { who, event, completed, text: message, diagnostic })
    return message
  }
  function deliver(who, event, canAdapt = true) {
    const message = rawHook(who, event)
    if (!message) return
    metrics.notificationChars += message.length
    metrics.reviews++
    if (who === 'c') metrics.unrelatedAlerts++
    const urgent = message.includes('; interrupt]')
    if (urgent) metrics.urgentAlerts++
    else metrics.deferredAlerts++
    if (who === 'b' && firstNoticeAt === null) firstNoticeAt = completed
    // Repeat the actual hook, including on ignored notices; no mock receipt checks.
    assert.equal(rawHook(who, event, true), '', 'A second hook must not repeat a delivered notice')
    suppressedDuplicates++
    if (who === 'b' && follows && canAdapt) {
      adapt('notification')
      const after = project()
      assert.equal(after.notifications.filter(n => n.targetSessionId === ids.b.sessionId && n.policy !== 'store-only').length, 0,
        'Adapting the assumption must clear pending impact')
      clearedChecks++
      // Acknowledgement is recorded independently of the assumption update.
      for (const notice of initialCandidates.filter(n => n.targetSessionId === ids.b.sessionId && n.policy !== 'store-only')) {
        coordinate(() => acknowledgeImpact(state, ids.b.sessionId, notice.id))
      }
      project()
    }
  }
  function applyChange() {
    changed = true
    writeFileSync(join(root, 'producer.mjs'), data.after)
    writeJson(join(root, 'public-spec.json'), data.newSpec)
    emit('producer-change', { completed, beforeHash: sha(data.before), afterHash: sha(data.after) })
    if (state) {
      if (scenario.publisherDeclared) {
        if (scenario.registry) coordinate(() => publishContract(state, { name: data.contract, version: 2, breaking: scenario.breaking,
          publishedBy: ids.a.taskId, declaredIn: 'producer.mjs', summary: 'Amount unit changed from cents to dollars' }))
        else coordinate(() => recordImpactChange(state, { stream: data.contract, revision: 1,
          summary: `${data.contract} updated`, before: data.oldSpec.expression, after: data.newSpec.expression,
          status: 'completed', contracts: [{ name: data.contract, version: 2, breaking: scenario.breaking,
            ...(scenario.changedParts ? { parts: scenario.changedParts } : {}) }], evidence: ['producer.mjs', 'public-spec.json'],
        }, ids.a))
        metrics.declarationWrites++
      } else coordinate(() => appendEvent(state, buildEvent({ ...ids.a, kind: 'file_write', timestampUtc: new Date().toISOString(),
        entities: [{ kind: 'file', identifier: 'producer.mjs', path: 'producer.mjs' }], detail: { phase: 'settled' } })))
      initialCandidates = project().notifications
      emit('projection-at-change', { notifications: initialCandidates })
      if (notifying(arm)) deliver('c', 'PostToolUse', false)
    }
    // C completes independent work in every arm; notices can be counted but cannot block it.
    writeFileSync(join(root, 'theme.css'), ':root { color: navy; }\n')
    emit('independent-task-completed', { completed })
  }

  if (state) {
    for (const who of ['a', 'c']) {
      coordinate(() => recordImpactSession(state, { goal: who === 'a' ? 'Update service implementation' : 'Style navigation', phase: 'working' }, ids[who]))
      metrics.declarationWrites++
    }
    if (scenario.registry) {
      coordinate(() => publishContract(state, { name: data.contract, version: 1, breaking: false, publishedBy: ids.a.taskId, summary: 'Amount in cents' }))
      metrics.declarationWrites++
    }
    declareConsumer(data.oldSpec.version)
    project()
  }
  for (let index = 0; index < plan.workItems; index++) {
    if (index === changeAfter) applyChange()
    if (state) project()
    if (notifying(arm) && arm !== 'delayed-targeted') deliver('b', 'PreToolUse')
    if (scenario.shared && index === 0) writeArtifact('adapter.mjs', artifact(scenario, 'adapter', spec), 'planned-work')
    writeArtifact(`consumers/${channels[index]}.mjs`, artifact(scenario, channels[index], spec), 'planned-work')
    completed++
    if (state) project()
    if (notifying(arm) && arm !== 'delayed-targeted') deliver('b', 'PostToolUse')
    if (arm === 'git-each') assert.equal(check('each-item').pass, true)
  }
  if (arm === 'delayed-targeted') {
    project()
    deliver('b', 'PostToolUse')
    lateDelivered = true
  }
  const final = check('final')
  const finalFiles = Object.fromEntries([...files(), ...(scenario.shared ? ['adapter.mjs'] : []), 'producer.mjs', 'theme.css'].map(file => [file, sha(readFileSync(join(root, file)))]))
  const ledger = state ? readAllEvents(state).events.map(toWire) : []
  const postState = state ? computeImpactReport(state) : null
  const trial = { trialId, pairId: `${scenario.id}--after-${changeAfter}`, runIndex, scenario: scenario.id,
    group: scenario.group, changeAfter, arm, followsNotifications: follows, firstNoticeAt, lateDelivered,
    metrics, finalPass: final.pass, finalFiles, initialCandidates, suppressedDuplicates, clearedChecks,
    ledger, remainingNotifications: postState?.notifications ?? [], trace }
  appendFileSync(join(out, 'trials.jsonl'), JSON.stringify(trial) + '\n')
  if (scenario.id === 'field-rename' && changeAfter === 2 && ['git-final', 'targeted'].includes(arm)) {
    cpSync(root, join(out, 'examples', arm), { recursive: true })
    writeJson(join(out, 'examples', arm, 'trial.json'), trial)
  }
  return trial
}

function shuffle(items) {
  let state = plan.seed >>> 0
  const rand = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32 }
  for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [items[i], items[j]] = [items[j], items[i]] }
  return items
}
function sourceHashes() {
  const files = ['PROTOCOL.md', 'plan.json', 'fixtures.mjs', 'run.mjs', 'analyze.mjs', 'analysis.test.mjs'].map(file => join(here, file))
  for (const dir of ['packages/core/src', 'plugins/agentgit/scripts']) {
    for (const file of readdirSync(join(repo, dir))) if (/\.(ts|mjs)$/.test(file)) files.push(join(repo, dir, file))
  }
  return Object.fromEntries(files.map(file => [relative(repo, file), sha(readFileSync(file))]))
}

try {
  assert.equal(plan.workItems, channels.length)
  if (existsSync(join(out, 'manifest.json'))) throw new Error(`Output already exists: ${out}; choose a fresh --out directory`)
  mkdirSync(out, { recursive: true })
  scratch = mkdtempSync(join(tmpdir(), 'agentgit-effectiveness-'))
  const hashes = sourceHashes()
  const manifest = { experiment: plan.experiment, startedAt: new Date().toISOString(), smoke, node: process.version,
    platform: platform(), arch: arch(), gitHead: git(repo, ['rev-parse', 'HEAD']),
    worktreeStatus: git(repo, ['status', '--short']), hashes, plan, semantics: 'scripted task replay, synchronous projection, actual subprocess hooks and validators' }
  writeJson(join(out, 'manifest.json'), manifest)
  cpSync(planFile, join(out, 'plan.json'))
  cpSync(join(here, 'PROTOCOL.md'), join(out, 'PROTOCOL.md'))
  const scenarios = smoke ? plan.scenarios.slice(0, 2) : plan.scenarios
  const truths = scenarios.map(oracle)
  writeJson(join(out, 'oracle.json'), truths)
  const jobs = []
  let pairIndex = 0
  for (const scenario of scenarios) for (const timing of smoke ? [2] : plan.changeAfterItems) {
    for (const arm of plan.arms) jobs.push({ scenario, timing, arm, pairIndex })
    pairIndex++
  }
  shuffle(jobs)
  const trials = []
  writeFileSync(join(out, 'trials.jsonl'), '')
  for (let index = 0; index < jobs.length; index++) {
    const job = jobs[index]
    trials.push(runTrial(job.scenario, job.timing, job.arm, job.pairIndex, index))
    if ((index + 1) % 14 === 0 || index + 1 === jobs.length) console.log(`Completed ${index + 1}/${jobs.length} trials`)
  }
  assert.deepEqual(sourceHashes(), hashes, 'Experiment or production code changed while running')
  const summary = analyze(plan, truths, trials, { smoke })
  writeJson(join(out, 'summary.json'), summary)
  writeFileSync(join(out, 'REPORT.md'), markdown(summary, manifest))
  writeJson(join(out, 'manifest.json'), { ...manifest, completedAt: new Date().toISOString(), trials: trials.length,
    resultHashes: Object.fromEntries(['trials.jsonl', 'oracle.json', 'summary.json', 'REPORT.md'].map(file => [file, sha(readFileSync(join(out, file)))])) })
  console.log(JSON.stringify({ out, gates: summary.gates, passed: summary.passed }, null, 2))
  process.exitCode = summary.passed ? 0 : 1
} catch (error) {
  console.error(error.stack ?? String(error))
  if (existsSync(out)) writeJson(join(out, 'ERROR.json'), { error: String(error), stack: error.stack })
  process.exitCode = 2
} finally {
  if (scratch && !keep) rmSync(scratch, { recursive: true, force: true })
  else if (scratch) console.log(`Scratch retained: ${scratch}`)
}

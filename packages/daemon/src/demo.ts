/**
 * The demo: one real collision, produced and then caught.
 *
 * This is not a mock. It writes to the workspace's own ledger, because a walkthrough
 * that ran against a fake store would prove nothing about the product - the whole
 * claim is that the coordination facts are derived from what actually happened. Every
 * task it creates is named `demo-*` and every event it writes is attributed to a
 * `demo` session, so the trail is easy to find and easy to remove.
 *
 * It deliberately asserts nothing about its own success. Each step prints the verdict
 * it got, and a step that fails to produce the expected verdict says so and marks the
 * run as failed. A demo that always prints "SUCCESS" is a demo nobody believes twice.
 *
 * @module @agentgit/daemon/demo
 */

import { resolve } from 'node:path'

import {
  appendEvent,
  buildBoardView,
  buildEvent,
  currentVersion,
  ensureWorkspace,
  loadContracts,
  preflightAndClaim,
  publishContract,
  recordAssumption,
  type Verdict,
} from '@agentgit/core'
import { panelMarkdown, writePanel, defaultPanelDir } from '@agentgit/board'

const DEMO_SESSION = 'demo'
const DEMO_FILE = 'src/login.py'
const DEMO_CONTRACT = 'auth.limit'

/** The two agents' own words. Similar on purpose: that is what makes it one work item. */
const INTENT_A = 'add rate limiting to the login endpoint so repeated failures back off'
const INTENT_B = 'add rate limiting to login so repeated failures are throttled'

export interface DemoOptions {
  readonly workspace: string
  readonly json?: boolean
}

interface Step {
  readonly name: string
  readonly expected: Verdict | null
  readonly got: Verdict | null
  readonly detail: string
  readonly ok: boolean
}

export function runDemo(options: DemoOptions): number {
  const root = resolve(options.workspace)
  const paths = ensureWorkspace(root)
  const now = new Date()
  const steps: Step[] = []
  const log: string[] = []

  const say = (line: string): void => {
    log.push(line)
    if (!options.json) process.stdout.write(`${line}\n`)
  }

  say(`AgenticGit demo - ${root}`)
  say('')
  say('Two agents, one file, no Git conflict. This is the case Git cannot see.')

  /* ---- 1. Agent A starts and writes the file ---------------------------------- */

  say('')
  say('1. Agent A opens a task and writes src/login.py')

  appendEvent(paths, buildEvent({
    kind: 'task_registered',
    timestampUtc: now.toISOString(),
    sessionId: 'demo-a',
    taskId: 'demo-a',
    entities: [{ kind: 'file', identifier: DEMO_FILE, path: DEMO_FILE }],
    intentText: INTENT_A,
    hostEvent: 'demo',
    reason: 'demo task',
  }))
  appendEvent(paths, buildEvent({
    kind: 'file_write',
    timestampUtc: new Date(now.getTime() + 1_000).toISOString(),
    sessionId: 'demo-a',
    taskId: 'demo-a',
    entities: [{ kind: 'file', identifier: DEMO_FILE, path: DEMO_FILE }],
    intentText: INTENT_A,
    hostEvent: 'demo',
    reason: 'demo write',
  }))
  say(`   A intent: "${INTENT_A}"`)

  /* ---- 2. Agent B asks before writing ---------------------------------------- */

  say('')
  say('2. Agent B is about to write the same file, for what it thinks is its own reason')
  say('   (B asks properly, with `claim`, so its own decision lands in the ledger too)')

  const overlap = preflightAndClaim(paths, {
    taskId: 'demo-b',
    sessionId: 'demo-b',
    entityKey: `file::${DEMO_FILE}`,
    entityPath: DEMO_FILE,
    intentText: INTENT_B,
  })

  say(`   B intent: "${INTENT_B}"`)
  say(`   verdict : ${overlap.verdict.toUpperCase()}`)
  say(`   reason  : ${overlap.reason}`)
  steps.push({
    name: 'duplicate work is caught',
    expected: 'reuse',
    got: overlap.verdict,
    detail: overlap.reason,
    ok: overlap.verdict === 'reuse',
  })

  /* ---- 3. A publishes the interface, B records that it relies on it ----------- */

  say('')
  say('3. Agent A publishes the interface it is introducing; agent B records that it is coded against v1')

  publishContract(paths, {
    name: DEMO_CONTRACT,
    summary: 'throttle(identifier, limit, window_seconds) -> decision',
    breaking: false,
    declaredIn: DEMO_FILE,
    publishedBy: 'demo-a',
    symbol: 'throttle',
    version: 1,
  })

  recordAssumption(paths, {
    taskId: 'demo-b',
    sessionId: 'demo-b',
    contract: DEMO_CONTRACT,
    version: 1,
    recordedAt: now.toISOString(),
    source: 'declared',
    path: DEMO_FILE,
  })

  say(`   ${DEMO_CONTRACT} v1 published; demo-b recorded against v1`)

  /* ---- 4. A changes it in a way that breaks B --------------------------------- */

  say('')
  say('4. Agent A publishes v2 with a breaking signature change')

  const published = publishContract(paths, {
    name: DEMO_CONTRACT,
    summary: 'throttle(identifier, budget) -> decision, where budget replaces limit and window_seconds',
    breaking: true,
    declaredIn: DEMO_FILE,
    publishedBy: 'demo-a',
    symbol: 'throttle',
    version: 2,
  })

  say(`   v2 published. Tasks now behind a breaking change: ${published.newlyStale.length}`)

  /* ---- 5. B asks again, while A is still landing it --------------------------- */

  say('')
  say('5. Agent B asks again, before writing')

  const stale = preflightAndClaim(paths, {
    taskId: 'demo-b',
    sessionId: 'demo-b',
    entityKey: `file::${DEMO_FILE}`,
    entityPath: DEMO_FILE,
    symbol: 'throttle',
    intentText: INTENT_B,
    contracts: [DEMO_CONTRACT],
  })

  say(`   verdict : ${stale.verdict.toUpperCase()}`)
  say(`   reason  : ${stale.reason}`)
  steps.push({
    name: 'a breaking change still being landed makes the other agent wait',
    expected: 'wait',
    got: stale.verdict,
    detail: stale.reason,
    ok: stale.verdict === 'wait',
  })

  /* ---- 6. A lands it, and the answer changes ---------------------------------- */

  say('')
  say('6. Agent A merges and says so')
  say('   `wait` is the only verdict that can hold indefinitely, so it is bounded: a task')
  say('   whose last event is older than inFlightMinutes stops counting as in flight, and')
  say('   an explicit integrate closes it immediately. A producer that quietly stops must')
  say('   not leave every consumer waiting on a task that will never speak again.')

  const landedAt = new Date(now.getTime() + 2_000).toISOString()
  appendEvent(paths, buildEvent({
    kind: 'lifecycle_validated',
    timestampUtc: landedAt,
    sessionId: 'demo-a',
    taskId: 'demo-a',
    hostEvent: 'demo',
    reason: 'demo: checkpointed',
  }))
  appendEvent(paths, buildEvent({
    kind: 'lifecycle_integrated',
    timestampUtc: landedAt,
    sessionId: 'demo-a',
    taskId: 'demo-a',
    entities: [{ kind: 'file', identifier: DEMO_FILE, path: DEMO_FILE }],
    hostEvent: 'demo',
    reason: 'demo: merged',
  }))

  const afterLanding = preflightAndClaim(paths, {
    taskId: 'demo-b',
    sessionId: 'demo-b',
    entityKey: `file::${DEMO_FILE}`,
    entityPath: DEMO_FILE,
    symbol: 'throttle',
    intentText: INTENT_B,
    contracts: [DEMO_CONTRACT],
  })

  say(`   verdict : ${afterLanding.verdict.toUpperCase()}`)
  say(`   reason  : ${afterLanding.reason}`)
  steps.push({
    name: 'a landed breaking change tells the other agent to replan',
    expected: 'review',
    got: afterLanding.verdict,
    detail: afterLanding.reason,
    ok: afterLanding.verdict === 'review',
  })

  /* ---- 7. The board ---------------------------------------------------------- */

  const view = buildBoardView(paths)
  const artifact = writePanel(view, defaultPanelDir(paths.root))

  say('')
  say('7. What the board now shows')
  say('')
  for (const line of panelMarkdown(view).split('\n')) say(`   ${line}`)
  say('')
  say(`   panel written to ${artifact.path}`)

  /* ---- Verdict on the demo --------------------------------------------------- */

  const failed = steps.filter((step) => !step.ok)
  say('')
  say('Result')
  for (const step of steps) {
    say(`  ${step.ok ? 'ok  ' : 'FAIL'} ${step.name} - expected ${step.expected}, got ${step.got}`)
  }

  say('')
  say('What this proves: two agents edited one file, Git would have reported nothing, and')
  say('the second agent was told the work already existed, then that the interface it had')
  say('coded against was still moving, then - once that moved - that it had to replan.')
  say('Both failures merge cleanly and break at run time.')

  say('')
  say('To remove the demo from this ledger, delete the demo shard file:')
  const contract = currentVersion(loadContracts(paths), DEMO_CONTRACT)
  say(`  .agentgit/events/*-${new Date().toISOString().slice(0, 10)}.jsonl   (contains the demo-* events)`)
  say(`  .agentgit/contracts/index.json                                     (contains ${DEMO_CONTRACT} up to v${contract?.version ?? '?'})`)
  say('  .agentgit/state/{leases,assumptions}.json')
  say('')
  say('Nothing outside .agentgit/ was created, and no file was modified.')

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ workspace: root, steps, view, panel: artifact, session: DEMO_SESSION }, null, 2)}\n`)
  }

  return failed.length === 0 ? 0 : 1
}

/**
 * Governor runtime tests: the whole decision path, driven without a host.
 *
 * These are the tests that stand in for "does the plugin actually do what the
 * experiment assumes", because everything in this file is exactly what the Cordis
 * adapter calls. If these pass and the adapter is thin, the plugin's behaviour is
 * known before it ever runs against a live model.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { ARMS } from '../src/config.ts'
import { GovernorRuntime, keyForPath } from '../src/governor.ts'

/** A fixed clock, so nothing in these tests depends on wall time. */
const CLOCK = '2026-01-01T00:00:00Z'

function runtime(arm: keyof typeof ARMS, options: { sink?: (line: string) => void } = {}) {
  return new GovernorRuntime(ARMS[arm], { now: () => CLOCK, ...options })
}

/** Two sessions, two tasks, one file, same stated intent. */
function contestedRuntime(arm: keyof typeof ARMS) {
  const governor = runtime(arm)
  governor.observe({
    kind: 'file_write',
    sessionId: 's1',
    taskId: 'T1',
    entities: [{ kind: 'file', identifier: 'a.py', path: 'a.py' }],
    intentText: 'add caching to the view',
  })
  governor.observe({
    kind: 'file_write',
    sessionId: 's2',
    taskId: 'T2',
    entities: [{ kind: 'file', identifier: 'a.py', path: 'a.py' }],
    intentText: 'add caching to the view',
  })
  return governor
}

const PROPOSAL = {
  entityKey: keyForPath('a.py'),
  entityPath: 'a.py',
  sessionId: 's2',
  taskId: 'T2',
  intentText: 'add caching to the view',
}

describe('observation gating', () => {
  test('records nothing on an inert arm, which is what makes A0 and A2 controls', () => {
    for (const arm of ['A0-baseline', 'A2-inert'] as const) {
      const governor = runtime(arm)
      assert.equal(governor.observe({ kind: 'file_write', sessionId: 's1' }), null, arm)
      assert.equal(governor.events.length, 0, arm)
      assert.equal(governor.report().counts.events, 0, arm)
    }
  })

  test('records on an instrumenting arm', () => {
    const governor = runtime('A1-instrument')
    const event = governor.observe({ kind: 'file_write', sessionId: 's1', taskId: 'T1' })
    assert.ok(event)
    assert.equal(governor.events.length, 1)
  })

  test('falls back to the session as the task and says so in the record', () => {
    const governor = runtime('A1-instrument')
    const event = governor.observe({ kind: 'file_write', sessionId: 's1' })
    assert.equal(event!.taskId, 's1')
    assert.equal(event!.detail!.taskIdSource, 'session-fallback')
  })

  test('marks an explicitly declared task as declared', () => {
    const governor = runtime('A1-instrument')
    const event = governor.observe({ kind: 'file_write', sessionId: 's1', taskId: 'T9' })
    assert.equal(event!.detail!.taskIdSource, 'declared')
  })

  test('forwards every record to the sink for persistence', () => {
    const lines: string[] = []
    const governor = runtime('A1-instrument', { sink: (line) => lines.push(line) })
    governor.observe({ kind: 'session_started', sessionId: 's1' })
    governor.observe({ kind: 'turn_ended', sessionId: 's1' })
    assert.equal(lines.length, 2)
  })

  test('records context loss, which the H3 probe cannot run without', () => {
    const governor = runtime('A1-instrument')
    // A compaction carries no task id, so the runtime has to attribute it to whatever
    // the session was last seen working on. Declaring the task first is what makes this
    // test cover that path rather than the session-fallback one.
    governor.observe({ kind: 'file_write', sessionId: 's1', taskId: 'T1' })
    governor.noteCompaction('s1')
    const compaction = governor.events.find((event) => event.kind === 'context_compacted')!
    assert.equal(compaction.taskId, 'T1', 'a compaction must land on the task the session was working on')
    assert.equal(compaction.detail!.taskIdSource, 'session-derived')
    assert.equal(governor.report().counts.sessionsWithContextLoss, 1)
  })
})

describe('ledger visibility (the session-only ablation)', () => {
  test('an inert scope sees nothing', () => {
    assert.deepEqual(runtime('A0-baseline').visibleContention(PROPOSAL), [])
  })

  test('cross-session scope sees the other session', () => {
    assert.equal(contestedRuntime('A1-instrument').visibleContention(PROPOSAL).length, 1)
  })

  test('session scope does not see the other session', () => {
    const governor = contestedRuntime('A4-session-only')
    assert.equal(governor.visibleContention(PROPOSAL).length, 0, 'this is the whole point of the ablation')
    // The ledger still holds everything; only visibility is restricted.
    assert.equal(governor.events.length, 2)
  })
})

describe('decisions per arm', () => {
  test('A1 records contention but never acts', () => {
    const decision = contestedRuntime('A1-instrument').decide(PROPOSAL)
    assert.equal(decision.action, 'none')
    assert.equal(decision.basis, 'policy-disabled')
    assert.equal(decision.competitors.length, 1, 'the observation must survive')
  })

  test('A3 advises: coordination, not admission control', () => {
    const decision = contestedRuntime('A3-advisory').decide(PROPOSAL)
    assert.equal(decision.action, 'advise')
    assert.equal(decision.interventionClass, 'coordination')
  })

  test('A4-gated denies: admission control', () => {
    const decision = contestedRuntime('A4-gated').decide(PROPOSAL)
    assert.equal(decision.action, 'deny')
    assert.equal(decision.interventionClass, 'admission-control')
  })

  test('A4-session-only cannot deny a conflict it cannot see', () => {
    const decision = contestedRuntime('A4-session-only').decide(PROPOSAL)
    assert.equal(decision.action, 'none')
  })

  test('A4-detect-only computes the denial and takes no action', () => {
    const decision = contestedRuntime('A4-detect-only').decide(PROPOSAL)
    assert.equal(decision.action, 'none')
    assert.equal(decision.intendedAction, 'deny')
    assert.equal(decision.dryRun, true)
  })
})

describe('gate accounting', () => {
  test('records a denial with the evidence needed to audit it', () => {
    const governor = contestedRuntime('A4-gated')
    const decision = governor.decide(PROPOSAL)
    governor.noteGate(decision, PROPOSAL)
    const gateEvent = governor.events.at(-1)!
    assert.equal(gateEvent.kind, 'gate_denied')
    assert.equal(gateEvent.detail!.basis, decision.basis)
    assert.equal(gateEvent.detail!.interventionClass, 'admission-control')
  })

  test('records a non-action as allowed, so the denominator is countable', () => {
    const governor = contestedRuntime('A1-instrument')
    governor.noteGate(governor.decide(PROPOSAL), PROPOSAL)
    assert.equal(governor.events.at(-1)!.kind, 'gate_allowed')
  })

  test('distinguishes a suppressed denial from a real one in the ledger', () => {
    const governor = contestedRuntime('A4-detect-only')
    governor.noteGate(governor.decide(PROPOSAL), PROPOSAL)
    const event = governor.events.at(-1)!
    assert.equal(event.kind, 'gate_allowed')
    assert.equal(event.detail!.intendedAction, 'deny', 'an ablation that is invisible in the data is worthless')
    assert.equal(event.detail!.dryRun, true)
  })
})

describe('advisory', () => {
  test('is silent on arms that do not advise', () => {
    for (const arm of ['A1-instrument', 'A4-gated'] as const) {
      assert.equal(contestedRuntime(arm).advisoryOverview('s2'), null, arm)
    }
  })

  test('is silent when nothing collides, so an idle repository costs no tokens', () => {
    const governor = runtime('A3-advisory')
    governor.observe({ kind: 'file_write', sessionId: 's1', taskId: 'T1', entities: [{ kind: 'file', identifier: 'a.py', path: 'a.py' }] })
    assert.equal(governor.advisoryOverview('s1'), null)
  })

  test('names the other session and task on an advising arm', () => {
    const text = contestedRuntime('A3-advisory').advisoryOverview('s2')
    assert.ok(text, 'a real collision must produce an advisory')
    assert.match(text, /file::a\.py/)
    assert.match(text, /T1/)
    assert.match(text, /s1/)
  })

  test('the overview is identical regardless of which session asks, because the ledger is shared', () => {
    const governor = contestedRuntime('A3-advisory')
    const fromS1 = governor.advisoryOverview('s1')
    const fromS2 = governor.advisoryOverview('s2')
    assert.ok(fromS1?.includes('file::a.py'))
    assert.ok(fromS2?.includes('file::a.py'))
  })

  test('respects the configured length cap', () => {
    const governor = new GovernorRuntime(
      { ...ARMS['A3-advisory'], advisoryMaxChars: 150 },
      { now: () => CLOCK },
    )
    for (const [i, session] of ['s1', 's2', 's3', 's4'].entries()) {
      governor.observe({
        kind: 'file_write',
        sessionId: session,
        taskId: `T${i}`,
        entities: [{ kind: 'file', identifier: 'a.py', path: 'a.py' }],
        intentText: 'a very long stated intent that will certainly be truncated by the renderer',
      })
    }
    const text = governor.advisoryOverview('s1')!
    assert.ok(text.length <= 150, `length ${text.length} exceeded the cap`)
  })

  test('the per-entity advisory is silent when there is no competitor', () => {
    const governor = runtime('A3-advisory')
    governor.observe({ kind: 'file_write', sessionId: 's1', taskId: 'T1', entities: [{ kind: 'file', identifier: 'a.py', path: 'a.py' }] })
    const proposal = { ...PROPOSAL, sessionId: 's1', taskId: 'T1' }
    assert.equal(governor.advisory(proposal, governor.decide(proposal)), null)
  })

  test('the per-entity advisory reports how much work followed context loss', () => {
    const governor = contestedRuntime('A3-advisory')
    // `contestedRuntime` already declared T2 for s2, so the compaction is attributed to
    // T2 by session derivation — the same path a real `compaction/end` takes, since the
    // host event carries no task id of its own.
    governor.noteCompaction('s2')
    governor.observe({
      kind: 'file_write',
      sessionId: 's2',
      taskId: 'T2',
      entities: [{ kind: 'file', identifier: 'a.py', path: 'a.py' }],
      intentText: 'add caching to the view',
    })
    const text = governor.advisory(PROPOSAL, governor.decide(PROPOSAL))!
    assert.match(text, /lost context 1 time\(s\)/)
    assert.match(text, /1 write\(s\) were issued after such a loss/)
  })
})

describe('attribution (the bugs that make H3 read zero)', () => {
  test('bookkeeping events form no capsule, so they cannot inflate B(t) forever', () => {
    const governor = runtime('A1-instrument')
    governor.observe({ kind: 'session_started', sessionId: 's1' })
    governor.observe({ kind: 'turn_ended', sessionId: 's1' })
    governor.observe({ kind: 'session_ended', sessionId: 's1' })
    assert.equal(governor.events.length, 3, 'still recorded as evidence')
    assert.equal(governor.report().counts.capsules, 0, 'but they are not work')
    assert.equal(governor.report().parallelism.peak, 0)
  })

  test('a compaction lands in the session\'s current task, not in a phantom capsule', () => {
    const governor = runtime('A1-instrument')
    governor.observe({
      kind: 'file_write',
      sessionId: 's2',
      taskId: 'T2',
      entities: [{ kind: 'file', identifier: 'a.py', path: 'a.py' }],
    })
    governor.noteCompaction('s2')
    governor.observe({
      kind: 'file_write',
      sessionId: 's2',
      entities: [{ kind: 'file', identifier: 'b.py', path: 'b.py' }],
    })

    const capsules = governor.capsules()
    assert.deepEqual([...capsules.keys()], ['T2'], 'no capsule named after the session')
    assert.equal(capsules.get('T2')!.nCompactEvents, 1)
    assert.equal(
      capsules.get('T2')!.writesAfterCompact,
      1,
      'the H3 probe would read zero if the compaction had opened its own capsule',
    )
    const compaction = governor.events.find((e) => e.kind === 'context_compacted')!
    assert.equal(compaction.taskId, 'T2')
    assert.equal(compaction.detail!.taskIdSource, 'session-derived')
  })

  test('before any task is declared, a session stands in as its own task', () => {
    const governor = runtime('A1-instrument')
    const event = governor.observe({ kind: 'file_write', sessionId: 's1' })
    assert.equal(event!.taskId, 's1')
    assert.equal(event!.detail!.taskIdSource, 'session-fallback')
  })

  test('a declared task is remembered and used for later unattributed events', () => {
    const governor = runtime('A1-instrument')
    governor.observe({ kind: 'file_write', sessionId: 's1', taskId: 'T7' })
    const later = governor.observe({ kind: 'file_write', sessionId: 's1' })
    assert.equal(later!.taskId, 'T7')
    assert.equal(later!.detail!.taskIdSource, 'session-derived')
  })

  test('sessions keep separate task memories', () => {
    const governor = runtime('A1-instrument')
    governor.observe({ kind: 'file_write', sessionId: 's1', taskId: 'T1' })
    governor.observe({ kind: 'file_write', sessionId: 's2', taskId: 'T2' })
    assert.equal(governor.observe({ kind: 'file_write', sessionId: 's1' })!.taskId, 'T1')
    assert.equal(governor.observe({ kind: 'file_write', sessionId: 's2' })!.taskId, 'T2')
  })

  test('exposes capsules for inspection', () => {
    const governor = runtime('A1-instrument')
    governor.observe({ kind: 'file_write', sessionId: 's1', taskId: 'T1' })
    assert.equal(governor.capsules().size, 1)
  })
})

describe('fault containment', () => {
  test('accumulates errors instead of throwing', () => {
    const governor = runtime('A1-instrument')
    governor.noteError('fs/write-intent', new Error('boom'))
    assert.deepEqual(governor.errors, [{ handler: 'fs/write-intent', message: 'boom' }])
  })

  test('normalises a non-Error throw', () => {
    const governor = runtime('A1-instrument')
    governor.noteError('x', 'just a string')
    assert.equal(governor.errors[0].message, 'just a string')
  })

  test('bounds the error buffer so a hot-loop fault cannot exhaust memory', () => {
    const governor = runtime('A1-instrument')
    for (let i = 0; i < 250; i += 1) governor.noteError('x', new Error(`e${i}`))
    assert.equal(governor.errors.length, 100)
    assert.equal(governor.errors.at(-1)!.message, 'e249')
  })

  test('a persistence failure is contained and fails closed', () => {
    const governor = new GovernorRuntime(ARMS['A1-instrument'], {
      now: () => CLOCK,
      sink: () => {
        throw new Error('disk full')
      },
    })
    // The fault must not escape into the host...
    assert.equal(governor.observe({ kind: 'session_started', sessionId: 's1' }), null)
    // ...it must be recorded...
    assert.equal(governor.errors.length, 1)
    assert.equal(governor.errors[0].handler, 'observe')
    // ...and the unpersisted event must NOT be retained, so live state never
    // diverges from the ledger the run is audited against.
    assert.equal(governor.events.length, 0)
  })
})

describe('report', () => {
  test('aggregates the framework quantities for a whole run', () => {
    const governor = contestedRuntime('A1-instrument')
    governor.noteCompaction('s2')
    const report = governor.report()
    assert.equal(report.counts.events, 3)
    assert.equal(report.counts.capsules, 2)
    assert.equal(report.counts.contestedEntities, 1)
    assert.equal(report.counts.sessionsWithContextLoss, 1)
  })
})

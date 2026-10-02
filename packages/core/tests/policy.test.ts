/**
 * Policy tests. The most important assertion in this file is that a blocking
 * decision is never classed as `coordination`: that classification is what keeps
 * a K4 result (an improvement bought by refusing work) from being reported as
 * governance revenue.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { buildCapsules, buildContention, entityTouches } from '../src/ledger.ts'
import { HUB_DECIDE_BAND } from '../src/hub.ts'
import {
  DEFAULT_POLICY,
  bestSimilarity,
  buildAdvisory,
  competitorsFor,
  decideWrite,
  extractIdentifiers,
  intentSimilarity,
  tokenize,
  type PolicyConfig,
  type WriteProposal,
} from '../src/policy.ts'
import { ev, write } from './helpers.ts'

/** Contention derived from a real event stream, so this also covers integration. */
function contentionFrom(events: Parameters<typeof buildCapsules>[0]) {
  return buildContention(buildCapsules(events))
}

/**
 * Touches without the two-or-more filter.
 *
 * Needed by the resolution tests: a symbol claim and a path claim about the same file sit
 * on *different* keys with one toucher each, so `buildContention` would drop both and the
 * test would pass for the wrong reason.
 */
function touchesFrom(events: Parameters<typeof buildCapsules>[0]) {
  return entityTouches(buildCapsules(events))
}

const twoTaskConflict = contentionFrom([
  write({ minutes: 0, taskId: 'T1', sessionId: 's1', path: 'a.py', intentText: 'add caching to the view' }),
  write({ minutes: 1, taskId: 'T2', sessionId: 's2', path: 'a.py', intentText: 'add caching to the view' }),
])

const sameTaskTwoSessions = contentionFrom([
  write({ minutes: 0, taskId: 'T1', sessionId: 's1', path: 'a.py' }),
  write({ minutes: 1, taskId: 'T1', sessionId: 's2', path: 'a.py' }),
])

const sameTaskOneSession = contentionFrom([
  write({ minutes: 0, taskId: 'T1', sessionId: 's1', path: 'a.py' }),
  write({ minutes: 1, taskId: 'T1', sessionId: 's1', path: 'a.py' }),
])

/** A `file_write` for one symbol, in the file it lives in. */
function symbolWrite(
  minutes: number,
  taskId: string,
  sessionId: string,
  symbol: string,
  path: string,
  intentText: string | null = null,
) {
  return ev({
    kind: 'file_write',
    minutes,
    taskId,
    sessionId,
    intentText,
    entities: [{ kind: 'symbol', identifier: symbol, path }],
  })
}

/**
 * Two agents naming the same function in different words.
 *
 * The lexical matcher scores this pair near zero, which is the miss E2 measured. A verdict
 * of "the same work" here can therefore only come from the shared symbol.
 */
const sameSymbolDifferentWords = contentionFrom([
  symbolWrite(0, 'T1', 's1', 'view.jsonify', 'src/views.py', 'return json from the view, not a rendered page'),
  symbolWrite(1, 'T2', 's2', 'view.jsonify', 'src/views.py', 'add a jsonify helper to the view'),
])

/** One agent names the function, the other names the file it lives in. */
const symbolMeetsPath = touchesFrom([
  symbolWrite(0, 'T1', 's1', 'view.jsonify', 'src/views.py'),
  write({ minutes: 1, taskId: 'T2', sessionId: 's2', path: 'src/views.py' }),
])

/** The precision trap: one file, two unrelated purposes. */
const sameFileDifferentPurpose = contentionFrom([
  write({
    minutes: 0,
    taskId: 'T1',
    sessionId: 's1',
    path: 'src/config.py',
    intentText: 'rename the logging level constants',
  }),
  write({
    minutes: 1,
    taskId: 'T2',
    sessionId: 's2',
    path: 'src/config.py',
    intentText: 'add a timeout setting for the client',
  }),
])

function proposal(overrides: Partial<WriteProposal> = {}): WriteProposal {
  return {
    entityKey: 'file::a.py',
    entityPath: 'a.py',
    sessionId: 's2',
    taskId: 'T2',
    intentText: 'add caching to the view',
    ...overrides,
  }
}

function config(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return { ...DEFAULT_POLICY, ...overrides }
}

describe('intent similarity', () => {
  test('tokenize drops stopwords and single characters', () => {
    assert.deepEqual(tokenize('Add the caching to a view'), ['caching', 'view'])
  })

  test('extractIdentifiers finds snake_case, camelCase and dotted tokens', () => {
    assert.deepEqual(
      extractIdentifiers('call jsonify_view and getUserName from app.routes').sort(),
      ['app.routes', 'getusername', 'jsonify_view'],
    )
  })

  test('is 1 for identical intent and 0 when either side is missing', () => {
    assert.equal(intentSimilarity('return json', 'return json'), 1)
    assert.equal(intentSimilarity(null, 'return json'), 0)
    assert.equal(intentSimilarity('return json', undefined), 0)
  })

  test('scores shared identifiers above shared prose', () => {
    const withIdentifiers = intentSimilarity(
      'refactor render_dashboard_html to use jsonify_view',
      'reuse jsonify_view inside render_dashboard_html',
    )
    const proseOnly = intentSimilarity('make the page faster please', 'speed up that screen somehow')
    assert.ok(withIdentifiers > proseOnly, `${withIdentifiers} should exceed ${proseOnly}`)
  })

  test('folds synonyms and plurals, so a rephrase of one job is not read as a different one', () => {
    // Without this the matcher saw "throttle" and "rate limiting" as unrelated words and scored
    // one change near zero, which the hub then read as "different purpose". The canonical map is
    // what makes the commonest rephrase land in the undecidable band instead of below it.
    assert.deepEqual(
      new Set(tokenize('throttle the login attempts')),
      new Set(tokenize('rate limiting the login attempt')),
    )

    const reworded = intentSimilarity('add rate limiting to the login endpoint', 'throttle repeated login attempts')
    assert.ok(
      reworded > HUB_DECIDE_BAND.replan && reworded < DEFAULT_POLICY.duplicateIntentThreshold,
      `a reworded duplicate must land in the undecidable band, got ${reworded}`,
    )
  })

  /**
   * This test documents a known limitation rather than desired behaviour. E2
   * exists to measure this gap; the assertion is here so the gap cannot be
   * forgotten and silently claimed as solved.
   */
  test('KNOWN CEILING: misses a semantic duplicate phrased in different words', () => {
    const semanticDuplicate = intentSimilarity(
      'return JSON from the view',
      'add a jsonify helper to the view',
    )
    assert.ok(
      semanticDuplicate < DEFAULT_POLICY.duplicateIntentThreshold,
      `lexical matching was expected to miss this pair, got ${semanticDuplicate}`,
    )
  })

  test('bestSimilarity picks the closest recorded intent', () => {
    assert.equal(bestSimilarity(proposal(), twoTaskConflict[0]), 1)
    assert.equal(bestSimilarity(proposal({ intentText: 'unrelated work on zeta.py' }), twoTaskConflict[0]), 0)
  })
})

describe('competitor selection', () => {
  test('excludes contention confined to the proposer\'s own session', () => {
    assert.equal(competitorsFor(proposal({ taskId: 'T1' }), sameTaskOneSession, DEFAULT_POLICY).length, 0)
  })

  test('keeps a same-task entity when another session also touched it', () => {
    assert.equal(competitorsFor(proposal({ taskId: 'T1', sessionId: 's1' }), sameTaskTwoSessions, DEFAULT_POLICY).length, 1)
  })

  test('ignores entities other than the proposal\'s', () => {
    assert.equal(competitorsFor(proposal({ entityKey: 'file::z.py' }), twoTaskConflict, DEFAULT_POLICY).length, 0)
  })

  test('matches a symbol claim against a path claim about the same file', () => {
    // The two agents named the same code at different resolutions. Comparing keys literally
    // saw two unrelated entities and reported nothing, which made the finer claim useless.
    const found = competitorsFor(
      proposal({ entityKey: 'file::src/views.py', entityPath: 'src/views.py', taskId: 'T2', sessionId: 's2' }),
      symbolMeetsPath,
      DEFAULT_POLICY,
    )
    assert.equal(found.length, 1)
  })
})

describe('structural evidence', () => {
  test('a shared symbol is enough to call it the same work, even when the words differ', () => {
    const decision = decideWrite(
      proposal({
        entityKey: 'symbol::view.jsonify',
        entityPath: 'src/views.py',
        symbol: 'view.jsonify',
        taskId: 'T2',
        sessionId: 's2',
        intentText: 'expose the payload as json',
      }),
      sameSymbolDifferentWords,
      config({ action: 'none' }),
    )

    assert.equal(decision.matchStrength, 'symbol')
    assert.equal(decision.detection, 'duplicate-intent')
    // The verdict does not rest on the score; the score is reported, not relied on.
    assert.ok(
      (decision.similarity ?? 0) < DEFAULT_POLICY.duplicateIntentThreshold,
      `expected the lexical matcher to miss this pair, got ${decision.similarity}`,
    )
  })

  test('a shared file with no shared symbol is not a duplicate on its own', () => {
    const decision = decideWrite(
      proposal({
        entityKey: 'file::src/config.py',
        entityPath: 'src/config.py',
        taskId: 'T2',
        sessionId: 's2',
        intentText: 'bump the default retry count',
      }),
      sameFileDifferentPurpose,
      config({ action: 'none' }),
    )

    assert.equal(decision.matchStrength, 'file')
    assert.equal(decision.detection, 'cross-task-conflict')
  })
})

describe('decideWrite', () => {
  test('reports no contention on a clean entity', () => {
    const decision = decideWrite(proposal({ entityKey: 'file::z.py' }), twoTaskConflict, config({ action: 'deny' }))
    assert.equal(decision.action, 'none')
    assert.equal(decision.basis, 'no-contention')
    assert.equal(decision.interventionClass, 'none')
  })

  test('does not act on work confined to the proposer\'s own session', () => {
    // Even with the most aggressive action configured, a session cannot conflict
    // with itself: the session is the unit of awareness.
    const decision = decideWrite(proposal({ taskId: 'T1' }), sameTaskOneSession, config({ action: 'deny' }))
    assert.equal(decision.basis, 'no-contention')
    assert.equal(decision.action, 'none')
  })

  test('does not act on same-task work across sessions when that rule is off', () => {
    const decision = decideWrite(
      proposal({ taskId: 'T1', sessionId: 's1', intentText: null }),
      sameTaskTwoSessions,
      config({ action: 'deny', treatCrossSessionAsContention: false }),
    )
    assert.equal(decision.basis, 'below-threshold')
    assert.equal(decision.action, 'none')
  })

  test('detects a two-task conflict and acts when configured to advise', () => {
    const decision = decideWrite(proposal(), twoTaskConflict, config({ action: 'advise' }))
    assert.equal(decision.basis, 'duplicate-intent')
    assert.equal(decision.action, 'advise')
    assert.equal(decision.interventionClass, 'coordination')
    assert.deepEqual(decision.otherTasks, ['T1'])
    assert.equal(decision.similarity, 1)
  })

  test('classifies two sessions inside one task as their own basis', () => {
    const decision = decideWrite(
      proposal({ taskId: 'T1', sessionId: 's1', intentText: null }),
      sameTaskTwoSessions,
      config({ action: 'advise' }),
    )
    assert.equal(decision.basis, 'cross-session-same-task')
    assert.equal(decision.otherTasks.length, 0)
  })

  test('a blocking decision is admission-control, never coordination', () => {
    for (const action of ['deny', 'ask'] as const) {
      const decision = decideWrite(proposal(), twoTaskConflict, config({ action }))
      assert.equal(decision.action, action)
      assert.equal(decision.interventionClass, 'admission-control')
      assert.notEqual(decision.interventionClass, 'coordination')
    }
  })

  test('dryRun computes the decision but takes no action', () => {
    const decision = decideWrite(proposal(), twoTaskConflict, config({ action: 'deny', dryRun: true }))
    assert.equal(decision.action, 'none', 'dry run must not block')
    assert.equal(decision.intendedAction, 'deny', 'the intent must still be recorded')
    assert.equal(decision.dryRun, true)
    // The evidence survives, so an ablation arm still produces analysable records.
    assert.equal(decision.basis, 'duplicate-intent')
    assert.equal(decision.competitors.length, 1)
  })

  test('records contention without acting when the policy is passive', () => {
    const decision = decideWrite(proposal(), twoTaskConflict, config({ action: 'none' }))
    assert.equal(decision.action, 'none')
    assert.equal(decision.basis, 'policy-disabled')
    assert.equal(decision.competitors.length, 1, 'the observation must not be lost')
  })

  test('respects a raised minOtherTasks threshold, independently of the session rule', () => {
    // The two rules are OR-ed, so the session rule must be off to isolate the
    // task threshold. Pinning that here stops the OR from being misread as AND.
    const decision = decideWrite(
      proposal(),
      twoTaskConflict,
      config({ action: 'deny', minOtherTasks: 2, treatCrossSessionAsContention: false }),
    )
    assert.equal(decision.basis, 'below-threshold')
    assert.equal(decision.action, 'none')
  })

  test('the session rule fires even when the task threshold is not met', () => {
    const decision = decideWrite(proposal(), twoTaskConflict, config({ action: 'deny', minOtherTasks: 5 }))
    assert.notEqual(decision.basis, 'below-threshold', 'another session is independently sufficient')
    assert.equal(decision.action, 'deny')
  })

  test('does not cap the other-task count, only the advisory payload', () => {
    const many = contentionFrom([
      ...[1, 2, 3, 4, 5, 6].map((i, index) =>
        write({ minutes: index, taskId: `T${i}`, sessionId: `s${i}`, path: 'a.py' }),
      ),
    ])
    const decision = decideWrite(
      proposal({ taskId: 'TX', sessionId: 'sX' }),
      many,
      config({ action: 'advise' }),
    )
    // A decision concerns exactly one entity key, so there is exactly one record;
    // the payload bound that matters is the per-record intent cap, tested below.
    assert.equal(decision.competitors.length, 1)
    assert.equal(decision.otherTasks.length, 6, 'the count drives the decision and is not capped')
  })

  test('flags contention with no usable intent as a cross-task conflict', () => {
    const decision = decideWrite(
      proposal({ intentText: null }),
      contentionFrom([
        write({ minutes: 0, taskId: 'T1', sessionId: 's1', path: 'a.py' }),
        write({ minutes: 1, taskId: 'T2', sessionId: 's2', path: 'a.py' }),
      ]),
      config({ action: 'advise' }),
    )
    assert.equal(decision.basis, 'cross-task-conflict')
    assert.equal(decision.similarity, null)
  })
})

describe('detection is observable independently of action', () => {
  test('a passive arm still reports what the detector saw', () => {
    // This is what makes E2 measurable. `A1-instrument` runs with action: 'none',
    // so `basis` is 'policy-disabled' on every decision; if detection were only
    // readable from `basis`, precision and recall would be uncomputable in the very
    // arm E2 is required to measure them in.
    const contention = buildContention(
      buildCapsules([
        write({ minutes: 0, sessionId: 's1', taskId: 'T1', path: 'a.py', intentText: 'add jsonify helper' }),
        write({ minutes: 1, sessionId: 's2', taskId: 'T2', path: 'a.py', intentText: 'add jsonify helper' }),
      ]),
    )
    const decision = decideWrite(
      {
        entityKey: 'file::a.py',
        entityPath: 'a.py',
        sessionId: 's2',
        taskId: 'T2',
        intentText: 'add jsonify helper',
      },
      contention,
      { ...DEFAULT_POLICY, action: 'none' },
    )

    assert.equal(decision.action, 'none', 'nothing was done')
    assert.equal(decision.basis, 'policy-disabled', 'the decision is still "policy off"')
    assert.equal(decision.detection, 'duplicate-intent', 'but the detection is recorded')
    assert.equal(decision.interventionClass, 'none')
  })

  test('detection matches basis whenever the policy is enabled', () => {
    const contention = buildContention(
      buildCapsules([
        write({ minutes: 0, sessionId: 's1', taskId: 'T1', path: 'a.py', intentText: 'add jsonify helper' }),
        write({ minutes: 1, sessionId: 's2', taskId: 'T2', path: 'a.py', intentText: 'add jsonify helper' }),
      ]),
    )
    const decision = decideWrite(
      {
        entityKey: 'file::a.py',
        entityPath: 'a.py',
        sessionId: 's2',
        taskId: 'T2',
        intentText: 'add jsonify helper',
      },
      contention,
      { ...DEFAULT_POLICY, action: 'advise' },
    )
    assert.equal(decision.detection, 'duplicate-intent')
    assert.equal(decision.basis, decision.detection)
  })

  test('an independent control reports no contention, not a suppressed one', () => {
    // The E2 false-positive floor: a file nobody else touched must never be labelled
    // as a collision, on any arm.
    const decision = decideWrite(
      { entityKey: 'file::solo.py', entityPath: 'solo.py', sessionId: 's1', taskId: 'T1', intentText: 'anything' },
      [],
      { ...DEFAULT_POLICY, action: 'advise' },
    )
    assert.equal(decision.detection, 'no-contention')
    assert.equal(decision.basis, 'no-contention')
    assert.equal(decision.action, 'none')
  })
})

describe('advisory rendering', () => {
  const decision = decideWrite(proposal(), twoTaskConflict, config({ action: 'advise' }))

  test('names the entity, the other task and the recorded intent', () => {
    const text = buildAdvisory(proposal(), decision, { writesAfterContextLoss: 0, compactionEvents: 0 }, 1200)
    assert.match(text, /file::a\.py/)
    assert.match(text, /T1/)
    assert.match(text, /add caching to the view/)
  })

  test('reports context loss only when it happened', () => {
    const quiet = buildAdvisory(proposal(), decision, { writesAfterContextLoss: 0, compactionEvents: 0 }, 1200)
    const loud = buildAdvisory(proposal(), decision, { writesAfterContextLoss: 4, compactionEvents: 2 }, 1200)
    assert.doesNotMatch(quiet, /lost context/)
    assert.match(loud, /lost context 2 time\(s\)/)
    assert.match(loud, /4 write\(s\)/)
  })

  test('never exceeds the configured cap, because E6 prices this text', () => {
    const text = buildAdvisory(proposal(), decision, { writesAfterContextLoss: 0, compactionEvents: 0 }, 120)
    assert.ok(text.length <= 120, `length ${text.length} exceeded cap`)
    assert.ok(text.endsWith('...'))
  })

  test('caps quoted intents per entity, which is what actually bounds the payload', () => {
    const manyIntents = contentionFrom([
      write({ minutes: 0, taskId: 'T1', sessionId: 's1', path: 'a.py', intentText: 'alpha work' }),
      write({ minutes: 1, taskId: 'T2', sessionId: 's2', path: 'a.py', intentText: 'beta work' }),
      write({ minutes: 2, taskId: 'T3', sessionId: 's3', path: 'a.py', intentText: 'gamma work' }),
      write({ minutes: 3, taskId: 'T4', sessionId: 's4', path: 'a.py', intentText: 'delta work' }),
    ])
    const decided = decideWrite(proposal({ taskId: 'TX', sessionId: 'sX' }), manyIntents, config({ action: 'advise' }))
    const text = buildAdvisory(proposal(), decided, { writesAfterContextLoss: 0, compactionEvents: 0 }, 5000, 2)
    assert.equal(text.match(/recorded intent:/g)?.length, 2)
  })

  test('is deterministic so replayed runs produce identical context', () => {
    const once = buildAdvisory(proposal(), decision, { writesAfterContextLoss: 1, compactionEvents: 1 }, 1200)
    const twice = buildAdvisory(proposal(), decision, { writesAfterContextLoss: 1, compactionEvents: 1 }, 1200)
    assert.equal(once, twice)
  })
})

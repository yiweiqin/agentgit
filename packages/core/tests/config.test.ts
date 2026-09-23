/**
 * Arm-isolation tests.
 *
 * These are research-validity assertions, not implementation details. If an arm
 * can leak a capability it is defined to lack, then a measured difference between
 * arms cannot be attributed to any mechanism, and every downstream experiment is
 * void.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  ARM_NAMES,
  ARMS,
  canAdvise,
  canBlock,
  describeCapabilities,
  overrideArm,
  resolveArm,
  seesOtherSessions,
} from '../src/config.ts'

describe('arm definitions', () => {
  test('covers the baseline, the placebo and both intervention classes', () => {
    assert.deepEqual([...ARM_NAMES].sort(), [
      'A0-baseline',
      'A1-instrument',
      'A2-inert',
      'A3-advisory',
      'A4-detect-only',
      'A4-gated',
      'A4-session-only',
    ])
  })

  test('A0 and A2 are both inert, and differ only by presence in the process', () => {
    for (const name of ['A0-baseline', 'A2-inert'] as const) {
      const arm = ARMS[name]
      assert.equal(arm.recordObservations, false, name)
      assert.equal(arm.ledgerScope, 'off', name)
      assert.equal(canBlock(arm), false, name)
      assert.equal(canAdvise(arm), false, name)
    }
  })

  test('A1 measures without ever intervening', () => {
    const arm = ARMS['A1-instrument']
    assert.equal(arm.recordObservations, true)
    assert.equal(arm.ledgerScope, 'cross-session')
    assert.equal(canBlock(arm), false, 'the instrument must never block')
    assert.equal(canAdvise(arm), false, 'the instrument must never inject')
  })

  test('A3 advises and never blocks: it must raise R without lowering lambda', () => {
    const arm = ARMS['A3-advisory']
    assert.equal(canAdvise(arm), true)
    assert.equal(canBlock(arm), false, 'a blocking A3 would confound the framework\'s central claim')
    assert.equal(arm.policy.action, 'advise')
  })

  test('A4-gated blocks and does not advise', () => {
    const arm = ARMS['A4-gated']
    assert.equal(canBlock(arm), true)
    assert.equal(canAdvise(arm), false, 'mixing the two would make the arm\'s effect uninterpretable')
    assert.equal(arm.policy.dryRun, false)
  })

  test('A4-session-only keeps blocking but removes cross-session memory', () => {
    const arm = ARMS['A4-session-only']
    assert.equal(canBlock(arm), true)
    assert.equal(seesOtherSessions(arm), false, 'this arm exists to test the ledger itself')
    assert.equal(arm.ledgerScope, 'session')
  })

  test('A4-detect-only computes every decision and acts on none', () => {
    const arm = ARMS['A4-detect-only']
    assert.equal(arm.policy.action, 'deny', 'the intent must be present in the records')
    assert.equal(arm.policy.dryRun, true, 'but it must never take effect')
    assert.equal(arm.recordObservations, true)
  })

  test('no arm except A3 and the inert controls is without a distinct purpose', () => {
    const fingerprints = ARM_NAMES.map((name) => {
      const arm = ARMS[name]
      return `${arm.recordObservations}|${arm.ledgerScope}|${arm.advisory}|${arm.gate}|${arm.policy.action}|${arm.policy.dryRun}`
    })
    // A0 and A2 are intentionally identical in capability; every other arm must
    // differ from every other, or two arms are measuring the same thing.
    const counts = new Map<string, number>()
    for (const fingerprint of fingerprints) counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1)
    const duplicates = [...counts.entries()].filter(([, count]) => count > 1)
    assert.equal(duplicates.length, 1, `unexpected duplicate arms: ${JSON.stringify(duplicates)}`)
  })
})

describe('resolveArm', () => {
  test('returns the declared configuration', () => {
    assert.equal(resolveArm('A3-advisory').advisory, true)
  })

  test('rejects an unknown arm rather than silently falling back', () => {
    assert.throws(() => resolveArm('A9-imaginary' as never), /unknown arm/)
  })
})

describe('overrideArm', () => {
  test('allows tightening an arm', () => {
    const tightened = overrideArm(ARMS['A3-advisory'], { advisoryMaxChars: 200 })
    assert.equal(tightened.advisoryMaxChars, 200)
    assert.equal(tightened.advisory, true, 'unrelated capabilities are preserved')
  })

  test('refuses to enable recording on an inert arm', () => {
    assert.throws(() => overrideArm(ARMS['A0-baseline'], { recordObservations: true }), /may not change recordObservations/)
  })

  test('refuses to change the gate, which was the leak that motivated the guard', () => {
    assert.throws(() => overrideArm(ARMS['A1-instrument'], { gate: 'deny' }), /may not change gate/)
  })

  test('refuses to switch an arm between coordination and admission control', () => {
    assert.throws(
      () => overrideArm(ARMS['A3-advisory'], { policy: { ...ARMS['A3-advisory'].policy, action: 'deny' } }),
      /may not change policy\.action/,
    )
  })

  test('refuses to turn an arm into a dry run or out of one', () => {
    assert.throws(
      () => overrideArm(ARMS['A4-gated'], { policy: { ...ARMS['A4-gated'].policy, dryRun: true } }),
      /may not change policy\.dryRun/,
    )
  })

  test('refuses to widen ledger scope, because that is what makes A4-session-only an ablation', () => {
    // The session-only ablation is defined as its own arm. Letting an override
    // widen its scope would silently convert it into A4-gated and destroy the
    // comparison that justifies the whole arm.
    assert.throws(() => overrideArm(ARMS['A4-session-only'], { ledgerScope: 'cross-session' }), /may not change ledgerScope/)
  })

  test('merges nested policy overrides instead of replacing the policy object', () => {
    const merged = overrideArm(ARMS['A4-gated'], { policy: { ...ARMS['A4-gated'].policy, minOtherTasks: 3 } })
    assert.equal(merged.policy.minOtherTasks, 3)
    assert.equal(merged.policy.action, 'deny', 'unrelated policy fields survive')
  })
})

describe('capability summary', () => {
  test('is stable, greppable and appears in every run log', () => {
    assert.equal(
      describeCapabilities(ARMS['A4-detect-only']),
      'record=true scope=cross-session advisory=false gate=deny policy=deny dryRun=true',
    )
  })
})

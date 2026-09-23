/**
 * The A/B harness is checked by running it, not by reading it.
 *
 * Three of the claims this product makes about itself live in `examples/ab/run.mjs` and
 * nowhere else, and each of them has already been wrong once during development:
 *
 * 1. **The arms differ.** An arm wired to nothing produces a table of identical rows, which
 *    reads exactly like a null result and is in fact a broken switch. The first version of
 *    this harness reported four identical arms because it parsed `--json` output line by line
 *    and every verdict became a parse error.
 * 2. **The ablation is a narrowed tool, not a broken one.** `A4-session-only` must still fill
 *    the ledger — it writes 12 events in the scenario — while answering `allow`. If it also
 *    stopped writing, the comparison would be against a plugin that was switched off.
 * 3. **Untouched ground is never disturbed.** This is the floor that catches a detector
 *    firing on everything, and no arm, at any obedience rate, may move it.
 *
 * The harness is driven with a two-arm subset so this stays a few seconds rather than a
 * minute: the invariants are about the *shape* of the result, and shape does not need all
 * four arms and all three obedience levels to be visible.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..', '..', '..')
const HARNESS = join(REPO, 'examples', 'ab', 'run.mjs')

interface Outcome {
  readonly arm: string
  readonly compliance: number
  readonly conflicts: readonly string[]
  readonly ledgerEvents: number
  readonly rounds: readonly { verdictB: string; nextActions?: string[]; stopped: boolean }[]
  readonly metrics: {
    readonly duplicateRounds: number
    readonly duplicatesClosed: number
    readonly independentRounds: number
    readonly independentStopped: number
    readonly untouchedRounds: number
    readonly untouchedDisturbed: number
    readonly actionable: number
  }
}

function runHarness(extra: string[]): { results: Outcome[]; stdout: string } {
  // The report and the JSON both go to stdout, so the machine-readable half is written to a
  // file. Byte-slicing the prose to find the JSON object would be a test that breaks the next
  // time a sentence is reworded, and it would break by parsing nothing rather than by failing.
  const out = join(mkdtempSync(join(tmpdir(), 'agentgit-ab-test-')), 'results.json')
  const result = spawnSync(
    process.execPath,
    [HARNESS, '--arms', 'A0-baseline,A4-session-only,A1-instrument,A3-advisory', ...extra, '--json', out],
    { encoding: 'utf8', cwd: REPO },
  )
  assert.equal(result.status, 0, `harness failed: ${result.stderr || result.stdout}`)
  const parsed = JSON.parse(readFileSync(out, 'utf8')) as { results: Outcome[] }
  return { results: parsed.results, stdout: result.stdout ?? '' }
}

const byArm = (results: Outcome[], arm: string, compliance: number) =>
  results.find((entry) => entry.arm === arm && entry.compliance === compliance)!

describe('the A/B harness reports a real difference between arms', () => {
  // One obedience level is enough to make the arm comparison, and keeps this to two runs.
  const { results, stdout } = runHarness(['--compliance', '1'])

  test('it ran every arm it was asked for', () => {
    assert.deepEqual(
      [...new Set(results.map((entry) => entry.arm))].sort(),
      ['A0-baseline', 'A1-instrument', 'A3-advisory', 'A4-session-only'],
    )
  })

  test('the control writes nothing, and the treatment writes to the ledger', () => {
    assert.equal(byArm(results, 'A0-baseline', 1).ledgerEvents, 0, 'the control leaves no trace')
    assert.ok(
      byArm(results, 'A4-session-only', 1).ledgerEvents > 0,
      'the ablation still records: it is a narrowed view, not a disabled plugin',
    )
  })

  test('the ablation still asks the question and answers allow', () => {
    // It wrote the other session's events and cannot see them. Both halves matter: an arm
    // that recorded nothing would be indistinguishable from the control for the wrong reason.
    const ablated = byArm(results, 'A4-session-only', 1)
    assert.ok(ablated.ledgerEvents > 0)
    assert.deepEqual([...new Set(ablated.rounds.map((round) => round.verdictB))], ['allow'])
  })

  test('the instrument arm decides without offering an action, and closes nothing', () => {
    // This is the finding, not an anomaly: knowing and saying so changes no outcome until
    // the caller is handed something to do. A1 and the control must therefore agree.
    const instrument = byArm(results, 'A1-instrument', 1)
    const baseline = byArm(results, 'A0-baseline', 1)
    assert.ok(
      instrument.rounds.some((round) => round.verdictB !== 'allow'),
      'the instrument arm must detect: it is not the control',
    )
    assert.equal(instrument.metrics.actionable, 0, 'and it must offer nothing')
    assert.equal(
      instrument.conflicts.length,
      baseline.conflicts.length,
      'so it leaves the same conflicts as the control',
    )
  })

  test('the default arm, obeyed, closes the duplicates and leaves no conflict', () => {
    const advisory = byArm(results, 'A3-advisory', 1)
    assert.equal(advisory.metrics.duplicatesClosed, advisory.metrics.duplicateRounds)
    assert.deepEqual(advisory.conflicts, [], 'what the product is for, in one assertion')
    assert.ok(advisory.metrics.actionable > 0, 'it earned that by offering usable next actions')
  })

  test('untouched ground is never disturbed, under any arm', () => {
    // The floor. An arm that moved this number would be firing on ground nobody has touched,
    // and its duplicate column would then be uninterpretable.
    for (const outcome of results) {
      assert.equal(outcome.metrics.untouchedDisturbed, 0, `${outcome.arm} disturbed untouched ground`)
      assert.equal(outcome.metrics.untouchedRounds, 1)
    }
  })

  test('the run says out loud that it is a fixture', () => {
    // The honesty of the harness is part of its contract: the numbers are meaningless without
    // the sentence that says agents are scripted and obedience is a dial.
    assert.match(stdout, /scripted/i)
    assert.match(stdout, /not as a measurement/i)
    assert.match(stdout, /obedience/i)
  })
})

describe('the harness refuses what it cannot measure with', () => {
  test('a typo in an arm name fails the run instead of shrinking it', () => {
    // Silently dropping an unknown arm would produce a shorter table that reads as complete.
    const result = spawnSync(process.execPath, [HARNESS, '--arms', 'A0-baseline,A9-nonsense'], {
      encoding: 'utf8',
      cwd: REPO,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /unknown arm 'A9-nonsense'/)
  })
})

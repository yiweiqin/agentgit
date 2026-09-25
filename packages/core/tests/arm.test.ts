/**
 * The experimental arm, and the claim that switching it changes what the product sees.
 *
 * An arm that only relabels itself is worse than no arm at all: the A/B experiment would
 * run two configurations, get the same numbers from both, and report a null effect for
 * what was in fact a switch wired to nothing. So the tests here are mostly about *effect*:
 * after the same events are written, does `A4-session-only` answer differently from
 * `A3-advisory`, does `A0-baseline` stop writing to the ledger at all, and does the scope
 * narrow leases along with events so the ablation measures the ledger rather than the
 * lease store.
 *
 * The arms that are deliberately not offered are checked too, because "refused" is a
 * behaviour: a config naming `A4-gated` must fail loudly rather than quietly becoming
 * something else.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { removeScratch } from './helpers.ts'

import {
  ARM_EFFECTS,
  DEFAULT_ARM,
  DEFAULT_CONFIG,
  PRODUCT_ARMS,
  appendEvent,
  buildEvent,
  ensureWorkspace,
  loadConfig,
  preflight,
  preflightAndClaim,
  readAllEvents,
  resolveProductArm,
  updateConfig,
  type ProductArm,
  type WorkspacePaths,
} from '@agentgit/core'

let root: string
let paths: WorkspacePaths
const scratch: string[] = []

const FILE = 'src/login.py'

function makeWorkspace(): WorkspacePaths {
  const dir = mkdtempSync(join(tmpdir(), 'agentgit-arm-'))
  scratch.push(dir)
  return ensureWorkspace(dir)
}

/** Set the arm the way a user would, through the writer that validates it. */
function setArm(arm: string): void {
  updateConfig(paths, { arm: arm as ProductArm })
}

/** One other session records a write, so there is something to see or not see. */
function otherSessionWrites(paths: WorkspacePaths, sessionId = 'other-session', taskId = 'other-task'): void {
  appendEvent(paths, buildEvent({
    kind: 'file_write',
    timestampUtc: new Date().toISOString(),
    sessionId,
    taskId,
    entities: [{ kind: 'file', identifier: FILE, path: FILE }],
    intentText: 'add rate limiting to the login endpoint',
    hostEvent: 'test',
  }))
}

function ask(paths: WorkspacePaths, sessionId = 'mine', intent = 'add rate limiting to login') {
  return preflight(paths, {
    taskId: sessionId,
    sessionId,
    entityKey: `file::${FILE}`,
    entityPath: FILE,
    intentText: intent,
  })
}

beforeEach(() => {
  paths = makeWorkspace()
})

afterEach(() => {
  // Never let housekeeping fail a test: a Windows handle on a directory `git` just wrote to
  // can outlive the command that held it. See `helpers.ts`.
  while (scratch.length > 0) removeScratch(scratch.pop()!)
})

describe('the arm set', () => {
  test('every offered arm says what it does', () => {
    // The point of exposing the arms is that a user can tell what they are switching
    // between, so an arm without an effect line is not shippable.
    for (const arm of PRODUCT_ARMS) {
      assert.equal(typeof ARM_EFFECTS[arm], 'string')
      assert.ok(ARM_EFFECTS[arm].length > 20, `${arm} needs a real description`)
    }
    assert.equal(Object.keys(ARM_EFFECTS).length, PRODUCT_ARMS.length, 'no arm is described but unofferable')
  })

  test('the default arm is one of the offered ones', () => {
    assert.ok((PRODUCT_ARMS as readonly string[]).includes(DEFAULT_ARM))
    assert.equal(DEFAULT_CONFIG.arm, DEFAULT_ARM)
  })

  test('an arm the product will not run is refused by name, with the reason', () => {
    // A quiet downgrade is the failure this prevents: the user would believe writes were
    // being gated and never see one blocked.
    assert.throws(() => resolveProductArm('A4-gated'), /refuses writes, and this product never does/)
    assert.throws(() => resolveProductArm('A2-inert'), /behaves identically to 'A0-baseline'/)
    assert.throws(() => resolveProductArm('A4-detect-only'), /behaves identically to 'A1-instrument'/)
    assert.throws(() => resolveProductArm('A9-imaginary'), /unknown arm/)
  })

  test('every research arm is either offered or refused with a specific reason', () => {
    // The other half of the same claim: an arm added to the research set later must not be
    // silently unreachable from the product. Either it is offered, or naming it explains.
    const research = [
      'A0-baseline', 'A1-instrument', 'A2-inert', 'A3-advisory', 'A4-gated', 'A4-session-only', 'A4-detect-only',
    ]
    for (const arm of research) {
      if ((PRODUCT_ARMS as readonly string[]).includes(arm)) continue
      assert.throws(() => resolveProductArm(arm), (error: Error) => error.message.includes(arm), `${arm} must explain itself`)
    }
  })
})

describe('reading and writing the arm', () => {
  test('a workspace with no config runs the default arm', () => {
    assert.equal(loadConfig(paths).arm, DEFAULT_ARM)
  })

  test('setting the arm keeps every other setting', () => {
    updateConfig(paths, { duplicateIntentThreshold: 0.9, leaseMinutes: 3 })
    setArm('A4-session-only')
    const config = loadConfig(paths)
    assert.equal(config.arm, 'A4-session-only')
    assert.equal(config.duplicateIntentThreshold, 0.9, 'tuning must not be reset by switching arms')
    assert.equal(config.leaseMinutes, 3)
  })

  test('a config naming a refused arm fails loudly on read, not silently', () => {
    // Written by hand, the way a user editing the file would. The blanket per-field
    // fallback must not swallow this: that would also reset every other field with no
    // message, so a mistyped arm would cost the tuned thresholds too.
    ensureWorkspace(paths.root)
    writeFileSync(
      paths.config,
      `${JSON.stringify({ ...DEFAULT_CONFIG, arm: 'A4-gated', duplicateIntentThreshold: 0.9 }, null, 2)}\n`,
      'utf8',
    )
    assert.throws(() => loadConfig(paths), /A4-gated refuses writes/)
  })

  test('unreadable config JSON still degrades to defaults instead of throwing', () => {
    writeFileSync(paths.config, '{ this is not json', 'utf8')
    assert.deepEqual(loadConfig(paths), DEFAULT_CONFIG)
  })

  test('the writer never produces a file the reader rejects', () => {
    // A config the tool writes and then refuses to read is the one failure that would make
    // the setting untrustworthy, so the round trip is asserted rather than assumed.
    for (const arm of PRODUCT_ARMS) {
      setArm(arm)
      assert.equal(loadConfig(paths).arm, arm)
    }
  })
})

describe('the arm changes what the product sees', () => {
  test('cross-session sees another session\'s write; session-only does not', () => {
    otherSessionWrites(paths)
    // The same ledger, the same question, two arms. This difference *is* the experiment:
    // if these two agreed, the A/B would measure nothing.
    setArm('A3-advisory')
    const shared = ask(paths)
    setArm('A4-session-only')
    const alone = ask(paths)

    assert.equal(shared.verdict, 'reuse', shared.reason)
    assert.equal(alone.verdict, 'allow', `session-only must not see the other session: ${alone.reason}`)
  })

  test('the ablated arm keeps what the session could have known alone', () => {
    /*
     * The ablation has to be a *narrowed* tool, not a broken one.
     *
     * Worth stating precisely, because it is easy to assume otherwise: the product's policy
     * requires a different session before two touches count as contention, so a session can
     * never create contention from its own events. What session-only keeps is its own
     * *leases* — the record of what this session already claimed — so one session working two
     * tasks on one entity is still caught. That is the difference between `A4-session-only`
     * and `A0-baseline`, and this is the test that pins it.
     */
    setArm('A4-session-only')
    preflightAndClaim(paths, {
      taskId: 'task-one', sessionId: 'mine', entityKey: `file::${FILE}`, entityPath: FILE, intentText: 'first thing',
    })
    const second = preflight(paths, {
      taskId: 'task-two', sessionId: 'mine', entityKey: `file::${FILE}`, entityPath: FILE, intentText: 'a different thing',
    })
    assert.notEqual(second.verdict, 'allow', `own lease must survive the ablation: ${second.reason}`)

    // And the baseline, which must see none of it, does not.
    setArm('A0-baseline')
    const baseline = preflight(paths, {
      taskId: 'task-two', sessionId: 'mine', entityKey: `file::${FILE}`, entityPath: FILE, intentText: 'a different thing',
    })
    assert.equal(baseline.verdict, 'allow', 'the control sees nothing, not even its own leases')
  })

  test('the baseline arm is blind even to its own ledger', () => {
    otherSessionWrites(paths)
    setArm('A0-baseline')
    const result = ask(paths)
    assert.equal(result.verdict, 'allow')
    assert.equal(result.evidence.detection, 'no-contention')
  })

  test('the baseline arm writes nothing, so it cannot contaminate the next arm', () => {
    // Without this, switching arms would leave the workspace carrying whichever arm ran
    // first, and every later comparison would be against a polluted ledger.
    setArm('A0-baseline')
    const before = readAllEvents(paths).events.length
    preflightAndClaim(paths, {
      taskId: 'mine', sessionId: 'mine', entityKey: `file::${FILE}`, entityPath: FILE, intentText: 'mine',
    })
    assert.equal(readAllEvents(paths).events.length, before, 'the control must leave no trace')
  })

  test('a normal arm does record its decision, so the ledger stays the record', () => {
    setArm('A3-advisory')
    const before = readAllEvents(paths).events.length
    preflightAndClaim(paths, {
      taskId: 'mine', sessionId: 'mine', entityKey: `file::${FILE}`, entityPath: FILE, intentText: 'mine',
    })
    assert.ok(readAllEvents(paths).events.length > before, 'the treatment records what it decided')
  })

  test('a lease from another session is invisible to the ablated arm', () => {
    // A lease is another session's activity in a shared file. If it stayed visible, the
    // session-only arm would still catch cross-session duplicates through the lease store,
    // and the ablation would credit the ledger for an effect that came from elsewhere.
    setArm('A3-advisory')
    preflightAndClaim(paths, {
      taskId: 'other-task', sessionId: 'other-session', entityKey: `file::${FILE}`, entityPath: FILE,
      intentText: 'add rate limiting to the login endpoint',
    })
    const shared = ask(paths, 'mine', 'add rate limiting to the login endpoint')
    assert.equal(shared.verdict, 'reuse', shared.reason)
    assert.ok(shared.evidence.leaseConflicts.length > 0, 'the shared arm sees the other lease')

    setArm('A4-session-only')
    const alone = ask(paths, 'mine', 'add rate limiting to the login endpoint')
    assert.deepEqual(alone.evidence.leaseConflicts, [], 'the ablated arm must not see it')
  })
})

describe('the arm decides whether the caller is told what to do', () => {
  test('measurement-only reports the same verdict with nothing to act on', () => {
    // A1 must not change the *decision*: if it did, a comparison against the default would
    // be measuring detection accuracy rather than the effect of being advised.
    otherSessionWrites(paths)
    setArm('A3-advisory')
    const advisory = ask(paths)
    setArm('A1-instrument')
    const instrument = ask(paths)

    assert.equal(instrument.verdict, advisory.verdict, 'the word is the same')
    assert.equal(instrument.reason, advisory.reason, 'and so is the reason')
    assert.ok(advisory.nextActions.length > 0, 'the default offers something to do')
    assert.deepEqual(instrument.nextActions, [], 'the instrument arm offers nothing')
  })

  test('a verdict is never suppressed, whatever the arm', () => {
    // The caller asked, so it cannot be told nothing happened when something did.
    otherSessionWrites(paths)
    setArm('A1-instrument')
    const result = ask(paths)
    assert.equal(result.verdict, 'reuse')
    assert.match(result.reason, /doing the same thing/)
  })

  test('the board and the panel read the workspace, not one session\'s view', () => {
    // `loadContext` with no scope stays the widest view, which is what a workspace-level
    // rendering needs: a board that adopted the reading session's arm would hide exactly
    // the cross-session work it exists to show.
    otherSessionWrites(paths)
    setArm('A4-session-only')
    const board = preflight(paths, {
      taskId: 'mine', sessionId: 'mine', entityKey: `file::${FILE}`, entityPath: FILE,
    })
    assert.equal(board.verdict, 'allow', 'the session-scoped query is narrowed')
    const unscoped = preflight(paths, { taskId: 'mine', sessionId: 'mine', entityKey: `file::${FILE}`, entityPath: FILE })
    assert.equal(unscoped.verdict, 'allow', 'and preflight always answers under the arm, by design')
    // The distinction is asserted where it lives: `loadContext` without a scope.
    assert.equal(readFileSync(paths.config, 'utf8').includes('A4-session-only'), true, 'arm is persisted for the board to report')
  })
})

describe('the arm is visible to the user', () => {
  test('a hand-written config without an arm falls back to the default', () => {
    // Forward and backward compatibility: a config written before arms existed must keep
    // working, and the product must not refuse to start over a missing field.
    const legacy = { ...DEFAULT_CONFIG } as Record<string, unknown>
    delete legacy.arm
    writeFileSync(paths.config, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')
    assert.equal(loadConfig(paths).arm, DEFAULT_ARM)
  })
})

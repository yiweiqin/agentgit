/**
 * The coordination hub: one ruling per contention, and the guarantees around it.
 *
 * Three properties are the whole point of this module, so each has a test that would fail if
 * it were quietly given up:
 *
 * 1. **Determinism.** The same events and the same instant give the same ruling, so two
 *    windows asking at once cannot get two answers.
 * 2. **Quiet publishing.** A ruling that keeps computing to the same conclusion is written to
 *    the ledger exactly once, so a stable workspace does not look like a changing one.
 * 3. **One conclusion per question.** When a window answers an ambiguous ruling, the earliest
 *    answer stands and every later one is recorded and ignored.
 *
 * The ambiguous fixtures use word lists rather than prose on purpose: the band is a numeric
 * property of the lexical matcher, and a fixture written as realistic prose would drift out
 * of the band the moment the matcher's stopword list changed.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  acquireLease,
  buildCapsules,
  computeHubVerdict,
  contentionSignature,
  entityTouches,
  HUB_PUBLISH_HOST_EVENT,
  HUB_RESOLVE_HOST_EVENT,
  hubSeenCount,
  hubVerdictId,
  isHubEvent,
  lastPublishedRuling,
  publishHubVerdict,
  readAllEvents,
  readHubMarker,
  readHubVerdict,
  releaseLease,
  seenMarkerName,
  writeHubMarker,
} from '../src/index.ts'
import { buildEvent } from '../src/ledger.ts'
import { appendEvent, ensureWorkspace, workspacePaths } from '../src/workspace.ts'

let root: string
let clock: Date

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentgit-hub-'))
  ensureWorkspace(root)
  clock = new Date()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function paths() {
  return workspacePaths(root)
}

/** Minutes before the test clock. Fixtures are relative so the suite cannot expire. */
function ago(minutes: number): string {
  return new Date(clock.getTime() - minutes * 60_000).toISOString()
}

function write(taskId: string, path: string, intent: string | null, at: string): void {
  appendEvent(
    paths(),
    buildEvent({
      kind: 'file_write',
      timestampUtc: at,
      sessionId: taskId,
      taskId,
      entities: [{ kind: 'file', identifier: path, path }],
      intentText: intent,
      hostEvent: 'test',
    }),
    new Date(at),
  )
}

function writeSymbol(taskId: string, symbol: string, path: string, intent: string, at: string): void {
  appendEvent(
    paths(),
    buildEvent({
      kind: 'file_write',
      timestampUtc: at,
      sessionId: taskId,
      taskId,
      entities: [{ kind: 'symbol', identifier: symbol, path }],
      intentText: intent,
      hostEvent: 'test',
    }),
    new Date(at),
  )
}

function answer(input: {
  entityKey: string
  decision: 'reuse' | 'replan'
  signature: string
  sessionId: string
  at: string
  reason?: string
}): void {
  appendEvent(
    paths(),
    buildEvent({
      kind: 'decision',
      timestampUtc: input.at,
      sessionId: input.sessionId,
      taskId: input.sessionId,
      hostEvent: HUB_RESOLVE_HOST_EVENT,
      reason: input.reason ?? input.decision,
      detail: {
        entityKey: input.entityKey,
        decision: input.decision,
        signature: input.signature,
        rulingId: 'hub-at-the-time',
      },
    }),
    new Date(input.at),
  )
}

const FILE = 'src/limiter.ts'

/** Word lists chosen to land in a known band of the lexical matcher. See the module note. */
const SAME_WORK_A = 'alpha beta gamma delta'
const SAME_WORK_B = 'alpha beta gamma epsilon' // token Jaccard 3/5 = 0.60 -> reuse
const DIFFERENT_A = 'epsilon zeta eta theta'
const UNDECIDABLE_A = 'alpha beta gamma delta'
const UNDECIDABLE_B = 'alpha beta epsilon' // token Jaccard 2/5 = 0.40 -> inside the band

/* -------------------------------------------------------------------------- */
/* Determinism                                                                 */
/* -------------------------------------------------------------------------- */

describe('the ruling is a function of the ledger, not of who asked', () => {
  test('the same events and instant produce the same ruling id', () => {
    write('task-a', FILE, SAME_WORK_A, ago(10))
    write('task-b', FILE, SAME_WORK_B, ago(9))

    const first = computeHubVerdict(paths(), clock)
    const second = computeHubVerdict(paths(), clock)

    assert.equal(first.id, second.id)
    assert.deepEqual(first.rulings, second.rulings)
  })

  test('the ruling id does not move when nothing about the ruling moved', () => {
    write('task-a', FILE, SAME_WORK_A, ago(10))
    write('task-b', FILE, SAME_WORK_B, ago(9))

    const early = computeHubVerdict(paths(), new Date(clock.getTime() - 60_000))
    const later = computeHubVerdict(paths(), clock)

    // A legitimate concern: the projection carries a timestamp, a parallelism figure and
    // ownership durations, all of which move on their own. If any of them were hashed into
    // the id, the hub would publish a "new" ruling on every tick.
    assert.equal(later.id, early.id, 'a time-varying field reached the ruling id')
    assert.notEqual(later.generatedAt, early.generatedAt, 'the fixture must actually move the clock')
  })

  test('a change to the conclusion does move the id', () => {
    write('task-a', FILE, SAME_WORK_A, ago(10))
    write('task-b', FILE, SAME_WORK_B, ago(9))
    const before = computeHubVerdict(paths(), clock)

    acquireLease(paths(), {
      entityKey: `file::${FILE}`,
      taskId: 'task-b',
      sessionId: 'task-b',
      reason: 'taking this over',
      minutes: 20,
    }, clock)

    const after = computeHubVerdict(paths(), clock)
    assert.notEqual(after.id, before.id, 'a different owner is a different conclusion')
  })

  test('a third task joining without changing the conclusion does not move the id', () => {
    // Publishing only on a changed conclusion is what keeps the ledger quiet. The newcomer
    // still appears as waiting in the *projection*, which is refreshed every tick — the
    // ledger records conclusions, the projection carries current facts.
    write('task-a', FILE, SAME_WORK_A, ago(10))
    write('task-b', FILE, SAME_WORK_B, ago(9))
    const before = computeHubVerdict(paths(), clock)

    write('task-c', FILE, DIFFERENT_A, ago(1))
    const after = computeHubVerdict(paths(), clock)

    assert.equal(after.id, before.id)
    assert.equal(after.rulings[0].word, 'reuse', 'the strongest evidence still decides')
    assert.deepEqual(after.rulings[0].owner.waiting, ['task-b', 'task-c'])
  })
})

/* -------------------------------------------------------------------------- */
/* The three words                                                             */
/* -------------------------------------------------------------------------- */

describe('what the hub concludes about one contention', () => {
  test('similar intents on one file are one job, and the earliest writer is recommended', () => {
    write('task-a', FILE, SAME_WORK_A, ago(10))
    write('task-b', FILE, SAME_WORK_B, ago(9))

    const verdict = computeHubVerdict(paths(), clock)
    const ruling = verdict.rulings.find((candidate) => candidate.entityKey === `file::${FILE}`)

    assert.ok(ruling)
    assert.equal(ruling.word, 'reuse')
    assert.equal(ruling.basis, 'intent-similarity')
    assert.equal(ruling.needsResolution, false)
    assert.equal(ruling.owner.taskId, 'task-a', 'the task that wrote it first owns the ground')
    assert.equal(ruling.owner.basis, 'first-write')
    assert.deepEqual(ruling.owner.waiting, ['task-b'])
  })

  test('intents about different things are different work on shared ground', () => {
    write('task-a', FILE, SAME_WORK_A, ago(10))
    write('task-b', FILE, DIFFERENT_A, ago(9))

    const ruling = computeHubVerdict(paths(), clock).rulings[0]
    assert.equal(ruling.word, 'replan')
    assert.equal(ruling.basis, 'different-intent')
    assert.equal(ruling.needsResolution, false)
  })

  test('evidence that cannot decide asks for a decision instead of guessing', () => {
    write('task-a', FILE, UNDECIDABLE_A, ago(10))
    write('task-b', FILE, UNDECIDABLE_B, ago(9))

    const ruling = computeHubVerdict(paths(), clock).rulings[0]
    assert.equal(ruling.word, 'ambiguous')
    assert.equal(ruling.basis, 'lexical-undecidable')
    assert.equal(ruling.needsResolution, true, 'this is the one case the brain exists for')
    assert.equal(ruling.similarity !== null && ruling.similarity > 0.2 && ruling.similarity < 0.42, true)
  })

  test('two tasks naming one symbol are one job without consulting the wording', () => {
    // Structural evidence stands on its own, which is why it is read off the key rather than
    // inferred from intents: two agents describing one function differently is still one
    // function, and the lexical matcher is known not to see that.
    writeSymbol('task-a', 'throttle', FILE, SAME_WORK_A, ago(10))
    writeSymbol('task-b', 'throttle', FILE, DIFFERENT_A, ago(9))

    const ruling = computeHubVerdict(paths(), clock).rulings.find(
      (candidate) => candidate.entityKey === 'symbol::throttle',
    )
    assert.ok(ruling)
    assert.equal(ruling.word, 'reuse')
    assert.equal(ruling.basis, 'structural-duplicate')
  })

  test('one recorded intent is not enough to call two tasks one job', () => {
    write('task-a', FILE, null, ago(10))
    write('task-b', FILE, SAME_WORK_A, ago(9))

    const ruling = computeHubVerdict(paths(), clock).rulings[0]
    assert.equal(ruling.word, 'replan')
    assert.equal(ruling.basis, 'insufficient-intent')
    assert.equal(ruling.needsResolution, false, 'a model call is not the answer to missing evidence')
  })

  test('a live lease outranks who wrote first', () => {
    write('task-a', FILE, SAME_WORK_A, ago(10))
    write('task-b', FILE, SAME_WORK_B, ago(9))
    acquireLease(paths(), {
      entityKey: `file::${FILE}`,
      taskId: 'task-b',
      sessionId: 'task-b',
      reason: 'taking this over',
      minutes: 20,
    }, clock)

    const ruling = computeHubVerdict(paths(), clock).rulings[0]
    assert.equal(ruling.owner.taskId, 'task-b')
    assert.equal(ruling.owner.basis, 'lease')
    assert.deepEqual(ruling.owner.waiting, ['task-a'])
  })

  test('a single task on its own ground is not a contention at all', () => {
    write('task-a', FILE, SAME_WORK_A, ago(10))
    assert.deepEqual(computeHubVerdict(paths(), clock).rulings, [])
  })
})

/* -------------------------------------------------------------------------- */
/* The brain                                                                   */
/* -------------------------------------------------------------------------- */

describe('an ambiguous ruling is answered once, and only once', () => {
  function ambiguous() {
    write('task-a', FILE, UNDECIDABLE_A, ago(10))
    write('task-b', FILE, UNDECIDABLE_B, ago(9))
    const verdict = computeHubVerdict(paths(), clock)
    const ruling = verdict.rulings[0]
    assert.equal(ruling.needsResolution, true)
    return { verdict, ruling }
  }

  test('an answer replaces the ask, and the ruling stops asking', () => {
    const { ruling } = ambiguous()
    const signature = contentionSignature(ruling)
    answer({ entityKey: ruling.entityKey, decision: 'reuse', signature, sessionId: 'task-b', at: ago(5) })

    const after = computeHubVerdict(paths(), clock).rulings[0]
    assert.equal(after.word, 'reuse')
    assert.equal(after.basis, 'resolved')
    assert.equal(after.needsResolution, false)
    assert.equal(after.resolvedBy, 'task-b')
  })

  test('the earliest answer stands and every later one is recorded but ignored', () => {
    const { ruling } = ambiguous()
    const signature = contentionSignature(ruling)
    answer({ entityKey: ruling.entityKey, decision: 'reuse', signature, sessionId: 'task-b', at: ago(5) })
    answer({ entityKey: ruling.entityKey, decision: 'replan', signature, sessionId: 'task-c', at: ago(1) })

    const after = computeHubVerdict(paths(), clock).rulings[0]
    assert.equal(after.word, 'reuse', 'a second window must not be able to produce a second conclusion')
    assert.equal(after.resolvedBy, 'task-b')
    assert.equal(after.supersededAnswers, 1)

    const recorded = readAllEvents(paths()).events.filter((event) => event.hostEvent === HUB_RESOLVE_HOST_EVENT)
    assert.equal(recorded.length, 2, 'the losing answer is still in the ledger, as an append-only system requires')
  })

  test('an answer about different contention is not applied', () => {
    // A third task joining is a materially different question, so an answer to the old
    // question must not silently bind the new one.
    const { ruling } = ambiguous()
    answer({
      entityKey: ruling.entityKey,
      decision: 'reuse',
      signature: 'someone-else|someone-else',
      sessionId: 'task-b',
      at: ago(5),
    })

    const after = computeHubVerdict(paths(), clock).rulings[0]
    assert.equal(after.word, 'ambiguous')
    assert.equal(after.needsResolution, true)
  })

  test('an answer cannot reopen a collision that evidence already decided', () => {
    write('task-a', FILE, SAME_WORK_A, ago(10))
    write('task-b', FILE, DIFFERENT_A, ago(9))
    const ruling = computeHubVerdict(paths(), clock).rulings[0]
    assert.equal(ruling.word, 'replan')

    answer({
      entityKey: ruling.entityKey,
      decision: 'reuse',
      signature: contentionSignature(ruling),
      sessionId: 'task-b',
      at: ago(5),
    })

    const after = computeHubVerdict(paths(), clock).rulings[0]
    assert.equal(after.word, 'replan', 'the ledger must not be usable to talk a decided ruling back open')
    assert.equal(after.basis, 'different-intent')
  })
})

/* -------------------------------------------------------------------------- */
/* Publishing                                                                  */
/* -------------------------------------------------------------------------- */

describe('publishing a ruling into the ledger', () => {
  test('the first ruling is published once, and a repeat publishes nothing', () => {
    write('task-a', FILE, SAME_WORK_A, ago(10))
    write('task-b', FILE, SAME_WORK_B, ago(9))

    const first = publishHubVerdict(paths(), computeHubVerdict(paths(), clock))
    assert.equal(first.published, true)
    assert.equal(first.reason, 'first-ruling')

    const second = publishHubVerdict(paths(), computeHubVerdict(paths(), clock))
    assert.equal(second.published, false)
    assert.equal(second.reason, 'unchanged', 'the same conclusion is not news')

    const published = readAllEvents(paths()).events.filter((event) => event.hostEvent === HUB_PUBLISH_HOST_EVENT)
    assert.equal(published.length, 1)
    assert.equal(published[0].kind, 'advisory_injected', 'the reserved kind is what this was for')
  })

  test('a restarted publisher republishes nothing, because the ledger already holds it', () => {
    write('task-a', FILE, SAME_WORK_A, ago(10))
    write('task-b', FILE, SAME_WORK_B, ago(9))
    publishHubVerdict(paths(), computeHubVerdict(paths(), clock))
    const before = readAllEvents(paths()).events.length

    // A fresh process: nothing carried in memory, everything read back from the ledger.
    const afterRestart = publishHubVerdict(paths(), computeHubVerdict(paths(), new Date(clock.getTime() + 5000)))

    assert.equal(afterRestart.published, false)
    assert.equal(readAllEvents(paths()).events.length, before)
  })

  test('the hub event cannot manufacture contention, so publishing cannot feed itself', () => {
    write('task-a', FILE, SAME_WORK_A, ago(10))
    write('task-b', FILE, SAME_WORK_B, ago(9))
    const before = computeHubVerdict(paths(), clock)
    publishHubVerdict(paths(), before)

    const events = readAllEvents(paths()).events
    const capsules = buildCapsules(events)
    const contention = entityTouches(capsules).filter(
      (record) => record.tasks.length > 1 || record.sessions.length > 1,
    )

    assert.equal(contention.length, before.rulings.length, 'the ruling event added a collision')
    assert.equal(computeHubVerdict(paths(), clock).id, before.id, 'publishing changed the ruling it published')

    const hubEvent = events.find((event) => event.hostEvent === HUB_PUBLISH_HOST_EVENT)!
    assert.equal(isHubEvent(hubEvent), true)
    assert.equal(hubEvent.taskId, null, 'a hub event must not open a capsule')
  })

  test('suppressing publication still refreshes the projection', () => {
    write('task-a', FILE, SAME_WORK_A, ago(10))
    write('task-b', FILE, SAME_WORK_B, ago(9))
    const result = publishHubVerdict(paths(), computeHubVerdict(paths(), clock), { publish: false })

    assert.equal(result.published, false)
    assert.equal(result.reason, 'suppressed')
    assert.equal(readAllEvents(paths()).events.filter((event) => event.hostEvent === HUB_PUBLISH_HOST_EVENT).length, 0)
    assert.ok(readHubVerdict(paths()), 'a reader must still see the current conclusion')
  })
})

/* -------------------------------------------------------------------------- */
/* Ownership stability, the starvation proxy                                   */
/* -------------------------------------------------------------------------- */

describe('ownership stability is reported, not hidden', () => {
  test('a recommendation that has stood for a while says so', () => {
    write('task-a', FILE, SAME_WORK_A, ago(30))
    write('task-b', FILE, SAME_WORK_B, ago(29))

    const early = new Date(clock.getTime() - 10 * 60_000)
    publishHubVerdict(paths(), computeHubVerdict(paths(), early))

    const later = computeHubVerdict(paths(), clock)
    const ruling = later.rulings[0]
    assert.equal(ruling.owner.taskId, 'task-a')
    assert.ok(
      ruling.owner.heldMinutes >= 9 && ruling.owner.heldMinutes <= 11,
      `expected about 10 minutes of stability, got ${ruling.owner.heldMinutes}`,
    )
    assert.ok(later.metrics.longestOwnershipMinutes >= 9)
    assert.equal(later.metrics.waitingTasks, 1, 'the task waiting on the owner is counted')

    // Restated next to the rulings, because a hub that ever became binding would be judged
    // on this number and it must not be readable apart from effective parallelism.
    assert.equal(later.metrics.parallelismMean, later.parallelism.mean)
  })

  test('the ruling reports how far behind the newest fact it is', () => {
    // A ruling is never fresher than the last thing that happened, and it is only recomputed on a
    // poll. Reporting the lag is what stops "the hub was quiet" from reading as "the hub was
    // watching": a stale ruling and a correct one look identical from outside.
    write('task-a', FILE, SAME_WORK_A, ago(10))
    write('task-b', FILE, SAME_WORK_B, ago(5))

    const verdict = computeHubVerdict(paths(), clock)
    assert.ok(
      verdict.metrics.inputLagMinutes >= 4.9 && verdict.metrics.inputLagMinutes <= 5.1,
      `expected about 5 minutes of lag, got ${verdict.metrics.inputLagMinutes}`,
    )
  })

  test('a published ruling is not counted as a fact, so the lag cannot read as zero', () => {
    // Hub events are excluded from the lag. Counting them would make a workspace where nothing had
    // happened for an hour report a lag of zero, because the hub's own last publish would be the
    // newest line in the ledger.
    write('task-a', FILE, SAME_WORK_A, ago(10))
    write('task-b', FILE, SAME_WORK_B, ago(30))
    publishHubVerdict(paths(), computeHubVerdict(paths(), clock))

    const verdict = computeHubVerdict(paths(), clock)
    assert.ok(
      verdict.metrics.inputLagMinutes >= 9.9,
      `the hub's own published ruling must not pass for workplace activity, got ${verdict.metrics.inputLagMinutes}`,
    )
  })

  test('the lag is recorded on the published event, so its average over a window is computable', () => {
    // A snapshot of the current lag says nothing about whether the spine was keeping up an hour
    // ago, and that is the only version of the number anything can be compared against.
    write('task-a', FILE, SAME_WORK_A, ago(10))
    write('task-b', FILE, SAME_WORK_B, ago(5))
    publishHubVerdict(paths(), computeHubVerdict(paths(), clock))

    const event = readAllEvents(paths()).events.find((e) => e.hostEvent === HUB_PUBLISH_HOST_EVENT)!
    assert.ok(typeof event.detail?.inputLagMinutes === 'number')
    assert.ok((event.detail?.inputLagMinutes as number) >= 4.9)
  })

  test('the published count includes the ruling it describes, in the projection a reader sees', () => {
    // The count is derived from the ledger at compute time, which is necessarily *before* the
    // ruling being computed is appended. Left uncorrected, the first projection would say
    // "0 ruling(s) published" while holding the first ruling.
    write('task-a', FILE, SAME_WORK_A, ago(10))
    write('task-b', FILE, SAME_WORK_B, ago(5))
    const first = computeHubVerdict(paths(), clock)
    assert.equal(first.metrics.published, 0, 'nothing had been published when this was computed')
    publishHubVerdict(paths(), first)

    assert.equal(readHubVerdict(paths())?.metrics.published, 1)

    // And it keeps counting, so the figure is a total rather than a constant.
    acquireLease(paths(), {
      entityKey: `file::${FILE}`,
      taskId: 'task-b',
      sessionId: 'task-b',
      reason: 'taking over',
      minutes: 20,
    }, clock)
    const second = computeHubVerdict(paths(), clock)
    assert.equal(second.metrics.published, 1, 'the count read at compute time sees the earlier publish')
    publishHubVerdict(paths(), second)
    assert.equal(readHubVerdict(paths())?.metrics.published, 2)
    assert.equal(lastPublishedRuling(readAllEvents(paths()).events)?.published, 2)
  })
})

/* -------------------------------------------------------------------------- */
/* The projection and the seen marker                                          */
/* -------------------------------------------------------------------------- */

describe('the projection is a cache, and reads safely', () => {
  test('round-trips the ruling and the exact injected text', () => {
    write('task-a', FILE, SAME_WORK_A, ago(10))
    write('task-b', FILE, SAME_WORK_B, ago(9))
    const verdict = computeHubVerdict(paths(), clock)
    publishHubVerdict(paths(), verdict)

    const read = readHubVerdict(paths())
    assert.ok(read)
    assert.equal(read.id, verdict.id)
    assert.equal(read.advisory, verdict.advisory)
    assert.deepEqual(read.targets, [FILE], 'the hook needs the paths to match a tool call against')
  })

  test('is absent rather than throwing when nothing has been published', () => {
    assert.equal(readHubVerdict(paths()), null)
  })

  test('a torn projection reads as absent, not as a broken ruling', () => {
    writeFileSync(join(paths().state, 'hub.json'), '{"id":"hub-x","rulings":[', 'utf8')
    assert.equal(readHubVerdict(paths()), null)
  })

  test('the injected text is the same for every window and names what to do', () => {
    write('task-a', FILE, UNDECIDABLE_A, ago(10))
    write('task-b', FILE, UNDECIDABLE_B, ago(9))
    const verdict = computeHubVerdict(paths(), clock)

    assert.match(verdict.advisory, /one ruling per contention/)
    assert.match(verdict.advisory, new RegExp(FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(verdict.advisory, /AMBIGUOUS/)
    assert.match(verdict.advisory, /agentgit_hub_resolve/)
    assert.equal(
      verdict.advisory.includes('task-b:'),
      false,
      'the text must not be written for one particular session',
    )
  })

  test('the advisory stays inside its cap, because it is injected into a loaded context', () => {
    for (let index = 0; index < 20; index += 1) {
      write('task-a', `src/file-${index}.ts`, UNDECIDABLE_A, ago(40 - index))
      write('task-b', `src/file-${index}.ts`, UNDECIDABLE_B, ago(39 - index))
    }
    const verdict = computeHubVerdict(paths(), clock)
    assert.equal(verdict.advisory.length <= 1200, true, `advisory was ${verdict.advisory.length} chars`)
    assert.equal(verdict.rulings.length <= 12, true)
    assert.equal(verdict.metrics.rulings, verdict.rulings.length)
  })
})

describe('the seen marker records what a window has already been shown', () => {
  test('is absent until something is shown, and then reports the ruling id', () => {
    assert.equal(readHubMarker(paths(), 'task-a'), null)
    writeHubMarker(paths(), 'task-a', { rulingId: 'hub-1', at: clock.toISOString(), event: 'SessionStart' })

    const marker = readHubMarker(paths(), 'task-a')
    assert.ok(marker)
    assert.equal(marker.rulingId, 'hub-1')
    assert.equal(marker.event, 'SessionStart')
  })

  test('counts how many windows have seen a given ruling, and keeps them apart', () => {
    writeHubMarker(paths(), 'task-a', { rulingId: 'hub-1', at: clock.toISOString(), event: 'SessionStart' })
    writeHubMarker(paths(), 'task-b', { rulingId: 'hub-1', at: clock.toISOString(), event: 'PreToolUse' })

    assert.equal(hubSeenCount(paths(), 'hub-1'), 2)
    assert.equal(hubSeenCount(paths(), 'hub-2'), 0)
    assert.equal(hubSeenCount(paths()), 2, 'with no ruling named, every seen window counts')
  })

  test('two session ids that sanitise to the same name still get two markers', () => {
    // Session ids are host-supplied and can contain path separators and colons. Collapsing
    // them would make one window's marker answer for another, which is exactly the identity
    // bug this hub cannot afford.
    assert.notEqual(seenMarkerName('a/b:c'), seenMarkerName('a-b-c'))
    writeHubMarker(paths(), 'a/b:c', { rulingId: 'hub-1', at: clock.toISOString(), event: 'PreToolUse' })
    writeHubMarker(paths(), 'a-b-c', { rulingId: 'hub-2', at: clock.toISOString(), event: 'PreToolUse' })

    assert.equal(readHubMarker(paths(), 'a/b:c')?.rulingId, 'hub-1')
    assert.equal(readHubMarker(paths(), 'a-b-c')?.rulingId, 'hub-2')
  })
})

/* -------------------------------------------------------------------------- */
/* Reserved ground, which is the case that precedes contention                 */
/* -------------------------------------------------------------------------- */

describe('a reservation is a conclusion, and it arrives before the collision does', () => {
  test('one task holding one file is reported and published, without waiting for a second writer', () => {
    // A ruling can only exist once two tasks touched the same ground. A lease exists from the
    // moment one task says it is working there — which is when a second window needs to know, and
    // is exactly the window at which "rule on the collision afterwards" is too late.
    write('task-a', FILE, SAME_WORK_A, ago(5))
    acquireLease(paths(), {
      entityKey: `file::${FILE}`,
      taskId: 'task-a',
      sessionId: 'task-a',
      reason: 'adding the rate limiter',
      minutes: 20,
    }, clock)

    const verdict = computeHubVerdict(paths(), clock)
    assert.deepEqual(verdict.rulings, [], 'one writer is not a contention')
    assert.equal(verdict.holders.length, 1)
    assert.equal(verdict.holders[0].taskId, 'task-a')
    assert.equal(verdict.holders[0].path, FILE)
    assert.match(verdict.holders[0].reason, /rate limiter/)
    assert.deepEqual(verdict.targets, [FILE], 'a pending write must be matchable against this')
    assert.match(verdict.advisory, /Reserved ground/)
    assert.match(verdict.advisory, /held by task-a/)

    const result = publishHubVerdict(paths(), verdict)
    assert.equal(result.published, true, 'a reservation is a conclusion, and it has to outlive the process')
    assert.equal(readAllEvents(paths()).events.filter((e) => e.hostEvent === HUB_PUBLISH_HOST_EVENT).length, 1)
  })

  test('renewing a lease is not news, so it does not republish', () => {
    write('task-a', FILE, SAME_WORK_A, ago(5))
    const lease = { entityKey: `file::${FILE}`, taskId: 'task-a', sessionId: 'task-a', reason: 'working', minutes: 20 }
    acquireLease(paths(), lease, clock)
    const first = computeHubVerdict(paths(), clock)
    publishHubVerdict(paths(), first)

    // A renewal moves only the expiry, which is deliberately outside the ruling id.
    acquireLease(paths(), lease, new Date(clock.getTime() + 1000))
    const again = computeHubVerdict(paths(), new Date(clock.getTime() + 1000))

    assert.equal(again.id, first.id, 'a renewed lease is the same reservation')
    assert.equal(publishHubVerdict(paths(), again).reason, 'unchanged')
  })

  test('releasing the last reservation is published, because "this ground is free" is worth saying', () => {
    write('task-a', FILE, SAME_WORK_A, ago(5))
    acquireLease(paths(), {
      entityKey: `file::${FILE}`,
      taskId: 'task-a',
      sessionId: 'task-a',
      reason: 'working',
      minutes: 20,
    }, clock)
    publishHubVerdict(paths(), computeHubVerdict(paths(), clock))

    releaseLease(paths(), 'task-a')
    const cleared = computeHubVerdict(paths(), clock)
    const result = publishHubVerdict(paths(), cleared)

    assert.equal(cleared.rulings.length, 0)
    assert.equal(cleared.holders.length, 0)
    assert.equal(result.published, true, 'a clearing is a conclusion; only permanent silence is not')
    assert.equal(result.reason, 'changed')
  })

  test('a freshly claimed workspace still produces no ledger noise', () => {
    // The other half of the rule above: nothing to say and nothing said before is silence, not a
    // conclusion. Otherwise every restart in a quiet workspace would add an event saying nothing.
    const verdict = computeHubVerdict(paths(), clock)
    assert.equal(publishHubVerdict(paths(), verdict).reason, 'nothing-to-rule-on')
    assert.equal(readAllEvents(paths()).events.filter((e) => e.hostEvent === HUB_PUBLISH_HOST_EVENT).length, 0)
  })

  test('the published event names the reservation, so the decision can be audited later', () => {
    write('task-a', FILE, SAME_WORK_A, ago(5))
    acquireLease(paths(), {
      entityKey: `file::${FILE}`,
      taskId: 'task-a',
      sessionId: 'task-a',
      reason: 'working',
      minutes: 20,
    }, clock)
    publishHubVerdict(paths(), computeHubVerdict(paths(), clock))

    const event = readAllEvents(paths()).events.find((e) => e.hostEvent === HUB_PUBLISH_HOST_EVENT)!
    assert.equal(event.detail?.holderCount, 1)
    assert.deepEqual(event.detail?.ownership, { [`file::${FILE}`]: 'task-a' })
    assert.match(String(event.reason), /held by task-a/)
  })
})

/* -------------------------------------------------------------------------- */
/* The id itself                                                               */
/* -------------------------------------------------------------------------- */

describe('the ruling id', () => {
  test('is a pure function of the rulings, the holders, the branches and the moved interfaces', () => {
    const base = { rulings: [], holders: [], integration: [], stale: [] }
    assert.equal(hubVerdictId(base), hubVerdictId(base))
    assert.notEqual(
      hubVerdictId(base),
      hubVerdictId({
        ...base,
        integration: [{ taskId: 'task-a', branch: 'agentgit/task-a', reason: 'first', blocking: false }],
      }),
    )
  })

  test('the published event carries the ruling it published, so it can be audited later', () => {
    write('task-a', FILE, SAME_WORK_A, ago(10))
    write('task-b', FILE, SAME_WORK_B, ago(9))
    const verdict = computeHubVerdict(paths(), clock)
    publishHubVerdict(paths(), verdict)

    const event = readAllEvents(paths()).events.find((candidate) => candidate.hostEvent === HUB_PUBLISH_HOST_EVENT)!
    assert.equal(event.detail?.rulingId, verdict.id)
    assert.equal(event.detail?.authority, 'advisory', 'the authority actually in force is recorded, not implied')
    assert.deepEqual(event.detail?.ownership, { [`file::${FILE}`]: 'task-a' })
    assert.equal(String(event.reason).includes('task-a'), true)
  })

  test('the published event is a normal ledger line the Python analyser can read', () => {
    write('task-a', FILE, SAME_WORK_A, ago(10))
    write('task-b', FILE, SAME_WORK_B, ago(9))
    publishHubVerdict(paths(), computeHubVerdict(paths(), clock))

    const shard = readAllEvents(paths()).files[0]
    const wire = JSON.parse(readFileSync(shard, 'utf8').trim().split('\n').pop()!) as Record<string, unknown>
    assert.equal(wire.schema_version, 'coord-ledger-0.1')
    assert.equal(wire.kind, 'advisory_injected')
    assert.equal(wire.task_id, null)
    assert.equal(String(wire.session_id).startsWith('hub:'), true)
  })
})

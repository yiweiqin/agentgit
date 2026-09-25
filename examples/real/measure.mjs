/**
 * Two numbers the experiment write-up was missing, measured where they can be.
 *
 * Why this is a separate script from cases.mjs
 * --------------------------------------------
 * `cases.mjs` reports what the pool contains: how many pairs, how close together, how
 * many are readable. This reports what the *product* does when it meets them — a
 * precision/recall score for experiment 1, and an advisory rate for experiment 3. Those
 * need the detector (`evaluatePack` / `decideWrite`) rather than the scanner, and keeping
 * them apart means a change to how cases are ranked cannot silently move a published
 * accuracy number.
 *
 * The ground truth is built from bytes, not from the intent text
 * --------------------------------------------------------------
 * This is the part that decides whether the score means anything.
 *
 * Experiment 1 asks whether the detector can tell duplicate work from two agents editing
 * one file for different reasons. The detector's only input is the two sessions' own
 * words. If the truth labels were also derived from those words — "similar intents are
 * duplicates" — the score would be the detector graded against its own output, and it
 * would come out near 1.0 while measuring nothing. {@link labelPair} therefore decides
 * the truth from the **patch bodies**: two sessions that write largely the same added
 * lines are duplicates no matter how they described it, and two that write disjoint
 * lines are independent even if they sound alike. The intent text is used solely as the
 * detector's input, never as the answer key.
 *
 * What this cannot measure, and says so
 * -------------------------------------
 * The pack can only label pairs where both patch bodies are readable and the two sides
 * are mechanically decidable. Everything else is excluded and counted, because an
 * excluded pair and a scored pair are not the same and merging them would quietly turn
 * "cannot tell" into "not a duplicate".
 *
 * @module examples/real/measure
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PRODUCT_POLICY,
  RAISED,
  buildCapsules,
  buildEvent,
  decideWrite,
  entityKey,
  entityTouches,
  evaluatePack,
  intentSimilarity,
  parsePack,
  TASKPACK_SCHEMA_VERSION,
} from '@agentgit/core'

import { CODE_EXTENSIONS, intentAt, scan } from './cases.mjs'

/** Added lines must overlap this much before two sessions are called the same job. */
export const DUPLICATE_OVERLAP = 0.5

/** A shared instruction shorter than this is a "continue", not the same task stated twice. */
const SUBSTANTIVE_INSTRUCTION = 40

const norm = (value) => value.replace(/\\/g, '/').toLowerCase()

const linesOf = (call, path) =>
  new Set(
    call.ops
      .filter((entry) => entry.relative === path)
      .flatMap((entry) => entry.op.hunks.flatMap((hunk) => hunk.added.map((line) => line.trim())))
      .filter((line) => line.length > 0),
  )

const identifiersOf = (call, path) =>
  new Set(
    call.ops
      .filter((entry) => entry.relative === path)
      .flatMap((entry) => entry.op.addedIdentifiers)
      .map((token) => token.toLowerCase()),
  )

const signaturesRemovedBy = (call, path) =>
  call.ops.filter((entry) => entry.relative === path).flatMap((entry) => entry.op.removedSignatures)

const overlapRatio = (left, right) => {
  const smaller = Math.min(left.size, right.size)
  if (smaller === 0) return null
  let shared = 0
  for (const line of left) if (right.has(line)) shared += 1
  return shared / smaller
}

/**
 * Decide one pair's truth.
 *
 * Two kinds of outside evidence, and the difference between them is stated rather than
 * hidden, because only one of them is independent of the detector:
 *
 * - **content** — the two patch bodies share their added lines, or share none at all. The
 *   detector never reads the patch bodies, so a score against this truth is a real test.
 * - **instruction** — the user said the same thing twice: the two sessions' instructions in
 *   force at their writes are the same substantial string. This is a fact about the
 *   transcript rather than a similarity judgement, but the detector reads that same text,
 *   so catching it is expected. It is reported as a sensitivity check and never as
 *   independent evidence.
 *
 * Returns null when neither settles it. A null is excluded and counted; scoring it as a
 * false negative would understate recall while looking rigorous.
 */
export function labelPair(left, right) {
  const linesLeft = linesOf(left.call, left.path)
  const linesRight = linesOf(right.call, right.path)
  const overlap = overlapRatio(linesLeft, linesRight)
  const bothThin = linesLeft.size === 0 || linesRight.size === 0

  const leftIntent = left.intent ?? ''
  const rightIntent = right.intent ?? ''
  const sameInstruction =
    leftIntent.length >= SUBSTANTIVE_INSTRUCTION && leftIntent === rightIntent

  if (overlap !== null && overlap >= DUPLICATE_OVERLAP) {
    return {
      truth: 'collision',
      truthKind: 'true-collision',
      evidence: 'content',
      why: `${Math.round(overlap * 100)}% of the smaller side's added lines appear on both sides`,
    }
  }

  if (sameInstruction) {
    return {
      truth: 'collision',
      truthKind: 'true-collision',
      evidence: 'instruction',
      why: `both sessions were working under the same instruction, ${leftIntent.length} characters long`,
    }
  }

  if (overlap === 0 || bothThin) {
    return {
      truth: 'independent',
      truthKind: 'independent-control',
      evidence: 'content',
      why: bothThin
        ? 'one side adds no lines, so the two cannot be doing the same work'
        : 'no added line is shared between the two sides',
    }
  }

  return null
}

/**
 * Build a scoreable pack out of the concurrent pairs the scan already found.
 *
 * The proposer is always the *second* writer, because that is the moment a preflight
 * would run. The first writer becomes a prior event, so the pack reproduces the ledger
 * as it actually stood rather than as it looks in hindsight.
 */
export function buildRealPack(described, candidates, options = {}) {
  const byId = new Map(described.map((session) => [session.sessionId, session]))
  const proposals = []
  const priorEvents = []
  const excluded = []
  /** Which outside signal produced each label, so the report can separate the strata. */
  const labels = []

  for (const candidate of candidates) {
    const left = byId.get(candidate.a.sessionId)
    const right = byId.get(candidate.b.sessionId)
    if (!left || !right) {
      excluded.push({ id: candidate.id, why: 'a session left the pool between the scan and the pack' })
      continue
    }
    const callA = left.patchCalls.filter((call) => call.ops.some((op) => op.relative === candidate.path)).at(-1)
    const callB = right.patchCalls.filter((call) => call.ops.some((op) => op.relative === candidate.path))[0]
    if (!callA || !callB) {
      excluded.push({ id: candidate.id, why: 'one side has no patch call on the shared path' })
      continue
    }

    const label = labelPair(
      { call: callA, path: candidate.path, sessionId: candidate.a.sessionId, intent: intentAt(left, callA.at) },
      { call: callB, path: candidate.path, sessionId: candidate.b.sessionId, intent: intentAt(right, callB.at) },
    )
    if (!label) {
      excluded.push({ id: candidate.id, why: 'the two patch bodies do not settle whether it is a duplicate' })
      continue
    }

    const proposalId = `p-${proposals.length + 1}-${candidate.id}`
    proposals.push({
      id: proposalId,
      sessionId: candidate.b.sessionId,
      taskId: candidate.b.sessionId,
      entityPath: candidate.path,
      intentText: intentAt(right, callB.at) || null,
      truth: label.truth,
      truthKind: label.truthKind,
      why: label.why,
    })
    labels.push({ id: proposalId, evidence: label.evidence, truth: label.truth })

    // Every write the other session made to this path before the proposal, as the ledger
    // would hold it. Only the first writer's touches matter for this pair, and replaying
    // more than it needs would let an unrelated session create the overlap the truth
    // label is supposed to be about.
    const writeAt = callA.at
    priorEvents.push({
      minute: 0,
      kind: 'file_write',
      sessionId: candidate.a.sessionId,
      taskId: candidate.a.sessionId,
      entityPath: candidate.path,
      intentText: intentAt(left, writeAt) || null,
    })
  }

  return {
    pack: {
      pack: options.name ?? 'real-pool-concurrent-pairs',
      schemaVersion: TASKPACK_SCHEMA_VERSION,
      description:
        'Concurrent cross-session same-file pairs from this machine, labelled from the patch ' +
        'bodies rather than from the intent text the detector reads.',
      priorEvents,
      proposals,
    },
    excluded,
    labels,
  }
}

/**
 * Score the pack.
 *
 * Every prior event is stamped at minute 0 of the shared base, so the pack has no internal
 * ordering: `evaluatePack` judges each proposal against the ledger as it stood before any
 * proposal, which is what stops the score from depending on pack order.
 */
function scorePack(pack, label) {
  return evaluatePack(parsePack(pack), PRODUCT_POLICY, { label })
}

/* -------------------------------------------------------------------------- */
/* Experiment 3: how often it speaks, and whether it ever refuses              */
/* -------------------------------------------------------------------------- */

/**
 * Every event the pool implies, as the ledger would hold it after adoption.
 *
 * Returns the workspace each event belongs to alongside the event, because entities are
 * workspace-relative and a replay that forgets which workspace it is in merges unrelated
 * ledgers that happen to use the same relative path.
 */
export function poolEvents(described) {
  const events = []
  const workspaceOf = new Map()
  for (const session of described) {
    if (!session.cwd) continue
    workspaceOf.set(session.sessionId, norm(session.cwd))
    for (const message of session.messages) {
      events.push(
        buildEvent({
          kind: 'task_registered',
          timestampUtc: new Date(message.at).toISOString(),
          sessionId: session.sessionId,
          taskId: session.sessionId,
          intentText: message.text.slice(0, 600),
          hostEvent: 'codex/rollout',
        }),
      )
    }
    for (const change of session.changes) {
      const entity = { kind: 'file', identifier: change.path, path: change.path }
      events.push(
        buildEvent({
          kind: 'file_write',
          timestampUtc: new Date(change.at).toISOString(),
          sessionId: session.sessionId,
          taskId: session.sessionId,
          entities: [entity],
          hostEvent: 'codex/rollout',
        }),
      )
    }
  }
  return { events, workspaceOf }
}

/**
 * Count advisories over the pool, replaying each path's touches in time order.
 *
 * The partitioning is exact rather than an approximation: a decision for a write on path
 * `p` reads only the contention record for `entityKey(p)`, and that record is built from
 * events that name an entity under `p`. Splitting the stream by path therefore yields the
 * same decisions as replaying it whole, without rebuilding every capsule once per write.
 */
export function advisoryCount(described, config = PRODUCT_POLICY) {
  const { events, workspaceOf } = poolEvents(described)
  /*
   * Partitioned by workspace *and* path, not by path alone.
   *
   * Entities are workspace-relative, and each workspace has its own ledger, so `readme.md`
   * in one repository and `readme.md` in another are unrelated entities that happen to
   * share a string. Keying on the path alone would put them in one partition and let a
   * write in one repository raise an advisory about the other — a false positive produced
   * entirely by the measurement rather than by the product.
   */
  const keyOf = (event, path) => `${workspaceOf.get(event.sessionId) ?? '?'}\u0000${norm(path)}`
  const byPath = new Map()

  for (const event of events) {
    for (const key of new Set((event.entities ?? []).map((entity) => keyOf(event, entity.path)))) {
      if (!byPath.has(key)) byPath.set(key, [])
      byPath.get(key).push(event)
    }
  }
  // A session's intent restatements belong to every path that session touched, because
  // the capsule they land in is the one the touch lands in.
  for (const [key, list] of byPath) {
    const workspace = key.split('\u0000')[0]
    const sessions = new Set(list.map((event) => event.sessionId))
    for (const event of events) {
      if ((event.entities ?? []).length === 0 && sessions.has(event.sessionId) &&
        (workspaceOf.get(event.sessionId) ?? '?') === workspace) {
        list.push(event)
      }
    }
    byPath.set(
      key,
      [...new Set(list)].sort((left, right) => Date.parse(left.timestampUtc) - Date.parse(right.timestampUtc)),
    )
  }

  let writes = 0
  let advisories = 0
  let refusals = 0
  const byBasis = new Map()
  const byKind = new Map()
  const byWorkspace = new Map()

  for (const [key, list] of byPath) {
    const workspace = key.split('\u0000')[0]
    const bare = workspace.split('/').filter(Boolean).pop() ?? workspace
    const entry = byWorkspace.get(bare) ?? { writes: 0, advisories: 0 }
    byWorkspace.set(bare, entry)
    const seen = []
    for (const event of list) {
      if (event.kind !== 'file_write') {
        seen.push(event)
        continue
      }
      writes += 1
      entry.writes += 1
      const contention = entityTouches(buildCapsules(seen))
      const entity = (event.entities ?? [])[0]
      const decision = decideWrite(
        {
          entityKey: entityKey(entity),
          entityPath: entity.path,
          sessionId: event.sessionId,
          taskId: event.taskId ?? undefined,
          intentText: lastIntent(seen, event.sessionId),
        },
        contention,
        config,
      )
      if (RAISED.includes(decision.detection)) {
        advisories += 1
        entry.advisories += 1
        byBasis.set(decision.detection, (byBasis.get(decision.detection) ?? 0) + 1)
        const kind = String(event.detail?.changeKind ?? 'unknown')
        byKind.set(kind, (byKind.get(kind) ?? 0) + 1)
      }
      if (decision.action === 'deny' || decision.action === 'ask') refusals += 1
      seen.push(event)
    }
  }

  // Denominator: the wall-clock time the sessions were actually running. Summed from each
  // session's own span, not from the span of the pool, so a quiet fortnight between two
  // sessions does not dilute the rate into meaninglessness.
  let sessionMs = 0
  let timedSessions = 0
  for (const session of described) {
    if (session.changes.length === 0) continue
    if (!Number.isFinite(session.startedAt) || !Number.isFinite(session.updatedAt)) continue
    if (session.updatedAt <= session.startedAt) continue
    sessionMs += session.updatedAt - session.startedAt
    timedSessions += 1
  }
  const sessionHours = sessionMs / 3_600_000

  return {
    writes,
    advisories,
    refusals,
    sessionHours,
    timedSessions,
    advisoryPerSessionHour: sessionHours === 0 ? null : advisories / sessionHours,
    hoursPerAdvisory: advisories === 0 ? null : sessionHours / advisories,
    byBasis: Object.fromEntries([...byBasis].sort()),
    byKind: Object.fromEntries([...byKind].sort()),
    byWorkspace: Object.fromEntries([...byWorkspace].sort()),
    config: { action: config.action, minOtherTasks: config.minOtherTasks, requireDifferentSession: config.requireDifferentSession },
  }
}

function lastIntent(seen, sessionId) {
  let found = null
  for (const event of seen) {
    if (event.sessionId === sessionId && event.intentText) found = event.intentText
  }
  return found
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                    */
/* -------------------------------------------------------------------------- */

export function measure(options = {}) {
  const result = scan(options.scan ?? {})
  const usable = result.candidates.filter(
    (candidate) => candidate.isRepo && CODE_EXTENSIONS.has(candidate.extension),
  )
  const { pack, excluded, labels } = buildRealPack(result.describedSessions, result.candidates)
  const metrics = pack.proposals.length > 0 ? scorePack(pack, 'real-pool') : null
  const advisories = advisoryCount(result.describedSessions)
  return { result, usable, pack, excluded, labels, metrics, advisories }
}

function humanReport(measured) {
  const lines = []
  const say = (line = '') => lines.push(String(line))
  const { pack, metrics, excluded, advisories, labels } = measured
  const byEvidence = (kind) => labels.filter((entry) => entry.evidence === kind)

  say('Experiment 1 · Detection Fidelity — scored against truth built outside the detector')
  say('-------------------------------------------------------------------------')
  say(`  candidate pairs the scan found            ${measured.result.candidates.length}`)
  say(`  in a real git repo and source code        ${measured.usable.length}`)
  say(`  pairs the patch bodies can label          ${pack.proposals.length}`)
  say(`  pairs they cannot label, excluded         ${excluded.length}`)
  say('')
  for (const entry of excluded.slice(0, 6)) say(`    - ${entry.id}: ${entry.why}`)
  if (excluded.length > 6) say(`    - ... and ${excluded.length - 6} more`)

  if (!metrics) {
    say('')
    say('  No pair could be labelled, so no precision or recall is reported. That is the')
    say('  honest answer and it is not the same as a detector that scores zero.')
    return `${lines.join('\n')}\n`
  }

  const contentCollisions = byEvidence('content').filter((entry) => entry.truth === 'collision').length
  const instructionCollisions = byEvidence('instruction').length
  const controls = labels.filter((entry) => entry.truth === 'independent').length

  say('')
  say(`  collisions, labelled by the patch bytes   ${contentCollisions}   (independent of the detector)`)
  say(`  collisions, labelled by the instruction   ${instructionCollisions}   (same text the detector reads)`)
  say(`  independent controls                      ${controls}`)
  say('')
  say(`  collisions (truth)                        ${metrics.tp + metrics.fn}`)
  say(`  independent controls (truth)              ${metrics.fp + metrics.tn}`)
  say('')
  say(`  precision                                 ${metrics.precision.toFixed(3)}  (${metrics.tp}/${metrics.tp + metrics.fp})`)
  say(`  recall                                    ${metrics.recall.toFixed(3)}  (${metrics.tp}/${metrics.tp + metrics.fn})`)
  say(`  recall within ceiling                     ${metrics.recallWithinCeiling.toFixed(3)}`)
  say(`  entity-visible ceiling                    ${metrics.entityVisibleCeiling.toFixed(3)}`)
  say(`  false rejection rate                      ${metrics.falseRejectionRate.toFixed(3)}`)
  say(`  control flag rate                         ${metrics.controlFlagRate.toFixed(3)}`)
  say('')
  say('  per proposal')
  for (const outcome of metrics.outcomes) {
    const evidence = labels.find((entry) => entry.id === outcome.id)?.evidence ?? '?'
    say(`    ${outcome.truthKind.padEnd(20)} by=${evidence.padEnd(11)} detected=${outcome.detected ? 'yes' : 'no '} ` +
      `basis=${outcome.detection.padEnd(22)} sim=${outcome.similarity === null ? 'n/a' : outcome.similarity.toFixed(2)}`)
    say(`      ${outcome.why}`)
  }

  /*
   * The reading that matters, and it is the unflattering one.
   *
   * `controlFlagRate` at 1.0 does not mean the detector is broken. It means the product as
   * configured raises *every* cross-session same-file pair, whatever the purpose. That is
   * by construction: `treatCrossSessionAsContention` is on and `minOtherTasks` is 1, and
   * since a session's task id is its session id, another session is always another task.
   * So `cross-task-conflict` fires every time and `duplicate-intent` only ever adds colour.
   *
   * The product's claim therefore survives this measurement only in the weak form: it never
   * refuses (false rejection 0), and the statement it makes is always true (someone else
   * really is on that entity). It is not, on this evidence, a duplicate detector.
   */
  if (metrics.controlFlagRate === 1 && metrics.fp + metrics.tn > 0) {
    say('')
    say(`  Reading: all ${metrics.fp + metrics.tn} independent controls were raised, with a ` +
      `${metrics.falseRejectionRate.toFixed(3)} refusal rate.`)
    say('  The product is an overlap detector on this evidence: it flags every cross-session')
    say('  same-file pair and defers every one of them. That is weaker than "it finds duplicate')
    say('  work", and it is what the numbers say. Nothing was lost — no write was refused.')
  }
  if (metrics.tp + metrics.fn < 5) {
    say('')
    say(`  Caveat: ${metrics.tp + metrics.fn} labelled collision(s) is too few for a rate. Read the`)
    say('  counts, not the ratio; a 1.000 or 0.000 here is a count in disguise.')
  }
  if (metrics.tp + metrics.fn > 0 && contentCollisions === 0) {
    say('')
    say(`  Caveat: every labelled collision came from the instruction, which is the text the`)
    say('  detector reads. Recall here is a sensitivity check — "does it catch a duplicate the')
    say('  user plainly stated twice" — not independent evidence of accuracy. The pool contains')
    say(`  no pair whose duplication is established by the bytes alone.`)
  }

  say('')
  say('Experiment 3 · Alert Economy — how often it speaks, and whether it ever refuses')
  say('----------------------------------------------------------------')
  say(`  writes replayed                           ${advisories.writes}`)
  say(`  advisories                                ${advisories.advisories}`)
  say(`  refusals                                  ${advisories.refusals}`)
  say(`  sessions with a positive span             ${advisories.timedSessions}`)
  say(`  session-hours                             ${advisories.sessionHours.toFixed(1)}`)
  say(
    `  advisories per session-hour               ${advisories.advisoryPerSessionHour === null ? 'n/a' : advisories.advisoryPerSessionHour.toFixed(3)}`,
  )
  say(
    `  session-hours per advisory                ${advisories.hoursPerAdvisory === null ? 'none to divide' : advisories.hoursPerAdvisory.toFixed(2) + ' hours'}`,
  )
  say('')
  say(`  by detection basis                        ${JSON.stringify(advisories.byBasis)}`)
  say('  by workspace')
  for (const [name, entry] of Object.entries(advisories.byWorkspace)) {
    const share = advisories.advisories === 0 ? 0 : entry.advisories / advisories.advisories
    say(`    ${name.padEnd(24)} ${String(entry.advisories).padStart(5)} of ${String(entry.writes).padStart(5)} writes  ${(share * 100).toFixed(0)}% of advisories`)
  }
  say('')
  say('  0 refusals is enforced rather than observed: PRODUCT_POLICY.action is none, so a')
  say('  non-zero count would be a wiring bug. This verifies the wire, it does not measure a')
  say('  property of the policy.')
  return `${lines.join('\n')}\n`
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (invokedDirectly) {
  const argv = process.argv.slice(2)
  const value = (name, fallback) => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
  }
  const started = Date.now()
  process.stderr.write('scanning transcripts...\n')
  const measured = measure({ scan: { workspaces: value('workspaces', '').split(',').filter(Boolean) } })
  process.stderr.write(`measured in ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
  process.stdout.write(humanReport(measured))

  const jsonAt = argv.indexOf('--json')
  if (jsonAt >= 0 && argv[jsonAt + 1]) {
    const target = argv[jsonAt + 1]
    mkdirSync(dirname(target), { recursive: true })
    const { describedSessions, ...rest } = measured
    void describedSessions
    const serializable = {
      ...rest,
      // The pack itself is not written: it quotes real intents and real paths, and a file
      // on disk is how that leaves the machine unnoticed.
      pack: { proposals: measured.pack.proposals.length, excluded: measured.excluded },
      intentSimilarity,
    }
    writeFileSync(target, `${JSON.stringify(serializable, null, 2)}\n`, 'utf8')
  }
}

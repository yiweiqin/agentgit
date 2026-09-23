#!/usr/bin/env node
/**
 * The A/B run: the same scenario under two arms, and what the difference actually is.
 *
 * What this measures, and what it refuses to
 * -----------------------------------------
 * A harness whose scripted agents always obey the verdict would report a perfect result by
 * construction — "we told it to stop and it stopped" is not evidence about anything. So
 * compliance is an explicit *parameter*, and the run reports a sensitivity curve rather
 * than a single number: the interesting row is not the one where every agent obeys, it is
 * the one where they ignore the advice, because that is what the cost of being wrong looks
 * like. The obedience pattern is seeded from the round and the compliance level only, never
 * from the arm, so the arms are compared on the *same* pattern — a paired design, because
 * an unpaired one would confound the arm with which rounds happened to be obeyed.
 *
 * It measures one thing: whether the second agent was told, and what a given obedience
 * rate would then do to the two outcomes that matter.
 *
 * - **duplicates closed** (lower is better): rounds where two agents did the same work on
 *   one entity, and the second was stopped or not. This is the product's stated target.
 * - **independent work let through** (higher is better): rounds where the two agents share
 *   an entity for genuinely different reasons. A tool that stops these is over-flagging, and
 *   the win on the first number must be read against this one. A drop here is a *cost*.
 * - **untouched ground** (must not move): rounds where the second agent works on an entity
 *   the first never touched. Nothing may interfere, under any arm or any obedience rate.
 *   This is the floor that catches a detector firing on everything.
 *
 * It does not measure productivity, quality, or what a real agent would do. The agents here
 * are scripted, their obedience is a dial, and the repository is a fixture.
 *
 * It drives the real CLI, not the library, so the whole path is exercised: config, arm
 * resolution, preflight, the lease store and the ledger. Verdicts are read back out of the
 * ledger the run itself wrote, which is also what catches an arm that changed nothing.
 *
 *     node examples/ab/run.mjs [--compliance 0,0.5,1] [--arms A0-baseline,A3-advisory] [--json out.json] [--keep]
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readAllEvents, workspacePaths } from '@agentgit/core'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const cli = join(repoRoot, 'packages', 'cli', 'src', 'main.ts')

const keep = process.argv.includes('--keep')
const argOf = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}
const complianceLevels = argOf('compliance', '0,0.5,1').split(',').map(Number)

/*
 * The report is buffered so it can be sent to the right stream at the end.
 *
 * With `--json` on stdout, prose and JSON cannot share it: a consumer would have to guess
 * where the document starts, and that guess breaks the first time a sentence is reworded.
 * So the human report goes to stderr when the JSON goes to stdout, and stdout carries
 * nothing but the document. Buffering costs nothing in a batch script and keeps the two
 * audiences from corrupting each other's output.
 */
const report = []
function say(line = '') {
  report.push(String(line))
}

/** Where the machine-readable half goes: a file when named, stdout when bare, nowhere otherwise. */
const jsonFlag = process.argv.indexOf('--json')
const jsonTarget = jsonFlag >= 0 ? process.argv[jsonFlag + 1] : null
const jsonToFile = Boolean(jsonTarget && !jsonTarget.startsWith('--'))
const jsonToStdout = jsonFlag >= 0 && !jsonToFile

/**
 * The rounds. Each is a pair of agents' own words, and the truth about them.
 *
 * `truth` is the ground truth the metrics are split by, and it is fixed here rather than
 * inferred from what the detector said — a harness that let the tool label its own answers
 * would score itself against its own output, which is how a detector with a bug reports
 * perfect precision.
 *
 * `entityB` differs from `entityA` only in the untouched row, which is the control: the
 * second agent works somewhere the first never went, and no arm may interfere.
 */
const ROUNDS = [
  {
    entityA: 'src/login.py',
    truth: 'duplicate',
    a: { intent: 'add rate limiting to the login endpoint so repeated failures back off', line: 'A: throttle per user' },
    b: { intent: 'add rate limiting to login so repeated failures are throttled', line: 'B: throttled login attempts' },
  },
  {
    entityA: 'src/session.py',
    truth: 'duplicate',
    a: { intent: 'make session tokens expire after an hour of inactivity', line: 'A: session ttl' },
    b: { intent: 'session tokens should expire after an hour idle', line: 'B: session timeout' },
  },
  {
    entityA: 'src/export.py',
    truth: 'duplicate',
    a: { intent: 'stream the csv export instead of building it in memory', line: 'A: streaming export' },
    b: { intent: 'avoid holding the whole csv export in memory, stream it', line: 'B: streamed csv' },
  },
  {
    entityA: 'src/config.py',
    truth: 'independent',
    a: { intent: 'read the config file once at startup instead of per request', line: 'A: cache the config' },
    b: { intent: 'add a per-user override to the config lookup', line: 'B: per-user overrides' },
  },
  {
    entityA: 'src/limiter.py',
    truth: 'independent',
    a: { intent: 'count failures in a rolling window rather than a fixed one', line: 'A: rolling window' },
    b: { intent: 'log every throttled request with its identifier', line: 'B: throttle logging' },
  },
  {
    entityA: 'src/health.py',
    entityB: 'src/retry_notes.py',
    truth: 'untouched',
    a: { intent: 'add a health check endpoint', line: 'A: health check' },
    b: { intent: 'document the retry policy in a helper module', line: 'B: retry notes' },
  },
].map((round) => ({ ...round, entityB: round.entityB ?? round.entityA }))

const ARMS = ['A0-baseline', 'A4-session-only', 'A1-instrument', 'A3-advisory']
const armsToRun = argOf('arms', ARMS.join(',')).split(',').map((arm) => arm.trim()).filter(Boolean)
for (const arm of armsToRun) {
  // Refused here rather than silently dropped, so a typo cannot shrink the run to nothing.
  if (!ARMS.includes(arm)) throw new Error(`unknown arm '${arm}'. Known arms: ${ARMS.join(', ')}`)
}

/* -------------------------------------------------------------------------- */
/* Plumbing                                                                    */
/* -------------------------------------------------------------------------- */

let scratch = null

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? scratch,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
  })
  if (result.error) throw result.error
  if (options.expectOk !== false && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  return result
}

/** The CLI, as a user runs it: arm honoured, config read, ledger written. */
function agentgit(args, env) {
  return run(process.execPath, [cli, ...args, '--workspace', scratch], { env, expectOk: false })
}

/**
 * Ask the product, and read the answer.
 *
 * The whole of stdout is parsed, not the last line: `--json` output is pretty-printed, so
 * taking the last line yields `}` and every verdict in the run silently becomes a parse
 * error. The first version of this script did exactly that, and reported four arms that all
 * behaved identically for the worst possible reason.
 */
function preflight(entity, session, task, intent) {
  const result = agentgit(['preflight', entity, '--claim', '--intent', intent, '--json'], {
    AGENTGIT_SESSION: session,
    AGENTGIT_TASK: task,
  })
  try {
    return JSON.parse((result.stdout ?? '').trim())
  } catch {
    throw new Error(
      `preflight produced no readable verdict for ${entity} (exit ${result.status}): ` +
        `${(result.stderr || result.stdout || '').trim().slice(0, 300)}`,
    )
  }
}

function write(relative, contents) {
  const file = join(scratch, relative)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents, 'utf8')
}

/* -------------------------------------------------------------------------- */
/* One run of the scenario under one arm                                       */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic obedience, seeded from the round and the level and *not* the arm.
 *
 * Pairing matters: if each arm drew its own random obedience, the comparison would confound
 * the arm with luck, and with six rounds a single different draw moves the result by a sixth.
 */
function makeRng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

function runScenario(arm, compliance) {
  scratch = mkdtempSync(join(tmpdir(), `agentgit-ab-${arm.replace(/[^a-z0-9]/gi, '')}-`))
  run('git', ['init', '-q', '-b', 'main', '.'])
  run('git', ['config', 'user.email', 'ab@example.com'])
  run('git', ['config', 'user.name', 'AB harness'])
  run('git', ['config', 'commit.gpgsign', 'false'])
  // The ledger is coordination state, not source. Without this it would be committed onto
  // both branches and conflict with itself, and every round would look collided.
  write('.gitignore', '.agentgit/\n')
  write('README.md', '# fixture\n')
  run('git', ['add', '-A'])
  run('git', ['commit', '-q', '-m', 'seed'])
  const seed = run('git', ['rev-parse', 'HEAD']).stdout.trim()

  // The arm is set through the product's own command, so an arm that cannot be selected
  // fails here rather than being silently ignored for the whole run.
  const set = agentgit(['config', 'arm', arm])
  if (set.status !== 0) throw new Error(`could not select arm ${arm}: ${set.stderr}`)

  const rng = makeRng(0x5eed + Math.round(compliance * 1000))
  const rounds = []

  /* --- phase one: the ledger. Both agents ask before they act. --------------- */

  for (const [index, round] of ROUNDS.entries()) {
    // Agent A always writes: it is first on this ground, and nothing can stop it.
    const verdictA = preflight(round.entityA, `session-a-${index}`, `task-a-${index}`, round.a.intent)

    // Agent B asks, then acts on the answer to the extent it obeys.
    const verdictB = preflight(round.entityB, `session-b-${index}`, `task-b-${index}`, round.b.intent)

    /*
     * Obedience is applied only to a verdict that came with something to do.
     *
     * This is an *assumption*, and it is the one that separates the instrument arm from the
     * default: a caller told only "someone else is on this entity" has been given a fact, not
     * an action, and is modelled as proceeding. That is what makes `A1-instrument` a
     * measurement arm rather than a differently-labelled treatment. If it is the wrong
     * assumption, the A1 row is the one to distrust, not the others.
     */
    const advised = verdictB.verdict !== 'allow'
    const actionable = advised && (verdictB.nextActions ?? []).length > 0
    const obeys = compliance >= 1 || (compliance > 0 && rng() < compliance)
    const stopped = actionable && obeys

    rounds.push({ round, verdictA: verdictA.verdict, verdictB: verdictB.verdict, advised, actionable, stopped })
  }

  /* --- phase two: the code. One branch per agent, from the shared ancestor. --- */

  const writeAll = (agentKey, predicate) => {
    for (const entry of rounds) {
      if (!predicate(entry)) continue
      const entity = agentKey === 'a' ? entry.round.entityA : entry.round.entityB
      const lines = [entry.round.a.line, entry.round.b.line]
      write(entity, `${agentKey === 'a' ? lines[0] : lines.join('\n')}\n`)
    }
  }

  run('git', ['checkout', '-q', '-b', 'agentgit/task-a'])
  writeAll('a', () => true)
  run('git', ['add', '-A'])
  run('git', ['commit', '-q', '-m', 'agent a'])

  run('git', ['checkout', '-q', '-b', 'agentgit/task-b', seed])
  writeAll('b', (entry) => !entry.stopped)
  run('git', ['add', '-A'])
  run('git', ['commit', '-q', '--allow-empty', '-m', 'agent b'])

  // The ghost merge: this is the only place the *code* is compared rather than the ledger.
  const merge = run('git', ['merge-tree', '--write-tree', 'agentgit/task-a', 'agentgit/task-b'], { expectOk: false })
  /*
   * The conflicted paths, read structurally rather than out of git's prose.
   *
   * `merge-tree` prints one `<mode> <object> <stage>\t<path>` line per stage for each file it
   * could not merge, then a human-readable summary. Matching on the `CONFLICT (...)` lines
   * would be reading a message that git is free to reword; matching the mode/stage prefix is
   * reading the data structure the message is generated from.
   */
  const conflicts = [
    ...new Set(
      (merge.stdout ?? '')
        .split('\n')
        .map((line) => line.match(/^\d{6} [0-9a-f]+ [1-3]\t(.+)$/)?.[1])
        .filter((path) => typeof path === 'string'),
    ),
  ].sort()

  // Read the verdicts back out of the ledger the run itself wrote. If an arm wrote nothing,
  // this is how the report can say so instead of quietly reporting a null effect.
  const { events } = readAllEvents(workspacePaths(scratch))

  const result = {
    arm,
    compliance,
    rounds,
    conflicts,
    ledgerEvents: events.length,
    metrics: score(rounds),
  }
  if (!keep) {
    rmSync(scratch, { recursive: true, force: true })
    scratch = null
  }
  return result
}

/**
 * The three numbers, from the recorded verdicts and the truth fixed at the top.
 *
 * A round counts as "both wrote" when B was not stopped, because A always writes. So for a
 * duplicate round, `both wrote` is the failure; for an untouched round it must always be
 * true. The middle row is deliberately reported rather than scored: see the report text.
 */
function score(rounds) {
  const of = (truth) => rounds.filter((entry) => entry.round.truth === truth)
  const bothWrote = (entries) => entries.filter((entry) => !entry.stopped).length
  const duplicates = of('duplicate')
  const independent = of('independent')
  const untouched = of('untouched')
  return {
    duplicateRounds: duplicates.length,
    duplicatesClosed: duplicates.length - bothWrote(duplicates),
    independentRounds: independent.length,
    independentStopped: independent.length - bothWrote(independent),
    untouchedRounds: untouched.length,
    untouchedDisturbed: untouched.length - bothWrote(untouched),
    advised: rounds.filter((entry) => entry.advised).length,
    actionable: rounds.filter((entry) => entry.actionable).length,
  }
}

/* -------------------------------------------------------------------------- */
/* Run and report                                                              */
/* -------------------------------------------------------------------------- */

say('AgenticGit A/B run')
say('')
say('A scripted two-agent scenario, the same ledger questions under four arms. This')
say('measures when the second agent is told, and what a given obedience rate would do to')
say('the outcome. It does not measure what a real agent does with the answer.')
say('')
say(`rounds: ${ROUNDS.length}  (${ROUNDS.filter((r) => r.truth === 'duplicate').length} duplicate, ` +
  `${ROUNDS.filter((r) => r.truth === 'independent').length} same-entity-different-purpose, ` +
  `${ROUNDS.filter((r) => r.truth === 'untouched').length} untouched)`)
say(`obedience levels: ${complianceLevels.join(', ')}   arms: ${armsToRun.length}`)

const results = []
for (const arm of armsToRun) {
  for (const compliance of complianceLevels) {
    results.push(runScenario(arm, compliance))
  }
}

/* --- the mechanics first, so the numbers below have a visible cause --------- */

say('')
say('what each arm knew, and what it said')
say('------------------------------------')
for (const arm of armsToRun) {
  const row = results.find((entry) => entry.arm === arm && entry.compliance === complianceLevels[0])
  const verdicts = {}
  for (const entry of row.rounds) verdicts[entry.verdictB] = (verdicts[entry.verdictB] ?? 0) + 1
  const summary = Object.entries(verdicts).map(([verdict, n]) => `${verdict} x${n}`).join(', ')
  say(`  ${arm.padEnd(17)} b-agent verdicts: ${summary}`)
  say(
    `  ${''.padEnd(17)} usable next actions: ${row.metrics.actionable}/${row.rounds.length}` +
      `   ledger events written: ${row.ledgerEvents}`,
  )
}

say('')
say('outcome by arm and obedience rate')
say('---------------------------------')
say('  arm                obey   dup closed   indep stopped   untouched   files left in conflict')
for (const result of results) {
  const m = result.metrics
  say(
    `  ${result.arm.padEnd(17)} ${String(result.compliance).padEnd(6)} ` +
      `${`${m.duplicatesClosed}/${m.duplicateRounds}`.padEnd(12)} ` +
      `${`${m.independentStopped}/${m.independentRounds}`.padEnd(15)} ` +
      `${`${m.untouchedRounds - m.untouchedDisturbed}/${m.untouchedRounds}`.padEnd(11)} ` +
      `${result.conflicts.length}`,
  )
}
const worst = results.find((entry) => entry.arm === 'A0-baseline')
if (worst) {
  say('')
  say(`  The ${worst.conflicts.length} files the baseline leaves conflicted: ${worst.conflicts.join(', ')}`)
  say('  Those are the same-entity rounds where both agents wrote. It is what the ghost merge')
  say('  finds with no coordination layer at all, and it is the number the others are read against.')
}

/* --- what the numbers do and do not support --------------------------------- */

const baseline = results.find((entry) => entry.arm === 'A0-baseline' && entry.compliance === complianceLevels[0])
const treatment = results.filter((entry) => entry.arm === 'A3-advisory')

say('')
say('how to read this')
say('----------------')
say(`  The baseline closes ${baseline.metrics.duplicatesClosed} of ${baseline.metrics.duplicateRounds} duplicates at every obedience rate,`)
say('  because it never says anything. That is the floor, and it is the whole control.')
say('')
say('  "indep stopped" counts rounds that share an entity for genuinely different reasons,')
say('  where the second agent was stopped. Read it as deferral rather than loss: the product')
say('  says REPLAN there, which means split the entity or agree an order, not abandon it. It')
say('  is reported next to the duplicate column because a tool that closed duplicates by')
say('  stopping everything would look identical on that column alone.')
say('')
say('  "untouched" must stay complete under every arm and every rate. It is the floor that')
say('  catches a detector firing on ground nobody has touched.')
say('')
say('  Obedience is only applied to a verdict that came with a usable next action. That is')
say('  an assumption, and it is what separates the instrument arm from the default: an agent')
say('  told only that someone else is on the entity is modelled as proceeding. If that')
say('  assumption is wrong, the A1 row is the one to distrust, not the others.')
say('')
const perfect = treatment.find((entry) => entry.compliance === 1)
const partial = treatment.find((entry) => entry.compliance === complianceLevels[Math.floor(complianceLevels.length / 2)])
if (perfect && partial) {
  say(`  The default arm closing ${perfect.metrics.duplicatesClosed}/${perfect.metrics.duplicateRounds} at full obedience is arithmetic, not`)
  say('  evidence: it is what "obeyed the advice" means, and a harness cannot discover it.')
  say(`  The row that carries information is obedience ${partial.compliance}, where ${partial.metrics.duplicatesClosed} of ${partial.metrics.duplicateRounds} are closed and the`)
  say('  rest are the cost of an agent that was warned and proceeded anyway. Nobody has')
  say('  measured a real agent\'s rate here, and that rate is the only number that would make')
  say('  this an effect size.')
}
say('')
say('  This is a fixture. Agents are scripted, obedience is a dial, the entities are chosen')
say('  to be legible. Read it as a check that the mechanism works and that the arms differ,')
say('  not as a measurement of how much it helps.')

if (!keep) {
  say('')
  say('Every scratch repository was removed. Pass --keep to inspect the last one.')
}

/* --- machine-readable, so the numbers can be compared across changes --------- */

if (jsonFlag >= 0) {
  const document = `${JSON.stringify({ rounds: ROUNDS.length, complianceLevels, results }, null, 2)}\n`
  if (jsonToFile) writeFileSync(jsonTarget, document, 'utf8')
  else process.stdout.write(document)
}

// Flushed last, and to stderr when the document owns stdout.
const text = `${report.join('\n')}\n`
if (jsonToStdout) process.stderr.write(text)
else process.stdout.write(text)

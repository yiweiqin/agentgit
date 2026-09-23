#!/usr/bin/env node
/**
 * The real-data scan: which of this machine's own agent sessions collided, and on what.
 *
 * Why this exists
 * ---------------
 * `examples/collision/run.mjs` shows the mechanism on a case chosen to be legible.
 * That is a walkthrough, and using it as evidence would be self-deception: the reader
 * cannot tell whether the tool works or whether the case was picked to flatter it. This
 * script goes the other way and starts from every session transcript on the machine, so
 * the case in the report is found rather than authored.
 *
 * The trap it is built around
 * ---------------------------
 * Naive "same file means collision" is wrong, and wrong in the flattering direction. One
 * developer returning to the same file on three consecutive days is not two agents
 * duplicating work; it is one agent, sequentially, and it can merge perfectly. Every one
 * of those days looks identical to a real collision if the only question asked is "did
 * two sessions touch this path". So the scan requires the two writes to be *close in
 * time*, reports three windows rather than one, and keeps the naive count so the
 * difference is visible instead of hidden.
 *
 * Provenance is kept per candidate
 * --------------------------------
 * A pair is only a candidate when both sides' patch bodies can be read, because the
 * report has to be able to say what each agent actually wrote. A pair where one side is
 * unreadable is not "no collision"; it is "cannot be shown", and the two are reported
 * separately.
 *
 *     node examples/real/cases.mjs                       # human summary
 *     node examples/real/cases.mjs --json out.json       # the same, machine-readable
 *     node examples/real/cases.mjs --workspaces /path/a,/path/b   # narrow the scan
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { intentSimilarity, parsePatchRecords, parseRolloutText, sessionsRoot } from '@agentgit/core'

/**
 * Which workspaces a scan reports on, when the caller did not say.
 *
 * Discovered from the transcripts rather than listed here. Every rollout records the
 * directory it ran in, so the honest scope of a scan over this machine's sessions is exactly
 * the set of directories those sessions used — and a hardcoded list would quietly exclude a
 * repository that was first used last week, and would only work on one machine.
 *
 * Narrowing with `--workspaces` is still worth doing: the pool contains scratch directories,
 * and a collision in one is real but is not what a reader of this report came for.
 */
export function discoveredWorkspaces(described) {
  const seen = new Map()
  for (const session of described) {
    if (!session.cwd) continue
    const key = norm(session.cwd)
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  // Busiest first, so the report leads with the workspace that has the most history in it
  // rather than with whichever path happened to sort first.
  return [...seen.entries()].sort((left, right) => right[1] - left[1]).map(([key]) => key)
}

/** The windows the scan reports. Three, because "concurrent" is a choice the reader must see. */
export const DEFAULT_WINDOWS_HOURS = [1, 6, 24]

/** Extensions a coordination claim is worth making about. Anything else is prose. */
export const CODE_EXTENSIONS = new Set([
  'py', 'pyi', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'go', 'rs', 'java', 'kt', 'cs',
  'c', 'h', 'cc', 'cpp', 'hpp', 'rb', 'php', 'swift', 'scala', 'sh', 'ps1', 'sql',
])

const norm = (value) => value.replace(/\\/g, '/').toLowerCase()

function walkRollouts(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.jsonl')) out.push(path)
    }
  }
  walk(root)
  return out.sort()
}

/** The path relative to a workspace root, or null when it lands outside it. */
function relativeTo(root, absolute) {
  const base = norm(root).replace(/\/+$/, '')
  const full = norm(absolute)
  return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : null
}

const repoCache = new Map()

function isGitRepo(dir) {
  const key = norm(dir)
  const cached = repoCache.get(key)
  if (cached !== undefined) return cached
  let answer = false
  try {
    answer = execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === 'true'
  } catch {
    answer = false
  }
  repoCache.set(key, answer)
  return answer
}

function extensionOf(path) {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Read the pool once, merging the rollout files that belong to one session.
 *
 * Codex splits one session across several rollout files when it is resumed, and every
 * file repeats the session id. Pairing files instead of sessions produced pairs of a
 * session *with itself* at zero seconds — 43 "candidates" that were one agent editing a
 * file twice in a row. Merging by session id is what makes the count mean what it says.
 *
 * One pass, because the transcripts are gigabytes and reading them twice for the session
 * and then for the patches doubles the wall clock for no information.
 */
export function readPool(options = {}) {
  const root = options.sessionsRoot ?? sessionsRoot()
  const files = walkRollouts(root)
  const bySession = new Map()
  let bytes = 0
  let unreadable = 0

  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
      bytes += Buffer.byteLength(text, 'utf8')
    } catch {
      unreadable += 1
      continue
    }
    const session = parseRolloutText(text, file)
    if (!session) continue
    const patches = parsePatchRecords(text, file)

    const id = session.sessionId ?? file
    let entry = bySession.get(id)
    if (!entry) {
      entry = {
        sessionId: id,
        rollouts: [],
        cwd: null,
        startedAt: null,
        updatedAt: null,
        userMessages: [],
        fileChanges: [],
        commands: [],
        calls: [],
      }
      bySession.set(id, entry)
    }
    entry.rollouts.push(file)
    entry.cwd = entry.cwd ?? session.cwd ?? session.workspaceRoots[0] ?? null
    entry.startedAt = earliest(entry.startedAt, session.startedAt)
    entry.updatedAt = latest(entry.updatedAt, session.updatedAt)
    entry.userMessages.push(...session.userMessages)
    entry.fileChanges.push(...session.fileChanges)
    entry.commands.push(...session.commands)
    entry.calls.push(...patches.calls)
  }

  for (const entry of bySession.values()) {
    entry.userMessages.sort(byTimestamp)
    entry.fileChanges.sort(byTimestamp)
    entry.calls.sort(byTimestamp)
  }
  return { root, sessions: [...bySession.values()], files: files.length, bytes, unreadable }
}

const byTimestamp = (left, right) => Date.parse(left.at) - Date.parse(right.at)

function earliest(current, candidate) {
  if (!candidate) return current
  if (!current) return candidate
  return Date.parse(candidate) < Date.parse(current) ? candidate : current
}

function latest(current, candidate) {
  if (!candidate) return current
  if (!current) return candidate
  return Date.parse(candidate) > Date.parse(current) ? candidate : current
}

/** One session's writes and patches, in workspace-relative terms. */
function describeSession(entry) {
  const { sessionId, cwd, calls, fileChanges, userMessages, rollouts } = entry
  const changes = []
  for (const change of fileChanges) {
    const relative = cwd ? relativeTo(cwd, change.absolutePath) : null
    if (!relative) continue
    changes.push({ at: Date.parse(change.at), path: relative, kind: change.kind })
  }

  const patchCalls = []
  for (const call of calls) {
    const ops = []
    for (const op of call.files) {
      const absolute = op.path.includes(':') || op.path.startsWith('/')
      const relative = absolute ? (cwd ? relativeTo(cwd, op.path) : null) : norm(op.path)
      if (!relative) continue
      ops.push({ relative, op })
    }
    if (ops.length > 0) patchCalls.push({ at: Date.parse(call.at), source: call.source, ops })
  }

  return {
    file: rollouts[0],
    rollouts,
    sessionId,
    cwd,
    intent: userMessages[0]?.text.replace(/\s+/g, ' ').trim().slice(0, 600) ?? null,
    startedAt: entry.startedAt ? Date.parse(entry.startedAt) : null,
    updatedAt: entry.updatedAt ? Date.parse(entry.updatedAt) : null,
    messages: userMessages.map((message) => ({ at: Date.parse(message.at), text: message.text.replace(/\s+/g, ' ').trim() })),
    changes,
    patchCalls,
  }
}

/** The session's own words at a moment, which is what a preflight of that moment would carry. */
export function intentAt(described, at) {
  let latest = null
  for (const message of described.messages) {
    if (Number.isFinite(message.at) && message.at <= at) latest = message
  }
  return (latest?.text ?? described.messages[0]?.text ?? described.intent ?? '').slice(0, 600)
}

/** Pairs of sessions that wrote one path close in time, deduped so a file is not counted per write. */
function concurrentPairs(described, windowsHours) {
  const byCwd = new Map()
  for (const session of described) {
    if (!session.cwd || session.changes.length === 0) continue
    const key = norm(session.cwd)
    if (!byCwd.has(key)) byCwd.set(key, [])
    byCwd.get(key).push(session)
  }

  const best = new Map()
  for (const group of byCwd.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i]
        const b = group[j]
        // A resumed session is several rollout files with one id; pairing two of them
        // would report one agent's consecutive edits as two agents colliding.
        if (a.sessionId === b.sessionId) continue
        // Cheapest possible rejection: no path in common at all.
        const pathsA = new Set(a.changes.map((change) => change.path))
        const shared = new Set(b.changes.filter((change) => pathsA.has(change.path)).map((change) => change.path))
        for (const path of shared) {
          const timesA = a.changes.filter((change) => change.path === path).map((change) => change.at).filter(Number.isFinite)
          const timesB = b.changes.filter((change) => change.path === path).map((change) => change.at).filter(Number.isFinite)
          let gap = Infinity
          for (const left of timesA) for (const right of timesB) gap = Math.min(gap, Math.abs(left - right))
          if (!Number.isFinite(gap)) continue
          const key = `${a.sessionId}|${b.sessionId}|${path}`
          const previous = best.get(key)
          if (!previous || gap < previous.gapMs) best.set(key, { gapMs: gap, path, a, b, cwd: a.cwd })
        }
      }
    }
  }

  const all = [...best.values()].sort((left, right) => left.gapMs - right.gapMs)
  const naive = all.length
  const windows = windowsHours.map((hours) => ({
    hours,
    pairs: all.filter((entry) => entry.gapMs <= hours * 3_600_000).length,
  }))
  return { all, naive, windows }
}

/**
 * Turn concurrent pairs into candidates the report can actually show.
 *
 * The bar is provenance, not severity: both sessions must have a readable patch on the
 * shared path, and the pair must be inside the widest window. Everything else is a
 * score, because a case is only useful if a reader can follow it.
 */
export function findCandidates(entry, options = {}) {
  const windowsHours = options.windowsHours ?? DEFAULT_WINDOWS_HOURS
  const maxGapMs = Math.max(...windowsHours) * 3_600_000
  const { all } = entry

  const candidates = []
  for (const pair of all) {
    if (pair.gapMs > maxGapMs) continue
    const { a, b, path } = pair
    const opsA = operationsOn(a, path)
    const opsB = operationsOn(b, path)
    if (opsA.length === 0 || opsB.length === 0) continue

    // Choose the two patch calls the ledger would have seen on either side of the gap,
    // so the reconstruction compares the edits that are actually adjacent in time.
    const callA = opsA[opsA.length - 1]
    const callB = opsB[0]
    const gapMs = Math.abs(callB.at - callA.at)
    if (gapMs > maxGapMs) continue

    const intentA = intentAt(a, callA.at)
    const intentB = intentAt(b, callB.at)
    const similarity = intentSimilarity(intentA, intentB)
    const extension = extensionOf(path)
    const addedA = callA.ops.filter((o) => o.relative === path).reduce((total, o) => total + o.op.addedLines, 0)
    const addedB = callB.ops.filter((o) => o.relative === path).reduce((total, o) => total + o.op.addedLines, 0)
    // Restricted to the shared path. Counting a signature the same call declared in some
    // other file would put an interface in the report's reasons that neither session
    // touched here, and the reason is what a reader checks the case against.
    const signatures = [
      ...callA.ops.filter((o) => o.relative === path).flatMap((o) => o.op.addedSignatures),
      ...callB.ops.filter((o) => o.relative === path).flatMap((o) => o.op.addedSignatures),
    ]

    const reasons = []
    let score = 3_600_000 / Math.max(gapMs, 60_000)
    if (!CODE_EXTENSIONS.has(extension)) {
      score *= 0.1
      reasons.push('not source code, so a collision here is editing churn')
    }
    if (addedA === 0 || addedB === 0) {
      score *= 0.5
      reasons.push('one side only deletes lines')
    }
    if (addedA > 400 || addedB > 400) {
      score *= 0.6
      reasons.push('at least one patch is too large to read in a report')
    }
    if (!intentA || !intentB) {
      score *= 0.4
      reasons.push('at least one session records no instruction to quote')
    }
    if (similarity >= 0.42) reasons.push('both sides describe the same work')
    else reasons.push('the two sides describe different work on one file')
    if (signatures.length > 0) {
      score *= 1.2
      reasons.push(`an interface is declared in the change: ${[...new Set(signatures)].join(', ')}`)
    }

    candidates.push({
      id: `${a.sessionId.slice(0, 8)}-${b.sessionId.slice(0, 8)}-${path.replace(/[^a-z0-9]+/gi, '-')}`,
      workspace: pair.cwd,
      isRepo: isGitRepo(pair.cwd),
      path,
      extension,
      gapSeconds: Math.round(gapMs / 1000),
      sameWork: similarity >= 0.42,
      similarity: Number(similarity.toFixed(3)),
      score: Number(score.toFixed(3)),
      reasons,
      a: {
        sessionId: a.sessionId,
        rollout: a.file,
        rollouts: a.rollouts,
        startedAt: a.startedAt ? new Date(a.startedAt).toISOString() : null,
        patchAt: new Date(callA.at).toISOString(),
        /**
         * Two intents, because they answer different questions and only one of them is what
         * the product ever sees.
         *
         * `intent` is the instruction in force at the write — the last thing the user said
         * before it. That is the text a preflight at that moment would have carried, so it
         * is the one the verdict is computed from, and it is often a one-line "continue".
         * `openingIntent` is the task as it was first stated, which is what a reader needs
         * to understand what the session was for.
         */
        intent: intentA,
        openingIntent: a.intent,
        addedLines: addedA,
        removedLines: callA.ops.filter((o) => o.relative === path).reduce((total, o) => total + o.op.removedLines, 0),
        patchSource: callA.source,
        signatures: [...new Set(callA.ops.filter((o) => o.relative === path).flatMap((o) => o.op.addedSignatures))],
      },
      b: {
        sessionId: b.sessionId,
        rollout: b.file,
        rollouts: b.rollouts,
        startedAt: b.startedAt ? new Date(b.startedAt).toISOString() : null,
        patchAt: new Date(callB.at).toISOString(),
        intent: intentB,
        openingIntent: b.intent,
        addedLines: addedB,
        removedLines: callB.ops.filter((o) => o.relative === path).reduce((total, o) => total + o.op.removedLines, 0),
        patchSource: callB.source,
        signatures: [...new Set(callB.ops.filter((o) => o.relative === path).flatMap((o) => o.op.addedSignatures))],
      },
    })
  }

  return candidates.sort((left, right) => right.score - left.score)
}

/** Every patch call in a session that touched one relative path, in time order. */
function operationsOn(session, path) {
  return session.patchCalls.filter((call) => call.ops.some((op) => op.relative === path))
}

/** The whole scan, from the transcripts on disk to a ranked candidate list. */
export function scan(options = {}) {
  const pool = readPool(options)
  const described = pool.sessions.map(describeSession)
  // An empty list means "you did not narrow it", not "scan nothing". A caller that filtered
  // every workspace out of a `--workspaces` argument should get the whole pool and can see
  // the full list in the report, rather than a silent empty result that reads like a finding.
  const scope = options.workspaces !== undefined && options.workspaces.length > 0 ? options.workspaces : discoveredWorkspaces(described)
  const workspaces = scope.map((value) => norm(value))

  const inScope = described.filter((session) => session.cwd && workspaces.includes(norm(session.cwd)))
  const { all, naive, windows } = concurrentPairs(inScope, options.windowsHours ?? DEFAULT_WINDOWS_HOURS)

  const perWorkspace = []
  for (const workspace of workspaces) {
    const group = inScope.filter((session) => norm(session.cwd) === workspace)
    const touchCounts = new Map()
    for (const session of group) {
      for (const path of new Set(session.changes.map((change) => change.path))) {
        touchCounts.set(path, (touchCounts.get(path) ?? 0) + 1)
      }
    }
    perWorkspace.push({
      root: group[0]?.cwd ?? workspace,
      sessions: group.length,
      sessionsWithPatches: group.filter((session) => session.patchCalls.length > 0).length,
      sharedFiles: [...touchCounts.values()].filter((count) => count > 1).length,
      isRepo: group.length > 0 ? isGitRepo(group[0].cwd) : false,
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    /** Whether the workspace list came from the transcripts or from the caller. */
    scope: options.workspaces !== undefined && options.workspaces.length > 0 ? 'given' : 'discovered',
    pool: {
      rollouts: pool.files,
      parsed: described.length,
      unreadable: pool.unreadable,
      bytes: pool.bytes,
      withFileChanges: described.filter((session) => session.changes.length > 0).length,
      withPatches: described.filter((session) => session.patchCalls.length > 0).length,
    },
    workspaces: perWorkspace,
    windows,
    naivePairs: naive,
    candidatePool: all.length,
    candidates: findCandidates({ all }, options),
    /**
     * The parsed sessions themselves, for callers that go on to replay one.
     *
     * Kept off the serialized form: a JSON dump of 2.5 GB of transcripts is not a
     * report, and a caller that wants it can call this function rather than read a file.
     */
    describedSessions: described,
  }
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                    */
/* -------------------------------------------------------------------------- */

function megabytes(bytes) {
  return `${(bytes / 1e9).toFixed(2)} GB`
}

function humanReport(result) {
  const lines = []
  const say = (line = '') => lines.push(String(line))

  say('AgenticGit real-pool scan')
  say('')
  say(`  sessions            ${result.pool.parsed} distinct, from ${result.pool.rollouts} rollout files, ${megabytes(result.pool.bytes)}`)
  say(`  with file changes   ${result.pool.withFileChanges}`)
  say(`  with patch bodies   ${result.pool.withPatches}   (the rest cannot be shown, not "no collision")`)
  say('')
  say('workspaces')
  say('----------')
  // Only the ones with anything to say get a line. A discovered scope reaches every
  // scratch directory a chat happened in, and most of those hold no shared file, so
  // printing them would bury the three that do without telling the reader anything.
  // `sharedFiles` is the criterion rather than `sessions`, because a workspace whose files
  // were each touched by one session has no pair to report at any distance.
  const interesting = result.workspaces.filter((workspace) => workspace.sharedFiles > 0)
  for (const workspace of interesting) {
    say(
      `  ${workspace.isRepo ? 'git ' : '    '} ${String(workspace.sessions).padStart(3)} sessions  ` +
        `${String(workspace.sharedFiles).padStart(3)} shared files  ${workspace.root}`,
    )
  }
  const quiet = result.workspaces.filter((workspace) => !interesting.includes(workspace))
  if (quiet.length > 0) {
    say(
      `        ${String(quiet.reduce((total, entry) => total + entry.sessions, 0)).padStart(3)} sessions in ` +
        `${quiet.length} further directories the transcripts recorded, none with a file two sessions touched`,
    )
  }
  if (result.scope === 'discovered') {
    say('')
    say('  This list is read from the transcripts rather than kept here, so the scope of the')
    say('  scan is a fact about the pool rather than a choice about what counts. Narrow it')
    say('  with --workspaces when a scratch directory is not what you are measuring.')
  }
  say('')
  say('cross-session same-file pairs, by how close the two writes were')
  say('---------------------------------------------------------------')
  for (const window of result.windows) {
    say(`  within ${String(window.hours).padStart(2)}h   ${window.pairs}`)
  }
  say(`  any distance (the naive count, most of it sequential work)   ${result.naivePairs}`)
  say('')
  say('  A pair is counted once per (session pair, file), at their closest two writes.')
  say('  "Concurrent" is therefore a choice of window, not a fact about the pool.')
  say('')
  say(`candidates with a readable patch on both sides: ${result.candidates.length}`)
  for (const candidate of result.candidates.slice(0, 8)) {
    say('')
    say(`  [${candidate.score}] ${candidate.path}  (${candidate.gapSeconds}s apart, ${candidate.sameWork ? 'same work' : 'different work'})`)
    say(`      ${candidate.isRepo ? 'git repo' : 'not a git repo'}  ${candidate.workspace}`)
    say(`      A ${candidate.a.sessionId.slice(0, 8)}  +${candidate.a.addedLines}/-${candidate.a.removedLines}  "${candidate.a.intent.slice(0, 70)}"`)
    say(`      B ${candidate.b.sessionId.slice(0, 8)}  +${candidate.b.addedLines}/-${candidate.b.removedLines}  "${candidate.b.intent.slice(0, 70)}"`)
    for (const reason of candidate.reasons) say(`      - ${reason}`)
  }
  if (result.candidates.length === 0) {
    say('')
    say('  No candidate has a readable patch on both sides of a shared file.')
    say('  That is the honest answer, and it is not the same as "no collision":')
    say('  it means no collision here can be *shown*, so no report should be built.')
  }
  return `${lines.join('\n')}\n`
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invokedDirectly) {
  const argOf = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`)
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
  }
  const workspacesArg = argOf('workspaces', process.env.AGENTGIT_SCAN_WORKSPACES ?? '')
  const workspaces = workspacesArg
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const windowsHours = argOf('window-hours', DEFAULT_WINDOWS_HOURS.join(','))
    .split(',')
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)

  const started = Date.now()
  const result = scan({ workspaces, windowsHours })
  process.stderr.write(`scanned in ${((Date.now() - started) / 1000).toFixed(1)}s\n`)

  const jsonAt = process.argv.indexOf('--json')
  if (jsonAt >= 0 && process.argv[jsonAt + 1]) {
    const { writeFileSync } = await import('node:fs')
    const { describedSessions, ...serializable } = result
    void describedSessions
    writeFileSync(process.argv[jsonAt + 1], `${JSON.stringify(serializable, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(humanReport(result))
}

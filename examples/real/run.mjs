#!/usr/bin/env node
/**
 * Build the before/after report for one real case.
 *
 * What it does, in order, and why each step is real
 * -------------------------------------------------
 * 1. Finds the case by scanning this machine's own transcripts (`cases.mjs`), rather than
 *    by picking a flattering example.
 * 2. Replays both sessions into a throwaway ledger with their real timestamps and asks
 *    the real `preflight()` the question the second agent's tool call would have asked.
 *    No part of the verdict is written here; it is the product's answer.
 * 3. Reconstructs each agent's version of the shared file by applying *their own patch
 *    bytes* to a revision both patches can anchor on, commits each on its own branch in a
 *    throwaway repository, and runs a real `git merge-tree`.
 * 4. Renders the two answers side by side and prints the content reference, so the report
 *    can be shown in the conversation that produced it.
 *
 * Three things it refuses to do
 * ----------------------------
 * - **It never writes to the source repository's git data.** Objects are read through an
 *   alternates file, refs are resolved with `rev-parse`, and every write happens in a temp
 *   repository. Only the HTML artifact is written back, under `.agentgit/state/`.
 * - **It never approximates a patch.** A patch that cannot be anchored on any candidate
 *   revision removes the case from consideration; it is not nudged into place, because a
 *   reconstructed merge would then be clean because of the reconstruction.
 * - **It never reports a number it did not compute.** Anything derived by reasoning rather
 *   than by running is labelled as such in the report.
 *
 *     node examples/real/run.mjs                  # the top case the product actually flags
 *     node examples/real/run.mjs --list           # every candidate, and why each ranks
 *     node examples/real/run.mjs --pick 1         # a specific one, even if it is a miss
 *     node examples/real/run.mjs --keep           # leave the temp repository in place
 *     node examples/real/run.mjs --out <dir>      # where to put the HTML
 *     node examples/real/run.mjs --workspaces A,B # narrow the scan to these directories
 *     node examples/real/run.mjs --refs origin/main,origin/agent-b
 *                                                 # also report the merge those two refs
 *                                                 # ended in; omitted means skip that block
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  adoptSession,
  applyFileOps,
  loadContext,
  mergeTreePreview,
  parseRolloutText,
  preflight,
  reverseFileOps,
  workspacePaths,
} from '@agentgit/core'
import { defaultStoryDir, writeStory } from '@agentgit/board'

import { CODE_EXTENSIONS, scan } from './cases.mjs'

const norm = (value) => value.replace(/\\/g, '/').toLowerCase()

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function tryGit(args, cwd) {
  try {
    return { ok: true, out: git(args, cwd) }
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

function humanGap(seconds) {
  if (seconds < 90) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 90) return `${minutes}m${rest ? ` ${rest}s` : ''}`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function shortStamp(iso) {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16)
}

/** `applyFileOps` returns lines without the final newline the file had; git wants it back. */
function withTrailingNewline(text) {
  return text.length === 0 ? '' : text.endsWith('\n') ? text : `${text}\n`
}

/** Write a tracked file inside the temp repository, creating the directories git left out. */
function writeRepoFile(repo, path, text) {
  const target = join(repo, ...path.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, withTrailingNewline(text), 'utf8')
}


/* -------------------------------------------------------------------------- */
/* The replay                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Rewrite a session's paths so the same work can be replayed under a temp root.
 *
 * The rebase is on the *root only*: `<workspace>\rfs\cli.py` becomes
 * `<temp>\rfs\cli.py`, so every entity key the ledger derives is byte-identical to the one
 * the real workspace would have produced. Nothing else is changed — the timestamps, the
 * intents and the file list are the transcript's own.
 */
function rebaseSession(session, fromRoot, toRoot, cutoffMs) {
  const from = norm(fromRoot).replace(/\/+$/, '')
  const fileChanges = []
  for (const change of session.fileChanges) {
    const at = Date.parse(change.at)
    if (Number.isFinite(at) && at > cutoffMs) continue
    const full = norm(change.absolutePath)
    if (!full.startsWith(`${from}/`)) continue
    const relative = full.slice(from.length + 1)
    const absolutePath = join(toRoot, ...relative.split('/'))
    fileChanges.push({ ...change, absolutePath, path: absolutePath })
  }
  const inPast = (entry) => {
    const at = Date.parse(entry.at)
    return !Number.isFinite(at) || at <= cutoffMs
  }
  return {
    ...session,
    cwd: toRoot,
    workspaceRoots: [toRoot],
    fileChanges,
    userMessages: session.userMessages.filter(inPast),
    tokenDrops: session.tokenDrops.filter(inPast),
  }
}

/**
 * Replay both sessions into a fresh ledger and ask the product what it would have said.
 *
 * The cutoff is the load-bearing detail. `loadContext` windows events from the past but
 * does not exclude events after its `now`, which is correct live — nothing is in the future
 * — and wrong for a replay, where the whole transcript is already on disk. Adopting
 * everything and then asking about a moment in the middle would hand the verdict knowledge
 * of the future, including the other session's later writes, and every case would look
 * detected. So the transcript is truncated at the question, and the truncation is by the
 * event's own timestamp.
 */
function replay(candidate, ledgerRoot, describedById) {
  mkdirSync(ledgerRoot, { recursive: true })
  const paths = workspacePaths(ledgerRoot)
  const cutoffMs = Date.parse(candidate.b.patchAt)

  let events = 0
  for (const side of [candidate.a, candidate.b]) {
    const described = describedById.get(side.sessionId)
    if (!described) return { ok: false, why: `session ${side.sessionId} is not in the pool any more` }
    for (const rollout of described.rollouts) {
      let text
      try {
        text = readFileSync(rollout, 'utf8')
      } catch {
        continue
      }
      const session = parseRolloutText(text, rollout)
      if (!session) continue
      events += adoptSession(paths, rebaseSession(session, described.cwd, ledgerRoot)).appended
    }
  }

  const at = new Date(cutoffMs)
  const query = {
    taskId: candidate.b.sessionId,
    sessionId: candidate.b.sessionId,
    entityKey: `file::${candidate.path}`,
    entityPath: candidate.path,
    intentText: candidate.b.intent,
    windowHours: 24,
  }
  // `A3-advisory` is the product's own arm, and it is named here rather than defaulted so
  // that the scope the events were read under and the action set the verdict offers come
  // from the same arm. A workspace with no config file already resolves to it.
  const context = loadContext(paths, at, 24, {
    arm: 'A3-advisory',
    sessionId: candidate.b.sessionId,
    taskId: candidate.b.sessionId,
  })
  return { ok: true, verdict: preflight(paths, query, context), events }
}

/** The patch calls that touched one path at one instant. */
function callsOn(described, path, atIso) {
  const at = Date.parse(atIso)
  const call = described.patchCalls.find(
    (entry) => entry.at === at && entry.ops.some((op) => op.relative === path),
  )
  if (!call) return []
  return call.ops.filter((op) => op.relative === path).map((op) => op.op)
}

/* -------------------------------------------------------------------------- */
/* The reconstruction                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The two one-sided versions of the shared file, and the revision they came from.
 *
 * Two strategies, tried in order, because the repository the case comes from commits in
 * batches rather than per change — and which strategy applies is itself a finding worth
 * printing.
 *
 * `anchored` — some committed revision accepts both patches as bases. This is the case the
 * plan assumed, and it is the simpler reading: both agents wrote on top of the same
 * revision, so each branch is that revision plus that agent's bytes.
 *
 * `reversed` — no revision accepts either patch, because both agents wrote against a
 * *working tree* that was not committed until later. The committed revision that holds
 * both changes is still real, so the branches are recovered from it in the other
 * direction: remove the *other* agent's change from the landed file and what is left is
 * this agent's version. The claim being made is then narrower and is stated as such — the
 * merge result is about the two edits as they landed, not about the working trees they were
 * written in.
 *
 * Never approximated. A strategy that cannot be applied exactly is discarded, and the case
 * is shown with no merge result at all rather than with a merge result that came from a
 * fudged anchor.
 */
function reconstruct(source, path, opsA, opsB, times) {
  const log = tryGit(['log', '--format=%H%x09%cI', '-n', '300', '--', path], source)
  if (!log.ok) return { ok: false, why: `git log failed for ${path}` }
  const commits = log.out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [oid, committedAt] = line.split('\t')
      return { oid, committedAt, at: Date.parse(committedAt) }
    })
  if (commits.length === 0) return { ok: false, why: `${path} has no history in the source repository` }

  const bodyOf = (oid) => {
    const show = tryGit(['show', `${oid}:${path}`], source)
    return show.ok ? show.out : null
  }

  /* Strategy 1: a revision both patches were written against. */
  for (const commit of commits) {
    const body = bodyOf(commit.oid)
    if (body === null) continue
    const left = applyFileOps(body, opsA)
    const right = applyFileOps(body, opsB)
    if (left.ok && right.ok) {
      return {
        ok: true,
        mode: 'anchored',
        revision: commit.oid,
        committedAt: commit.committedAt,
        base: body,
        left: left.lines.join('\n'),
        right: right.lines.join('\n'),
        verified: true,
        gapLines: closestEditedLines(body.replace(/\r\n/g, '\n').split('\n'), opsA, opsB),
        why: null,
      }
    }
  }

  /* Strategy 2: the earliest revision that holds both changes, read backwards. */
  const oldestFirst = [...commits].reverse()
  const latestWrite = Math.max(times.a, times.b)
  for (const commit of oldestFirst) {
    if (Number.isFinite(commit.at) && commit.at < latestWrite) continue
    const body = bodyOf(commit.oid)
    if (body === null) continue
    const left = reverseFileOps(body, opsB)
    const right = reverseFileOps(body, opsA)
    if (!left.ok || !right.ok) continue
    // Removing the second change from the first agent's version must also work, or the
    // revision does not hold the two changes independently and the "base" is not one.
    const base = reverseFileOps(left.lines.join('\n'), opsA)
    if (!base.ok) continue

    /*
     * The check that makes this mode usable at all.
     *
     * Reading the branches backwards and then merging them would otherwise be a closed
     * loop: any pair of one-sided files can be produced, and the merge result would say
     * something about the reconstruction rather than about the two sessions. Applying both
     * patches *forward* to the derived base and requiring the exact same lines back closes
     * it — the three files are then a real three-way state, and the merge compares what the
     * two sessions wrote. A revision that fails this is discarded rather than explained.
     */
    const baseText = base.lines.join('\n')
    const forwardA = applyFileOps(baseText, opsA)
    const forwardB = applyFileOps(baseText, opsB)
    if (!forwardA.ok || !forwardB.ok) continue
    if (forwardA.lines.join('\n') !== left.lines.join('\n')) continue
    if (forwardB.lines.join('\n') !== right.lines.join('\n')) continue

    return {
      ok: true,
      mode: 'reversed',
      revision: commit.oid,
      committedAt: commit.committedAt,
      base: baseText,
      left: left.lines.join('\n'),
      right: right.lines.join('\n'),
      verified: true,
      gapLines: closestEditedLines(base.lines, opsA, opsB),
      why: null,
    }
  }

  const firstFailure = commits
    .map((commit) => {
      const body = bodyOf(commit.oid)
      if (body === null) return null
      const attempt = applyFileOps(body, opsA)
      return attempt.ok ? null : attempt.reason
    })
    .find((reason) => reason !== null)

  return {
    ok: false,
    why:
      `no revision accepts both patches, and no later revision holds both changes to read them back from` +
      (firstFailure ? ` (for example: ${firstFailure})` : ''),
  }
}

function conflictPaths(lines) {
  const paths = new Set()
  for (const line of lines) {
    const tab = line.indexOf('\t')
    if (tab >= 0) paths.add(line.slice(tab + 1).trim())
  }
  return [...paths]
}

/**
 * How far apart the two sessions' edits sit, in lines of the base file.
 *
 * Reported alongside a clean merge because "0 conflicts" and "the edits are five lines
 * apart in the same argument block" are both true, and only together do they describe the
 * case. Measured on the base coordinates each patch was applied to, by the position of the
 * first line of each edited region — `hunk.old[0]`, which is a line the base actually
 * contains. A hunk that quotes no region has no position and contributes nothing.
 *
 * This is a derived number rather than an observation, and it is labelled as one where it
 * appears in the report.
 */
function closestEditedLines(baseLines, opsA, opsB) {
  const positionsOf = (ops) => {
    const out = []
    for (const op of ops) {
      for (const hunk of op.hunks) {
        if (hunk.old.length === 0) continue
        const at = baseLines.findIndex((candidate) => candidate.trimEnd() === hunk.old[0].trimEnd())
        if (at >= 0) out.push(at)
      }
    }
    return out
  }
  const as = positionsOf(opsA)
  const bs = positionsOf(opsB)
  if (as.length === 0 || bs.length === 0) return null
  let best = Infinity
  for (const left of as) for (const right of bs) best = Math.min(best, Math.abs(left - right))
  return Number.isFinite(best) ? best : null
}

/* -------------------------------------------------------------------------- */
/* The report                                                                   */
/* -------------------------------------------------------------------------- */

function honestyNotes({ candidate, verdict, reconstructed, realMerge }) {
  const notes = [
    'One case is a demonstration, not a rate. The pool scan that found it reports how many others exist, and at what distances.',
    'A clean textual merge is not behavioural correctness: git being silent is not evidence that the work was right.',
  ]
  if (reconstructed.ok && reconstructed.mode === 'anchored') {
    notes.push(
      `Both sessions’ patches were written against commit ${reconstructed.revision.slice(0, 8)}, so each branch is that revision plus one session’s own bytes. ` +
        'Real branches carry every other file too, and further conflicts could come from those.',
    )
  } else if (reconstructed.ok) {
    notes.push(
      `Neither patch was written against a commit — both sessions wrote into an uncommitted working tree, which is how this repository is used. ` +
        `The one-sided versions are therefore the landed file at ${reconstructed.revision.slice(0, 8)} with the *other* session’s change removed, ` +
        'so the merge below is about the two edits as they landed, not about the working trees they were typed in.',
    )
    notes.push(
      'Reading the branches backwards only works for edits that occupy separable regions of the file, so a clean merge is the expected outcome in ' +
        'this mode rather than a surprise. The number is this pair’s own answer and says nothing about how often git is blind; that is what ' +
        'Experiment 4 counts across the pool.',
    )
  } else {
    notes.push(`The reconstruction is unavailable (${reconstructed.why}), so no merge result is shown at all.`)
  }
  if (realMerge) {
    notes.push(
      `The conflict count for the two real branches (${realMerge.labels.join(' vs ')}) is real, but it is the merge at the *end* of the divergence, ` +
        'not at the moment shown above. The distance between those two moments is the point of the screen.',
    )
  }
  if (reconstructed.ok && reconstructed.gapLines !== null) {
    notes.push(
      `The ${reconstructed.gapLines}-line distance between the two edits is derived from the reconstruction rather than measured on the working ` +
        'tree, and it describes the two edits as they landed.',
    )
  }
  notes.push(
    `The verdict is the product’s own output for the replayed ledger (detection: ${verdict.evidence.detection}). ` +
      'It is a similarity judgement over recorded intent text, so it can be wrong, and it is advisory by construction: nothing was refused.',
  )
  notes.push(
    'The similarity it compares is the last instruction the user had given each session, because that is what the ledger records — not what the ' +
      'agent was doing. Here that instruction was a one-line continuation, so a collision the two sessions’ edits imply can be missed when their ' +
      'words are thin. That is a limit of the detection, and Experiment 1 is the measurement of it.',
  )
  if (!candidate.sameWork) {
    notes.push('These two sessions were working on different things, which is why the verdict is a deferral rather than a duplicate.')
  }
  return notes
}

async function main() {
  const argv = process.argv.slice(2)
  const flag = (name) => argv.includes(`--${name}`)
  const value = (name, fallback) => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
  }
  /** A comma-separated flag, as the list it names, with empty entries dropped. */
  const list = (name) =>
    value(name, process.env[`AGENTGIT_${name.toUpperCase()}`] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)

  const workspaces = list('workspaces')
  const refArgs = list('refs')

  const started = Date.now()
  process.stderr.write('scanning transcripts...\n')
  const result = scan({ workspaces })
  process.stderr.write(
    `scanned ${result.pool.parsed} sessions in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
      `(${result.pool.withPatches} with readable patches)\n`,
  )

  const byId = new Map(result.describedSessions.map((session) => [session.sessionId, session]))
  const usable = result.candidates.filter((candidate) => candidate.isRepo && CODE_EXTENSIONS.has(candidate.extension))

  if (flag('list')) {
    process.stdout.write(
      `candidates: ${result.candidates.length}; in a real git repo and source code: ${usable.length}\n`,
    )
    for (const [index, candidate] of usable.entries()) {
      process.stdout.write(
        `  [${index}] score ${candidate.score}  ${candidate.path}  ${humanGap(candidate.gapSeconds)} apart\n` +
          `      ${candidate.workspace}\n` +
          `      A ${candidate.a.sessionId.slice(0, 8)} +${candidate.a.addedLines}/-${candidate.a.removedLines}  "${candidate.a.intent.slice(0, 60)}"\n` +
          `      B ${candidate.b.sessionId.slice(0, 8)} +${candidate.b.addedLines}/-${candidate.b.removedLines}  "${candidate.b.intent.slice(0, 60)}"\n`,
      )
    }
    return 0
  }

  if (usable.length === 0) {
    process.stderr.write(
      '\nNo case can be shown. Every concurrent same-file pair is either outside a git\n' +
        'repository or lacks a readable patch on one side. Reasons, per candidate:\n\n',
    )
    for (const candidate of result.candidates) {
      process.stderr.write(
        `  ${candidate.path}  (${humanGap(candidate.gapSeconds)} apart, ${candidate.workspace})\n` +
          `      ${candidate.isRepo ? '' : 'not a git repository; '}${CODE_EXTENSIONS.has(candidate.extension) ? '' : 'not source code'}\n` +
          candidate.reasons.map((reason) => `      - ${reason}\n`).join(''),
      )
    }
    process.stderr.write(
      '\nNo report was built. A report is not owed a case, and inventing one is the one\n' +
        'thing this script exists to prevent.\n',
    )
    return 1
  }

  const pickIndex = argv.indexOf('--pick')
  const explicitPick = pickIndex >= 0 ? Number(argv[pickIndex + 1]) : null
  const order = explicitPick === null ? usable : [usable[explicitPick]]
  if (explicitPick !== null && !order[0]) {
    process.stderr.write(`--pick ${explicitPick} is out of range; there are ${usable.length} usable candidates\n`)
    return 1
  }

  const workDir = mkdtempSync(join(tmpdir(), 'agentgit-real-'))
  const attempts = []
  let chosen = null

  try {
    for (const [index, candidate] of order.entries()) {
      const ledgerRoot = join(workDir, `try-${index}`, 'ledger')
      const played = replay(candidate, ledgerRoot, byId)
      if (!played.ok) {
        attempts.push({ candidate, why: played.why })
        continue
      }
      if (played.verdict.verdict === 'allow') {
        attempts.push({ candidate, why: 'the product allowed it, so there is nothing to show' })
        continue
      }
      chosen = { candidate, played }
      break
    }

    if (!chosen) {
      process.stderr.write('\nNo case produced a verdict worth showing. Each attempt, and why:\n\n')
      for (const attempt of attempts) {
        process.stderr.write(
          `  ${attempt.candidate.path}  (${humanGap(attempt.candidate.gapSeconds)} apart)\n` +
            `      - ${attempt.why}\n` +
            attempt.candidate.reasons.map((reason) => `      - ${reason}\n`).join(''),
        )
      }
      process.stderr.write(
        '\nNo report was built. A case the product stays silent about is a finding, not a\n' +
          'demo, and it belongs in the experiment, not in a before/after screen.\n',
      )
      return 1
    }

    const { candidate, played } = chosen
    const { verdict } = played
    const source = candidate.workspace
    const repo = join(workDir, 'repo')

    /* ---- git objects, borrowed read-only through an alternates file ---- */
    mkdirSync(repo, { recursive: true })
    git(['init', '-q'], repo)
    const gitDir = git(['rev-parse', '--absolute-git-dir'], source).trim()
    mkdirSync(join(repo, '.git', 'objects', 'info'), { recursive: true })
    writeFileSync(join(repo, '.git', 'objects', 'info', 'alternates'), `${join(gitDir, 'objects')}\n`, 'utf8')
    git(['config', 'user.email', 'agentgit-report@localhost'], repo)
    git(['config', 'user.name', 'agentgit report'], repo)
    // Nothing is checked out of the history, so line-ending conversion would only add a
    // warning and a chance that a committed blob differs from the bytes that were applied.
    git(['config', 'core.autocrlf', 'false'], repo)

    /* ---- the two agents' own bytes, on two branches ---- */
    const describedA = byId.get(candidate.a.sessionId)
    const describedB = byId.get(candidate.b.sessionId)
    const opsA = callsOn(describedA, candidate.path, candidate.a.patchAt)
    const opsB = callsOn(describedB, candidate.path, candidate.b.patchAt)
    const reconstructed = opsA.length > 0 && opsB.length > 0
      ? reconstruct(candidate.workspace, candidate.path, opsA, opsB, {
          a: Date.parse(candidate.a.patchAt),
          b: Date.parse(candidate.b.patchAt),
        })
      : { ok: false, why: 'the patch that touched the file could not be located in the transcript' }

    let mergePreview = null
    if (reconstructed.ok) {
      writeRepoFile(repo, candidate.path, reconstructed.base)
      git(['add', '--', candidate.path], repo)
      git(['commit', '-q', '-m', `base: ${candidate.path} at ${reconstructed.revision.slice(0, 8)}`], repo)
      const trunk = git(['symbolic-ref', '--short', 'HEAD'], repo).trim()

      git(['checkout', '-q', '-b', 'agentgit/task-a'], repo)
      writeRepoFile(repo, candidate.path, reconstructed.left)
      git(['add', '--', candidate.path], repo)
      git(['commit', '-q', '-m', `task-a: ${candidate.a.sessionId.slice(0, 8)}`], repo)

      git(['checkout', '-q', trunk], repo)
      git(['checkout', '-q', '-b', 'agentgit/task-b'], repo)
      writeRepoFile(repo, candidate.path, reconstructed.right)
      git(['add', '--', candidate.path], repo)
      git(['commit', '-q', '-m', `task-b: ${candidate.b.sessionId.slice(0, 8)}`], repo)

      git(['checkout', '-q', trunk], repo)
      mergePreview = mergeTreePreview(repo, 'agentgit/task-a', 'agentgit/task-b')
    }

    /* ---- what git said when the two real branches finally met ---- */
    /*
     * Only when the caller names the two refs.
     *
     * Which refs a repository's divergence ended in is a property of that repository, so
     * there is nothing sensible to default to: a guess would either resolve to nothing (and
     * quietly print "not recoverable" for every case) or resolve to the wrong pair and print
     * a conflict count that belongs to some other divergence. The names are the caller's to
     * supply, because only the caller knows which branches the two agents actually landed on.
     */
    const realRefs = refArgs
      .map((spec) => {
        const comma = spec.indexOf(',')
        if (comma < 0) return { ref: spec, label: spec.replace(/^refs\/remotes\//, '') }
        return { ref: spec.slice(0, comma).trim(), label: spec.slice(comma + 1).trim() }
      })
      .filter((entry) => entry.ref.length > 0)
    const resolved = []
    for (const { ref, label } of realRefs) {
      const full = ref.startsWith('refs/') ? ref : `refs/remotes/${ref}`
      const oid = tryGit(['rev-parse', '--verify', '-q', full], source)
      if (oid.ok && oid.out.trim()) resolved.push({ label, ref: full, branch: label.replace(/[^a-z0-9]+/gi, '-'), oid: oid.out.trim() })
    }
    let realMerge = null
    if (resolved.length === 2) {
      for (const entry of resolved) git(['update-ref', `refs/heads/${entry.branch}`, entry.oid], repo)
      const preview = mergeTreePreview(repo, resolved[0].branch, resolved[1].branch)
      realMerge = {
        labels: resolved.map((entry) => entry.label),
        message: preview.message,
        supported: preview.supported,
        paths: conflictPaths(preview.conflicts),
      }
    }

    /* ---- the report ---- */
    const mergeConflicts = mergePreview?.supported ? conflictPaths(mergePreview.conflicts) : []
    const before = {
      label: 'git',
      headline: mergePreview?.supported
        ? mergePreview.clean
          ? 'merges cleanly — 0 conflicts'
          : `${mergeConflicts.length} file(s) in conflict`
        : reconstructed.ok
          ? 'merge-tree unavailable'
          : 'no answer for these two writes',
      tone: mergePreview?.supported ? (mergePreview.clean ? 'clear' : 'danger') : 'warn',
      facts: [
        { label: 'asked to', value: 'merge the two sessions’ versions of one file' },
        {
          label: 'conflicts',
          value: mergePreview?.supported ? String(mergeConflicts.length) : 'not computed',
          mono: true,
        },
        {
          label: 'the two edits are',
          value: reconstructed.gapLines === null || !reconstructed.ok
            ? 'unknown'
            : `${reconstructed.gapLines} line(s) apart in the shared file`,
        },
        { label: 'can only answer', value: 'at merge time — both sides committed, someone starts a merge' },
        {
          label: 'when those branches did meet',
          value: realMerge
            ? `${realMerge.paths.length} file(s) conflicted (${realMerge.labels.join(' vs ')})`
            : refArgs.length === 2
              ? 'neither ref resolved in this repository'
              : 'not asked — pass --refs to include it',
        },
      ],
      command: mergePreview?.supported ? 'git merge-tree --write-tree agentgit/task-a agentgit/task-b' : null,
      raw: mergePreview?.supported
        ? `${mergePreview.message}\n${mergePreview.tree ?? ''}`
        : reconstructed.ok
          ? mergePreview?.message ?? null
          : reconstructed.why,
      observed: true,
    }

    const otherOpening = candidate.a.openingIntent ?? ''
    const otherCarried = verdict.evidence.competitors[0]?.intents?.[0] ?? candidate.a.intent
    const after = {
      label: 'AgenticGit',
      headline: `${verdict.verdict} — ${verdict.evidence.detection}`,
      tone: verdict.verdict === 'review' ? 'danger' : 'warn',
      facts: [
        { label: 'verdict', value: verdict.verdict, mono: true },
        { label: 'detection', value: verdict.evidence.detection, mono: true },
        { label: 'other task', value: verdict.evidence.otherTasks.join(', ') || '(none)', mono: true },
        { label: 'asked at', value: shortStamp(verdict.decidedAt), mono: true },
        { label: 'the other write was', value: `${humanGap(candidate.gapSeconds)} earlier` },
        {
          label: 'that task opened with',
          value: otherOpening.length > 96 ? `${otherOpening.slice(0, 96)}…` : otherOpening || '(nothing recorded)',
        },
      ],
      quote: otherCarried
        ? {
            text: otherCarried,
            attribution: `task ${verdict.evidence.otherTasks[0] ?? candidate.a.sessionId}, the instruction the ledger carried at that moment`,
          }
        : null,
      raw: verdict.reason,
      observed: true,
    }

    const timeline = [
      {
        at: shortStamp(candidate.a.patchAt),
        who: `session ${candidate.a.sessionId.slice(0, 8)} (a)`,
        what: `writes ${candidate.path}: +${candidate.a.addedLines}/-${candidate.a.removedLines}`,
        kind: 'write',
      },
      {
        at: shortStamp(candidate.b.patchAt),
        who: 'AgenticGit answers, before the write',
        what: `${verdict.verdict}: ${verdict.reason.slice(0, 170)}`,
        kind: 'verdict',
      },
      {
        at: shortStamp(candidate.b.patchAt),
        who: `session ${candidate.b.sessionId.slice(0, 8)} (b)`,
        what: `writes ${candidate.path}: +${candidate.b.addedLines}/-${candidate.b.removedLines}`,
        kind: 'write',
      },
    ]
    /*
     * Order is explicit rather than sorted, because two of the entries are not timestamps
     * and a comparator over display strings would silently place them anywhere. The order
     * below is the order the events happened in.
     */
    if (reconstructed.ok && reconstructed.mode === 'reversed') {
      timeline.push({
        at: shortStamp(new Date(reconstructed.committedAt).toISOString()),
        who: 'git',
        what:
          `both sessions’ changes land in the same commit ${reconstructed.revision.slice(0, 8)}, ` +
          `${humanGap(Math.round((Date.parse(reconstructed.committedAt) - Date.parse(candidate.b.patchAt)) / 1000))} after the second write — ` +
          'so there was never a merge for git to check',
        kind: 'merge',
      })
    }
    if (realMerge) {
      timeline.push({
        at: 'much later, at the end of the divergence',
        who: 'git',
        what: `${realMerge.message}; ${realMerge.paths.length} file(s) conflicted across ${realMerge.labels.join(' vs ')}`,
        kind: 'merge',
      })
    }

    const view = {
      workspace: source,
      title: `Two sessions, one file, ${humanGap(candidate.gapSeconds)} apart`,
      subtitle: 'found by scanning this machine’s own agent transcripts, not chosen by hand',
      generatedAt: new Date().toISOString(),
      provenance: [
        { label: 'case', value: candidate.id },
        { label: 'session a', value: candidate.a.sessionId },
        { label: 'session b', value: candidate.b.sessionId },
        { label: 'patch source', value: `${candidate.a.patchSource} / ${candidate.b.patchSource}` },
        { label: 'ledger replayed', value: `${played.events} events, truncated at the question` },
        {
          label: 'reconstruction',
          value: reconstructed.ok
            ? `${reconstructed.mode} from ${reconstructed.revision.slice(0, 8)} (${String(reconstructed.committedAt).slice(0, 16)})` +
              `${reconstructed.verified ? ', verified by re-applying both patches forward' : ''}`
            : `unavailable: ${reconstructed.why}`,
        },
        { label: 'attempts before this', value: String(attempts.length) },
      ],
      before,
      after,
      timeline,
      honesty: honestyNotes({ candidate, verdict, reconstructed, realMerge }),
    }

    const outDir = value('out', defaultStoryDir(source))
    const artifact = writeStory(view, outDir)
    process.stdout.write(`${artifact.path}\n`)
    process.stdout.write(`${artifact.reference}\n`)
    process.stderr.write(
      `\ncase ${candidate.id}\n` +
        `  ${candidate.path} in ${source}\n` +
        `  gap      ${humanGap(candidate.gapSeconds)}\n` +
        `  verdict  ${verdict.verdict} (${verdict.evidence.detection})\n` +
        `  merge    ${mergePreview?.supported ? (mergePreview.clean ? 'clean, 0 conflicts' : `${mergeConflicts.length} conflicts`) : `unavailable: ${reconstructed.ok ? 'merge-tree unsupported' : reconstructed.why}`}\n` +
        `  report   ${artifact.bytes} bytes\n` +
        `  skipped  ${attempts.length} candidate(s) before this one\n`,
    )
    return 0
  } finally {
    if (!flag('keep')) rmSync(workDir, { recursive: true, force: true })
    else process.stderr.write(`\ntemp repository kept at ${workDir}\n`)
  }
}

process.exitCode = await main()

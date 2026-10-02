/**
 * Recover the file effects of shell commands the hook could not see.
 *
 * The gap this closes
 * -------------------
 * `track.mjs` records a `file_write` only when a *named* write tool carries the path. A shell
 * command — `python gen.py > module.py`, `sed -i`, `Set-Content`, a code generator — is opaque
 * to a static reader, so the hook records `kind: 'command'` with no entity and the ledger says
 * nothing about the file that changed. On a session written mostly through the shell the
 * ledger is empty of exactly the writes it exists to describe.
 *
 * The recovery is post-hoc and out of the write path: the hook must stay constant work, so the
 * reconciliation happens in the daemon, where a `git status` and a ledger read are already
 * affordable, and where a mistake cannot break a tool call.
 *
 * How a write is attributed
 * -------------------------
 * There is no way to observe *which* command produced a file, so this does not pretend to. It
 * reports a newly-changed path against the most recent shell command still inside
 * {@link SHELL_ATTRIBUTION_WINDOW_MS}, and says so in `detail.attribution =
 * 'post-hoc-diff'` with the command's event id. That is a weaker claim than a recorded write —
 * an editor save in the same window would be misattributed — and it is labelled as such rather
 * than passed off as an observation.
 *
 * Determinism and testability
 * ---------------------------
 * Everything decidable is a pure function over `git status` output and the event stream. The
 * runner reads the repo and the state file; the parsing, the diff and the attribution take
 * their inputs as arguments, so they are tested with no repository and no clock.
 *
 * @module @agentgit/core/reconcile
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { isRepo, statusShortAll } from './git.ts'
import { buildEvent, compareCodepoint, toWire } from './ledger.ts'
import type { CoordEvent } from './types.ts'
import { appendEvent, readAllEvents, AGENTGIT_DIR, type WorkspacePaths } from './workspace.ts'

/** Where the last observed working tree is remembered, so a tick reports only what is new. */
export const WRITES_SEEN_FILE = 'writes-seen.json'

/** Shape version of {@link WRITES_SEEN_FILE}. A mismatch is read as "no snapshot yet". */
export const WRITES_SEEN_VERSION = 1

/**
 * How long after a shell command its file effects are still attributed to it.
 *
 * Generous on purpose: a generator can run for a while, and the cost of a wide window is a
 * misattribution label that is already disclosed, while the cost of a narrow one is a write
 * that never enters the ledger at all.
 */
export const SHELL_ATTRIBUTION_WINDOW_MS = 120_000

/** `hostEvent` on a reconciled write. Greppable, and cannot collide with a hook's own. */
export const RECONCILE_HOST_EVENT = 'daemon/reconcile'

/** One path as `git status` last reported it, plus the stat that detects a later change. */
export interface WorkingTreeEntry {
  readonly status: string
  readonly mtimeMs: number
  readonly size: number
}

/** Workspace-relative path to its last observed state. */
export type WorkingTreeSnapshot = Readonly<Record<string, WorkingTreeEntry>>

/** Which command a changed path is being blamed on, and how confidently. */
interface ShellAttribution {
  readonly taskId: string
  readonly sessionId: string
  readonly commandEventId: string
}

/**
 * Undo git's C-quoting of a path.
 *
 * `core.quotePath` is on by default, so a path with a space or a non-ASCII byte arrives
 * wrapped in double quotes with backslash escapes. Reading it raw would name a file that does
 * not exist, which is worse than not naming it: the ledger would carry a path nothing can match.
 */
function unquoteGitPath(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed
  return trimmed
    .slice(1, -1)
    .replace(/\\(["\\])/g, '$1')
    .replace(/\\t/g, '\t')
    .replace(/\\n/g, '\n')
}

/** One `git status --porcelain` line to its path and two-character status, or `null`. */
export function parsePorcelainLine(line: string): { path: string; status: string } | null {
  const trimmed = line.replace(/\r$/, '')
  if (trimmed.trim().length === 0) return null
  const status = trimmed.slice(0, 2)
  let rest = trimmed.slice(3)
  if (rest.length === 0) return null
  // A rename reports both names; the one that exists on disk now is the destination.
  const arrow = rest.indexOf(' -> ')
  if (arrow !== -1) rest = rest.slice(arrow + 4)
  return { path: unquoteGitPath(rest), status }
}

/** Stat of one absolute path, or `null` when it is gone. */
export type StatFile = (absolutePath: string) => { mtimeMs: number; size: number } | null

function defaultStat(absolutePath: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = statSync(absolutePath)
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return null
  }
}

/**
 * True for a path inside the coordination directory.
 *
 * The ledger must never record its own files. `.agentgit/events/*.jsonl` changes on every
 * append, so treating it as a workspace write would make each reconciliation produce a change
 * that provokes the next one — a feedback loop that grows the ledger without bound and buries
 * the real work in noise.
 */
function isCoordinationPath(relative: string): boolean {
  const normalized = relative.replace(/\\/g, '/')
  return normalized === AGENTGIT_DIR || normalized.startsWith(`${AGENTGIT_DIR}/`)
}

/**
 * The current dirty set, keyed by workspace-relative path.
 *
 * Only files git already reports are kept. A file that is changed and then committed leaves the
 * set, which is correct: the next edit to it is a new change, and the diff below would miss it
 * if the entry lingered with a stale status.
 */
export function workingTreeSnapshot(
  root: string,
  lines: readonly string[],
  stat: StatFile = defaultStat,
): WorkingTreeSnapshot {
  const out: Record<string, WorkingTreeEntry> = {}
  for (const line of lines) {
    const parsed = parsePorcelainLine(line)
    if (!parsed) continue
    if (isCoordinationPath(parsed.path)) continue
    const absolute = isAbsolute(parsed.path) ? parsed.path : join(root, parsed.path)
    const info = stat(absolute)
    out[parsed.path] = { status: parsed.status, mtimeMs: info?.mtimeMs ?? 0, size: info?.size ?? 0 }
  }
  return out
}

/**
 * Paths that are new, or whose status, size or mtime moved since the last snapshot.
 *
 * mtime is included because a shell command can rewrite a file git already reported as dirty;
 * without it the second write would be invisible and the ledger would record the first only.
 */
export function changedSince(previous: WorkingTreeSnapshot, current: WorkingTreeSnapshot): string[] {
  const out: string[] = []
  for (const [path, entry] of Object.entries(current)) {
    const before = previous[path]
    if (!before) {
      out.push(path)
      continue
    }
    if (before.status !== entry.status || before.mtimeMs !== entry.mtimeMs || before.size !== entry.size) {
      out.push(path)
    }
  }
  return out.sort(compareCodepoint)
}

/**
 * The most recent unattributed shell command still inside the window, or `null`.
 *
 * `coverageGap` is required so this only ever blames a command the hook itself declared opaque.
 * A command whose targets *were* visible already produced a real `file_write`, and attributing
 * its paths a second time would double-count the same change.
 */
export function attributionFor(
  events: readonly CoordEvent[],
  now: Date,
  windowMs = SHELL_ATTRIBUTION_WINDOW_MS,
): ShellAttribution | null {
  const nowMs = now.getTime()
  let best: { at: number; attribution: ShellAttribution } | null = null
  for (const event of events) {
    if (event.kind !== 'command') continue
    if (event.detail?.coverageGap !== true) continue
    if (!event.taskId) continue
    const at = Date.parse(event.timestampUtc)
    if (!Number.isFinite(at) || at < nowMs - windowMs || at > nowMs) continue
    if (best === null || at > best.at) {
      best = {
        at,
        attribution: {
          taskId: event.taskId,
          sessionId: event.sessionId,
          commandEventId: toWire(event).event_id,
        },
      }
    }
  }
  return best?.attribution ?? null
}

/** Where the snapshot lives for one workspace. */
export function writesSeenPath(paths: WorkspacePaths): string {
  return join(paths.state, WRITES_SEEN_FILE)
}

/** The last snapshot, or `null` when none has been written (a first run is not a diff). */
export function readWritesSeen(paths: WorkspacePaths): WorkingTreeSnapshot | null {
  const file = writesSeenPath(paths)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      version?: unknown
      snapshot?: unknown
    }
    if (raw.version !== WRITES_SEEN_VERSION) return null
    if (!raw.snapshot || typeof raw.snapshot !== 'object' || Array.isArray(raw.snapshot)) return null
    const snapshot: Record<string, WorkingTreeEntry> = {}
    for (const [path, entry] of Object.entries(raw.snapshot as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue
      const value = entry as Partial<WorkingTreeEntry>
      snapshot[path] = {
        status: typeof value.status === 'string' ? value.status : '',
        mtimeMs: typeof value.mtimeMs === 'number' ? value.mtimeMs : 0,
        size: typeof value.size === 'number' ? value.size : 0,
      }
    }
    return snapshot
  } catch {
    // A torn snapshot means "start over": one missed attribution is cheaper than a crash in the
    // daemon, and the next tick re-reads the tree anyway.
    return null
  }
}

/** Persist the snapshot, temp-then-rename so a reader never sees a half-written file. */
export function writeWritesSeen(paths: WorkspacePaths, snapshot: WorkingTreeSnapshot): void {
  mkdirSync(paths.state, { recursive: true })
  const file = writesSeenPath(paths)
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify({ version: WRITES_SEEN_VERSION, snapshot })}\n`, 'utf8')
  renameSync(temp, file)
}

export interface ReconcileOptions {
  readonly now?: Date
  readonly windowMs?: number
  /** The `git status --porcelain --untracked-files=all` lines. Injected by tests. */
  readonly statusLines?: readonly string[]
  /** File stat. Injected by tests. */
  readonly statFile?: StatFile
}

export interface ReconcileResult {
  readonly appended: number
  /** Paths this pass saw as changed, whether or not a command could be blamed for them. */
  readonly paths: readonly string[]
}

/**
 * Fold the working tree's new changes back into the ledger as `file_write` events.
 *
 * A first run records the baseline and appends nothing: every file already dirty when the
 * daemon started predates it, and blaming a command for them would be a fabrication. If a
 * change cannot be attributed to any command in the window, it is still recorded in the
 * snapshot so a later tick cannot blame a newer command for it.
 */
export function reconcileShellWrites(
  paths: WorkspacePaths,
  options: ReconcileOptions = {},
): ReconcileResult {
  const now = options.now ?? new Date()
  const statusLines =
    options.statusLines ?? (isRepo(paths.root) ? statusShortAll(paths.root) : [])
  const current = workingTreeSnapshot(paths.root, statusLines, options.statFile ?? defaultStat)

  const previous = readWritesSeen(paths)
  if (previous === null) {
    writeWritesSeen(paths, current)
    return { appended: 0, paths: [] }
  }

  const changed = changedSince(previous, current)
  let appended = 0
  if (changed.length > 0) {
    const { events } = readAllEvents(paths)
    const attribution = attributionFor(events, now, options.windowMs)
    if (attribution) {
      for (const path of changed) {
        appendEvent(
          paths,
          buildEvent({
            kind: 'file_write',
            timestampUtc: now.toISOString(),
            sessionId: attribution.sessionId,
            taskId: attribution.taskId,
            entities: [{ kind: 'file', identifier: path, path }],
            hostEvent: RECONCILE_HOST_EVENT,
            reason: 'shell-write-reconciled',
            detail: {
              attribution: 'post-hoc-diff',
              fromCommandEventId: attribution.commandEventId,
              status: current[path]?.status ?? null,
            },
          }),
          now,
        )
        appended += 1
      }
    }
  }

  writeWritesSeen(paths, current)
  return { appended, paths: changed }
}

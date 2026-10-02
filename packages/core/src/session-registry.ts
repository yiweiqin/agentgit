/**
 * Which of the live sessions this process *is*.
 *
 * The problem being solved
 * ------------------------
 * An MCP server is spawned by the host and told very little. When the host does not hand
 * down a session id, the old fallback was "whichever session wrote to the ledger last in the
 * past thirty minutes" — which two windows running at once both satisfy. They then resolve to
 * the *same* id, every verdict is attributed to one of them, and `preflight` reports a task's
 * own work back to it as somebody else's. For a hub whose entire output is "who owns this",
 * a collision here does not degrade the answer, it inverts it.
 *
 * What replaces it
 * ----------------
 * The ledger already records, for every session, when it was last seen and the working
 * directory it reported. That is enough to *claim* one of them rather than guess:
 *
 * 1. Sessions are derived from the ledger, so no hook had to learn a new trick.
 * 2. A session already claimed by a live process is not offered again. Claims are exclusive
 *    files, so two servers starting at the same instant cannot both take one.
 * 3. Candidates are ranked by working directory first, because the MCP server inherits the
 *    session's directory and that is a real discriminator rather than a recency race.
 * 4. Nothing available means a per-process id (`mcp-<machine>-<pid>`) instead of a shared
 *    one, so two windows are at worst *both wrong* rather than certainly identical.
 *
 * A claim is a heuristic and is reported as one: `agentgit_whoami` says which rung answered,
 * so a user can see for themselves why two agents look like one instead of being told to pass
 * a parameter they do not have.
 *
 * @module @agentgit/core/session-registry
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { compareCodepoint } from './ledger.ts'
import { isHubEvent } from './hub.ts'
import { rootKey } from './paths.ts'
import { machineId, readAllEvents, type WorkspacePaths } from './workspace.ts'
import type { CoordEvent } from './types.ts'

/** Where claims live, under `state/`. */
export const CLAIMS_DIRNAME = 'sessions'

/** How far back a session is still a candidate for claiming. */
export const CLAIM_WINDOW_MINUTES = 30

/** One session the ledger knows about, as a claiming candidate. */
export interface SessionCandidate {
  readonly sessionId: string
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  /** The directory the session reported, which is what the MCP server can be matched on. */
  readonly cwd: string | null
  readonly tasks: readonly string[]
}

/** What one process recorded when it claimed a session. */
export interface SessionClaimFile {
  readonly version: number
  readonly sessionId: string
  readonly pid: number
  /**
   * When the claiming process started, in epoch milliseconds.
   *
   * Stored so a reused pid is detectable: if the file names this pid but a different start
   * time, the process that wrote it is gone and a new process merely inherited its number.
   */
  readonly startedAt: number
  readonly claimedAt: string
  readonly cwd: string | null
}

/** Session ids nobody claims are still sessions; this is only about *attribution*. */
export function sessionFileName(sessionId: string): string {
  const readable = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 8)
  return `${readable || 'session'}-${digest}.claim.json`
}

function claimsDir(paths: WorkspacePaths): string {
  return join(paths.state, CLAIMS_DIRNAME)
}

/**
 * Every session the ledger knows about, newest first.
 *
 * Sessions the hub itself wrote are excluded: the hub records a ruling under its own
 * `hub:<machine>` session, and letting that become a claimable candidate would let a window
 * attribute its writes to the hub.
 */
export function deriveSessions(
  events: readonly CoordEvent[],
  options: { readonly windowMinutes?: number; readonly now?: Date } = {},
): SessionCandidate[] {
  const windowMinutes = options.windowMinutes ?? CLAIM_WINDOW_MINUTES
  const now = options.now ?? new Date()
  const cutoff = now.getTime() - windowMinutes * 60_000

  const bySession = new Map<string, { first: string; last: string; cwd: string | null; tasks: Set<string> }>()
  for (const event of events) {
    if (!event.sessionId || isHubEvent(event)) continue
    const at = Date.parse(event.timestampUtc)
    if (Number.isFinite(at) && at < cutoff) continue

    const entry = bySession.get(event.sessionId) ?? { first: event.timestampUtc, last: event.timestampUtc, cwd: null, tasks: new Set<string>() }
    if (compareCodepoint(event.timestampUtc, entry.first) < 0) entry.first = event.timestampUtc
    if (compareCodepoint(event.timestampUtc, entry.last) > 0) entry.last = event.timestampUtc
    // Only ever set from a record that carries one; `track.mjs` writes it on every hook event.
    const cwd = event.detail?.cwd
    if (entry.cwd === null && typeof cwd === 'string' && cwd !== '') entry.cwd = cwd
    if (event.taskId) entry.tasks.add(event.taskId)
    bySession.set(event.sessionId, entry)
  }

  return [...bySession.entries()]
    .map(([sessionId, entry]) => ({
      sessionId,
      firstSeenAt: entry.first,
      lastSeenAt: entry.last,
      cwd: entry.cwd,
      tasks: [...entry.tasks].sort(compareCodepoint),
    }))
    .sort((a, b) => compareCodepoint(b.lastSeenAt, a.lastSeenAt) || compareCodepoint(a.sessionId, b.sessionId))
}

/** Read every claim file, tolerating a torn or unreadable one. */
export function loadClaims(paths: WorkspacePaths): SessionClaimFile[] {
  const dir = claimsDir(paths)
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.claim.json'))
  } catch {
    return []
  }
  const out: SessionClaimFile[] = []
  for (const name of names) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<SessionClaimFile>
      if (!raw || typeof raw.sessionId !== 'string' || typeof raw.pid !== 'number') continue
      out.push({
        version: typeof raw.version === 'number' ? raw.version : 1,
        sessionId: raw.sessionId,
        pid: raw.pid,
        startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
        claimedAt: typeof raw.claimedAt === 'string' ? raw.claimedAt : '',
        cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
      })
    } catch {
      // A torn claim must not take the identity path down: the consequence of ignoring it is
      // one extra candidate offered, which the exclusive create below still arbitrates.
    }
  }
  return out.sort((a, b) => compareCodepoint(a.sessionId, b.sessionId))
}

/**
 * Is the process that wrote this claim still running?
 *
 * `process.kill(pid, 0)` sends no signal and only asks the OS whether the process exists;
 * `EPERM` means it exists and belongs to somebody else, which is still alive. Anything else
 * is a claim by a process that is gone, and a claim nobody is using must not keep a session
 * out of circulation.
 */
export function defaultPidIsAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface ClaimInput {
  readonly pid: number
  /** Epoch milliseconds when this process started. */
  readonly startedAt: number
  readonly at?: Date
  /** The directory this process sees, matched against what the session reported. */
  readonly cwd?: string | null
  readonly windowMinutes?: number
  /** Injectable so a test can describe a machine's process table without owning one. */
  readonly pidIsAlive?: (claim: SessionClaimFile) => boolean
  readonly now?: Date
}

export type ClaimSource = 'existing' | 'registry' | 'fallback'

export interface ClaimedSession {
  readonly sessionId: string
  readonly source: ClaimSource
  /** Which rung answered, in words, for `agentgit_whoami`. */
  readonly explanation: string
}

function claimPath(paths: WorkspacePaths, sessionId: string): string {
  return join(claimsDir(paths), sessionFileName(sessionId))
}

/**
 * Write a claim only if nobody else holds that session.
 *
 * `wx` is the whole arbitration: two servers that both picked the same candidate cannot both
 * create the file, so the loser moves on to its next choice instead of silently sharing an
 * identity. That is the single-writer property this module exists for.
 */
function tryCreateClaim(paths: WorkspacePaths, claim: SessionClaimFile): boolean {
  try {
    mkdirSync(claimsDir(paths), { recursive: true })
    writeFileSync(claimPath(paths, claim.sessionId), `${JSON.stringify(claim, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })
    return true
  } catch {
    return false
  }
}

function dropClaim(paths: WorkspacePaths, sessionId: string): void {
  try {
    rmSync(claimPath(paths, sessionId), { force: true })
  } catch {
    // Reclaiming is best-effort: a claim we cannot delete is one we simply will not take.
  }
}

/** True when this claim was written by *this* process instance rather than a predecessor. */
function isMine(claim: SessionClaimFile, input: ClaimInput): boolean {
  return claim.pid === input.pid && claim.startedAt === input.startedAt
}

/**
 * Claim the session this process most plausibly is.
 *
 * Idempotent: calling it again in the same process returns the same answer without touching
 * the filesystem, which matters because it runs on the first tool call of every session.
 */
export function claimSession(paths: WorkspacePaths, input: ClaimInput): ClaimedSession {
  const now = input.now ?? input.at ?? new Date()
  const isAlive = input.pidIsAlive ?? ((claim: SessionClaimFile) => defaultPidIsAlive(claim.pid))
  const claims = loadClaims(paths)

  const mine = claims.find((claim) => isMine(claim, input))
  if (mine) {
    return { sessionId: mine.sessionId, source: 'existing', explanation: 'a claim this process already made' }
  }

  // Reclaim first, so a crashed window's session becomes available again instead of waiting
  // for a window that will never close.
  for (const claim of claims) {
    /*
     * A claim naming *this* pid with a different start time belongs to a predecessor.
     *
     * The process table cannot answer this: the pid is alive, because it is ours. But the
     * number was recycled, and the process that wrote the claim is gone. Without this check the
     * session would be held forever by a claim nothing can ever release — the exact wedge a
     * lease-style expiry exists to avoid.
     */
    if (claim.pid === input.pid && claim.startedAt !== input.startedAt) {
      dropClaim(paths, claim.sessionId)
      continue
    }
    if (!isAlive(claim)) dropClaim(paths, claim.sessionId)
  }
  const held = new Set(
    loadClaims(paths)
      .filter((claim) => !isMine(claim, input))
      .map((claim) => claim.sessionId),
  )

  const { events } = readAllEvents(paths)
  const candidates = deriveSessions(events, { windowMinutes: input.windowMinutes, now }).filter(
    (candidate) => !held.has(candidate.sessionId),
  )

  /*
   * Working directory first, recency second.
   *
   * The MCP server inherits the session's directory, and `track.mjs` records the directory
   * each session reported, so a match is evidence about *which* session this is. Ordering by
   * recency alone would make the winner a race between two windows that both wrote a second
   * ago, which is the failure this module replaces.
   */
  const wanted = input.cwd ?? null
  const wantedKey = wanted === null ? null : rootKey(wanted)
  const ranked = [...candidates].sort((a, b) => {
    if (wantedKey !== null) {
      // Compared by identity, not by the recorded spelling: a session started as `c:\users\me`
      // and a server reporting `C:\Users\me` are the same directory on Windows, and a string
      // comparison made them two - which sent the session id to the wrong window.
      const aMatch = a.cwd !== null && rootKey(a.cwd) === wantedKey ? 1 : 0
      const bMatch = b.cwd !== null && rootKey(b.cwd) === wantedKey ? 1 : 0
      if (aMatch !== bMatch) return bMatch - aMatch
    }
    return compareCodepoint(b.lastSeenAt, a.lastSeenAt) || compareCodepoint(a.sessionId, b.sessionId)
  })

  const stamp = now.toISOString()
  for (const candidate of ranked) {
    const claim: SessionClaimFile = {
      version: 1,
      sessionId: candidate.sessionId,
      pid: input.pid,
      startedAt: input.startedAt,
      claimedAt: stamp,
      cwd: wanted,
    }
    if (tryCreateClaim(paths, claim)) {
      const matched = wantedKey !== null && candidate.cwd !== null && rootKey(candidate.cwd) === wantedKey
      return {
        sessionId: candidate.sessionId,
        source: 'registry',
        explanation:
          `a session recorded in this workspace's ledger and not claimed by another live process` +
          (matched ? ', whose working directory matches this server' : ''),
      }
    }
  }

  /*
   * Nothing to claim.
   *
   * A per-process id, not a per-machine one. The old placeholder was identical for every MCP
   * server on the machine, so two windows with no ledger history were *guaranteed* to look
   * like one agent. An id that cannot be shared is worth more than a tidy one.
   */
  const fallback = `mcp-${machineId()}-${input.pid}`
  const claim: SessionClaimFile = {
    version: 1,
    sessionId: fallback,
    pid: input.pid,
    startedAt: input.startedAt,
    claimedAt: stamp,
    cwd: wanted,
  }
  if (!tryCreateClaim(paths, claim)) {
    // A stale file from a previous process that held this pid. Ours now, and nothing else
    // could legitimately hold a pid-scoped id.
    dropClaim(paths, fallback)
    tryCreateClaim(paths, claim)
  }
  return {
    sessionId: fallback,
    source: 'fallback',
    explanation: 'no unclaimed session in this workspace, so this process uses its own id',
  }
}

/* -------------------------------------------------------------------------- */
/* Process-wide cache                                                          */
/* -------------------------------------------------------------------------- */

const cached = new Map<string, ClaimedSession>()

/**
 * {@link claimSession} remembered for the life of the process.
 *
 * A window is one process and one session, so resolving this per tool call would be wasted
 * work on the hot path and would risk a session changing identity mid-conversation.
 */
export function claimSessionOnce(paths: WorkspacePaths, input: ClaimInput): ClaimedSession {
  const key = paths.root
  const existing = cached.get(key)
  if (existing) return existing
  const claimed = claimSession(paths, input)
  cached.set(key, claimed)
  return claimed
}

/** Drop the cache. Exported for tests, which share a process across many workspaces. */
export function forgetClaimedSessions(): void {
  cached.clear()
}

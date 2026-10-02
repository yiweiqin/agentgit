/**
 * Read Codex session rollouts into coordination events.
 *
 * Why this exists
 * ---------------
 * A hook sees a tool call but not the reason for it. The reason lives in the
 * session transcript: the user's instruction, the agent's plan, and the fact that
 * the conversation was compacted halfway through. Without that, the coordinator
 * knows a file was written but not what it was for, which is exactly the knowledge
 * a duplicate check needs.
 *
 * Two deliberate choices
 * ----------------------
 * **Backfill, never double-count.** The hook records a write when a tool runs; this
 * module records the same write from the transcript. A file change is therefore
 * skipped when a hook event already covers the same session and path inside a time
 * window. Adoption fills coverage gaps — tools a hook cannot see, and sessions that
 * ran before the plugin was installed — rather than inflating every touch count.
 *
 * **The transcript format is an internal format.** It is parsed defensively, and a
 * shape this module does not recognise produces fewer events rather than an error.
 * The plugin must keep working when Codex changes its record layout, so nothing here
 * is allowed to throw out of a hook or a daemon tick.
 *
 * @module @agentgit/core/codex-rollout
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { buildEvent, toWire } from './ledger.ts'
import { isCheckMessage } from './checks.ts'
import { isWithinRoot } from './paths.ts'
import type { CoordEvent, Entity } from './types.ts'
import { appendEvent, readAllEvents, toWorkspaceRelative, type WorkspacePaths } from './workspace.ts'

/** Where Codex keeps session transcripts, honouring `CODEX_HOME`. */
export function codexHome(): string {
  const configured = process.env.CODEX_HOME?.trim()
  return configured && configured.length > 0 ? configured : join(homedir(), '.codex')
}

/** `<home>/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`. */
export function sessionsRoot(home: string = codexHome()): string {
  return join(home, 'sessions')
}

/**
 * Every rollout file, newest last.
 *
 * Walks the date directories rather than globbing, because the nesting is the only
 * bounded part of the layout: a repository can accumulate thousands of sessions and
 * a recursive scan would stat all of them on every daemon tick.
 *
 * The walk is memoized for {@link ROLLOUT_LISTING_TTL_MS}. The daemon calls this every
 * fifteen seconds to adopt sessions, and re-reading the same date tree four times a minute
 * buys nothing: a session that appears in the meantime is picked up on the next walk, which
 * is a minute of extra latency on a *backfill* path — the live session is already recorded by
 * its own hook. A one-shot caller (the CLI, the board) starts with an empty cache, so only a
 * long-lived process ever sees the memo.
 */
export function listRolloutFiles(home: string = codexHome(), maxDays = 14): string[] {
  const key = `${home}\u0000${maxDays}`
  const now = Date.now()
  const cached = listingCache.get(key)
  if (cached && now - cached.at < ROLLOUT_LISTING_TTL_MS) return cached.files
  const files = walkRolloutFiles(home, maxDays)
  listingCache.set(key, { at: now, files })
  // Bounded: one entry per distinct sessions root, of which a machine has a handful.
  if (listingCache.size > ROLLOUT_LISTING_MAX) {
    const oldest = listingCache.keys().next().value
    if (oldest !== undefined) listingCache.delete(oldest)
  }
  return files
}

function walkRolloutFiles(home: string, maxDays: number): string[] {
  const root = sessionsRoot(home)
  if (!existsSync(root)) return []
  const files: string[] = []
  const years = safeDirs(root).sort().slice(-2)
  for (const year of years) {
    const months = safeDirs(join(root, year)).sort().slice(-4)
    for (const month of months) {
      const days = safeDirs(join(root, year, month)).sort().slice(-maxDays)
      for (const day of days) {
        const dir = join(root, year, month, day)
        for (const name of safeDirs(dir, false)) {
          if (name.endsWith('.jsonl')) files.push(join(dir, name))
        }
      }
    }
  }
  return files.sort()
}

function safeDirs(dir: string, directories = true): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => (directories ? entry.isDirectory() : entry.isFile()))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

export interface RolloutFileChange {
  readonly at: string
  readonly absolutePath: string
  readonly path: string
  readonly kind: string
}

export interface RolloutCommand {
  readonly at: string
  readonly command: string
}

export interface RolloutMessage {
  readonly at: string
  readonly text: string
}

export interface RolloutTokenDrop {
  readonly at: string
  readonly fromTokens: number
  readonly toTokens: number
}

export interface RolloutSession {
  readonly sessionId: string
  readonly path: string
  readonly cwd: string | null
  readonly workspaceRoots: readonly string[]
  readonly startedAt: string | null
  readonly updatedAt: string | null
  readonly contextWindowId: string | null
  readonly userMessages: readonly RolloutMessage[]
  readonly fileChanges: readonly RolloutFileChange[]
  readonly commands: readonly RolloutCommand[]
  readonly tokenDrops: readonly RolloutTokenDrop[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * A drop in input tokens large enough that the conversation cannot still be intact.
 *
 * This is an **inference**, and it is labelled as one everywhere it surfaces. Codex
 * rollouts carry no compaction record, so the only observable trace of a context
 * reset is that the next request's input is a fraction of the previous one. A ratio
 * of one half is chosen because ordinary turns only ever grow; a halving has no
 * benign explanation in this record.
 */
const TOKEN_DROP_RATIO = 0.5
/** Below this the numbers are startup noise, not a conversation worth resetting. */
const TOKEN_DROP_FLOOR = 8_000

/**
 * The command text of a `CommandExecution`, from whichever shape it arrives in.
 *
 * The live format is an argv array — `["pwsh", "-Command", "…"]` — and this used to read
 * only a string, or an object's `command` field. Both are null for every record in a real
 * transcript, so every adopted shell command was dropped in silence. That is the one gap
 * adoption exists to fill: the hook cannot see what a shell command touches, which is why
 * an opaque command is recorded as an explicit coverage gap rather than skipped.
 *
 * `parsed_cmd` looks like the structured answer and is not: it is present on every record
 * and always empty.
 */
function commandTextOf(item: Record<string, unknown>): string | null {
  const direct = str(item.command)
  if (direct) return direct
  const argv = item.command
  if (Array.isArray(argv)) {
    const parts = argv.filter((part): part is string => typeof part === 'string' && part.length > 0)
    if (parts.length > 0) return parts.join(' ')
  }
  return str(asRecord(item.command)?.command)
}

function timestampOf(record: Record<string, unknown>): string {
  return str(record.timestamp) ?? new Date(0).toISOString()
}

/**
 * Parse one rollout file.
 *
 * Tolerant by construction: an unreadable or partial file yields whatever was
 * legible, because a session that is being written right now is the normal case and
 * must not blank the view for everyone else in the workspace.
 */
export function parseRollout(file: string): RolloutSession | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  return parseRolloutText(text, file)
}

/**
 * Parse rollout text a caller has already read.
 *
 * The transcript pool is gigabytes, and a study that reads it twice — once for the
 * session and once for the patch bodies — spends half its wall clock on the second
 * read. Letting the caller hand in the text it already holds keeps the module's
 * single implementation of the format while making one pass possible.
 */
export function parseRolloutText(text: string, file: string): RolloutSession | null {
  let sessionId: string | null = null
  let cwd: string | null = null
  let contextWindowId: string | null = null
  let startedAt: string | null = null
  let updatedAt: string | null = null
  const workspaceRoots: string[] = []
  const userMessages: RolloutMessage[] = []
  const fileChanges: RolloutFileChange[] = []
  const commands: RolloutCommand[] = []
  const tokenDrops: RolloutTokenDrop[] = []

  let highWaterTokens = 0
  let previousInput = 0

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    const type = str(record.type)
    const payload = asRecord(record.payload)
    if (!payload) continue
    const at = timestampOf(record)
    if (updatedAt === null || at > updatedAt) updatedAt = at

    if (type === 'session_meta') {
      sessionId = str(payload.session_id) ?? str(payload.id) ?? sessionId
      cwd = str(payload.cwd) ?? cwd
      startedAt = str(payload.timestamp) ?? startedAt
      const window = asRecord(payload.context_window)
      contextWindowId = str(window?.window_id) ?? contextWindowId
      if (Array.isArray(payload.runtime_workspace_roots)) {
        for (const root of payload.runtime_workspace_roots) {
          const value = str(root)
          if (value && !workspaceRoots.includes(value)) workspaceRoots.push(value)
        }
      }
      continue
    }

    if (type === 'turn_context') {
      const window = asRecord(payload.context_window)
      contextWindowId = str(window?.window_id) ?? contextWindowId
      continue
    }

    if (type !== 'event_msg') continue

    const eventType = str(payload.type)

    if (eventType === 'item_completed') {
      const item = asRecord(payload.item)
      if (!item) continue
      const itemType = str(item.type)

      if (itemType === 'UserMessage') {
        const content = Array.isArray(item.content) ? item.content : []
        const parts: string[] = []
        for (const entry of content) {
          const block = asRecord(entry)
          const value = str(block?.text)
          if (value) parts.push(value)
        }
        const text2 = parts.join('\n').trim()
        if (text2) userMessages.push({ at, text: text2 })
        continue
      }

      if (itemType === 'FileChange') {
        const changes = asRecord(item.changes)
        if (!changes) continue
        for (const [absolutePath, raw] of Object.entries(changes)) {
          const change = asRecord(raw)
          fileChanges.push({
            at,
            absolutePath,
            path: absolutePath,
            kind: str(change?.type) ?? 'update',
          })
        }
        continue
      }

      if (itemType === 'CommandExecution') {
        const command = commandTextOf(item)
        if (command) commands.push({ at, command })
        continue
      }

      continue
    }

    if (eventType === 'token_count') {
      const info = asRecord(payload.info)
      const last = asRecord(info?.last_token_usage)
      const input = num(last?.input_tokens) ?? 0
      if (input > 0) {
        if (
          previousInput >= TOKEN_DROP_FLOOR &&
          input < previousInput * TOKEN_DROP_RATIO &&
          highWaterTokens >= TOKEN_DROP_FLOOR
        ) {
          tokenDrops.push({ at, fromTokens: previousInput, toTokens: input })
        }
        highWaterTokens = Math.max(highWaterTokens, input)
        previousInput = input
      }
      continue
    }
  }

  if (!sessionId) return null
  return {
    sessionId,
    path: file,
    cwd,
    workspaceRoots,
    startedAt,
    updatedAt,
    contextWindowId,
    userMessages,
    fileChanges,
    commands,
    tokenDrops,
  }
}

/**
 * Whether a session belongs to a workspace, by containment on path boundaries.
 *
 * Delegates to {@link isWithinRoot} so the one place that decides directory identity also
 * decides containment: on Windows `c:\repo` and `C:\Repo` are one directory, and a
 * case-sensitive comparison here made a session invisible to its own workspace.
 */
const isWithin = isWithinRoot

/**
 * Sessions belonging to one workspace.
 *
 * Membership is containment rather than equality, and it is checked in both directions.
 *
 * - A session started *inside* the workspace belongs to it. This is the ordinary case, since
 *   an agent is usually started somewhere in the project, and the equality check this
 *   replaces missed every one of them: a session running in `src/auth` contributed nothing
 *   to the repository it was working in, while the comment above claimed otherwise. A
 *   `resolve()` call on both sides does not fix that on its own — it only makes the
 *   comparison exact.
 * - A session started *above* the workspace — at a repository root, when the workspace is a
 *   package inside it — belongs to it too. The ledger refuses entities outside the
 *   workspace (`toWorkspaceRelative` returns null for them), so adopting such a session
 *   records exactly the writes that landed here and nothing else.
 *
 * A sibling that merely shares a prefix (`/repo-other` against `/repo`) is not inside it,
 * which is why this compares path boundaries instead of string prefixes.
 */
const rolloutCache = new Map<string, { size: number; mtime: number; session: RolloutSession | null }>()

/** Cap on parsed sessions kept in memory. See {@link rememberRollout} for the eviction rule. */
const ROLLOUT_CACHE_MAX = 256

/** How long a directory listing is trusted before the date tree is walked again. */
export const ROLLOUT_LISTING_TTL_MS = 60_000

/** How many distinct sessions roots are memoized. */
const ROLLOUT_LISTING_MAX = 8

const listingCache = new Map<string, { at: number; files: string[] }>()

/**
 * Remember one parsed rollout, evicting the least recently used when full.
 *
 * The obvious alternative — clearing the whole cache once it passes the cap — was a cliff:
 * a workspace with more rollouts than the cap re-parsed every file on every tick, and the
 * parse is the expensive part (reading and parsing the whole transcript, not stat-ing it).
 * Evicting one entry keeps a hot set resident and makes the steady-state cost proportional
 * to what actually changed.
 */
function rememberRollout(file: string, size: number, mtime: number, session: RolloutSession | null): void {
  // Re-inserting moves the key to the end, which is what makes `Map` insertion order an LRU
  // order. Without this an entry read every tick but written once would still be evicted first.
  rolloutCache.delete(file)
  rolloutCache.set(file, { size, mtime, session })
  if (rolloutCache.size > ROLLOUT_CACHE_MAX) {
    const oldest = rolloutCache.keys().next().value
    if (oldest !== undefined) rolloutCache.delete(oldest)
  }
}

/**
 * Drop every memoized listing and parsed session.
 *
 * Exported for tests, which create a fresh scratch sessions root per case and must not inherit
 * the previous one's memo.
 */
export function resetRolloutCaches(): void {
  listingCache.clear()
  rolloutCache.clear()
}

export function sessionsForWorkspace(root: string, home: string = codexHome(), updatedSince = -Infinity): RolloutSession[] {
  const target = resolve(root)
  const out: RolloutSession[] = []
  for (const file of listRolloutFiles(home)) {
    let signature
    try { signature = statSync(file) } catch { continue }
    if (signature.mtimeMs < updatedSince) continue
    const cached = rolloutCache.get(file)
    const session = cached?.size === signature.size && cached.mtime === signature.mtimeMs
      ? cached.session : parseRollout(file)
    rememberRollout(file, signature.size, signature.mtimeMs, session)
    if (!session) continue
    const candidates = [session.cwd, ...session.workspaceRoots].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
    const belongs = candidates.some((candidate) => isWithin(target, candidate) || isWithin(candidate, target))
    if (belongs) out.push(session)
  }
  return out
}

/** The intent a session is working on: its first instruction to the agent. */
export function sessionIntent(session: RolloutSession): string | null {
  const first = session.userMessages.find(message => !isCheckMessage(message.text))
  if (!first) return null
  return first.text.replace(/\s+/g, ' ').trim().slice(0, 600) || null
}

export interface AdoptOptions {
  /** How far apart a hook event and a transcript entry may be and still be the same write. */
  readonly dedupeWindowMs?: number
  readonly home?: string
  /** Only adopt sessions updated within this many hours. */
  readonly maxAgeHours?: number
  readonly now?: Date
}

export interface AdoptResult {
  readonly sessions: number
  readonly appended: number
  readonly skippedAsDuplicate: number
  readonly files: readonly string[]
}

/**
 * Fold a workspace's Codex sessions into its ledger.
 *
 * Idempotent: the event id is a content hash, so re-adopting an unchanged transcript
 * adds nothing. It is therefore safe to run on every daemon tick and from any
 * command, with no separate "have I already imported this" bookkeeping to get wrong.
 */
export function adoptWorkspace(
  paths: WorkspacePaths,
  options: AdoptOptions = {},
): AdoptResult {
  const now = options.now ?? new Date()
  const maxAge = (options.maxAgeHours ?? 72) * 3_600_000
  const sessions = sessionsForWorkspace(paths.root, options.home ?? codexHome(), now.getTime() - maxAge)
  const existing = readAllEvents(paths).events
  const seen = new Set(existing.map((event) => toWire(event).event_id))

  let appended = 0
  let skipped = 0
  let considered = 0

  for (const session of sessions) {
    const updated = session.updatedAt ? Date.parse(session.updatedAt) : now.getTime()
    if (Number.isFinite(updated) && now.getTime() - updated > maxAge) continue
    considered += 1
    const result = adoptSession(paths, session, existing, seen, options)
    appended += result.appended
    skipped += result.skipped
  }

  return { sessions: considered, appended, skippedAsDuplicate: skipped, files: [] }
}

/**
 * Adopt one session, returning how many events were new.
 *
 * `existing` is passed in so a caller adopting many sessions reads the ledger once
 * instead of once per session.
 */
export function adoptSession(
  paths: WorkspacePaths,
  session: RolloutSession,
  existing: readonly CoordEvent[] = readAllEvents(paths).events,
  seen: Set<string> = new Set(existing.map((event) => toWire(event).event_id)),
  options: AdoptOptions = {},
): { appended: number; skipped: number } {
  const window = options.dedupeWindowMs ?? 10 * 60_000
  const taskId = session.sessionId
  let appended = 0
  let skipped = 0

  const record = (event: CoordEvent): void => {
    const id = toWire(event).event_id
    if (seen.has(id)) {
      skipped += 1
      return
    }
    seen.add(id)
    appendEvent(paths, event)
    appended += 1
  }

  if (session.startedAt) {
    record(buildEvent({
      kind: 'session_started',
      timestampUtc: session.startedAt,
      sessionId: session.sessionId,
      hostEvent: 'codex/rollout',
      detail: { contextWindowId: session.contextWindowId, source: 'rollout' },
    }))
  }

  const intent = sessionIntent(session)
  if (intent && session.startedAt) {
    record(buildEvent({
      kind: 'task_registered',
      timestampUtc: session.startedAt,
      sessionId: session.sessionId,
      taskId,
      intentText: intent,
      hostEvent: 'codex/rollout',
      detail: { adopted: true },
    }))
  }

  // A message after the first is steering, so it is recorded as a new statement of
  // intent rather than as a separate task. Overwriting the intent is what keeps a
  // duplicate check comparing against what the session is doing *now*.
  for (const message of session.userMessages.filter(message => !isCheckMessage(message.text)).slice(1)) {
    record(buildEvent({
      kind: 'task_registered',
      timestampUtc: message.at,
      sessionId: session.sessionId,
      taskId,
      intentText: message.text.replace(/\s+/g, ' ').trim().slice(0, 600),
      hostEvent: 'codex/rollout',
      detail: { adopted: true, restated: true },
    }))
  }

  for (const drop of session.tokenDrops) {
    record(buildEvent({
      kind: 'context_compacted',
      timestampUtc: drop.at,
      sessionId: session.sessionId,
      taskId,
      hostEvent: 'codex/rollout',
      reason: 'inferred from a halving of request input tokens',
      detail: { inferred: true, fromTokens: drop.fromTokens, toTokens: drop.toTokens },
    }))
  }

  for (const change of session.fileChanges) {
    const rel = toWorkspaceRelative(paths.root, change.absolutePath)
    if (!rel) continue
    // Older imported events had no intent. Enriching new events must not replay old writes.
    if (existing.some(event => event.kind === 'file_write' && event.hostEvent === 'codex/rollout' &&
      event.sessionId === session.sessionId && event.timestampUtc === change.at &&
      event.entities?.some(entity => entity.path === rel))) { skipped += 1; continue }
    if (hasHookCoverage(existing, session.sessionId, rel, change.at, window)) {
      skipped += 1
      continue
    }
    const entity: Entity = { kind: 'file', identifier: rel, path: rel }
    const writeIntent = session.userMessages
      .filter(message => !isCheckMessage(message.text) && message.at <= change.at)
      .at(-1)?.text ?? intent
    record(buildEvent({
      kind: 'file_write',
      timestampUtc: change.at,
      sessionId: session.sessionId,
      taskId,
      entities: [entity],
      intentText: writeIntent?.replace(/\s+/g, ' ').trim().slice(0, 600) ?? null,
      hostEvent: 'codex/rollout',
      detail: { adopted: true, changeKind: change.kind },
    }))
  }

  for (const command of session.commands) {
    record(buildEvent({
      kind: 'command',
      timestampUtc: command.at,
      sessionId: session.sessionId,
      taskId,
      hostEvent: 'codex/rollout',
      reason: command.command.slice(0, 200),
      detail: { adopted: true, coverageGap: 'shell-file-effects-not-statically-visible' },
    }))
  }

  return { appended, skipped }
}

/**
 * Whether a hook already recorded this write.
 *
 * The hook fires at tool-call time and the transcript entry lands when the tool
 * finishes, so the two timestamps differ by the duration of the write. The window
 * absorbs that, and the direction does not matter: an adoption that arrives before
 * the hook is just as much a duplicate as one that arrives after.
 */
function hasHookCoverage(
  existing: readonly CoordEvent[],
  sessionId: string,
  relativePath: string,
  at: string,
  windowMs: number,
): boolean {
  const when = Date.parse(at)
  if (!Number.isFinite(when)) return false
  return existing.some((event) => {
    if (event.sessionId !== sessionId) return false
    if (event.kind !== 'file_write') return false
    if (event.hostEvent === 'codex/rollout') return false
    const hit = (event.entities ?? []).some((entity) => entity.path === relativePath || entity.identifier === relativePath)
    if (!hit) return false
    const other = Date.parse(event.timestampUtc)
    return Number.isFinite(other) ? Math.abs(other - when) <= windowMs : false
  })
}

/** Most recently modified rollout, used by the daemon to decide whether to re-adopt. */
export function newestRolloutStamp(home: string = codexHome()): number {
  let newest = 0
  for (const file of listRolloutFiles(home)) {
    try {
      newest = Math.max(newest, statSync(file).mtimeMs)
    } catch {
      // A file removed between listing and stating simply does not count.
    }
  }
  return newest
}

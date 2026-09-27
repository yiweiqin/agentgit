/**
 * The desktop task: one pinned Codex task per workspace, and the record of whether this
 * workspace has already been offered one.
 *
 * Why a state file and not a memory
 * ---------------------------------
 * The offer is made by a hook, but the task is created by the model in the conversation, and
 * only after the user agrees. Those are different processes and may be different sessions, so
 * "we have already asked" cannot live in either one. It lives here, in the same derived `state/`
 * directory as the hub projection, for the same reason that one does: it is a fact about *this
 * workspace on this machine*, not about a session. Losing it costs one repeated offer, which is
 * the correct direction for that failure to point.
 *
 * One offer, not a stream of them
 * -------------------------------
 * A hook that asked on every session would be a nag, and a nag is what teaches people to stop
 * reading a plugin's output - the output that also carries the rulings, which are the actual
 * product. So the offer is made at most once, the answer is remembered whether it was yes or no,
 * and a repeat is refused inside a cooldown window.
 *
 * The rule is a pure function
 * ---------------------------
 * {@link shouldOfferDesktop} takes state and a clock and returns a boolean. Nothing about it
 * needs the filesystem, which matters because `plugins/agentgit/scripts/desktop.mjs` has to
 * decide the same thing from an installed plugin directory with no `node_modules` and therefore
 * carries its own copy. A pure rule is the only kind that copy can be driven against, so
 * `packages/cli/tests/desktop-hook.test.ts` does exactly that.
 *
 * @module @agentgit/core/desktop
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import type { WorkspacePaths } from './workspace.ts'

/** Bumped only if the shape below changes incompatibly; a mismatch reads as "never offered". */
export const DESKTOP_VERSION = 2

/** How long to wait before asking again after an offer that was ignored rather than answered. */
export const DESKTOP_OFFER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000

/**
 * What this workspace has decided about its desktop task.
 *
 * `threadId` is the whole point: set means the task exists and the offer is over forever.
 * `declinedAt` is the other terminal answer, and it is remembered rather than dropped so a user
 * who said no once is not asked every week. `offeredAt` covers the case in between - an offer
 * that was neither accepted nor refused, where the cooldown is what keeps it from repeating.
 */
export interface DesktopState {
  readonly version: number
  readonly workspace: string
  /** The task this workspace is reported in, or `null` when none has been created yet. */
  readonly threadId: string | null
  /** The heartbeat automation that keeps that task alive, or `null` when none was created. */
  readonly automationId: string | null
  /** When an offer was last put in front of a user, answered or not. */
  readonly offeredAt: string | null
  /** When a user said no. Terminal until `agentgit desktop --reset`. */
  readonly declinedAt: string | null
  /** The ruling the desktop task has already reported, so it can stay quiet about a repeat. */
  readonly lastRulingId: string | null
  /** When the desktop task last looked, whether or not it had anything to say. */
  readonly lastReportedAt: string | null
  /**
   * Conversation id to the instant it was pinned, one entry per conversation.
   *
   * `/agentgit` pins the conversation it was typed in, and this is the record of which
   * conversations that has already happened to. Keyed on the conversation id rather than a
   * boolean because a workspace has many conversations: pinning one must not make the next one
   * look pinned, and re-running `/agentgit` in the same one must not pin it twice.
   */
  readonly pinnedThreads: Record<string, string>
  /**
   * When this workspace was first enabled through one of the two new flows, or `null`.
   *
   * Distinct from `offeredAt`, which records that a question was asked: this records that the
   * answer was yes and the workspace was initialised. It is the fact a reader wants when asking
   * "since when has this workspace been coordinating", and it is what the two flows write.
   */
  readonly enabledAt: string | null
}

/** Which sort of directory a hook or command resolved: opted in, a bare repo, an ordinary folder, or unresolved. */
export type WorkspaceKind = 'claimed' | 'repo' | 'folder' | 'none'

/**
 * A change to the record, with the readonly modifiers removed.
 *
 * `DesktopState`'s fields are readonly because a read record must not be mutated in place, but a
 * caller building a patch has to assign to them one at a time. Spelling the mutable form once here
 * is what keeps `writeDesktopState` and its callers from each inventing their own cast.
 */
export type DesktopStatePatch = {
  -readonly [K in keyof Omit<DesktopState, 'version' | 'workspace'>]?: Omit<DesktopState, 'version' | 'workspace'>[K]
}

/** The one spelling of the state file's path, mirrored in `scripts/desktop.mjs`. */
export function desktopStatePath(paths: WorkspacePaths): string {
  return join(paths.state, 'desktop.json')
}

/**
 * What the desktop task is called in the sidebar.
 *
 * The workspace name is part of it because the record is per workspace: a ledger, a board and a
 * ruling are all scoped to one, so two repositories with work in flight are two different
 * answers and must not share one task where they would look like one.
 */
export function desktopTaskTitle(root: string): string {
  const name = basename(resolve(root)) || resolve(root)
  return `AgenticGit — ${name}`
}

/** The state a workspace has before it has been offered anything. */
export function emptyDesktopState(root: string): DesktopState {
  return {
    version: DESKTOP_VERSION,
    workspace: resolve(root),
    threadId: null,
    automationId: null,
    offeredAt: null,
    declinedAt: null,
    lastRulingId: null,
    lastReportedAt: null,
    pinnedThreads: {},
    enabledAt: null,
  }
}

/** An object of string to string, dropping every value that is not a non-empty string. */
function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && entry !== '') out[key] = entry
  }
  return out
}

function normalize(raw: unknown, root: string): DesktopState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Partial<DesktopState>
  if (record.version !== DESKTOP_VERSION) return null
  const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
  return {
    version: DESKTOP_VERSION,
    workspace: typeof record.workspace === 'string' && record.workspace ? record.workspace : resolve(root),
    threadId: text(record.threadId),
    automationId: text(record.automationId),
    offeredAt: text(record.offeredAt),
    declinedAt: text(record.declinedAt),
    lastRulingId: text(record.lastRulingId),
    lastReportedAt: text(record.lastReportedAt),
    pinnedThreads: stringRecord(record.pinnedThreads),
    enabledAt: text(record.enabledAt),
  }
}

/**
 * What this workspace has decided, or `null` when it has decided nothing.
 *
 * A file from a different version reads as absent rather than as a partly-understood record:
 * every field here means "do not ask again", and honouring a field whose meaning has changed is
 * the one way this file can do harm. The cost of being wrong in the other direction is a single
 * repeated offer.
 */
export function readDesktopState(paths: WorkspacePaths): DesktopState | null {
  const file = desktopStatePath(paths)
  if (!existsSync(file)) return null
  try {
    return normalize(JSON.parse(readFileSync(file, 'utf8')), paths.root)
  } catch {
    return null
  }
}

/**
 * Apply a patch and persist it, returning the state as it now stands.
 *
 * Temp-then-rename, because the reader is a hook inside a session: a half-written file would read
 * as "never offered" and produce a second offer, which is the exact thing this file exists to
 * prevent. The plain-write fallback exists for a platform that refuses the replace; writing
 * something is better than silently forgetting that a task was already created.
 *
 * A failure to write is not thrown. Every caller is either a hook that must not fail a session or
 * a tool that has already done the thing it is recording.
 */
export function writeDesktopState(paths: WorkspacePaths, patch: DesktopStatePatch): DesktopState {
  const current = readDesktopState(paths) ?? emptyDesktopState(paths.root)
  const next: DesktopState = { ...current, ...patch, version: DESKTOP_VERSION, workspace: current.workspace }
  const file = desktopStatePath(paths)
  const body = `${JSON.stringify(next, null, 2)}\n`
  try {
    mkdirSync(paths.state, { recursive: true })
    const temp = `${file}.tmp-${process.pid}`
    writeFileSync(temp, body, 'utf8')
    try {
      renameSync(temp, file)
    } catch {
      rmSync(temp, { force: true })
      writeFileSync(file, body, 'utf8')
    }
  } catch {
    // See above: recording a decision must never be the reason a session fails.
  }
  return next
}

/** Drop every decision this workspace has made, so the offer can be made again. */
export function resetDesktopState(paths: WorkspacePaths): boolean {
  const file = desktopStatePath(paths)
  if (!existsSync(file)) return false
  try {
    rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Whether to offer this workspace a desktop task, now.
 *
 * Pure, so it can be driven from one table against the copy in the hook. The order of the checks
 * is the policy: a task that exists ends the question, a refusal ends it too, and only an offer
 * that was never answered is subject to the cooldown.
 */
export function shouldOfferDesktop(state: DesktopState | null, now: Date): boolean {
  if (!state) return true
  if (state.threadId !== null) return false
  if (state.declinedAt !== null) return false
  if (state.offeredAt === null) return true
  const offeredAt = Date.parse(state.offeredAt)
  // An offer whose timestamp cannot be read is treated as having just happened, so a corrupt
  // field costs one cooldown rather than an offer on every single session.
  if (!Number.isFinite(offeredAt)) return false
  return now.getTime() - offeredAt >= DESKTOP_OFFER_COOLDOWN_MS
}

/**
 * Whether the desktop task should say anything about this ruling.
 *
 * The whole reason the task is quiet: a heartbeat that re-reported the same conclusion would cost
 * a model call and a notification to say nothing changed, and that is how a monitor becomes
 * something people mute. Reporting is therefore keyed on the ruling's own id - the same id the
 * hub uses to mean "this is a different conclusion from the one before".
 */
export function shouldReportRuling(state: DesktopState | null, rulingId: string | null): boolean {
  if (rulingId === null) return false
  return state?.lastRulingId !== rulingId
}

/* -------------------------------------------------------------------------- */
/* The two new flows: enabling a bare repository, and pinning a conversation  */
/* -------------------------------------------------------------------------- */

/**
 * Whether to offer a not-yet-opted-in repository the chance to enable AgenticGit.
 *
 * Pure, so `plugins/agentgit/scripts/desktop.mjs` can carry its own copy and be driven against
 * this one over a table. The order of the checks is the policy, and it mirrors
 * {@link shouldOfferDesktop}: a refusal is terminal, and only an offer that was never answered is
 * subject to the cooldown.
 *
 * `kind` is a parameter rather than something the caller filters before calling, because the rule
 * is the whole answer to "should a repository with no `.agentgit` be asked". A `claimed` workspace
 * is never asked here - it has its own offer - and `none` means no usable directory, so neither is
 * offered, and both are asserted in the same table rather than left to a caller's `if`.
 */
export function shouldOfferInit(state: InitOfferRecord | null, kind: WorkspaceKind, now: Date): boolean {
  if (kind !== 'repo' && kind !== 'folder') return false
  if (!state) return true
  if (state.declinedAt !== null) return false
  if (state.offeredAt === null) return true
  const offeredAt = Date.parse(state.offeredAt)
  // An unreadable timestamp is treated as "just offered", so a corrupt field costs one cooldown
  // rather than an offer on every single prompt.
  if (!Number.isFinite(offeredAt)) return false
  return now.getTime() - offeredAt >= DESKTOP_OFFER_COOLDOWN_MS
}

/**
 * Whether a user's first message is the `/agentgit` command.
 *
 * The command is only recognised as the *first* token: a message that mentions `/agentgit` while
 * describing something else must not enable the workspace and pin the conversation. Leading
 * whitespace is allowed because a pasted command often carries it.
 */
export function promptEnablesAgentGit(prompt: string | null | undefined): boolean {
  if (typeof prompt !== 'string') return false
  return /^\s*\/agentgit\b/i.test(prompt)
}

/**
 * Whether this conversation still needs to be pinned for a workspace being enabled.
 *
 * A workspace has many conversations, and the pin is per conversation: enabling from a second one
 * must pin that one too, while re-running `/agentgit` in a conversation already pinned must not.
 * No record at all means nothing has been pinned, so the answer is yes.
 */
export function shouldPinOnEnable(state: DesktopState | null, threadId: string | null): boolean {
  if (typeof threadId !== 'string' || threadId.trim() === '') return false
  return !state?.pinnedThreads?.[threadId]
}

/** Record that a conversation was pinned, merging it into whatever is already pinned. */
export function recordPinnedThread(
  paths: WorkspacePaths,
  threadId: string,
  at: Date = new Date(),
): DesktopState {
  const current = readDesktopState(paths)
  const pinnedThreads = { ...(current?.pinnedThreads ?? {}), [threadId]: at.toISOString() }
  return writeDesktopState(paths, { pinnedThreads })
}

/**
 * Record that a workspace was enabled, keeping the first instant rather than the latest.
 *
 * The field answers "since when", so overwriting it on a second enable would make the answer
 * wrong. A workspace that is already enabled is returned untouched.
 */
export function markEnabled(paths: WorkspacePaths, at: Date = new Date()): DesktopState {
  const current = readDesktopState(paths)
  if (current?.enabledAt) return current
  return writeDesktopState(paths, { enabledAt: at.toISOString() })
}

/* -------------------------------------------------------------------------- */
/* The machine-level record for repositories that have not opted in yet       */
/* -------------------------------------------------------------------------- */

/**
 * Bumped only if the shape below changes incompatibly; a mismatch reads as "never offered".
 *
 * This file lives on the machine rather than in the workspace, and that placement is forced by
 * what it records: a repository that has *not* opted in has no `.agentgit` to write into, and
 * creating one just to remember having asked would scatter state across every repository the
 * agent was ever opened in - exactly the failure the plugin's other rules are built to avoid.
 */
export const INIT_OFFERS_VERSION = 1

/** How many repositories one machine remembers before the oldest records are dropped. */
export const INIT_OFFERS_MAX = 500

/** What this machine remembers about offering one not-yet-claimed repository. */
export interface InitOfferRecord {
  readonly offeredAt: string | null
  readonly declinedAt: string | null
}

export interface InitOffersState {
  readonly version: number
  readonly workspaces: Record<string, InitOfferRecord>
}

/** The state a machine has before it has offered anything. */
export function emptyInitOffersState(): InitOffersState {
  return { version: INIT_OFFERS_VERSION, workspaces: {} }
}

/**
 * `<AGENTGIT_HOME or ~/.agentgit>/offers.json`.
 *
 * `AGENTGIT_HOME` is honoured so the tests can point a hook at a scratch directory, the same
 * arrangement `AGENTGIT_CODEX_HOME` already uses for `config.toml`.
 */
export function initOffersPath(env: Record<string, string | undefined> = process.env): string {
  const configured = (env.AGENTGIT_HOME ?? '').trim()
  const home = configured !== '' ? resolve(configured) : join(homedir(), '.agentgit')
  return join(home, 'offers.json')
}

function normalizeInitOffers(raw: unknown): InitOffersState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyInitOffersState()
  const record = raw as Partial<InitOffersState>
  if (record.version !== INIT_OFFERS_VERSION) return emptyInitOffersState()
  const source = record.workspaces
  const workspaces: Record<string, InitOfferRecord> = {}
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    for (const [dir, entry] of Object.entries(source as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const value = entry as Partial<InitOfferRecord>
      workspaces[dir] = {
        offeredAt: typeof value.offeredAt === 'string' && value.offeredAt !== '' ? value.offeredAt : null,
        declinedAt: typeof value.declinedAt === 'string' && value.declinedAt !== '' ? value.declinedAt : null,
      }
    }
  }
  return { version: INIT_OFFERS_VERSION, workspaces }
}

/** Read the machine-level record, treating anything unreadable as "nothing remembered". */
export function readInitOffers(env: Record<string, string | undefined> = process.env): InitOffersState {
  const file = initOffersPath(env)
  if (!existsSync(file)) return emptyInitOffersState()
  try {
    return normalizeInitOffers(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return emptyInitOffersState()
  }
}

/** The most recent timestamp a record carries, for ordering, or `0` when it has none. */
function initOfferStamp(record: InitOfferRecord): number {
  const value = record.offeredAt ?? record.declinedAt
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Drop records for directories that are gone, then cap what is left at the newest few.
 *
 * The record is keyed by absolute path and this machine may open hundreds of repositories, so
 * without a bound it would grow forever. A directory that no longer exists cannot be offered
 * again in any case, so dropping it costs nothing; timestamps order the survivors so the cap
 * keeps the repositories most likely to be opened again.
 */
function pruneInitOffers(workspaces: Record<string, InitOfferRecord>): Record<string, InitOfferRecord> {
  const live = Object.entries(workspaces).filter(([dir]) => {
    try {
      return existsSync(dir)
    } catch {
      return false
    }
  })
  if (live.length <= INIT_OFFERS_MAX) return Object.fromEntries(live)
  live.sort((a, b) => initOfferStamp(b[1]) - initOfferStamp(a[1]))
  return Object.fromEntries(live.slice(0, INIT_OFFERS_MAX))
}

/**
 * Apply a patch to one repository's record and persist the file, returning the state as it stands.
 *
 * Temp-then-rename for the same reason `writeDesktopState` uses it: the reader is a hook inside a
 * session, and a half-written file would read as "never offered" and produce a second question -
 * the exact nag this record exists to prevent.
 */
export function writeInitOffer(
  root: string,
  patch: { offeredAt?: string | null; declinedAt?: string | null },
  env: Record<string, string | undefined> = process.env,
): InitOffersState {
  const current = readInitOffers(env)
  const key = resolve(root)
  const existing = current.workspaces[key] ?? { offeredAt: null, declinedAt: null }
  return persistInitOffers(
    {
      version: INIT_OFFERS_VERSION,
      workspaces: pruneInitOffers({ ...current.workspaces, [key]: { ...existing, ...patch } }),
    },
    env,
  )
}

/**
 * Forget this machine's record for one repository, so the question can be asked again.
 *
 * The way back for someone who declined an offer by accident, mirroring `agentgit desktop --reset`
 * for the workspace-level one. Returns whether there was anything to clear.
 */
export function clearInitOffer(root: string, env: Record<string, string | undefined> = process.env): boolean {
  const current = readInitOffers(env)
  const key = resolve(root)
  if (!Object.prototype.hasOwnProperty.call(current.workspaces, key)) return false
  const rest: Record<string, InitOfferRecord> = {}
  for (const [dir, record] of Object.entries(current.workspaces)) {
    if (dir !== key) rest[dir] = record
  }
  persistInitOffers({ version: INIT_OFFERS_VERSION, workspaces: rest }, env)
  return true
}

/**
 * Write the machine-level record, atomically.
 *
 * A failure is swallowed rather than thrown: the only callers are a hook that must not fail a
 * session and a command that records a decision the user already made. Losing the write costs one
 * repeated offer, which is the safe direction for this file to fail in.
 */
function persistInitOffers(state: InitOffersState, env: Record<string, string | undefined>): InitOffersState {
  const file = initOffersPath(env)
  const body = `${JSON.stringify(state, null, 2)}\n`
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.tmp-${process.pid}`
    writeFileSync(temp, body, 'utf8')
    try {
      renameSync(temp, file)
    } catch {
      rmSync(temp, { force: true })
      writeFileSync(file, body, 'utf8')
    }
  } catch {
    // See above: recording an offer must never be the reason a session fails.
  }
  return state
}

/** One repository's record, or `null` when this machine has not offered it. */
export function initOfferFor(
  root: string,
  env: Record<string, string | undefined> = process.env,
): InitOfferRecord | null {
  return readInitOffers(env).workspaces[resolve(root)] ?? null
}

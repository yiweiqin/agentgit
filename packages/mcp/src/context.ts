/**
 * Which workspace, which task, which session — resolved once, and reported.
 *
 * This is the least certain part of the plugin, so it is also the most explicit. An
 * MCP server is spawned by the host and is told very little: it gets a working
 * directory it did not choose, and whether it learns the session id depends on a host
 * detail that may change. Everything here is therefore a documented fallback chain
 * rather than an assumption, and {@link describeIdentity} prints which link of the
 * chain answered so a user can see immediately why two agents look like one.
 *
 * Getting this wrong is not cosmetic. A verdict attributed to the wrong task makes the
 * real task look idle and the wrong one look busy, which turns the coordination signal
 * into noise that reads like a bug.
 *
 * @module @agentgit/mcp/context
 */

import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  ensureWorkspace,
  findWorkspaceRoot,
  machineId,
  readAllEvents,
  type WorkspacePaths,
} from '@agentgit/core'

/** Environment variables that might carry the host's session id, most specific first. */
const SESSION_ENV_VARS = [
  'AGENTGIT_SESSION',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CODEX_SESSION',
  'CLAUDE_SESSION_ID',
] as const

export type SessionSource =
  | 'argument'
  | 'environment'
  | 'ledger'
  | 'placeholder'

export type WorkspaceSource = 'argument' | 'environment' | 'discovered'

export interface Identity {
  readonly paths: WorkspacePaths
  readonly sessionId: string
  readonly taskId: string
  readonly sessionSource: SessionSource
  readonly workspaceSource: WorkspaceSource
  /** How the session was found, in words, for `agentgit_whoami` and for errors. */
  readonly explanation: string
  /** True when the session id is a guess, so callers can soften their wording. */
  readonly sessionIsGuess: boolean
}

export interface ResolveInput {
  /** Explicit `workspace` tool argument. */
  readonly workspace?: string | null
  /** Explicit `session` tool argument, normally copied from a previous result. */
  readonly session?: string | null
  /** Explicit `task` tool argument, normally copied from a previous result. */
  readonly task?: string | null
  /** How far back a ledger session is still considered current. */
  readonly sessionWindowMinutes?: number
  readonly now?: Date
}

function fromEnvironment(names: readonly string[]): string | null {
  for (const name of names) {
    const value = process.env[name]
    if (value && value.trim() !== '') return value.trim()
  }
  return null
}

/** Expand a leading `~` so a tool argument can be written the way a shell would. */
export function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return resolve(homedir(), value.slice(2))
  return value
}

/**
 * Which workspace.
 *
 * `--workspace` and the environment come first because the host's working directory
 * is not reliably the project: a plugin loaded from a cache directory may inherit the
 * cache's parent. Discovery walks up from the current directory for a `.agentgit`
 * directory, then for a `.git` directory, so the first command in a fresh repository
 * still reports something useful.
 */
export function resolveWorkspace(
  explicit?: string | null,
): { paths: WorkspacePaths; source: WorkspaceSource; explanation: string } {
  if (explicit && explicit.trim() !== '') {
    const root = resolve(expandHome(explicit.trim()))
    if (!existsSync(root)) {
      throw new Error(
        `workspace '${explicit}' does not exist. Pass an absolute path, or omit the argument to use the current directory.`,
      )
    }
    return { paths: ensureWorkspace(root), source: 'argument', explanation: `the workspace argument (${root})` }
  }

  const fromEnv = fromEnvironment(['AGENTGIT_WORKSPACE'])
  if (fromEnv) {
    const root = resolve(expandHome(fromEnv))
    if (existsSync(root)) {
      return { paths: ensureWorkspace(root), source: 'environment', explanation: `AGENTGIT_WORKSPACE (${root})` }
    }
  }

  const discovered = findWorkspaceRoot(process.cwd())
  return {
    paths: ensureWorkspace(discovered),
    source: 'discovered',
    explanation: `walking up from ${process.cwd()}`,
  }
}

/**
 * The most recent session that wrote to this ledger.
 *
 * This is the load-bearing fallback. The Codex hooks do know the real session id and
 * record it on every event, so the newest one in this workspace is almost always the
 * session that is asking. It is a heuristic, not a fact, and it is labelled as one:
 * two sessions running at once will both resolve to whichever wrote last.
 *
 * The window exists so a session from yesterday does not claim today's writes. Beyond
 * it, an unattributed session is better than a confidently wrong one.
 */
export function newestSessionId(paths: WorkspacePaths, now: Date, windowMinutes: number): string | null {
  const { events } = readAllEvents(paths)
  if (events.length === 0) return null

  const cutoff = now.getTime() - windowMinutes * 60_000
  let newest: { sessionId: string; at: number } | null = null

  for (const event of events) {
    const at = Date.parse(event.timestampUtc)
    if (!Number.isFinite(at) || at < cutoff) continue
    if (!newest || at >= newest.at) newest = { sessionId: event.sessionId, at }
  }

  return newest?.sessionId ?? null
}

/** Resolve workspace, session and task, and remember how each was decided. */
export function resolveIdentity(input: ResolveInput = {}): Identity {
  const now = input.now ?? new Date()
  const windowMinutes = input.sessionWindowMinutes ?? 30
  const { paths, source: workspaceSource, explanation: workspaceExplanation } = resolveWorkspace(input.workspace)

  let sessionId: string | null = null
  let sessionSource: SessionSource = 'placeholder'
  let detail = ''

  if (input.session && input.session.trim() !== '') {
    sessionId = input.session.trim()
    sessionSource = 'argument'
    detail = 'passed as the session argument'
  }

  if (!sessionId) {
    const fromEnv = fromEnvironment(SESSION_ENV_VARS)
    if (fromEnv) {
      sessionId = fromEnv
      sessionSource = 'environment'
      detail = `read from the environment`
    }
  }

  if (!sessionId) {
    const fromLedger = newestSessionId(paths, now, windowMinutes)
    if (fromLedger) {
      sessionId = fromLedger
      sessionSource = 'ledger'
      detail = `the most recent session in this ledger (within ${windowMinutes} minutes)`
    }
  }

  if (!sessionId) {
    sessionId = `mcp-${machineId()}`
    sessionSource = 'placeholder'
    detail = 'a placeholder, because no session has recorded anything here yet'
  }

  // A task id derived from the session keeps two sessions in one workspace in two
  // tasks, which is the entire premise of the product. A random id per call would put
  // every call in its own task and show no collisions at all.
  //
  // The fallback is the bare session id, and it has to be *exactly* that: the hook
  // (`plugins/agentgit/scripts/track.mjs`) and the CLI fall back the same way, and a
  // prefix here - `t-abc123` against the hook's `abc123` - split one agent's work into
  // two tasks. The symptom is quiet and confusing: the board shows two half-tasks that
  // never collide with each other, because they are no longer about the same ground.
  const taskId = input.task && input.task.trim() !== '' ? input.task.trim() : sessionId

  return {
    paths,
    sessionId,
    taskId,
    sessionSource,
    workspaceSource,
    explanation: `Workspace: ${workspaceExplanation}. Session: ${detail}.`,
    sessionIsGuess: sessionSource === 'ledger' || sessionSource === 'placeholder',
  }
}

export interface WhoAmI {
  readonly workspace: string
  readonly workspaceSource: WorkspaceSource
  readonly sessionId: string
  readonly sessionSource: SessionSource
  readonly taskId: string
  readonly sessionIsGuess: boolean
  readonly explanation: string
  readonly hint: string | null
}

/** The diagnostic a user reads when two agents appear to be one. */
export function describeIdentity(identity: Identity): WhoAmI {
  const hint =
    identity.sessionSource === 'argument'
      ? null
      : 'If several agents run in this workspace at once, pass `session` explicitly on every call — ' +
        'copy it from the first result you get. Without it, calls are attributed to whichever session wrote most recently.'

  return {
    workspace: identity.paths.root,
    workspaceSource: identity.workspaceSource,
    sessionId: identity.sessionId,
    sessionSource: identity.sessionSource,
    taskId: identity.taskId,
    sessionIsGuess: identity.sessionIsGuess,
    explanation: identity.explanation,
    hint,
  }
}

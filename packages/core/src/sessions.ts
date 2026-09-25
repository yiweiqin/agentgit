/**
 * What a session is called, so a commit can be attributed to a conversation.
 *
 * A coordination view that says a commit came from session `01a0c2fc-630e-…` tells a
 * developer nothing they can act on. Codex already has a human name for every thread and
 * writes it down; this module reads that name and hands back the same string the desktop
 * UI shows, with the provenance attached so a caller can say *where* the name came from.
 *
 * The fallback chain is the point, not a detail. `session_index.jsonl` is a Codex-internal
 * file that is written when a thread is named, so it is missing entries for sessions that
 * were never named, and it can be absent entirely on a machine that has not run the desktop
 * app. Each rung is therefore honest about being a fallback, and the last rung — the short
 * commit-style prefix of the session id — is always available, so a graph is never blank.
 *
 * Nothing here throws. A label that cannot be resolved degrades to an id rather than
 * failing a board refresh, for the same reason every other reader in this package
 * tolerates a malformed line: a coordination view that refuses to load is strictly worse
 * than one that reports less.
 *
 * @module @agentgit/core/sessions
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { codexHome, listRolloutFiles, parseRolloutText } from './codex-rollout.ts'

/** File Codex appends `{id, thread_name, updated_at}` lines to. */
export const SESSION_INDEX_FILENAME = 'session_index.jsonl'

export function sessionIndexPath(home: string = codexHome()): string {
  return join(home, SESSION_INDEX_FILENAME)
}

export interface ThreadName {
  /** The conversation name as the Codex UI shows it. */
  readonly name: string
  readonly updatedAt: string | null
}

/**
 * Every thread name Codex has recorded, keyed by thread id.
 *
 * Last occurrence wins, which is `session_index.jsonl`'s own contract: it is append-only
 * and a rename appends a new line, so the newest line is the current name. Ordering by
 * `updated_at` instead would be wrong for the case that actually occurs — a rename during
 * the same second, where the timestamps tie and only append order breaks it.
 */
export function loadThreadNames(home: string = codexHome()): Map<string, ThreadName> {
  const names = new Map<string, ThreadName>()
  const file = sessionIndexPath(home)
  if (!existsSync(file)) return names

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return names
  }

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // A torn final line is the ordinary case for a file being appended to. Skipping it
      // costs one name; refusing the file would cost every name.
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    const id = typeof record.id === 'string' && record.id.trim() !== '' ? record.id.trim() : null
    const name = typeof record.thread_name === 'string' && record.thread_name.trim() !== '' ? record.thread_name.trim() : null
    if (!id || !name) continue
    names.set(id, {
      name,
      updatedAt: typeof record.updated_at === 'string' ? record.updated_at : null,
    })
  }
  return names
}

/** Where a label came from, so a surface can show it rather than implying certainty. */
export type SessionLabelSource = 'index' | 'first-prompt' | 'task' | 'session-id' | 'author'

export interface SessionLabel {
  readonly sessionId: string
  readonly label: string
  readonly source: SessionLabelSource
}

/**
 * The first thing the user asked in a session, read from its rollout.
 *
 * Used only for sessions the index does not name. Codex names a thread from the first
 * prompt, so this recovers the same string for a session that was named but whose index
 * line has not been written yet, or whose index was pruned.
 */
export function firstPromptsFromRollouts(home: string = codexHome(), maxDays = 14): Map<string, string> {
  const prompts = new Map<string, string>()
  for (const file of listRolloutFiles(home, maxDays)) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const session = parseRolloutText(text, file)
    if (!session) continue
    const first = session.userMessages[0]?.text
    if (!first) continue
    if (!prompts.has(session.sessionId)) prompts.set(session.sessionId, first)
  }
  return prompts
}

/**
 * Session ids in, labels out, with the provenance of each.
 *
 * `firstPrompts` is passed in rather than computed here because reading the transcript
 * pool is the expensive half and a caller rendering a graph resolves labels for the same
 * sessions repeatedly. A caller that has no prompts to offer simply omits it and gets the
 * shorter chain.
 */
export function resolveSessionLabels(
  sessionIds: readonly string[],
  options: {
    readonly home?: string
    readonly threadNames?: Map<string, ThreadName>
    readonly firstPrompts?: Map<string, string>
    readonly taskIdForSession?: (sessionId: string) => string | null
  } = {},
): Map<string, SessionLabel> {
  const home = options.home ?? codexHome()
  const threads = options.threadNames ?? loadThreadNames(home)
  const prompts = options.firstPrompts
  const labels = new Map<string, SessionLabel>()

  for (const sessionId of sessionIds) {
    if (!sessionId || labels.has(sessionId)) continue

    const thread = threads.get(sessionId)
    if (thread) {
      labels.set(sessionId, { sessionId, label: thread.name, source: 'index' })
      continue
    }

    const prompt = prompts?.get(sessionId)
    if (prompt) {
      labels.set(sessionId, { sessionId, label: prompt, source: 'first-prompt' })
      continue
    }

    const taskId = options.taskIdForSession?.(sessionId)
    if (taskId) {
      labels.set(sessionId, { sessionId, label: taskId, source: 'task' })
      continue
    }

    labels.set(sessionId, { sessionId, label: shortSessionId(sessionId), source: 'session-id' })
  }

  return labels
}

/** The id prefix used when nothing else is known: long enough to be unique, short enough to read. */
export function shortSessionId(sessionId: string): string {
  const trimmed = sessionId.trim()
  return trimmed.length <= 8 ? trimmed : trimmed.slice(0, 8)
}

/**
 * A label trimmed to fit one row of a list.
 *
 * Codex thread names are the first prompt verbatim, so they can run to a full sentence.
 * The cut is at a word boundary when one is close to the limit, because a name truncated
 * mid-word reads as corruption while one truncated at a space reads as truncation.
 */
export function shortenLabel(label: string, max = 42): string {
  const flat = label.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const boundary = cut.lastIndexOf(' ')
  const body = boundary > max * 0.6 ? cut.slice(0, boundary) : cut
  return `${body.trimEnd()}…`
}

/**
 * Pure helpers that translate host payloads into ledger vocabulary.
 *
 * Everything here is testable with plain objects, so the risky translation
 * (which tool wrote what, and what the agent said it was doing) is verified
 * without a harness, a model, or a session.
 *
 * @module dsh-coord-governor/adapter
 */

import { normalizeEntity, normalizePath } from './ledger.ts'
import type { Entity } from './types.ts'

/**
 * Tool names that mutate files, keyed to the family they belong to.
 *
 * Host tool names are not stable API, so this is a starting point that the
 * harness records against rather than a closed set: `classifyTool` returns
 * `'unknown'` for anything unrecognised, and the instrument counts those, so a
 * rename shows up as a coverage drop in E0 instead of silently losing writes.
 */
export const WRITE_TOOLS: Readonly<Record<string, string>> = {
  write: 'fs',
  write_file: 'fs',
  write_text: 'fs',
  str_replace: 'str-replace',
  str_replace_editor: 'str-replace',
  edit: 'str-replace',
  edit_file: 'str-replace',
  apply_patch: 'patch',
  create_file: 'fs',
}

/** Tools that run arbitrary commands; their file effects are not statically visible. */
export const SHELL_TOOLS: readonly string[] = ['bash', 'shell', 'pwsh', 'powershell', 'run_command', 'exec']

/** Arguments that commonly carry a path, in priority order. */
export const PATH_ARGUMENT_KEYS: readonly string[] = [
  'file_path',
  'filePath',
  'path',
  'file',
  'filename',
  'target',
  'target_path',
  'absolute_path',
]

/** Arguments that carry the agent's own account of what it is doing. */
const INTENT_ARGUMENT_KEYS: readonly string[] = ['description', 'intent', 'summary', 'task', 'reason']

/** Argument keys holding the literal before/after text of an edit. */
const EDIT_TEXT_ARGUMENT_KEYS: readonly string[] = ['old_string', 'new_string', 'old_str', 'new_str']

export type ToolClass = 'write' | 'shell' | 'read' | 'other' | 'unknown'

/** Classify a tool by name. Unrecognised names are reported, never guessed. */
export function classifyTool(name: string | null | undefined): ToolClass {
  if (!name) return 'unknown'
  const lower = name.toLowerCase()
  if (Object.hasOwn(WRITE_TOOLS, lower)) return 'write'
  if (SHELL_TOOLS.includes(lower)) return 'shell'
  if (lower.startsWith('read') || lower === 'view' || lower === 'cat' || lower === 'list_dir') return 'read'
  if (lower.startsWith('get_') || lower.startsWith('list_') || lower.startsWith('search')) return 'other'
  return 'unknown'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * Extract candidate paths from a tool's arguments.
 *
 * Returns every candidate found rather than the first: a patch-style tool can
 * touch several files, and silently keeping one would understate contention.
 * Nested `edits[].file_path` and `files[]` shapes are walked one level deep,
 * because that covers the common multi-file tool shapes without pretending to
 * understand arbitrary schemas.
 */
export function extractPaths(args: unknown): string[] {
  const found: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) {
      const normalized = normalizePath(value)
      if (normalized && !found.includes(normalized)) found.push(normalized)
    }
  }

  const walk = (record: Record<string, unknown>): void => {
    for (const key of PATH_ARGUMENT_KEYS) {
      if (key in record) push(record[key])
    }
    for (const container of ['edits', 'files', 'changes', 'paths']) {
      const value = record[container]
      if (Array.isArray(value)) {
        for (const item of value) {
          const nested = asRecord(item)
          if (nested) {
            for (const key of PATH_ARGUMENT_KEYS) {
              if (key in nested) push(nested[key])
            }
          } else {
            push(item)
          }
        }
      }
    }
  }

  const root = asRecord(args)
  if (root) walk(root)
  else if (typeof args === 'string') push(args)

  return found
}

/**
 * Build a textual intent from a tool call, in priority order: the agent's own
 * description, else the edited literals, else the raw command.
 *
 * The agent's own words are the strongest signal, which is why
 * `INTENT_ARGUMENT_KEYS` is consulted first. Falling back to the edit text
 * matters because most hosts do not make the model restate its goal per call.
 */
export function extractIntent(args: unknown, maxChars = 600): string | null {
  const record = asRecord(args)
  if (!record) return typeof args === 'string' ? args.slice(0, maxChars) : null

  const parts: string[] = []
  for (const key of INTENT_ARGUMENT_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) parts.push(value.trim())
  }
  for (const key of EDIT_TEXT_ARGUMENT_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) parts.push(`${key}=${value.trim()}`)
  }
  if (parts.length === 0 && typeof record.command === 'string' && record.command.trim()) {
    parts.push(record.command.trim())
  }
  if (parts.length === 0) return null
  const text = parts.join(' | ')
  return text.length <= maxChars ? text : text.slice(0, maxChars)
}

/**
 * Turn a proposed write into ledger entities. Symbol-level identity is used when
 * the host supplies an entity kind other than `file`.
 */
export function toEntities(paths: readonly string[], kind = 'file'): Entity[] {
  const out: Entity[] = []
  for (const path of paths) {
    const entity = normalizeEntity({ kind, identifier: path, path })
    if (entity) out.push(entity)
  }
  return out
}

/**
 * Extract a stable session identity from an unknown host object.
 *
 * Looks for the shapes DSH uses (`id` on a session-like object) and falls back to
 * the object's own identity via a WeakMap, so the same object always yields the
 * same key even when it exposes no id. Returning `null` is a hard failure the
 * caller must surface: an unattributable event is not evidence.
 *
 * The `agent` hop matters. `tools/pre-execute` hands the listener a tool execution whose
 * `.agent.id` *is* the session id, but `fs/write-intent` hands over a tool-execution-shaped
 * object whose own id is a call id, not a session. Without this hop the write records were
 * attributed to generated `anonymous-session-*` keys, which silently detaches every
 * `file_write` from its task and empties `B(t)`.
 */
const objectIds = new WeakMap<object, string>()
let anonymousCounter = 0

const ID_KEYS = ['id', 'sessionId', 'session_id'] as const

export function sessionIdOf(candidate: unknown): string | null {
  if (typeof candidate === 'string' && candidate) return candidate
  const record = asRecord(candidate)
  if (!record) return null
  for (const key of ID_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value) return value
  }
  for (const holder of [asRecord(record.session), asRecord(record.agent)]) {
    if (!holder) continue
    for (const key of ID_KEYS) {
      const value = holder[key]
      if (typeof value === 'string' && value) return value
    }
  }
  const existing = objectIds.get(record)
  if (existing) return existing
  anonymousCounter += 1
  const generated = `anonymous-session-${anonymousCounter}`
  objectIds.set(record, generated)
  return generated
}

/**
 * Wrap an observer listener so a defect in this plugin cannot take the agent down.
 *
 * Use this only for listeners whose return value nobody reads — the `@mode emit` feeds.
 * A waterfall listener's return value *is* a contract the host acts on, and this helper
 * answers a failure with `undefined`, which for a waterfall means "no decision". See
 * {@link guardDecision} for why that is the wrong answer there.
 *
 * The host's own guidance is explicit that a read/parse failure must be contained and
 * must not crash boot. A plugin that throws inside a listener is worse than one that does
 * nothing, so every registered listener goes through here or `guardDecision`; failures
 * are counted and surfaced in the report rather than swallowed silently.
 */
export function safeHandler<A extends unknown[], R>(
  name: string,
  handler: (...args: A) => R,
  onError: (name: string, error: unknown) => void,
): (...args: A) => R | undefined {
  return (...args: A): R | undefined => {
    try {
      const result = handler(...args)
      if (result instanceof Promise) {
        return result.catch((error: unknown) => {
          onError(name, error)
          return undefined
        }) as R
      }
      return result
    } catch (error) {
      onError(name, error)
      return undefined
    }
  }
}

/**
 * Contain a failure inside a waterfall listener without destroying the host's decision.
 *
 * A waterfall listener returns a decision the host then acts on: an allow/deny/ask for
 * `tools/pre-execute`, the messages that enter a step for `agent/pre-step`, the write
 * intent for `fs/write-intent`. Returning `undefined` in that position does not mean
 * "no opinion" — it means the value the host was about to use is gone. The concrete
 * failure this prevents: a listener awaits `next()`, which yields the host's own
 * decision, and then throws while computing its advisory. Under `safeHandler` the
 * handler resolves to `undefined`, so the host receives no decision instead of the one
 * it had already produced — a plugin that reports zero faults while breaking the agent.
 *
 * `fallback` is therefore the decision already obtained from `next()`, not a fabricated
 * default. The worst case becomes "this plugin contributed nothing", which is the only
 * failure mode acceptable for a component that is not supposed to be load-bearing.
 *
 * A rejection from `next()` itself is deliberately *not* caught here: at that point no
 * valid decision exists to fall back to, and inventing one would hide a host fault
 * behind a plugin-shaped silence.
 */
export function guardDecision<R>(
  name: string,
  fallback: R,
  compute: () => R,
  onError: (name: string, error: unknown) => void,
): R {
  try {
    return compute()
  } catch (error) {
    onError(name, error)
    return fallback
  }
}

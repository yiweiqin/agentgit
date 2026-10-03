#!/usr/bin/env node
/**
 * Hook fast path: read one hook payload, append one ledger line, exit.
 *
 * This file runs before **every** tool call the agent makes, so its cost is paid
 * on the critical path of the whole session. Three consequences, and they are the
 * only reason this file is not part of `@agentgit/core`:
 *
 * 1. **Only Node builtins and sibling scripts.** It must run from the installed plugin
 *    directory without a `node_modules`, a build step, or a path back to this
 *    repository. Nothing here can be `import`ed from `packages/`.
 * 2. **No analysis, no git, no model.** Anything that decides something belongs in
 *    the daemon or the MCP server. This file only records; a rule that looks at
 *    other state would make the cost of a hook depend on the size of a workspace.
 * 3. **It cannot fail loudly.** A hook that throws, prints, or exits non-zero can
 *    break a tool call. Every path here ends in `exit 0` with nothing on stdout.
 *
 * The wire format is duplicated from `@agentgit/core/ledger` on purpose, down to
 * the `event_id` hash, so a line written here is byte-identical to one the library
 * would have written and can be deduplicated against it.
 *
 * @module agentgit/hook-track
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

import { isDirectRun, noteFailure } from './hook-errors.mjs'
import { extractPaths, findWorkspace, normalizePayload, readStdin } from './hook-runtime.mjs'

/** Must match `SCHEMA_VERSION` in `packages/core/src/ledger.ts` and `coord_ledger.py`. */
const SCHEMA_VERSION = 'coord-ledger-0.1'

/**
 * The arms that record nothing, mirrored from core's `armRecordsNothing`.
 *
 * The hook runs per tool call with no dependencies and no build step, so it cannot import
 * `@agentgit/core` and has to carry its own copy of this rule — the same arrangement as
 * `canonicalEntityPath`, mirrored in `hook-runtime.mjs` for the same reason. Copies drift, so
 * `packages/cli/tests/hooks.test.ts` drives both against one table and fails the moment the
 * two disagree. What that prevents: a user selecting the baseline arm, believing the
 * workspace had stopped recording, while the hook kept appending.
 */
const ARMS_THAT_RECORD_NOTHING = new Set(['A0-baseline'])

/** Read the workspace config, tolerating every way it can be unreadable. */
function armOf(paths) {
  try {
    const raw = JSON.parse(readFileSync(paths.config, 'utf8'))
    return raw && typeof raw === 'object' && typeof raw.arm === 'string' ? raw.arm : null
  } catch {
    // No config, or malformed: fall through to the default arm, which records. A workspace
    // that cannot state its arm must keep working rather than silently stopping.
    return null
  }
}

function workspacePaths(root) {
  const agentgit = join(root, '.agentgit')
  return {
    root,
    agentgit,
    config: join(agentgit, 'config.json'),
    events: join(agentgit, 'events'),
    state: join(agentgit, 'state'),
    tasks: join(agentgit, 'state', 'tasks.json'),
  }
}

function machineId() {
  const raw = (process.env.AGENTGIT_MACHINE || '').trim() || hostname() || 'unknown'
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'unknown'
}

/**
 * The task this session belongs to.
 *
 * Declared by the CLI or the MCP server when a task is started explicitly, and
 * otherwise the session itself. The fallback matters: `buildCapsules` ignores
 * events with no task id, so a hook that left this null would write rows that are
 * never counted as anyone's work.
 */
function taskIdFor(paths, sessionId) {
  try {
    if (existsSync(paths.tasks)) {
      const table = JSON.parse(readFileSync(paths.tasks, 'utf8'))
      const declared = table && typeof table === 'object' ? table[sessionId] : null
      if (typeof declared === 'string' && declared.length > 0) {
        return { taskId: declared, source: 'declared' }
      }
    }
  } catch {
    // A corrupt table degrades to the session fallback rather than losing the record.
  }
  return { taskId: sessionId, source: 'session-fallback' }
}

/* -------------------------------------------------------------------------- */
/* tool classification                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What a tool call can do to a file, so far as the hook can tell from its name.
 *
 * The default for an unrecognised name is `'other'`, and `'other'` is *recorded*, as a
 * gap rather than as a write. That asymmetry is the whole point of this function. A
 * tool that cannot be identified might be a write we would not see, and a ledger that
 * is quietly missing an agent's edits is worse than one with a few extra rows: the
 * collisions it fails to report are exactly the ones it exists to report. Rows for
 * shell commands and unknown tools carry no entity, so they add no false contention —
 * only a visible statement that something happened whose file effects are unknown.
 *
 * The read set is a positive list instead of a prefix guess, because a name like
 * `get_changes` or `list_edits` would be misfiled as a read by a prefix rule and then
 * silently dropped. Being wrong in that direction is the one error this file cannot
 * afford.
 */
const WRITE_TOOLS = new Set([
  'write',
  'write_file',
  'write_text',
  'create_file',
  'str_replace',
  'str_replace_editor',
  'edit',
  'edit_file',
  'apply_patch',
  'multiedit',
  'notebook_edit',
])

const SHELL_TOOLS = new Set([
  'bash',
  'shell',
  'sh',
  'pwsh',
  'powershell',
  'run_command',
  'run_shell_command',
  'exec',
  'exec_command',
  'cmd',
  'terminal',
])

/** Tools that only ever read. A tool absent from this set is treated as unknown. */
const READ_TOOLS = new Set([
  'read',
  'read_file',
  'read_text',
  'read_many',
  'view',
  'view_file',
  'cat',
  'grep',
  'ripgrep',
  'rg',
  'glob',
  'find',
  'search',
  'list',
  'list_dir',
  'list_files',
  'ls',
  'tree',
  'notebook_read',
  'todo_read',
  'todo_list',
  'get_goal',
  'get_context',
])

function classifyTool(name) {
  if (!name) return 'other'
  const lower = String(name).toLowerCase()
  if (READ_TOOLS.has(lower)) return 'read'
  if (WRITE_TOOLS.has(lower)) return 'write'
  if (SHELL_TOOLS.has(lower)) return 'shell'
  return 'other'
}

/** The agent's own account of what it is doing, when the tool call carries one. */
function extractIntent(input, maxChars = 400) {
  if (typeof input === 'string') return input.slice(0, maxChars) || null
  if (!input || typeof input !== 'object') return null
  const parts = []
  for (const key of ['description', 'intent', 'summary', 'task', 'reason', 'explanation']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) parts.push(value.trim())
  }
  if (parts.length === 0 && typeof input.command === 'string') parts.push(input.command.trim())
  if (parts.length === 0) return null
  const text = parts.join(' | ')
  return text.length <= maxChars ? text : text.slice(0, maxChars)
}

/* -------------------------------------------------------------------------- */
/* wire format                                                                 */
/* -------------------------------------------------------------------------- */

function buildWire(input) {
  const body = {
    schema_version: SCHEMA_VERSION,
    kind: input.kind,
    timestamp_utc: input.timestampUtc,
    session_id: input.sessionId,
    developer: input.developer ?? null,
    task_id: input.taskId ?? null,
    entities: input.entities ?? [],
    intent_text: input.intentText ?? null,
    host_event: input.hostEvent ?? null,
    reason: input.reason ?? null,
    detail: input.detail ?? null,
  }
  const eventId = `evt-${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 24)}`
  return { event_id: eventId, ...body }
}

/**
 * Append one line, with no duplicate check.
 *
 * There was one, and removing it is the point. `event_id` is a hash of the whole record
 * *including its timestamp*, so a retried hook invocation produces a different id and the
 * check could not fire. What it did cost was unconditional: a stat plus an 8 KB read and
 * scan on every tool call, on the one path in this design that has to stay cheap.
 *
 * Duplicate suppression belongs where it can be done on meaning rather than on bytes, and
 * that is `adoptSession`, which drops a rollout's file change when the hook already
 * recorded the same session writing the same path within a window. Those timestamps differ
 * by the duration of the write, which is exactly why that check is a window and this one
 * could never be.
 */
function appendLine(file, line) {
  mkdirSync(join(file, '..'), { recursive: true })
  appendFileSync(file, line, { encoding: 'utf8' })
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Record one hook payload. Returns nothing: this script never speaks to the host.
 *
 * Exported so `hook.mjs` can run it in-process, which is what removes two of the three Node
 * startups per tool call. Standalone use is unchanged — see {@link isDirectRun} below.
 */
export function run(payloadText) {
  const payload = normalizePayload(payloadText, { cwdFallback: process.cwd() })
  if (!payload) return
  if (!payload.sessionId) return

  const found = findWorkspace(payload.cwd)
  if (!found.root) return
  const paths = workspacePaths(found.root)
  // Permission to record, decided without creating anything.
  //
  // A workspace that already has an events directory is fair game. So is a claimed one
  // (`.agentgit` present), because that is a project that has opted in. A bare git
  // repository is not: auto-claiming it would scatter ledgers wherever an agent happened
  // to run. The directory itself is created by the append, so a tool call this hook
  // decides not to record leaves the workspace byte-for-byte as it found it.
  const mayRecord = existsSync(paths.events) || found.kind === 'claimed'
  if (!mayRecord) return

  // An arm that records nothing must record nothing *here*, or the control arm would still
  // fill the ledger and every later comparison would be against a contaminated workspace.
  const arm = armOf(paths)
  if (arm !== null && ARMS_THAT_RECORD_NOTHING.has(arm)) return

  const { taskId, source } = taskIdFor(paths, payload.sessionId)
  const timestampUtc = new Date().toISOString()
  const developer = process.env.USERNAME || process.env.USER || null
  const base = {
    timestampUtc,
    sessionId: payload.sessionId,
    developer,
    taskId,
    hostEvent: `codex/${payload.eventName || 'unknown'}`,
  }
  const common = {
    tool: payload.toolName ?? null,
    taskIdSource: source,
    transcriptPath: payload.transcriptPath ?? null,
    // The workspace root this record landed in, and the directory the session reported.
    // Both are kept because they differ when a hook fires from a subdirectory, and that
    // difference is the first thing to check when a record lands in the wrong ledger.
    workspace: found.root,
    cwd: payload.cwd,
  }

  const className = classifyTool(payload.toolName)
  // Only readers are skipped. The ledger exists to describe *produced* change, and a
  // record for every read would bury that in noise while making the cost of the hook
  // depend on how much the agent browsed. Everything else is recorded: a write and a
  // shell command as themselves, and anything unrecognised as an explicit gap.
  const interesting = className !== 'read'
  let entry = null

  if (payload.eventName === 'SessionStart') {
    entry = { ...base, kind: 'session_started', taskId: null, detail: { ...common } }
  } else if (payload.eventName === 'Stop') {
    entry = { ...base, kind: 'turn_ended', taskId: null, detail: { ...common } }
  } else if (payload.eventName === 'UserPromptSubmit') {
    // A check request is coordination traffic, not a new statement of the participant's task.
    if (/^AgenticGit (?:协调检查 check-[0-9a-f]+|自动协调唤醒 [0-9a-f]+)/u.test((payload.prompt ?? '').trimStart())) return
    entry = {
      ...base,
      kind: 'task_registered',
      intentText: payload.prompt ? payload.prompt.replace(/\s+/g, ' ').trim().slice(0, 600) : null,
      detail: { ...common, restated: true },
    }
  } else if (payload.eventName === 'PreToolUse' && interesting) {
    const intentText = extractIntent(payload.toolInput)
    // Paths are only extracted from a named write tool. A shell command's effects are
    // not statically visible, and guessing them from the command text would put a path
    // in the ledger that nothing actually wrote. The patch dialect is the one exception,
    // because there the path is a structured marker rather than prose.
    const pathsHit = className === 'write' ? extractPaths(payload.toolInput, found.root) : []
    if (pathsHit.length > 0) {
      entry = {
        ...base,
        kind: 'file_write',
        entities: pathsHit.map((path) => ({ kind: 'file', identifier: path, path })),
        intentText,
        detail: { ...common, phase: 'intent' },
      }
    } else {
      // The targets are not statically visible. Recording the gap is the honest option:
      // pretending coverage is total would make every contention figure silently low
      // instead of visibly incomplete. The reason distinguishes "we know how this tool
      // works and it is opaque" from "we do not recognise this tool at all", because
      // the second one is a signal that this file needs a new entry in its tool sets.
      entry = {
        ...base,
        kind: 'command',
        intentText,
        reason:
          className === 'shell'
            ? 'shell-file-effects-not-statically-visible'
            : className === 'other'
              ? `unrecognised-tool:${payload.toolName ?? 'unnamed'}`
              : 'write-targets-not-statically-visible',
        detail: { ...common, phase: 'intent', coverageGap: true, toolClass: className },
      }
    }
  } else if (payload.eventName === 'PostToolUse' && interesting) {
    const failed =
      payload.toolResponse != null &&
      typeof payload.toolResponse === 'object' &&
      (payload.toolResponse.is_error === true || payload.toolResponse.isError === true)
    entry = {
      ...base,
      kind: 'write_settled',
      reason: failed ? 'error' : 'ok',
      detail: { ...common, phase: 'settled' },
    }
  }

  if (!entry) return

  const wire = buildWire(entry)
  const day = timestampUtc.slice(0, 10)
  const file = join(paths.events, `${machineId()}-${day}.jsonl`)
  appendLine(file, `${JSON.stringify(wire)}\n`)
}

if (isDirectRun(import.meta.url)) {
  try {
    run(readStdin())
  } catch (error) {
    // A coordination record is never worth failing a tool call over, but a hook that fails is
    // worth writing down: otherwise a broken recorder and a quiet session look the same.
    noteFailure('track', error, { cwd: process.cwd() })
  }
  process.exit(0)
}

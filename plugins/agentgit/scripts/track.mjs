#!/usr/bin/env node
/**
 * Hook fast path: read one hook payload, append one ledger line, exit.
 *
 * This file runs before **every** tool call the agent makes, so its cost is paid
 * on the critical path of the whole session. Three consequences, and they are the
 * only reason this file is not part of `@agentgit/core`:
 *
 * 1. **No imports outside `node:`.** It must run from the installed plugin
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
import { isAbsolute, join, resolve } from 'node:path'

/** Must match `SCHEMA_VERSION` in `packages/core/src/ledger.ts` and `coord_ledger.py`. */
const SCHEMA_VERSION = 'coord-ledger-0.1'

/* -------------------------------------------------------------------------- */
/* input                                                                       */
/* -------------------------------------------------------------------------- */

function readStdin() {
  // A TTY means nobody piped a payload. Reading would block until the user typed,
  // which would hang the tool call, so this is the one case that returns early.
  if (process.stdin.isTTY) return ''
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function firstString(source, keys) {
  if (!source || typeof source !== 'object') return null
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function normalizePayload(raw) {
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const eventName =
    firstString(parsed, ['hook_event_name', 'hookEventName', 'event_name', 'eventName', 'event']) ?? ''
  const sessionId = firstString(parsed, ['session_id', 'sessionId', 'thread_id', 'threadId', 'conversation_id'])
  const cwd = firstString(parsed, ['cwd', 'working_directory', 'workingDirectory']) ?? process.cwd()
  const toolName = firstString(parsed, ['tool_name', 'toolName', 'name'])
  const transcriptPath = firstString(parsed, ['transcript_path', 'transcriptPath'])
  const toolInput = parsed.tool_input ?? parsed.toolInput ?? parsed.arguments ?? parsed.input ?? null
  const toolResponse = parsed.tool_response ?? parsed.toolResponse ?? parsed.result ?? null
  const prompt = firstString(parsed, ['prompt', 'user_prompt', 'userPrompt', 'message'])

  return { eventName, sessionId, cwd, toolName, toolInput, toolResponse, transcriptPath, prompt }
}

/* -------------------------------------------------------------------------- */
/* workspace                                                                   */
/* -------------------------------------------------------------------------- */

function hasDir(dir, name) {
  try {
    return existsSync(join(dir, name))
  } catch {
    return false
  }
}

/**
 * Nearest ancestor that is a workspace, else a git repository.
 *
 * Auto-initialising inside an ordinary directory would scatter `.agentgit`
 * directories wherever an agent happened to run, so a directory that is neither
 * already claimed nor inside a repository is left alone and the hook is a no-op.
 */
function findWorkspace(startDir) {
  let current = resolve(startDir)
  let repo = null
  for (;;) {
    if (hasDir(current, '.agentgit')) return { root: current, kind: 'claimed' }
    if (repo === null && (hasDir(current, '.git') || hasDir(current, '.hg'))) repo = current
    const parent = join(current, '..')
    const next = resolve(parent)
    if (next === current) return repo ? { root: repo, kind: 'repo' } : { root: null, kind: 'none' }
    current = next
  }
}

function workspacePaths(root) {
  const agentgit = join(root, '.agentgit')
  return {
    root,
    agentgit,
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

const PATH_ARGUMENT_KEYS = [
  'file_path',
  'filePath',
  'path',
  'file',
  'filename',
  'target',
  'target_path',
  'absolute_path',
  'notebook_path',
]

/** `*** Update File: src/a.ts` and friends, from the apply_patch dialect. */
const PATCH_PATH_RE = /^\*\*\*\s+(?:Add|Update|Delete|Move to)\s+File:\s*(.+?)\s*$/gm

function normalizePath(value) {
  return String(value).trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * The one spelling of a file's identity, mirroring `canonicalEntityPath` in
 * `packages/core/src/workspace.ts`.
 *
 * Copied rather than imported on purpose: this script runs as a Codex hook, from a
 * directory that may have no `node_modules` and no build output, so it cannot depend
 * on the workspace. A core test drives both copies through the same input table, which
 * is what keeps the duplication from turning into two ledgers that never match.
 */
function canonicalPath(root, value) {
  const normalized = normalizePath(value)
  if (!normalized || !root) return normalized

  const rootAbs = resolve(root).replace(/\\/g, '/').replace(/\/+$/, '')
  const targetAbs = isAbsolute(normalized)
    ? resolve(normalized).replace(/\\/g, '/')
    : resolve(root, normalized).replace(/\\/g, '/')

  // Case-insensitively, because Windows paths differ in case and the same file must
  // not become two entities depending on which producer spelled it.
  const rootKey = rootAbs.toLowerCase()
  const targetKey = targetAbs.toLowerCase()
  if (targetKey === rootKey) return normalized
  if (!targetKey.startsWith(`${rootKey}/`)) return normalized
  return targetAbs.slice(rootAbs.length + 1)
}

/** Every path a tool call names, or an empty list when they are not statically visible. */
function extractPaths(toolName, input, root) {
  const found = []
  const push = (value) => {
    if (typeof value !== 'string' || !value.trim()) return
    const normalized = canonicalPath(root, value)
    if (normalized && !found.includes(normalized)) found.push(normalized)
  }

  if (typeof input === 'string') {
    let match
    const re = new RegExp(PATCH_PATH_RE.source, 'gm')
    while ((match = re.exec(input)) !== null) push(match[1])
    // A bare string carries a path only in the patch dialect, where the marker above
    // already found it. Guessing otherwise would attribute writes to prose.
    return found
  }

  const record = input && typeof input === 'object' && !Array.isArray(input) ? input : null
  if (!record) return found

  for (const key of PATH_ARGUMENT_KEYS) {
    if (key in record) push(record[key])
  }
  for (const container of ['edits', 'files', 'changes', 'paths']) {
    const value = record[container]
    if (!Array.isArray(value)) continue
    for (const item of value) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        for (const key of PATH_ARGUMENT_KEYS) {
          if (key in item) push(item[key])
        }
      } else {
        push(item)
      }
    }
  }
  if (typeof record.command === 'string') {
    let match
    const re = new RegExp(PATCH_PATH_RE.source, 'gm')
    while ((match = re.exec(record.command)) !== null) push(match[1])
  }
  return found
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

function main() {
  const payload = normalizePayload(readStdin())
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
    const pathsHit = className === 'write' ? extractPaths(payload.toolName, payload.toolInput, found.root) : []
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

try {
  main()
} catch {
  // A coordination record is never worth failing a tool call over.
}
process.exit(0)

#!/usr/bin/env node
/**
 * Hook: put the hub's ruling into this session's context, and do nothing else.
 *
 * This is the *push* half of the hub. The ruling itself is computed by the daemon and
 * published as a ledger event; this script only reads the daemon's small projection and
 * hands the already-rendered text to the host, which is the only part that has to run
 * inside the session.
 *
 * Why it is split this way, and what it must never do
 * ---------------------------------------------------
 * `track.mjs` runs before **every** tool call and is deliberately constant work. This script
 * runs on the same path, so it inherits the same constraints, and one more:
 *
 * 1. **No imports outside `node:`.** It runs from the installed plugin directory, which has
 *    no `node_modules` and no build step.
 * 2. **No reading the ledger.** The advisory comes from `state/hub.json`, a bounded file the
 *    daemon writes. Reading `events/*.jsonl` here would make the cost of a tool call grow with
 *    the size of the workspace, which is the one thing the design forbids. There is a test that
 *    deletes the events directory and asserts this script still works.
 * 3. **It cannot fail loudly.** A hook that throws, prints non-JSON, or exits non-zero can break
 *    a tool call. Every path ends in `exit 0`, and the only stdout it ever produces is one valid
 *    hook-output object.
 * 4. **It never writes to the ledger.** See the module note in `@agentgit/core/hub`: whether a
 *    session has *seen* a ruling is not a coordination fact about the workspace, so it is
 *    recorded in a marker file rather than as an event. That keeps this path read-mostly and
 *    keeps the ledger about work.
 *
 * What it injects, and when
 * -------------------------
 * With impact-protocol.json present, read only this receiver's bounded inbox and revalidate
 * its input generation. Urgent items may appear at PreToolUse; deferred items wait for
 * PostToolUse, SessionStart or UserPromptSubmit. Nothing cancels an in-progress tool.
 * The global ruling behavior below is retained for older daemon projections only:
 * - `SessionStart` and `UserPromptSubmit`: the whole ruling, once per ruling.
 * - `PreToolUse`: only when the pending call names a file the hub has actually ruled on, so a
 *   write to contested ground is where the window finds out. Nothing is injected for a write to
 *   ground nobody else wants.
 * - Never twice for the same ruling: the marker records what this session has already been
 *   shown, so a long session is not re-told the same conclusion on every edit.
 *
 * @module agentgit/hub-hook
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { isDirectRun, noteFailure } from './hook-errors.mjs'

/** Hook events this script answers. Anything else is not its business. */
const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'])

/** Belt-and-braces cap. The daemon already caps its advisory; a tampered file must not flood a context. */
const MAX_ADVISORY_CHARS = 1500

/* -------------------------------------------------------------------------- */
/* input                                                                       */
/* -------------------------------------------------------------------------- */

function readStdin() {
  // A TTY means nobody piped a payload. Reading would block until the user typed, which would
  // hang the tool call, so this is the one case that returns early.
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  return {
    eventName:
      firstString(parsed, ['hook_event_name', 'hookEventName', 'event_name', 'eventName', 'event']) ?? '',
    sessionId: firstString(parsed, ['session_id', 'sessionId', 'thread_id', 'threadId', 'conversation_id']),
    cwd: firstString(parsed, ['cwd', 'working_directory', 'workingDirectory']) ?? process.cwd(),
    toolName: firstString(parsed, ['tool_name', 'toolName', 'name']),
    toolInput: parsed.tool_input ?? parsed.toolInput ?? parsed.arguments ?? parsed.input ?? null,
  }
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
 * Identical to `track.mjs`'s rule, and for the same reason: a directory that is neither
 * already claimed nor inside a repository must be left completely alone, so an agent running
 * in a scratch folder does not get coordination advice about it.
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

function stateDir(root) {
  return join(root, '.agentgit', 'state')
}

/* -------------------------------------------------------------------------- */
/* which pending write touches ruled ground                                    */
/* -------------------------------------------------------------------------- */

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
 * Copied rather than imported on purpose, exactly as `track.mjs` copies it: this script runs
 * as a Codex hook from a directory with no `node_modules` and no build output. A core test
 * drives both copies through one input table, which is what keeps the two from drifting into
 * two spellings that never match.
 */
function canonicalPath(root, value) {
  const normalized = normalizePath(value)
  if (!normalized || !root) return normalized

  const rootAbs = resolve(root).replace(/\\/g, '/').replace(/\/+$/, '')
  const targetAbs = isAbsolute(normalized)
    ? resolve(normalized).replace(/\\/g, '/')
    : resolve(root, normalized).replace(/\\/g, '/')

  const rootKey = rootAbs.toLowerCase()
  const targetKey = targetAbs.toLowerCase()
  if (targetKey === rootKey) return normalized
  if (!targetKey.startsWith(`${rootKey}/`)) return normalized
  return targetAbs.slice(rootAbs.length + 1)
}

/** Every path a tool call names, or an empty list when they are not statically visible. */
function extractPaths(input, root) {
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
  // `tool_input.command` is where apply_patch and Bash put their payload, per the host's own
  // event schema.
  if (typeof record.command === 'string') {
    let match
    const re = new RegExp(PATCH_PATH_RE.source, 'gm')
    while ((match = re.exec(record.command)) !== null) push(match[1])
  }
  return found
}

/* -------------------------------------------------------------------------- */
/* what this session has already been shown                                    */
/* -------------------------------------------------------------------------- */

/**
 * The marker file name for one session, mirroring `seenMarkerName` in
 * `packages/core/src/hub.ts`.
 *
 * Copied for the same reason `canonicalPath` is: no imports are available here. The copies
 * must agree, because core uses the same file to tell a tool caller whether the ruling this
 * window holds is still current. A drift test drives both from one table.
 */
function seenMarkerName(sessionId) {
  const readable = String(sessionId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const digest = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 8)
  return `${readable || 'session'}-${digest}.json`
}

function readMarker(paths, sessionId) {
  const file = join(paths.state, 'hub-seen', seenMarkerName(sessionId))
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw && typeof raw.rulingId === 'string' ? raw : null
  } catch {
    return null
  }
}

function writeMarker(paths, sessionId, rulingId, event) {
  const dir = join(paths.state, 'hub-seen')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, seenMarkerName(sessionId)),
    `${JSON.stringify({ version: 1, rulingId, at: new Date().toISOString(), event })}\n`,
    'utf8',
  )
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Targeted delivery for the impact protocol: one bounded inbox, never another session's
 * context. Returns the hook-output line to print, or `null` when there is nothing to deliver.
 *
 * The inbox is revalidated against the declarations it was computed from, so an inbox built
 * from state that has since moved on is dropped rather than delivered late.
 */
function deliverImpacts(paths, payload) {
  const file = join(paths.state, 'impact-inbox', seenMarkerName(payload.sessionId))
  if (!existsSync(file)) return null
  const inbox = JSON.parse(readFileSync(file, 'utf8'))
  if (inbox.version !== 1 || inbox.sessionId !== payload.sessionId || inbox.workspace !== paths.root ||
      !Array.isArray(inbox.notifications) || Date.parse(inbox.expiresAt) <= Date.now() ||
      !Number.isFinite(Date.parse(inbox.expiresAt)) || Date.parse(inbox.generatedAt) > Date.now()) return
  // Recheck declarations and contract assumptions at delivery, including self-adaptation.
  const stamp = JSON.stringify(['impact-input.json', 'assumptions.json', '../contracts/index.json'].map(name => {
    if (name === 'impact-input.json') {
      try { return [name, readFileSync(join(paths.state, name), 'utf8')] } catch { return [name, null] }
    }
    try { const stat = statSync(join(paths.state, name)); return [name, stat.size, stat.mtimeMs] } catch { return [name, null] }
  }))
  if (stamp !== inbox.inputStamp) return
  const dir = join(paths.state, 'impact-seen', seenMarkerName(payload.sessionId))
  const selected = []
  let length = 0
  for (const item of inbox.notifications.slice(0, 20)) {
    if (!/^impact-[0-9a-f]{24}$/.test(item.id) || typeof item.text !== 'string' || !item.text.trim()) continue
    if (!['interrupt', 'defer'].includes(item.policy)) continue
    // Pre-tool is a boundary before a write; deferred updates wait until a completed tool or new turn.
    if (payload.eventName === 'PreToolUse' && item.policy !== 'interrupt') continue
    if (existsSync(join(dir, `${item.id}.json`))) continue
    const text = item.text.slice(0, 1400)
    if (length + text.length + 2 > MAX_ADVISORY_CHARS) break
    selected.push({ ...item, text })
    length += text.length + 2
  }
  if (!selected.length) return null
  mkdirSync(dir, { recursive: true })
  // Only mark the items actually included: bounded output must not silently lose the rest.
  const claimed = selected.filter(item => {
    try {
      writeFileSync(join(dir, `${item.id}.json`), JSON.stringify({
        id: item.id, sessionId: payload.sessionId, at: new Date().toISOString(), event: payload.eventName,
      }), { flag: 'wx' })
      return true
    } catch { return false }
  })
  if (!claimed.length) return null
  return `${JSON.stringify({ hookSpecificOutput: {
    hookEventName: payload.eventName, additionalContext: claimed.map(item => item.text).join('\n\n'),
  } })}\n`
}

/**
 * The hook-output object to print, or `null` when this payload needs no advisory.
 *
 * Returns the string rather than printing it so `hook.mjs` can merge this with the desktop
 * hook's context into a single response, and so a standalone run prints exactly what it always
 * did. Standalone use is unchanged — see {@link isDirectRun} below.
 */
export function run(payloadText) {
  const payload = normalizePayload(payloadText)
  if (!payload || !payload.sessionId) return null
  if (!EVENTS.has(payload.eventName)) return null

  const found = findWorkspace(payload.cwd)
  if (!found.root) return null

  const paths = { root: found.root, state: stateDir(found.root) }
  // The impact protocol reads only this receiver's bounded inbox, so it is the whole answer
  // when it is on. The global ruling path below is kept for older daemon projections.
  if (existsSync(join(paths.state, 'impact-protocol.json'))) return deliverImpacts(paths, payload)
  // A global ruling is never delivered after a tool has finished: it exists to interrupt a
  // write about the ground it is about to touch, and there is no write left to interrupt.
  if (payload.eventName === 'PostToolUse') return null
  const hubFile = join(paths.state, 'hub.json')
  if (!existsSync(hubFile)) return null

  let hub = null
  try {
    hub = JSON.parse(readFileSync(hubFile, 'utf8'))
  } catch {
    // A torn projection is a tick mid-write. Saying nothing is correct; the next tool call
    // will read the finished file.
    return null
  }
  if (!hub || typeof hub.id !== 'string' || typeof hub.advisory !== 'string') return null
  /*
   * Something has to be in it.
   *
   * A ruling carries contentions and a reservation is a holder, and either is worth a window's
   * attention. What must never happen is pushing an empty verdict: a ruling that always fires
   * trains the model to ignore it, and the tokens are paid on every tool call.
   */
  const rulingCount = Array.isArray(hub.rulings) ? hub.rulings.length : 0
  const holderCount = Array.isArray(hub.holders) ? hub.holders.length : 0
  if (rulingCount === 0 && holderCount === 0) return
  if (hub.advisory.trim() === '') return

  /*
   * A write is only interrupted with a ruling about the ground it is about to touch.
   *
   * The alternative — telling every write about every contention — is how an advisory becomes
   * noise, and a window that is told something irrelevant on every edit stops reading any of it.
   */
  if (payload.eventName === 'PreToolUse') {
    const targets = Array.isArray(hub.targets) ? hub.targets : []
    const hit = extractPaths(payload.toolInput, found.root).filter((path) => targets.includes(path))
    if (hit.length === 0) return
  }

  // Never twice for the same ruling. This applies to every event, including the write-time
  // nudge: a long session should be told a conclusion once, not on every save.
  if (readMarker(paths, payload.sessionId)?.rulingId === hub.id) return

  const advisory =
    hub.advisory.length <= MAX_ADVISORY_CHARS
      ? hub.advisory
      : `${hub.advisory.slice(0, MAX_ADVISORY_CHARS - 3)}...`

  writeMarker(paths, payload.sessionId, hub.id, payload.eventName)
  return `${JSON.stringify({
    hookSpecificOutput: { hookEventName: payload.eventName, additionalContext: advisory },
  })}\n`
}

if (isDirectRun(import.meta.url)) {
  let output = null
  try {
    output = run(readStdin())
  } catch (error) {
    // Coordination advice is never worth failing a tool call over, but the failure is worth
    // writing down: a hub that throws and a hub with nothing to say both print nothing.
    noteFailure('hub', error, { cwd: process.cwd() })
  }
  if (output) process.stdout.write(output)
  process.exit(0)
}

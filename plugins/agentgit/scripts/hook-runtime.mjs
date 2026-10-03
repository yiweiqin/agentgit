/**
 * Shared hook input and path handling. Only Node builtins are required, so the
 * installed plugin can run without node_modules or a TypeScript build.
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export function readStdin() {
  // A TTY means nobody piped a payload. Reading would block until the user typed,
  // which would hang the tool call, so this is the one case that returns early.
  if (process.stdin.isTTY) return ''
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

export function firstString(source, keys) {
  if (!source || typeof source !== 'object') return null
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/**
 * Preserve host field aliases in one place. Only recording and advisory hooks
 * opt into a cwd fallback; daemon startup and setup offers require an explicit cwd.
 */
export function normalizePayload(raw, { cwdFallback = null } = {}) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return {
    eventName: firstString(parsed, ['hook_event_name', 'hookEventName', 'event_name', 'eventName', 'event']) ?? '',
    sessionId: firstString(parsed, ['session_id', 'sessionId', 'thread_id', 'threadId', 'conversation_id']),
    threadId: firstString(parsed, ['thread_id', 'threadId', 'conversation_id', 'session_id', 'sessionId']),
    cwd: firstString(parsed, ['cwd', 'working_directory', 'workingDirectory']) ?? cwdFallback,
    toolName: firstString(parsed, ['tool_name', 'toolName', 'name']),
    toolInput: parsed.tool_input ?? parsed.toolInput ?? parsed.arguments ?? parsed.input ?? null,
    toolResponse: parsed.tool_response ?? parsed.toolResponse ?? parsed.result ?? null,
    transcriptPath: firstString(parsed, ['transcript_path', 'transcriptPath']),
    prompt: firstString(parsed, ['prompt', 'user_prompt', 'userPrompt', 'message']),
  }
}

function hasDir(dir, name) {
  try {
    return existsSync(join(dir, name))
  } catch {
    return false
  }
}

/** Prefer an opted-in ancestor, then a repository; only setup offers accept ordinary folders. */
export function findWorkspace(startDir, { allowFolder = false } = {}) {
  let current = resolve(startDir)
  let repo = null
  for (;;) {
    if (hasDir(current, '.agentgit')) return { root: current, kind: 'claimed' }
    if (repo === null && (hasDir(current, '.git') || hasDir(current, '.hg'))) repo = current
    const parent = join(current, '..')
    const next = resolve(parent)
    if (next === current) {
      if (repo) return { root: repo, kind: 'repo' }
      return allowFolder ? { root: resolve(startDir), kind: 'folder' } : { root: null, kind: 'none' }
    }
    current = next
  }
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

/** Mirrors core canonicalEntityPath; hooks cannot import the workspace packages. */
export function canonicalPath(root, value) {
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

/** Extract only explicit file arguments and patch headers; never guess paths from shell prose. */
export function extractPaths(input, root) {
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

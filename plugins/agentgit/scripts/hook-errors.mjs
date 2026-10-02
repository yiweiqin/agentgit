/**
 * Record a hook failure where a human can find it, without failing the hook.
 *
 * The problem this solves
 * -----------------------
 * Every hook here ends in `catch {}` and `exit 0`, and it has to: a hook that throws or exits
 * non-zero can break a tool call, and recording coordination is never worth that. But "swallow
 * the error" and "swallow the bug" look identical from the outside. The symptom of a broken
 * hook is a ledger that is quietly short, which is indistinguishable from a session that did
 * nothing — the exact failure this whole plugin exists to make visible. So the error is written
 * down instead of thrown: one bounded line in `state/hook-errors.jsonl`, which `agentgit doctor`
 * reports.
 *
 * Where it writes, and where it must not
 * --------------------------------------
 * Only into a directory that is already a workspace (`.agentgit` present, found by walking up).
 * A repository that has not opted in must be left byte for byte as it was, so a failure there
 * is silent — the same rule `track.mjs` uses to decide whether it may record at all.
 *
 * @module agentgit/hook-errors
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Must match the name `agentgit doctor` reads in `packages/cli/src/install.ts`. */
export const HOOK_ERRORS_FILE = 'hook-errors.jsonl'

/** Rotate rather than grow without bound: a crash loop must not fill a disk. */
const MAX_ERROR_BYTES = 64 * 1024

/** One recorded message is capped, so a giant stack or payload cannot bloat the file. */
const MAX_MESSAGE_CHARS = 400

/**
 * True when this module is the process entry point, rather than imported by `hook.mjs`.
 *
 * Each script keeps a standalone `main` so it can still be run and tested on its own — the drift
 * tests invoke them directly — while the dispatcher imports the same `run` without re-executing
 * it. Compared on real paths and case-folded on Windows, because a hook may be launched with a
 * differently-spelled path than the one Node resolved.
 */
export function isDirectRun(metaUrl) {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    const self = realpathSync(fileURLToPath(metaUrl))
    const invoked = realpathSync(entry)
    return process.platform === 'win32' ? self.toLowerCase() === invoked.toLowerCase() : self === invoked
  } catch {
    return false
  }
}

/**
 * Nearest ancestor that already carries coordination state, or `null`.
 *
 * Deliberately only `.agentgit`: an unclaimed repository is not ours to write into, and creating
 * state there just to report that we failed to create state would be worse than the silence.
 */
export function workspaceRootFor(startDir) {
  let current
  try {
    current = resolve(startDir)
  } catch {
    return null
  }
  for (;;) {
    if (existsSync(join(current, '.agentgit'))) return current
    const parent = join(current, '..')
    const next = resolve(parent)
    if (next === current) return null
    current = next
  }
}

/**
 * Append one failure line, best effort, and never throw.
 *
 * `root` is used when the caller already resolved the workspace; otherwise `cwd` is walked up to
 * find one. If neither yields a workspace, nothing is written.
 */
export function noteFailure(script, error, options = {}) {
  const message = (() => {
    const text = error && error.message ? String(error.message) : String(error)
    return text.length <= MAX_MESSAGE_CHARS ? text : text.slice(0, MAX_MESSAGE_CHARS)
  })()

  // The debug switch is honoured even when there is nowhere to write to, because the case a
  // developer is debugging is exactly the one where the workspace could not be found.
  if (process.env.AGENTGIT_HOOK_DEBUG === '1') {
    process.stderr.write(`[agentgit ${script}] ${message}\n`)
  }

  const root = options.root ?? workspaceRootFor(options.cwd ?? process.cwd())
  if (!root) return

  const dir = join(root, '.agentgit', 'state')
  const file = join(dir, HOOK_ERRORS_FILE)
  const line = `${JSON.stringify({
    at: new Date().toISOString(),
    script,
    message,
    event: typeof options.event === 'string' ? options.event : null,
  })}\n`

  try {
    mkdirSync(dir, { recursive: true })
    try {
      if (statSync(file).size > MAX_ERROR_BYTES) rmSync(file, { force: true })
    } catch {
      // No file yet, or it vanished between the stat and the remove. Either way: append.
    }
    appendFileSync(file, line, { encoding: 'utf8' })
  } catch {
    // The one failure this module must never produce is its own.
  }
}

/** How many recorded failures there are, and how many are recent. Never throws. */
export function countHookErrors(file, sinceMs = 24 * 60 * 60 * 1000, now = Date.now()) {
  try {
    const text = readFileSync(file, 'utf8')
    let total = 0
    let recent = 0
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue
      total += 1
      try {
        const at = Date.parse(JSON.parse(raw).at)
        if (Number.isFinite(at) && now - at <= sinceMs) recent += 1
      } catch {
        // An unreadable line still counts as a recorded failure, just not a dated one.
      }
    }
    return { total, recent }
  } catch {
    return { total: 0, recent: 0 }
  }
}

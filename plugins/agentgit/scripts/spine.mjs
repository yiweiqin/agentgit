#!/usr/bin/env node
/**
 * Hook: keep exactly one daemon watching this workspace, and say nothing.
 *
 * Why this file exists
 * --------------------
 * The hub's push half (`hub.mjs`) reads `state/hub.json`, and only a running daemon writes
 * that projection. So a workspace with no daemon has a push channel that is permanently
 * silent - the mechanism is wired and there is simply nothing to say. Before this script the
 * only way to get a daemon was for a human to run `agentgit up` in a terminal and leave it
 * open, which is not a plugin, it is a chore.
 *
 * This script is the missing half: at session start it makes sure a daemon is watching this
 * workspace, and otherwise does nothing at all.
 *
 * The same three constraints as `track.mjs`, for the same reason
 * --------------------------------------------------------------
 * It runs on the session-start path, alongside a script that runs before every tool call, so
 * it inherits the same rules:
 *
 * 1. **No imports outside `node:`.** It runs from the installed plugin directory, which has no
 *    `node_modules` and no build step.
 * 2. **It reads no ledger.** Liveness is one small file (`state/daemon.json`) and the answer is
 *    a pid. Reading `events/*.jsonl` here would make starting a session cost more as the
 *    workspace grows, which is the one thing this design forbids.
 * 3. **It cannot fail loudly.** A hook that throws or exits non-zero can break a session. Every
 *    path ends in `exit 0` with nothing on stdout - including the happy path, because this hook
 *    injects no context, so an empty stdout is the correct output rather than a fallback.
 *
 * What it will not do
 * -------------------
 * It starts a daemon only where the recorder already records: a workspace that has a ledger
 * directory, or that has already been claimed with a `.agentgit` of its own. Spawning one for
 * every repository an agent happened to open would scatter state across the machine, and the
 * daemon creates `.agentgit` on start - so an unclaimed directory is left byte-for-byte alone,
 * exactly as `track.mjs` leaves it.
 *
 * Two spellings are duplicated from `@agentgit/daemon`: the endpoint file's path and its
 * version. Copies drift, so `packages/cli/tests/spine.test.ts` drives both against the library
 * and fails the moment they disagree - the same arrangement `canonicalEntityPath` and the arm
 * table already use.
 *
 * @module agentgit/hook-spine
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Must match `ENDPOINT_VERSION` in `packages/daemon/src/endpoint.ts`. */
const ENDPOINT_VERSION = 1

/** Must match `ENDPOINT_FILE_NAME` in `packages/daemon/src/endpoint.ts`. */
const ENDPOINT_FILE_NAME = 'daemon.json'

/**
 * Hook events this script answers.
 *
 * `SessionStart` is the moment a workspace gets its watcher. `UserPromptSubmit` is here so a
 * daemon that died mid-session is replaced on the next turn rather than at the next session -
 * an unattended process will sometimes be killed, and a push channel that never comes back is
 * indistinguishable from a workspace with nothing to coordinate.
 *
 * Both are cheap when nothing is wrong: one read of a small file, one `kill(pid, 0)`, exit.
 */
const EVENTS = new Set(['SessionStart', 'UserPromptSubmit'])

/**
 * How long a spawn lock is trusted, in milliseconds.
 *
 * The lock covers one narrow window: between "decided to start a daemon" and "the daemon has
 * written its endpoint file". A daemon normally binds and advertises in well under a second, so
 * this is generous, and it doubles as a rate limit - a workspace whose daemon dies in a crash
 * loop gets one restart attempt per window instead of one per hook invocation.
 */
const SPAWN_LOCK_STALE_MS = 15_000

/** Rotate the log once past this size, so an unattended daemon cannot fill a disk. */
const MAX_LOG_BYTES = 1_000_000

/* -------------------------------------------------------------------------- */
/* input                                                                       */
/* -------------------------------------------------------------------------- */

function readStdin() {
  // A TTY means nobody piped a payload. Reading would block until the user typed, which would
  // hang the session, so this is the one case that returns early.
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
    /*
     * Deliberately no `process.cwd()` fallback, unlike `track.mjs` and `hub.mjs`.
     *
     * Those two decide something about the payload and, at worst, attribute a record to the wrong
     * ledger. This one *starts a process* that will watch a directory for as long as it lives, so
     * guessing the directory is a larger claim than the other scripts make. The host's hook schema
     * always sends `cwd`; if it is ever missing, doing nothing is the only answer that cannot
     * leave a stray watcher behind, and it is also why a test that omits `cwd` cannot reach into
     * the repository the test suite is running from.
     */
    cwd: firstString(parsed, ['cwd', 'working_directory', 'workingDirectory']),
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
 * Identical to `track.mjs`'s rule, and it has to stay identical: the two scripts have to agree
 * about which directory a workspace is, or the spine would watch one root while the recorder
 * wrote to another. A directory that is neither is left alone entirely.
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

/** The one spelling of the endpoint file's path, mirroring `endpointPathFor` in the library. */
function endpointPathFor(root) {
  return join(stateDir(root), ENDPOINT_FILE_NAME)
}

/* -------------------------------------------------------------------------- */
/* machine-specific config, written by `agentgit install`                       */
/* -------------------------------------------------------------------------- */

/**
 * Read `spine.json`, which `agentgit install` writes beside the templates at the plugin root.
 *
 * It sits one level up from this script, next to `hooks.json` and `.mcp.json`, because those are
 * the files `install` generates: the templates live at the root and the generated files are
 * written beside them. Looking in `scripts/` next to this file would find nothing, and finding
 * nothing here is a silent return - which is exactly how this was shipped wrong the first time.
 *
 * Everything machine-specific lives there rather than in the hook template, because a hook
 * handler's command line is asserted to be exactly "node plus one script" - adding the daemon
 * entry as a third argument would have made the install check either wrong or weaker. The file
 * is gitignored for the same reason `hooks.json` is: it holds this machine's absolute paths.
 *
 * A missing or unreadable file is silence, not an error. That is what a checkout that was never
 * installed looks like, and a hook that guessed a daemon path would spawn garbage.
 */
function readSpineConfig() {
  try {
    const raw = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'spine.json'), 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    const daemon = typeof raw.daemon === 'string' && raw.daemon ? raw.daemon : null
    if (!daemon || !existsSync(daemon)) return null
    const configured = typeof raw.node === 'string' && raw.node ? raw.node : null
    return {
      // `process.execPath` is the better default when the configured node has been moved or
      // uninstalled: this script is already running under a Node new enough for the hook, and
      // `install.ts` records the same flags it would need for that binary.
      node: configured && existsSync(configured) ? configured : process.execPath,
      daemon,
      flags: Array.isArray(raw.flags) ? raw.flags.filter((flag) => typeof flag === 'string') : [],
    }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* is a daemon already watching this workspace                                 */
/* -------------------------------------------------------------------------- */

function readEndpoint(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    if (raw.version !== ENDPOINT_VERSION) return null
    if (!Number.isInteger(raw.pid) || raw.pid <= 0) return null
    return raw
  } catch {
    return null
  }
}

/**
 * True when a process with this id exists.
 *
 * `EPERM` counts as alive: on Windows it means the pid exists but belongs to a process this one
 * may not signal. Reading that as dead would start a second daemon on a workspace that already
 * has one, which is precisely the outcome the endpoint file exists to prevent.
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM'
  }
}

/* -------------------------------------------------------------------------- */
/* one spawn at a time                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Take the exclusive right to start a daemon, or return false.
 *
 * `openSync(..., 'wx')` is the one primitive available without dependencies that cannot be won
 * by two processes at once, so this is a real lock rather than a best-effort timestamp check.
 * A holder that never got as far as writing an endpoint - because the machine slept mid-spawn -
 * is displaced once its lock is stale, which is what keeps one unlucky crash from permanently
 * disabling the spine for a workspace.
 */
function takeSpawnLock(lockFile) {
  try {
    mkdirSync(dirname(lockFile), { recursive: true })
  } catch {
    return false
  }
  const payload = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockFile, 'wx')
      try {
        writeFileSync(fd, payload)
      } finally {
        closeSync(fd)
      }
      return true
    } catch (error) {
      if (!error || error.code !== 'EEXIST') return false
      let fresh = false
      try {
        fresh = Date.now() - statSync(lockFile).mtimeMs < SPAWN_LOCK_STALE_MS
      } catch {
        fresh = false
      }
      // A fresh holder is doing exactly what we were about to do. Two daemons on one workspace
      // is worse than a restart that waits one window.
      if (fresh) return false
      try {
        rmSync(lockFile, { force: true })
      } catch {
        return false
      }
      // Fall through and race for the exclusive create; losing it means someone else got there.
    }
  }
  return false
}

/** The daemon's own stdout and stderr, appended and rotated. `null` when it cannot be opened. */
function openLog(file) {
  try {
    const rotate = statSync(file).size > MAX_LOG_BYTES
    return openSync(file, rotate ? 'w' : 'a')
  } catch {
    try {
      return openSync(file, 'a')
    } catch {
      return null
    }
  }
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

function main() {
  const payload = normalizePayload(readStdin())
  if (!payload) return
  if (!EVENTS.has(payload.eventName)) return
  // No `cwd` means no directory this hook is allowed to start a watcher for. See the note in
  // `normalizePayload`: guessing here is how a stray daemon outlives the session that made it.
  if (!payload.cwd) return

  const found = findWorkspace(payload.cwd)
  if (!found.root) return

  // Permission to watch, decided without creating anything, and by the same rule the recorder
  // uses to decide whether to record. The two must agree: a watcher where nothing is recorded
  // would have nothing to rule on, and a ledger with no watcher would never be read.
  const events = join(found.root, '.agentgit', 'events')
  const mayWatch = existsSync(events) || found.kind === 'claimed'
  if (!mayWatch) return

  const endpointFile = endpointPathFor(found.root)
  const running = readEndpoint(endpointFile)
  if (running && isProcessAlive(running.pid)) return

  const config = readSpineConfig()
  if (!config) return

  const state = stateDir(found.root)
  if (!takeSpawnLock(join(state, 'spine.lock'))) return

  const logFile = join(state, 'spine.log')
  const log = openLog(logFile)
  const stdio = log === null ? 'ignore' : ['ignore', log, log]

  try {
    const child = spawn(
      config.node,
      [
        ...config.flags,
        config.daemon,
        '--watch',
        found.root,
        // Port 0, not a fixed one: several workspaces each get their own daemon, and a fixed
        // port would make the second one fail to bind rather than simply advertise its own.
        '--port',
        '0',
        '--endpoint-file',
        endpointFile,
        // stdout has no reader here, and the daemon's startup banner would otherwise be written
        // into a detached pipe that nobody drains.
        '--quiet',
      ],
      { detached: true, stdio, windowsHide: true },
    )
    // Without this the hook process cannot exit until the daemon does, which would hang the
    // session it is supposed to be helping.
    child.unref()
  } catch {
    // A daemon that cannot be started is not worth failing a session over. The endpoint file is
    // left absent, so the next prompt tries again.
  } finally {
    if (log !== null) {
      try {
        // The child has its own copy of the descriptor; this process is about to exit, so holding
        // it open here would only keep the file locked for no reason.
        closeSync(log)
      } catch {
        // Already closed, or never ours to close.
      }
    }
  }
}

try {
  main()
} catch {
  // Starting a watcher is never worth failing a session over.
}
process.exit(0)

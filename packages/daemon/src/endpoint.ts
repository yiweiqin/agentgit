/**
 * The endpoint file: how a running daemon tells the next process that it is already
 * watching a workspace, and which port it chose.
 *
 * Why a file rather than a fixed port
 * -----------------------------------
 * The daemon used to be started by hand on a fixed port, so "is one already running" was
 * answered by the person who started it. `plugins/agentgit/scripts/spine.mjs` starts the
 * daemon automatically on `SessionStart`, unattended, for every claimed workspace on the
 * machine - and it must do so exactly once per workspace. Binding a fixed port cannot
 * answer that question (a second workspace would collide rather than discover the first),
 * so the automatic daemon binds port 0 and writes the port it was given here, next to a
 * pid that the next caller can check for liveness.
 *
 * The file lives under `.agentgit/state/`, which is derived state that `.gitignore`
 * already excludes, so it is never committed and deleting it loses nothing: a daemon that
 * is still running rewrites it, and one that is gone should be replaced anyway.
 *
 * @module @agentgit/daemon/endpoint
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { workspacePaths } from '@agentgit/core'

/** Bumped only if the shape below changes incompatibly; a mismatch reads as "absent". */
export const ENDPOINT_VERSION = 1

/** The file's name inside `.agentgit/state/`, mirrored as literal text in `spine.mjs`. */
export const ENDPOINT_FILE_NAME = 'daemon.json'

export interface EndpointRecord {
  readonly version: number
  readonly pid: number
  readonly port: number
  readonly url: string
  readonly roots: readonly string[]
  readonly startedAt: string
}

/**
 * The one spelling of the endpoint file, mirrored in `plugins/agentgit/scripts/spine.mjs`.
 *
 * Copied rather than imported on purpose, exactly as `canonicalEntityPath` is: the hook
 * script runs from an installed plugin directory with no `node_modules` and no build step.
 * `packages/cli/tests/spine.test.ts` drives both spellings over one table, which is what
 * keeps the two from drifting into a workspace where the spine never finds its own daemon.
 */
export function endpointPathFor(root: string): string {
  return join(workspacePaths(root).state, ENDPOINT_FILE_NAME)
}

/**
 * True when a process with this id exists.
 *
 * `EPERM` counts as alive: on Windows it means the pid exists but belongs to someone this
 * process may not signal. Treating that as dead would start a second daemon on a workspace
 * that already has one, which is the one outcome this file exists to prevent. The obvious
 * alternative - probing the port - cannot be done without a socket and would turn a
 * liveness check into I/O.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The endpoint file's contents, or `null` when it is absent, torn or a different shape. */
export function readEndpoint(file: string): EndpointRecord | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Partial<EndpointRecord>
  if (record.version !== ENDPOINT_VERSION) return null
  // A pid of zero or less is never a daemon, and `isProcessAlive` already refuses to probe one.
  // Rejecting it here is what keeps every caller from having to re-check the same thing, and it
  // keeps this function's answer the same as the hook's copy of it.
  if (!Number.isInteger(record.pid) || (record.pid as number) <= 0) return null
  if (!Number.isInteger(record.port) || (record.port as number) < 0) return null
  if (typeof record.url !== 'string' || !Array.isArray(record.roots)) return null
  return {
    version: ENDPOINT_VERSION,
    pid: record.pid as number,
    port: record.port as number,
    url: record.url,
    roots: record.roots.filter((root): root is string => typeof root === 'string'),
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
  }
}

/**
 * Write the endpoint atomically, so a reader never sees half a record.
 *
 * A torn endpoint file would read as "no daemon", and the spine's answer to "no daemon" is
 * to start one - so a torn write here is a duplicate daemon, not just a bad read. Writing
 * to a temporary name and renaming is what makes that impossible.
 */
export function writeEndpoint(file: string, record: Omit<EndpointRecord, 'version'>): void {
  mkdirSync(dirname(file), { recursive: true })
  const payload: EndpointRecord = { version: ENDPOINT_VERSION, ...record }
  const temporary = `${file}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

/**
 * Remove the endpoint file, but only if this process wrote it.
 *
 * A daemon that exits must not delete the record of a *different*, still-running daemon -
 * which is what would happen if a user started two and then stopped one. Comparing the pid
 * makes shutdown ownership-safe.
 */
export function removeEndpoint(file: string): void {
  const record = readEndpoint(file)
  if (record && record.pid !== process.pid) return
  try {
    rmSync(file, { force: true })
  } catch {
    // A file another process is replacing is not an error; the next daemon rewrites it.
  }
}

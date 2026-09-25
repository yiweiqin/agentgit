/**
 * Shared builders for ledger tests.
 *
 * Not a `*.test.ts` file, so the runner's glob does not execute it as a suite.
 */

import { chmodSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { buildEvent } from '../src/ledger.ts'
import type { CoordEvent } from '../src/types.ts'

/** Base instant for all fixtures; every offset is relative to this. */
export const T0 = Date.parse('2026-01-01T00:00:00Z')

/** ISO timestamp `minutes` after {@link T0}. */
export function at(minutes: number): string {
  return new Date(T0 + minutes * 60_000).toISOString()
}

/** A minimal well-formed event; override only what a test cares about. */
export function ev(overrides: Partial<CoordEvent> & { kind: CoordEvent['kind']; minutes: number }): CoordEvent {
  const { minutes, ...rest } = overrides
  return buildEvent({
    timestampUtc: at(minutes),
    sessionId: 's1',
    ...rest,
  } as Parameters<typeof buildEvent>[0])
}

/** A `file_write` event for one path. */
export function write(overrides: {
  minutes: number
  sessionId?: string
  taskId: string
  path: string
  intentText?: string | null
}): CoordEvent {
  return ev({
    kind: 'file_write',
    minutes: overrides.minutes,
    sessionId: overrides.sessionId ?? 's1',
    taskId: overrides.taskId,
    intentText: overrides.intentText ?? null,
    entities: [{ kind: 'file', identifier: overrides.path, path: overrides.path }],
  })
}

/* -------------------------------------------------------------------------- */
/* Housekeeping                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Clear the read-only attribute from a tree, deepest first.
 *
 * `git` writes its object files read-only, and Windows refuses to delete one. Node's
 * `rmSync` with `force: true` is documented to remove read-only files but does not reliably
 * do so for a Windows directory tree, which is why the explicit pass exists.
 */
function clearReadOnly(dir: string): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) clearReadOnly(full)
    try {
      chmodSync(full, 0o666)
    } catch {
      // A file that vanished, or a handle we cannot reopen. The retry below decides.
    }
  }
  try {
    chmodSync(dir, 0o777)
  } catch {
    // Same.
  }
}

/**
 * Delete a scratch repository, and never let housekeeping fail a test.
 *
 * These directories held a real repository that `git` and the CLI were writing to moments
 * ago. Under a full parallel run, an external handle — the OS file scanner picking up a
 * freshly created `.git` tree — can hold one for a few seconds, and the delete then fails
 * with `EPERM` on whichever test happened to be running last. That reads as a broken test
 * and is not one: every assertion has already passed by the time a teardown hook runs.
 *
 * Two stages, because the two causes need different remedies: retry with a widening delay
 * covers a handle that goes away on its own, and clearing the read-only attribute covers the
 * one git leaves behind. Then a report on stderr rather than a throw, because a directory
 * that can never be removed is worth noticing but is not evidence about the product.
 */
export function removeScratch(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    return
  } catch {
    // Fall through to the attribute pass and one more attempt.
  }
  clearReadOnly(dir)
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch (error) {
    process.stderr.write(`[agentgit tests] could not remove ${dir}: ${(error as Error).message}\n`)
  }
}

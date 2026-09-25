/**
 * Shared builders for ledger tests.
 *
 * Not a `*.test.ts` file, so the runner's glob does not execute it as a suite.
 */

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

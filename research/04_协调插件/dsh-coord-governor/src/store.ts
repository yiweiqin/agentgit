/**
 * Append-only ledger storage.
 *
 * Appends are synchronous on purpose. The ledger's value is that it records
 * exactly what happened and in what order; an asynchronous buffer that loses the
 * tail of a crashed run would corrupt `B(t)` at precisely the moment the run
 * became most interesting. E6 measures the latency this costs, and if it is too
 * expensive the fix is to batch inside the harness, not to weaken the ordering
 * guarantee here.
 *
 * @module dsh-coord-governor/store
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * The ledger file name.
 *
 * Must match `LEDGER_FILENAME` in `04_协调插件/coord_ledger.py`, because that
 * analyser resolves `<dir>/events.jsonl`. A different name here would make every
 * Python-side report silently empty — a failure mode that looks like "no
 * contention found" rather than "wrong file". `tests/interop.test.ts` reads the
 * Python constant and fails if the two drift.
 */
export const LEDGER_FILENAME = 'events.jsonl'

/**
 * Resolve the ledger file path.
 *
 * A relative path is resolved against the process working directory, which the
 * harness pins per arm and per round. Absolute paths are honoured so a run can
 * put every arm's ledger in one collection directory outside the worktree.
 */
export function ledgerFilePath(configured: string, cwd: string = process.cwd()): string {
  if (!configured) return join(cwd, LEDGER_FILENAME)
  const base = isAbsolute(configured) ? configured : resolve(cwd, configured)
  // A path ending in `.jsonl` is treated as the file itself; anything else is a
  // directory, because that is how a human writes it in config either way.
  return base.endsWith('.jsonl') ? base : join(base, LEDGER_FILENAME)
}

/** Append one already-serialized line, creating the directory on first use. */
export function appendLedgerLine(filePath: string, line: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  appendFileSync(filePath, line, { encoding: 'utf8' })
}

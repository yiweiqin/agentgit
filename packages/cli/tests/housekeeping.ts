/**
 * Teardown for scratch directories in this package's tests.
 *
 * Not a `*.test.ts` file, so the runner's glob does not execute it as a suite. That is the same
 * arrangement `packages/core/tests/helpers.ts` uses, and why it is a separate module at all.
 *
 * The problem this solves, and why it is not paranoia
 * ---------------------------------------------------
 * These suites spawn real Node processes, and several of them hand the child a temporary directory
 * as its working directory. Windows holds a directory handle for a moment after the process that
 * had it as its cwd exits, so `rmSync` on that directory fails with `EPERM` - intermittently, and
 * on whichever test happens to finish last. Every assertion in the test has already passed by the
 * time a teardown hook runs, so a throw here reads as a broken test and is not one. It was observed
 * failing roughly one run in three before this existed.
 *
 * `packages/core/tests/helpers.ts` has a variant that additionally clears the read-only attribute,
 * because it removes real `git` trees whose object files Windows refuses to delete. Nothing here
 * removes a repository, so the retry is the whole remedy and the attribute pass would be dead code.
 *
 * Reporting rather than throwing is deliberate, for the reason `packages/core/tests/helpers.ts`
 * gives: a directory that can never be removed is worth noticing, and it is not evidence about the
 * product.
 */

import { rmSync } from 'node:fs'

export function removeScratch(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch (error) {
    process.stderr.write(`[agentgit tests] could not remove ${dir}: ${(error as Error).message}\n`)
  }
}

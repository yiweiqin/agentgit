#!/usr/bin/env node
/**
 * The `agentgit` executable: the CLI, on whatever Node the user already has.
 *
 * Why there is a wrapper at all, when `src/main.ts` already has a shebang
 * ---------------------------------------------------------------------
 * A shebang can name an interpreter but cannot pass it a flag, and the CLI is TypeScript. Node
 * only strips types unflagged from major 23 onward, so on the 22.19 the package requires the
 * `.ts` entry cannot be executed directly. The `bin` entry therefore points here, and this file
 * adds the flag when the running Node needs it.
 *
 * The alternative - shipping compiled JavaScript - would mean a build step between an edit and
 * the thing a user runs, in a repository whose whole shape is "the source is the artifact". The
 * flag is read from the running version rather than hard-coded for the same reason `install.ts`
 * reads it: the same file has to work on 22 and on 23+.
 *
 * `stdio: 'inherit'` matters and is not a default: `agentgit up` prints a live board and takes
 * Ctrl+C, and a wrapper that piped the output would make both of those worse.
 *
 * @module agentgit/bin
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const major = Number(process.versions.node.split('.')[0])
const flags = Number.isFinite(major) && major >= 23 ? [] : ['--experimental-strip-types']

const result = spawnSync(process.execPath, [...flags, main, ...process.argv.slice(2)], {
  stdio: 'inherit',
})

if (result.error) {
  process.stderr.write(`agentgit: could not start node: ${result.error.message}\n`)
  process.exit(2)
}
// The CLI's exit codes are its interface - 0 clean, 1 found something to act on, 2 usage error -
// so this passes the child's status through rather than flattening it to success.
process.exit(result.status ?? 1)

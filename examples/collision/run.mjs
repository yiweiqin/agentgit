#!/usr/bin/env node
/**
 * The collision walkthrough, in a throwaway repository.
 *
 * `agentgit demo` runs against the workspace you point it at, which for a first look is
 * usually the checkout you are actually working in. This script does the same thing the
 * way you would want to try it: it makes a scratch repository under the system temp
 * directory, seeds it with a small app, and runs the real CLI against it. Nothing outside
 * that directory is written, and the whole thing is deleted on the way out unless you ask
 * for it to be kept.
 *
 * It runs in three acts.
 *
 * 1. **The ledger.** Two agents describe the same work in their own words and the second
 *    is told the work already exists. This is `agentgit demo`.
 * 2. **The repository.** Two tasks get their own worktree and branch, and a checkpoint by
 *    one task commits only that task's file while a second agent's unfinished edit sits in
 *    the same tree untouched. This is the part Git cannot do for you and the part that is
 *    actually dangerous to get wrong.
 * 3. **The handover.** What the product will not do by itself: the integration order and
 *    the ghost merge, plus the commands it hands you instead of running them.
 *
 *     node examples/collision/run.mjs [--keep] [--open]
 *
 * `--keep` leaves the scratch repository in place and prints its path, so you can poke at
 * it. `--open` starts the live board against the scratch workspace; press Ctrl+C to stop.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const cli = join(repoRoot, 'packages', 'cli', 'src', 'main.ts')

const keep = process.argv.includes('--keep')
const open = process.argv.includes('--open')
const scratch = mkdtempSync(join(tmpdir(), 'agentgit-collision-'))

const bold = (text) => (process.stdout.isTTY ? `\u001b[1m${text}\u001b[0m` : text)
const dim = (text) => (process.stdout.isTTY ? `\u001b[2m${text}\u001b[0m` : text)

function say(line = '') {
  process.stdout.write(`${line}\n`)
}

/**
 * Run a program in the scratch repository, echoing it the way a person would have typed it.
 * `display` is what gets printed; the real argv carries absolute paths that would bury the
 * one line the reader is meant to follow.
 */
function run(command, args, options = {}) {
  say(dim(`  $ ${options.display ?? [command, ...args].join(' ')}`))
  const result = spawnSync(command, args, { cwd: options.cwd ?? scratch, encoding: 'utf8', stdio: options.quiet ? 'pipe' : 'inherit', env: { ...process.env, ...options.env } })
  if (result.error) throw result.error
  if (options.quiet && result.status !== 0) {
    // Quiet output is still output when something failed; swallowing it hides the reason.
    process.stderr.write(`${result.stdout ?? ''}${result.stderr ?? ''}`)
  }
  return result.status ?? 1
}

/** Run the AgenticGit CLI itself, from inside the scratch repository. */
function agentgit(args, options = {}) {
  return run(process.execPath, [cli, ...args], {
    ...options,
    display: options.display ?? `agentgit ${args.join(' ')}`,
  })
}

function write(relative, contents) {
  const file = join(scratch, relative)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents, 'utf8')
}

function commit(message) {
  run('git', ['add', '-A'], { quiet: true })
  run('git', ['commit', '-q', '-m', message], { quiet: true })
}

function section(number, title) {
  say('')
  say(bold(`${number}. ${title}`))
  say('')
}

/* -------------------------------------------------------------------------- */
/* A repository to collide in                                                  */
/* -------------------------------------------------------------------------- */

say(dim(`scratch repository: ${scratch}`))
run('git', ['init', '-q', '-b', 'main', '.'], { quiet: true })
run('git', ['config', 'user.email', 'demo@example.com'], { quiet: true })
run('git', ['config', 'user.name', 'AgenticGit demo'], { quiet: true })
run('git', ['config', 'commit.gpgsign', 'false'], { quiet: true })

write('src/login.py', 'def login(user, password):\n    return check(user, password)\n')
write('src/config.py', 'LIMIT = 5\nWINDOW_SECONDS = 60\n')
write('README.md', '# demo app\n')
commit('seed')

/* -------------------------------------------------------------------------- */
/* Act 1: the ledger                                                           */
/* -------------------------------------------------------------------------- */

section(1, 'Two agents, one file, no Git conflict')
agentgit(['demo'])

/* -------------------------------------------------------------------------- */
/* Act 2: the repository                                                       */
/* -------------------------------------------------------------------------- */

section(2, 'Each task gets its own worktree, and a checkpoint stays inside it')

say('  Two tasks start in the same repository. Each gets a branch and a checkout of its')
say('  own, so neither agent has to see the other\'s half-finished file in its editor.')
agentgit(['task', 'start', 'demo-a', '--intent', 'make login failures back off', '--path', 'src/login.py'], { env: { AGENTGIT_SESSION: 'demo-a' } })
agentgit(['task', 'start', 'demo-b', '--intent', 'throttle repeated logins', '--path', 'src/limiter.py'], { env: { AGENTGIT_SESSION: 'demo-b' } })

say('')
say('  `agentgit task list` now shows one entry per task, with its own branch:')
agentgit(['task', 'list'])

say('')
say('  Agent A edits the login module. Agent B edits its own file and leaves the config')
say('  module half-finished - the state every second agent is in when someone else')
say('  checkpoints the whole tree. Then A checkpoints, naming only its own path:')
say('')
write('src/login.py', 'def login(user, password):\n    return throttle(user, limit=LIMIT, window_seconds=WINDOW_SECONDS)\n')
write('src/config.py', 'LIMIT = 5\nWINDOW_SECONDS = 60\n# halfway through adding a per-user override\n')
agentgit(['task', 'checkpoint', 'demo-a', '--path', 'src/login.py', '--message', 'checkpoint: rate limiting in login'])

say('')
say('  What Git says is still uncommitted afterwards:')
run('git', ['status', '--short'])
say('')
say(dim('  The config module is still an uncommitted edit in progress, and it is not the'))
say(dim('  checkpoint\'s. `git add -A && git commit` would have taken it. That is the'))
say(dim('  difference the product is built on.'))

/* -------------------------------------------------------------------------- */
/* Act 3: the handover                                                         */
/* -------------------------------------------------------------------------- */

section(3, 'What it will not do for you')

say('  Reconcile reports the state of the ledger and the handover order, and it does not')
say('  merge, rebase or delete anything:')
agentgit(['reconcile'])

say('')
say('  When a real merge is needed it describes the command rather than running it:')
agentgit(['why', 'demo-a'])

/* -------------------------------------------------------------------------- */
/* Leaving the scratch repository in a known state                             */
/* -------------------------------------------------------------------------- */

const panel = join(scratch, '.agentgit', 'state', 'panel', 'agentgit-panel.html')

section('End', 'where everything actually happened')

say('  Everything above happened in a real repository, with real commits:')
say(`  ${scratch}`)
say('')
say(`  The panel fragment for that workspace is at`)
say(`  ${panel}`)
if (open) {
  say('')
  say('  Starting the live board. Ctrl+C to stop.')
  run(process.execPath, [cli, 'up', '--workspace', scratch])
}

if (keep) {
  say('')
  say('  --keep was passed, so the repository is left in place. Remove it with:')
  say(`  ${process.platform === 'win32' ? 'rmdir /s /q' : 'rm -rf'} "${scratch}"`)
} else {
  rmSync(scratch, { recursive: true, force: true })
  say('')
  say('  The scratch repository has been removed. Pass --keep to inspect it instead.')
}

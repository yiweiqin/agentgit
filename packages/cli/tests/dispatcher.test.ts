/**
 * The dispatcher: one Node process per lifecycle event, running the same steps in the same order.
 *
 * Before this, each of track/spine/hub/desktop was its own handler, so a session start spawned four
 * `node` processes and every file edit spawned two. What those tests could not see, and this file
 * exists to pin down, is that merging them must not merge their *failures*: a step that throws has
 * to be recorded and skipped, and the steps after it — and the exit code — must be unaffected.
 *
 * The checkout's own `hook.mjs` is driven, not a copy, so the tests exercise what an install ships.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { removeScratch } from './housekeeping.ts'

/** The checkout root, found from this file rather than from the working directory. */
const REPO = join(import.meta.dirname, '..', '..', '..')
const SCRIPTS = join(REPO, 'plugins', 'agentgit', 'scripts')

let workspace: string
let offersHome: string
let shim: string
let shimRoot: string

/**
 * A copy of the shipped dispatcher and the scripts it imports, in a directory this test owns.
 *
 * The copy is not for isolation of the code — it is the `spine.json` beside it. The checkout has a
 * generated one naming the real daemon, and a session start would then spawn a daemon per test and
 * leave it holding the scratch workspace. A config naming a daemon that is not there makes the
 * spine step start nothing, which is exactly what this file is not testing.
 */
before(() => {
  shimRoot = mkdtempSync(join(tmpdir(), 'agentgit-dispatch-plugin-'))
  mkdirSync(join(shimRoot, 'scripts'), { recursive: true })
  for (const script of ['hook.mjs', 'track.mjs', 'spine.mjs', 'hub.mjs', 'desktop.mjs', 'hook-errors.mjs', 'hook-runtime.mjs']) {
    writeFileSync(join(shimRoot, 'scripts', script), readFileSync(join(SCRIPTS, script), 'utf8'), 'utf8')
  }
  writeFileSync(
    join(shimRoot, 'spine.json'),
    `${JSON.stringify({ node: process.execPath, daemon: join(shimRoot, 'no-such-daemon.mjs'), flags: [] }, null, 2)}\n`,
    'utf8',
  )
  shim = join(shimRoot, 'scripts', 'hook.mjs')
})

after(() => {
  removeScratch(shimRoot)
})

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'agentgit-dispatch-'))
  // A claimed workspace: the dispatcher, like every hook, may only write to one.
  mkdirSync(join(workspace, '.agentgit', 'state'), { recursive: true })
  // The machine-level record for a repository that has not opted in must land here, never in the
  // real home directory of whoever runs the suite.
  offersHome = mkdtempSync(join(tmpdir(), 'agentgit-dispatch-home-'))
})

afterEach(() => {
  // `removeScratch`, not `rmSync`: the spawned hook had this directory as its cwd, and Windows
  // holds the handle for a moment after it exits. See `housekeeping.ts`.
  removeScratch(workspace)
  removeScratch(offersHome)
})

function runHook(payload: unknown, overrides: Record<string, string | undefined> = {}) {
  const result = spawnSync(process.execPath, [shim], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    // Never the checkout: a payload without `cwd` must not be able to reach the repository this
    // suite runs from. That bug has already happened once in this package.
    cwd: workspace,
    env: { ...process.env, AGENTGIT_HOME: offersHome, CODEX_THREAD_ID: 'thread-a', ...overrides },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function sessionStart(): Record<string, unknown> {
  return { hook_event_name: 'SessionStart', session_id: 'session-d', cwd: workspace }
}

/** The injected text, or `null` when the dispatcher chose to say nothing. */
function contextOf(result: { stdout: string }): string | null {
  if (result.stdout.trim() === '') return null
  const parsed = JSON.parse(result.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string }
  }
  return parsed.hookSpecificOutput.additionalContext
}

/**
 * A hub projection the hub hook will read and publish on a session start.
 *
 * Written by hand rather than produced by a daemon: the dispatcher's job is to run the steps it is
 * given, and the shortest road to "two steps both have something to say" is to hand one of them a
 * finished ruling.
 */
function seedHub(): void {
  writeFileSync(
    join(workspace, '.agentgit', 'state', 'hub.json'),
    `${JSON.stringify({
      id: 'ruling-1',
      advisory: 'HUB-ADVISORY: two tasks want src/limiter.ts',
      rulings: [{ id: 'ruling-1' }],
      holders: [],
      targets: ['src/limiter.ts'],
    })}\n`,
    'utf8',
  )
}

describe('the hook dispatcher', () => {
  test('merges what every step has to say into one hook-output object', () => {
    seedHub()

    const result = runHook(sessionStart())

    assert.equal(result.status, 0)
    const context = contextOf(result)
    assert.ok(context, 'a ruling and a due offer are both worth saying')
    assert.match(context, /HUB-ADVISORY/, 'the hub step contributed its ruling')
    assert.match(context, /AgenticGit/, 'the desktop step contributed its offer')
    assert.ok(context.includes('\n\n'), 'the two contexts are joined, not run together')
    // Record, then spine, then hub, then desktop. The order is load-bearing: a ruling read before
    // the recorder would describe a workspace one line out of date, and the offer goes last
    // because it may inject context but changes no coordination state.
    assert.ok(
      context.indexOf('HUB-ADVISORY') < context.indexOf('AgenticGit'),
      'the ruling precedes the offer, so the offer never delays what the hub has to say',
    )
    // One object and one event name: the host reads one response per hook invocation, and a
    // second object on stdout is a protocol error rather than extra context.
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>
    assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput'])
  })

  test('a throwing step is recorded, and the steps after it still run', () => {
    seedHub()
    // `hub-seen` exists as a *file*, so the hub's marker write throws. The hub runs before the
    // desktop offer, so a dispatcher that let the throw escape would lose the offer too.
    writeFileSync(join(workspace, '.agentgit', 'state', 'hub-seen'), 'not a directory', 'utf8')

    const result = runHook(sessionStart())

    assert.equal(result.status, 0, 'a hook must never fail the tool call it is attached to')
    const context = contextOf(result)
    assert.ok(context, 'the offer still arrives')
    assert.match(context, /AgenticGit/)
    assert.ok(!context.includes('HUB-ADVISORY'), 'the failed step contributed nothing')

    const record = join(workspace, '.agentgit', 'state', 'hook-errors.jsonl')
    assert.ok(existsSync(record), 'the swallowed failure is written down, not lost')
    const lines = readFileSync(record, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1, 'one bounded line per failure')
    assert.match(lines[0], /"event":"hub"/, 'the record names which step failed')
  })

  test('still ends in exit 0 with nothing on stdout for a payload it cannot route', () => {
    for (const payload of ['', '{', 'null', '[]', '"a string"', '{"hook_event_name":"SessionEnd"}']) {
      const result = runHook(payload)
      assert.equal(result.status, 0, `payload ${JSON.stringify(payload)} must not fail the hook`)
      assert.equal(result.stdout, '', 'the protocol channel stays empty when there is nothing to say')
    }
  })

  test('narrows the ruling to a pending write, so a read is not interrupted', () => {
    seedHub()

    const read = runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'session-d',
      cwd: workspace,
      tool_name: 'read_file',
      tool_input: { file_path: join(workspace, 'src', 'limiter.ts') },
    })
    assert.equal(read.status, 0)
    assert.equal(read.stdout, '', 'a tool that cannot change a file is not worth a ruling')

    const write = runHook({
      hook_event_name: 'PreToolUse',
      session_id: 'session-d',
      cwd: workspace,
      tool_name: 'apply_patch',
      tool_input: '*** Update File: src/limiter.ts',
    })
    assert.equal(write.status, 0)
    assert.match(contextOf(write) ?? '', /HUB-ADVISORY/, 'a pending write to ruled ground is')
  })

  test('runs the hub on a post-tool event, but never with a global ruling', () => {
    seedHub()

    const result = runHook({
      hook_event_name: 'PostToolUse',
      session_id: 'session-d',
      cwd: workspace,
      tool_name: 'apply_patch',
      tool_input: '*** Update File: src/a.ts',
      tool_response: { is_error: false },
    })

    assert.equal(result.status, 0)
    const context = contextOf(result) ?? ''
    // The hub is reached here, but a global ruling is not delivered: it exists to interrupt a
    // write about the ground it is about to touch, and by now there is no write left. The reason
    // PostToolUse reaches the hub at all is the impact protocol, whose deferred notifications are
    // explicitly held back until a tool has completed - and that path is only live when
    // `impact-protocol.json` exists, which it does not in this workspace.
    assert.doesNotMatch(context, /HUB-ADVISORY/, 'a global ruling has no write left to interrupt')
    // The desktop step also runs on this path, and a completed write is the one moment a session
    // that began before the plugin was enabled can still be offered coordination.
    assert.match(context, /AgenticGit/, 'a completed write can still reach a session that missed SessionStart')
    assert.ok(existsSync(join(workspace, '.agentgit', 'events')), 'the write was still recorded')
  })
})

describe('the failure record', () => {
  test('writes one bounded line into the workspace, and leaves an unclaimed directory alone', async () => {
    const { noteFailure, countHookErrors, HOOK_ERRORS_FILE } = (await import(
      new URL('../../../plugins/agentgit/scripts/hook-errors.mjs', import.meta.url).href
    )) as {
      noteFailure: (script: string, error: unknown, options?: Record<string, unknown>) => void
      countHookErrors: (file: string) => { total: number; recent: number }
      HOOK_ERRORS_FILE: string
    }
    // The name is the contract between the writer here and the reader in `agentgit doctor`.
    assert.equal(HOOK_ERRORS_FILE, 'hook-errors.jsonl')

    noteFailure('hub', new Error('kaboom'), { root: workspace, event: 'SessionStart' })
    const file = join(workspace, '.agentgit', 'state', HOOK_ERRORS_FILE)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1, 'one failure is one line')
    const parsed = JSON.parse(lines[0]) as { script: string; event: string; message: string }
    assert.equal(parsed.script, 'hub')
    assert.equal(parsed.event, 'SessionStart')
    assert.equal(parsed.message, 'kaboom')
    assert.deepEqual(countHookErrors(file), { total: 1, recent: 1 })

    // A stack or a payload must not be able to bloat the file.
    noteFailure('track', new Error('x'.repeat(10_000)), { root: workspace })
    const last = JSON.parse(readFileSync(file, 'utf8').trim().split('\n').at(-1) as string) as { message: string }
    assert.equal(last.message.length, 400)

    // The rule every hook shares: a repository that has not opted in is never written to, even to
    // report that something failed.
    const bare = mkdtempSync(join(tmpdir(), 'agentgit-bare-'))
    try {
      noteFailure('track', new Error('ignored'), { cwd: bare })
      assert.ok(!existsSync(join(bare, '.agentgit')), 'an unclaimed directory must gain nothing')
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

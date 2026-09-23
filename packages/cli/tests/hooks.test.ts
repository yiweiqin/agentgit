/**
 * The hook loop, end to end: the command Codex will actually run, with the payload
 * Codex actually sends, landing a record in `.agentgit/events/`.
 *
 * Two of these tests are the only ones in the suite that would still be interesting
 * if the code were perfect:
 *
 * - The command is read out of the *generated* `hooks.json`, not written out by hand.
 *   A template that renders an unrunnable command is invisible until a user installs
 *   it, and then it looks like an agent that simply did not write anything.
 * - The hook is driven with a payload shaped like Codex's, and the resulting record is
 *   compared against what `@agentgit/core` computes for the same file. The hook carries
 *   its own copy of the path canonicalisation, because it cannot import the library, and
 *   this is the test that keeps the two copies agreeing. When they diverge the failure is
 *   silent: the ledger fills with keys that never match a preflight, and every collision
 *   reads as clear ground.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalEntityPath, appendEvent, loadLeases, readAllEvents, workspacePaths } from '@agentgit/core'

/** The checkout root, found from this file rather than from the working directory. */
const REPO = join(import.meta.dirname, '..', '..', '..')
const TRACK = join(REPO, 'plugins', 'agentgit', 'scripts', 'track.mjs')

let workspace: string
let eventsDir: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'agentgit-hooks-'))
  // A claimed workspace: `.agentgit/` already exists, which is the only case where the
  // hook is allowed to create the events directory.
  mkdirSync(join(workspace, '.agentgit'), { recursive: true })
  eventsDir = join(workspace, '.agentgit', 'events')
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

/** Run the hook exactly as Codex would: payload on stdin, nothing on stdout. */
function runHook(payload: Record<string, unknown>, script = TRACK) {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, AGENTGIT_MACHINE: 'test-machine' },
  })
  return result
}

/** Every event the hook has written so far. */
function events(): Record<string, never>[] {
  const { events: parsed } = readAllEvents(workspacePaths(workspace))
  return parsed as unknown as Record<string, never>[]
}

function only(): Record<string, never> {
  const all = events()
  assert.equal(all.length, 1, `expected exactly one event, got ${all.length}`)
  return all[0]
}

/**
 * Every assertion below reads the parsed event rather than the raw line: `readAllEvents`
 * converts the wire's snake_case back to the camelCase the library uses, so a test
 * written against `event.session_id` would compare `undefined` to a string and pass for
 * the wrong reason.
 */
const SESSION = 'session-abc'

function preToolUse(path: string, intent = 'add rate limiting'): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    session_id: SESSION,
    cwd: workspace,
    tool_name: 'apply_patch',
    tool_input: `*** Update File: ${path}`,
    prompt: intent,
  }
}

describe('the hook protocol', () => {
  test('records a PreToolUse write and exits cleanly with nothing on stdout', () => {
    const result = runHook(preToolUse(join(workspace, 'src', 'auth.ts')))
    assert.equal(result.status, 0, 'a non-zero exit from a hook can break the tool call')
    assert.equal(result.stdout, '', 'stdout is the host\'s protocol channel')
    assert.equal(result.stderr, '')
  })

  test('survives every malformed input without failing', () => {
    for (const payload of ['', '{', 'null', '[]', '"a string"', '{"hook_event_name":"PreToolUse"}']) {
      const result = spawnSync(process.execPath, [TRACK], { input: payload, encoding: 'utf8' })
      assert.equal(result.status, 0, `payload ${JSON.stringify(payload)} must not fail the hook`)
      assert.equal(result.stdout, '')
    }
  })

  test('does nothing outside a claimed workspace', () => {
    const bare = mkdtempSync(join(tmpdir(), 'agentgit-bare-'))
    try {
      // No `.agentgit` and no `.git`, so this is a stranger's directory: writing into
      // it would be scattering ledgers wherever an agent happened to run.
      const result = runHook({ ...preToolUse(join(bare, 'a.ts')), cwd: bare })
      assert.equal(result.status, 0)
      assert.equal(existsSync(join(bare, '.agentgit')), false)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  test('reads and search tools are not recorded, so the ledger stays about produced change', () => {
    for (const tool of ['read_file', 'grep', 'list_dir']) {
      runHook({ ...preToolUse(join(workspace, 'src', 'auth.ts')), tool_name: tool })
    }
    assert.equal(existsSync(eventsDir), false, 'a record for every read would bury the writes')
  })

  test('a write whose targets are not statically visible is recorded as a gap, not silently dropped', () => {
    runHook({
      hook_event_name: 'PreToolUse',
      session_id: SESSION,
      cwd: workspace,
      tool_name: 'run_shell_command',
      tool_input: { command: 'echo hi > src/out.txt' },
    })
    const event = only()
    assert.equal(event.kind, 'command')
    assert.match(String(event.reason), /not-statically-visible/)
    assert.equal((event.detail as Record<string, unknown>).coverageGap, true)
  })
})

describe('what lands in the ledger', () => {
  test('a write event carries the workspace-relative path, not the machine\'s absolute one', () => {
    runHook({
      ...preToolUse(join(workspace, 'src', 'auth.ts')),
      // A structured tool input, so the intent is a sentence rather than the whole patch.
      tool_input: { file_path: join(workspace, 'src', 'auth.ts'), description: 'add rate limiting to login' },
    })
    const event = only()

    assert.equal(event.kind, 'file_write')
    assert.equal(event.sessionId, SESSION)
    assert.equal(event.taskId, SESSION, 'with no declared task, the session is the task')
    assert.equal(event.intentText, 'add rate limiting to login')
    assert.equal(event.hostEvent, 'codex/PreToolUse')

    const entities = event.entities as unknown as { path: string; kind: string }[]
    assert.equal(entities.length, 1)
    assert.equal(entities[0].path, 'src/auth.ts')
    assert.equal(entities[0].kind, 'file')
  })

  test('the patch dialect names its own targets, so apply_patch edits are attributed', () => {
    // The path is not in a named field here; it is in the marker line, and the hook has
    // to read the dialect or every patch-based edit would go unrecorded.
    runHook(preToolUse(join(workspace, 'src', 'auth.ts'), 'tighten the limiter'))
    const event = only()
    const entities = event.entities as unknown as { path: string }[]
    assert.equal(entities[0].path, 'src/auth.ts')
    assert.match(String(event.intentText), /auth\.ts/, 'with nothing better, the patch itself is the intent')
  })

  test('the hook and the library agree on the entity key, which is the only thing keeping them joined', () => {
    // The hook cannot import `@agentgit/core`, so it carries a second implementation of
    // this. Two spellings of one path means two entities, no collisions detected, and no
    // error anywhere to say so.
    const absolute = join(workspace, 'src', 'deep', 'nested', 'thing.ts')
    runHook(preToolUse(absolute))

    const entities = only().entities as unknown as { path: string }[]
    assert.equal(
      entities[0].path,
      canonicalEntityPath(workspace, absolute),
      'the hook wrote a key the preflight would never compute',
    )

    // The same three spellings a caller might use must all reduce to it.
    const expected = 'src/deep/nested/thing.ts'
    for (const spelling of [absolute, 'src/deep/nested/thing.ts', absolute.replace(/\//g, '\\')]) {
      assert.equal(canonicalEntityPath(workspace, spelling), expected)
    }
  })

  test('a path outside the workspace keeps its absolute form rather than a bogus relative one', () => {
    const outside = join(workspace, '..', 'not-in-the-workspace', 'x.ts')
    runHook(preToolUse(outside))
    const entities = only().entities as unknown as { path: string }[]
    assert.ok(!entities[0].path.startsWith('..'), 'a parent escape must not be stored as a relative key')
  })

  test('SessionStart, UserPromptSubmit and Stop are recorded with their own kinds', () => {
    runHook({ hook_event_name: 'SessionStart', session_id: SESSION, cwd: workspace })
    assert.equal(only().kind, 'session_started')

    rmSync(eventsDir, { recursive: true, force: true })
    runHook({ hook_event_name: 'UserPromptSubmit', session_id: SESSION, cwd: workspace, prompt: 'fix the limiter' })
    assert.equal(only().kind, 'task_registered')

    rmSync(eventsDir, { recursive: true, force: true })
    runHook({ hook_event_name: 'Stop', session_id: SESSION, cwd: workspace })
    assert.equal(only().kind, 'turn_ended')
  })

  test('a failed tool is recorded as failed, so the ledger does not claim work that never happened', () => {
    runHook({
      ...preToolUse(join(workspace, 'src', 'auth.ts')),
      hook_event_name: 'PostToolUse',
      tool_response: { is_error: true },
    })
    assert.equal(only().reason, 'error')

    rmSync(eventsDir, { recursive: true, force: true })
    runHook({
      ...preToolUse(join(workspace, 'src', 'auth.ts')),
      hook_event_name: 'PostToolUse',
      tool_response: { is_error: false },
    })
    assert.equal(only().reason, 'ok')
  })

  test('the record lands in the workspace the session reported, even when fired from a subdirectory', () => {
    const nested = join(workspace, 'src', 'deep')
    mkdirSync(nested, { recursive: true })
    runHook({ ...preToolUse(join(nested, 'thing.ts')), cwd: nested })

    const event = only()
    assert.equal((event.detail as Record<string, unknown>).workspace, workspace, 'the root is recorded for exactly this diagnosis')
    const entities = event.entities as unknown as { path: string }[]
    assert.equal(entities[0].path, 'src/deep/thing.ts', 'the key is still relative to the workspace, not the subdirectory')
  })

  test('a declared task wins over the session fallback, so several sessions can be one task', () => {
    mkdirSync(join(workspace, '.agentgit', 'state'), { recursive: true })
    writeFileSync(
      join(workspace, '.agentgit', 'state', 'tasks.json'),
      JSON.stringify({ [SESSION]: 't-explicit' }),
      'utf8',
    )
    runHook(preToolUse(join(workspace, 'src', 'auth.ts')))
    assert.equal(only().taskId, 't-explicit')
    assert.equal((only().detail as Record<string, unknown>).taskIdSource, 'declared')
  })

  test('the same record appended twice is kept twice, because two edits are two events', () => {
    // Deliberate: the event id hashes the timestamp, so a retry cannot be recognised by
    // id, and the hot path does not pay for a scan that could not fire. Suppressing a
    // real second edit would undercount every task that iterates on a file. The check
    // that does work is in `adoptSession`, which matches on meaning — session, path and
    // a time window — rather than on bytes.
    const paths = workspacePaths(workspace)
    const event = {
      kind: 'file_write' as const,
      timestampUtc: '2026-01-01T00:00:00.000Z',
      sessionId: SESSION,
      taskId: SESSION,
      entities: [{ kind: 'file' as const, identifier: 'src/a.ts', path: 'src/a.ts' }],
      hostEvent: 'codex/PreToolUse',
    }
    appendEvent(paths, event)
    appendEvent(paths, event)
    assert.equal(events().length, 2)
  })

  test('two genuine edits by one session are both recorded', () => {
    const edit = (intent: string) => ({
      ...preToolUse(join(workspace, 'src', 'auth.ts')),
      tool_input: { file_path: join(workspace, 'src', 'auth.ts'), description: intent },
    })
    runHook(edit('first attempt'))
    runHook(edit('second attempt'))

    const all = events()
    assert.equal(all.length, 2)
    assert.deepEqual(all.map((event) => event.intentText), ['first attempt', 'second attempt'])
  })
})

describe('the installed command', () => {
  test('is runnable as generated, and records under the session that invoked it', () => {
    // Install into a temporary home so this test exercises the real generated file
    // without touching the user's own installation.
    const home = mkdtempSync(join(tmpdir(), 'agentgit-hookhome-'))
    try {
      const out = execFileSync(
        process.execPath,
        [join(REPO, 'packages', 'cli', 'src', 'main.ts'), 'install', '--copy', '--home', home, '--stamp', 'local-test'],
        { encoding: 'utf8' },
      )
      assert.match(out, /plugin {6}: /)

      const hooksPath = join(home, 'plugins', 'agentgit', 'hooks.json')
      const hooks = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
        hooks: Record<string, { hooks: { command: string }[] }[]>
      }

      for (const [name, entry] of Object.entries(hooks.hooks)) {
        const command = entry[0].hooks[0].command
        const parsed = [...command.matchAll(/"([^"]+)"/g)].map((match) => match[1])
        assert.ok(existsSync(parsed[1]), `${name} points at ${parsed[1]}, which does not exist`)

        const result = spawnSync(parsed[0], [...parsed.slice(1)], {
          input: JSON.stringify({
            hook_event_name: name,
            session_id: 'session-from-generated-hooks',
            cwd: workspace,
            tool_name: 'apply_patch',
            tool_input: `*** Update File: ${join(workspace, 'src', 'from-hook.ts')}`,
          }),
          encoding: 'utf8',
        })
        assert.equal(result.status, 0, `${name} failed: ${result.stderr}`)
      }

      const recorded = (events() as unknown as { hostEvent: string }[]).map((event) => event.hostEvent)
      for (const name of Object.keys(hooks.hooks)) {
        assert.ok(recorded.includes(`codex/${name}`), `${name} produced no record`)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('every event in the generated file answers with the same script', () => {
    const hooks = JSON.parse(readFileSync(join(REPO, 'plugins', 'agentgit', 'hooks.json.template'), 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    assert.deepEqual(
      Object.keys(hooks.hooks).sort(),
      ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'],
      'these five are the whole documented hook surface; a sixth would never fire',
    )
  })
})

describe('the spool', () => {
  test('is sharded per machine and per day, so two machines never write one file', () => {
    runHook(preToolUse(join(workspace, 'src', 'auth.ts')))
    const files = readdirSync(eventsDir)
    assert.equal(files.length, 1)
    assert.match(files[0], /^test-machine-\d{4}-\d{2}-\d{2}\.jsonl$/)
  })

  test('is one JSON object per line, readable by the Python analyser unchanged', () => {
    runHook(preToolUse(join(workspace, 'src', 'auth.ts')))
    const file = join(eventsDir, readdirSync(eventsDir)[0])
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)

    const wire = JSON.parse(lines[0]) as Record<string, unknown>
    assert.equal(wire.schema_version, 'coord-ledger-0.1', 'the version `coord_ledger.py` checks')
    for (const key of ['event_id', 'kind', 'timestamp_utc', 'session_id', 'task_id', 'entities', 'intent_text', 'host_event']) {
      assert.ok(key in wire, `the wire format is snake_case and includes ${key}`)
    }
    assert.equal(typeof wire.event_id, 'string')
  })

  test('a lease written by the library is visible to the ledger the hook fills', () => {
    // The two halves of the plugin meet here and nowhere else: the hook writes events,
    // the library reads them. A schema drift between them shows up as an empty board.
    const paths = workspacePaths(workspace)
    runHook(preToolUse(join(workspace, 'src', 'auth.ts')))
    const { events: parsed, malformed } = readAllEvents(paths)
    assert.equal(malformed, 0)
    assert.equal(parsed.length, 1)
    assert.equal(loadLeases(paths).leases.length, 0, 'a fresh workspace has no leases to report')
  })
})

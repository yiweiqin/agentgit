/**
 * The push channel: the hook that puts the hub's ruling into a session's context.
 *
 * What is worth testing here is not that the script prints a string. It is the three
 * properties that decide whether this is a coordination mechanism or a nuisance:
 *
 * 1. **It reads one small file and never the ledger.** There is a test that deletes
 *    `events/` entirely and asserts the script still works, because the alternative — reading
 *    the event stream on a path that runs before every tool call — makes the cost of a tool
 *    call grow with the size of the workspace.
 * 2. **It says nothing when it has nothing to say.** No ruling, a torn projection, an empty
 *    ruling, an unrelated file: all four produce an empty stdout and exit 0, and a hook that
 *    printed anything else could break the tool call it is attached to.
 * 3. **It says a thing once.** The marker records what this session has been shown, so a long
 *    session is not re-told the same conclusion on every save.
 *
 * Two of the helpers are copies of functions in `@agentgit/core`, because this script runs
 * from an installed plugin directory with no `node_modules`. The drift tests at the bottom
 * drive the shipped source against the library over one table, which is the arrangement the
 * repository already uses for `canonicalEntityPath` and for the arm table.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { canonicalEntityPath, seenMarkerName as coreSeenMarkerName, workspacePaths } from '@agentgit/core'

import { removeScratch } from './housekeeping.ts'

/** The checkout root, found from this file rather than from the working directory. */
const REPO = join(import.meta.dirname, '..', '..', '..')
const HUB = join(REPO, 'plugins', 'agentgit', 'scripts', 'hub.mjs')

let workspace: string
let stateDir: string
let neutral: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'agentgit-hub-hook-'))
  mkdirSync(join(workspace, '.agentgit'), { recursive: true })
  stateDir = join(workspace, '.agentgit', 'state')
  // The hook process's own directory for every spawn. Left to inherit, a payload that omits `cwd`
  // resolves against the directory the test runner started in - the checkout, when the suite runs
  // from the repository root - which is exactly how a hook test ends up writing into the repository
  // it is supposed to be testing.
  neutral = mkdtempSync(join(tmpdir(), 'agentgit-hub-hook-cwd-'))
})

afterEach(() => {
  removeScratch(workspace)
  // This one was the cwd of a process the test just spawned, which is the case Windows keeps a
  // handle on for a moment. See `housekeeping.ts`.
  removeScratch(neutral)
})

/** Run the hook exactly as Codex would: payload on stdin, one JSON object on stdout. */
function runHook(payload: Record<string, unknown>): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [HUB], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: neutral,
    env: { ...process.env, AGENTGIT_MACHINE: 'test-machine' },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** A projection shaped exactly as the daemon writes it, with one contention. */
function publishRuling(
  overrides: { id?: string; rulings?: unknown[]; targets?: string[]; holders?: unknown[] } = {},
): void {
  mkdirSync(stateDir, { recursive: true })
  const rulings =
    overrides.rulings ??
    [
      {
        entityKey: 'file::src/limiter.ts',
        kind: 'file',
        path: 'src/limiter.ts',
        word: 'reuse',
        basis: 'intent-similarity',
        needsResolution: false,
      },
    ]
  const holders = overrides.holders ?? []
  // The advisory is built from the same inputs as `targets`, so a test asserting that a path
  // reached the session is asserting about the injection rather than about fixture prose.
  const lines = ['## Coordination hub — one ruling per contention']
  for (const ruling of rulings as { entityKey: string; word: string }[]) {
    lines.push(`- ${ruling.entityKey} — ${ruling.word.toUpperCase()}`)
  }
  for (const entry of holders as { entityKey: string; taskId: string }[]) {
    lines.push(`Reserved ground — ${entry.entityKey} held by ${entry.taskId}`)
  }
  if (rulings.length === 0 && holders.length === 0) lines.push('Nothing in flight.')
  writeFileSync(
    join(stateDir, 'hub.json'),
    JSON.stringify({
      version: 1,
      id: overrides.id ?? 'hub-aaa',
      generatedAt: new Date().toISOString(),
      workspace,
      authority: 'advisory',
      targets: overrides.targets ?? (holders.length > 0 ? ['src/reserved.ts'] : ['src/limiter.ts']),
      rulings,
      holders,
      advisory: lines.join('\n'),
    }),
    'utf8',
  )
}

/** One live reservation, as the daemon writes it. */
function holder(): unknown {
  return {
    entityKey: 'file::src/reserved.ts',
    kind: 'file',
    path: 'src/reserved.ts',
    taskId: 'task-a',
    sessionId: 'session-a',
    reason: 'adding the rate limiter',
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    heldMinutes: 3,
    others: [],
  }
}

function sessionStart(sessionId = 'session-a'): Record<string, unknown> {
  return { hook_event_name: 'SessionStart', session_id: sessionId, cwd: workspace }
}

function preToolUse(filePath: string, sessionId = 'session-a'): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    cwd: workspace,
    tool_name: 'apply_patch',
    tool_input: { file_path: filePath, description: 'tighten the limiter' },
  }
}

/** The injected text, or `null` when the hook chose to say nothing. */
function injected(result: { stdout: string }): string | null {
  if (result.stdout.trim() === '') return null
  const parsed = JSON.parse(result.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string }
  }
  return parsed.hookSpecificOutput.additionalContext
}

/* -------------------------------------------------------------------------- */

describe('the hook cannot fail a tool call', () => {
  test('says nothing and exits cleanly when the hub has not published anything', () => {
    const result = runHook(sessionStart())
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
  })

  test('survives every malformed input without failing', () => {
    for (const payload of ['', '{', 'null', '[]', '"a string"', '{"hook_event_name":"SessionStart"}']) {
      const result = spawnSync(process.execPath, [HUB], { input: payload, encoding: 'utf8', cwd: neutral })
      assert.equal(result.status, 0, `payload ${JSON.stringify(payload)} must not fail the hook`)
      assert.equal(result.stdout, '')
    }
  })

  test('a torn projection is silence, not a broken hook', () => {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'hub.json'), '{"id":"hub-x","rulings":[', 'utf8')
    const result = runHook(sessionStart())
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
  })

  test('an untouched workspace is left completely alone', () => {
    const bare = mkdtempSync(join(tmpdir(), 'agentgit-hub-bare-'))
    try {
      const result = runHook({ hook_event_name: 'SessionStart', session_id: 's', cwd: bare })
      assert.equal(result.status, 0)
      assert.equal(result.stdout, '')
      assert.equal(existsSync(join(bare, '.agentgit')), false, 'a stranger directory must not gain state')
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  test('an event it does not answer gets no output even with a ruling in place', () => {
    publishRuling()
    for (const event of ['PostToolUse', 'Stop', 'SessionEnd', 'PreCompact']) {
      const result = runHook({ hook_event_name: event, session_id: 'session-a', cwd: workspace })
      assert.equal(result.stdout, '', `${event} is not a context-injecting event`)
    }
  })
})

describe('what reaches the session', () => {
  test('a session start is told the ruling, as hook output the host injects', () => {
    publishRuling()
    const result = runHook(sessionStart())

    assert.equal(result.status, 0)
    const parsed = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string }
    }
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart')
    assert.match(parsed.hookSpecificOutput.additionalContext, /src\/limiter\.ts/)
    assert.match(parsed.hookSpecificOutput.additionalContext, /one ruling per contention/)
  })

  test('a pending write to ruled ground is told, before it happens', () => {
    publishRuling()
    const result = runHook(preToolUse('src/limiter.ts'))

    assert.equal(result.status, 0)
    assert.match(injected(result) ?? '', /REUSE/)
  })

  test('an apply_patch payload is understood, because that is how edits actually arrive', () => {
    publishRuling()
    const result = runHook({
      ...sessionStart(),
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command: '*** Begin Patch\n*** Update File: src/limiter.ts\n' },
    })
    assert.match(injected(result) ?? '', /src\/limiter\.ts/)
  })

  test('an absolute path is matched against a workspace-relative target', () => {
    publishRuling()
    const result = runHook(preToolUse(join(workspace, 'src', 'limiter.ts')))
    assert.match(injected(result) ?? '', /src\/limiter\.ts/)
  })

  test('a write to ground nobody else wants is not interrupted', () => {
    // The alternative — telling every write about every contention — is how an advisory becomes
    // noise, and a window told something irrelevant on every edit stops reading any of it.
    publishRuling()
    const result = runHook(preToolUse('src/unrelated-file.ts'))
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
  })

  test('a ruling with nothing in it is not pushed at all', () => {
    publishRuling({ rulings: [], holders: [] })
    assert.equal(runHook(sessionStart()).stdout, '')
  })

  test('a reservation is pushed, because that is the warning that arrives before the collision', () => {
    // A ruling can only exist once two tasks touched the same ground. A reservation exists from
    // the moment one task says it is working there, and that is the moment a second window needs
    // to know — so a hook that only pushed rulings would be silent at the only moment that matters.
    publishRuling({ rulings: [], holders: [holder()] })
    const result = runHook(preToolUse('src/reserved.ts'))

    assert.equal(result.status, 0)
    assert.match(injected(result) ?? '', /Reserved ground/)
    assert.match(injected(result) ?? '', /held by task-a/)
  })

  test('a write to ground nobody reserved and nobody contested is still not interrupted', () => {
    publishRuling({ rulings: [], holders: [holder()] })
    assert.equal(runHook(preToolUse('src/unrelated.ts')).stdout, '')
  })
})

describe('a conclusion is stated once, not on every save', () => {
  test('the same ruling is not repeated to the same session', () => {
    publishRuling()
    const first = runHook(sessionStart())
    assert.match(injected(first) ?? '', /src\/limiter\.ts/)

    for (let index = 0; index < 5; index += 1) {
      assert.equal(runHook(sessionStart()).stdout, '', 'a repeated advisory is a token cost with no information')
    }
  })

  test('a changed ruling is pushed again', () => {
    publishRuling({ id: 'hub-aaa' })
    assert.match(injected(runHook(sessionStart())) ?? '', /src\/limiter\.ts/)

    publishRuling({ id: 'hub-bbb', targets: ['src/other.ts'] })
    assert.notEqual(runHook(sessionStart()).stdout, '')
  })

  test('two sessions are told independently', () => {
    publishRuling()
    assert.notEqual(runHook(sessionStart('session-a')).stdout, '')
    assert.notEqual(runHook(sessionStart('session-b')).stdout, '')
    assert.equal(runHook(sessionStart('session-a')).stdout, '')
    assert.equal(runHook(sessionStart('session-b')).stdout, '')
  })

  test('the marker is written where the library looks for it', () => {
    // Core reads this same file to tell a tool caller whether the ruling this window holds is
    // still current. Two spellings of the name would mean a window that never appears to have
    // been told anything.
    publishRuling()
    runHook(sessionStart('session-from-hook'))

    const marker = join(stateDir, 'hub-seen', coreSeenMarkerName('session-from-hook'))
    assert.ok(existsSync(marker), 'the hook wrote its marker somewhere the library does not read')
    assert.equal((JSON.parse(readFileSync(marker, 'utf8')) as { rulingId: string }).rulingId, 'hub-aaa')
  })
})

describe('the hot path stays constant', () => {
  test('works with no ledger at all, which is the whole cost argument', () => {
    // The script must read the projection and the marker and nothing else. If a future change
    // made it read the ledger, this test would still pass — so it is paired with a source check
    // below that asserts the ledger path is never mentioned.
    publishRuling()
    rmSync(workspacePaths(workspace).events, { recursive: true, force: true })

    assert.match(injected(runHook(sessionStart())) ?? '', /src\/limiter\.ts/)
    assert.match(injected(runHook(preToolUse('src/limiter.ts', 'session-b'))) ?? '', /REUSE/)
  })

  test('names no ledger path, so nothing can creep back onto the per-call path', () => {
    const source = readFileSync(HUB, 'utf8')
    for (const forbidden of ['events.jsonl', "join(paths.root, '.agentgit', 'events')", 'readAllEvents']) {
      assert.equal(source.includes(forbidden), false, `the hook must not reach for ${forbidden}`)
    }
  })

  test('imports nothing outside node:, because it runs with no node_modules', () => {
    const source = readFileSync(HUB, 'utf8')
    const imports = [...source.matchAll(/^import .*?from '([^']+)'/gm)].map((match) => match[1])
    assert.ok(imports.length > 0)
    for (const specifier of imports) {
      assert.ok(specifier.startsWith('node:'), `${specifier} would not resolve from an installed plugin`)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* The two copies, driven against the library                                  */
/* -------------------------------------------------------------------------- */

/**
 * Compile one or more functions out of the shipped source, with free variables injected.
 *
 * The helpers are copied into `hub.mjs` rather than imported, so a drift test has to run the
 * *shipped* text. `new Function` is used instead of importing the module because the module
 * executes its hook on load and calls `process.exit`, which would take the test runner with it.
 */
function extract<T>(source: string, names: readonly string[], scope: Record<string, unknown>): T {
  const bodies = names.map((name) => {
    const body = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?\\n\\}`, 'm'))?.[0]
    assert.ok(body, `hub.mjs must still declare ${name}, which this test drives`)
    return body
  })
  const keys = Object.keys(scope)
  const last = names[names.length - 1]
  return new Function(...keys, `${bodies.join('\n')}\nreturn ${last}`)(...keys.map((key) => scope[key])) as T
}

describe('the hook\'s copies of two library rules cannot drift', () => {
  test('its session marker name is the library\'s, over ids that are awkward on a filesystem', () => {
    const source = readFileSync(HUB, 'utf8')
    const fromHook = extract<(sessionId: string) => string>(source, ['seenMarkerName'], { createHash })

    for (const sessionId of [
      'session-a',
      'thr_01J8Z6Q',
      'a/b:c',
      'a-b-c',
      '..',
      '',
      'SESSION-UPPER',
      'x'.repeat(200),
      '会话-名称',
    ]) {
      assert.equal(fromHook(sessionId), coreSeenMarkerName(sessionId), `marker name differs for ${sessionId}`)
    }
  })

  test('its path spelling is the library\'s, so a target and a tool call can meet', () => {
    const source = readFileSync(HUB, 'utf8')
    const fromHook = extract<(root: string, value: string) => string>(
      source,
      ['normalizePath', 'canonicalPath'],
      { resolve, isAbsolute },
    )

    const absolute = join(workspace, 'src', 'deep', 'thing.ts')
    for (const spelling of [
      absolute,
      'src/deep/thing.ts',
      './src/deep/thing.ts',
      absolute.replace(/\//g, '\\'),
      'src\\deep\\thing.ts',
    ]) {
      assert.equal(
        fromHook(workspace, spelling),
        canonicalEntityPath(workspace, spelling),
        `the hook and the library disagree about ${spelling}`,
      )
    }
    assert.equal(fromHook(workspace, absolute), 'src/deep/thing.ts')
    // Outside the workspace, the absolute form is kept rather than turned into a bogus relative.
    const outside = join(dirname(workspace), 'elsewhere', 'x.ts')
    assert.equal(fromHook(workspace, outside), canonicalEntityPath(workspace, outside))
  })
})

/**
 * The spine hook: what makes the push channel non-empty.
 *
 * `hub.mjs` reads a projection that only a running daemon writes, so before this hook there was
 * a wired mechanism with nothing behind it - the plugin was installed and the hub never spoke.
 * The properties worth testing are therefore not "does it print a string" but:
 *
 * 1. **Exactly one daemon per workspace.** Two publishers on one workspace each produce their own
 *    ruling, which is the split the hub exists to prevent. So there is a test for "already
 *    advertised", a test for "the pid is gone, replace it", and a test for the spawn lock that
 *    covers the window before the daemon has advertised at all.
 * 2. **It says nothing, ever.** `stdout` stays empty on every path including success, because
 *    this hook injects no context and a hook that printed anything else could break a session.
 * 3. **It never claims a directory nobody asked it to.** The daemon creates `.agentgit` on start,
 *    so a stranger directory must come out byte-for-byte as it went in.
 * 4. **It stays cheap and self-contained.** No imports outside `node:`, and it never opens the
 *    ledger - the same two source assertions `hub-hook.test.ts` makes, for the same reasons.
 *
 * Two spellings are copied into `spine.mjs` rather than imported, because it runs from an
 * installed plugin directory with no `node_modules`. The drift tests at the bottom drive the
 * shipped source against `@agentgit/daemon` over one table, which is the arrangement this
 * repository already uses for `canonicalEntityPath` and the arm table.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  ENDPOINT_FILE_NAME,
  ENDPOINT_VERSION,
  endpointPathFor,
  writeEndpoint,
} from '@agentgit/daemon'

import { removeScratch } from './housekeeping.ts'

/** The checkout root, found from this file rather than from the working directory. */
const REPO = join(import.meta.dirname, '..', '..', '..')
const SPINE = join(REPO, 'plugins', 'agentgit', 'scripts', 'spine.mjs')
const HOOK_ERRORS = join(REPO, 'plugins', 'agentgit', 'scripts', 'hook-errors.mjs')
const HOOK_RUNTIME = join(REPO, 'plugins', 'agentgit', 'scripts', 'hook-runtime.mjs')

/** A pid that cannot be running: used to stand in for a daemon that crashed. */
const DEAD_PID = 2_147_483_647

let home: string
let workspace: string
let neutral: string

beforeEach(() => {
  // `home` stands in for the installed plugin directory: it holds a copy of the hook and the
  // `spine.json` beside it. Copying the hook is what lets a test point it at a stub daemon
  // without writing into the checkout.
  home = mkdtempSync(join(tmpdir(), 'agentgit-spine-home-'))
  workspace = mkdtempSync(join(tmpdir(), 'agentgit-spine-ws-'))
  // The hook process's own directory for every spawn, so it is never the checkout.
  neutral = mkdtempSync(join(tmpdir(), 'agentgit-spine-cwd-'))
})

afterEach(() => {
  removeScratch(home)
  removeScratch(workspace)
  // This one was the cwd of a process the test just spawned, which is the case Windows keeps a
  // handle on for a moment. See `housekeeping.ts`.
  removeScratch(neutral)
})

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function launchLog(): string {
  return join(home, 'launches.log')
}

/**
 * A stand-in for the daemon.
 *
 * It records one line per launch and writes the endpoint file exactly as the real daemon does,
 * then exits. Exiting immediately is deliberate: "did a daemon get started" is the question, and
 * a stub that lived forever would leave processes behind in a test run.
 */
function stubDaemon(): string {
  const file = join(home, 'stub-daemon.mjs')
  writeFileSync(
    file,
    [
      "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'",
      "import { dirname } from 'node:path'",
      'const args = process.argv.slice(2)',
      "const value = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : null }",
      "const watch = value('--watch')",
      "const endpoint = value('--endpoint-file')",
      'const log = process.env.AGENTGIT_SPINE_TEST_LOG',
      "if (log) appendFileSync(log, `${watch}\\n`)",
      'if (endpoint) {',
      '  mkdirSync(dirname(endpoint), { recursive: true })',
      '  writeFileSync(',
      '    endpoint,',
      "    `${JSON.stringify({ version: 1, pid: process.pid, port: 0, url: 'http://localhost:0', roots: watch ? [watch] : [], startedAt: new Date().toISOString() })}\\n`,",
      "    'utf8',",
      '  )',
      '}',
    ].join('\n') + '\n',
    'utf8',
  )
  return file
}

/** Copy the shipped hook into `home/scripts` and give it a config at the plugin root, as install does. */
function installSpine(overrides: { daemon?: string; node?: string; flags?: string[] } = {}): string {
  const shim = join(home, 'scripts', 'spine.mjs')
  mkdirSync(join(home, 'scripts'), { recursive: true })
  writeFileSync(shim, readFileSync(SPINE, 'utf8'), 'utf8')
  // Include the sibling modules shipped by an installed plugin.
  writeFileSync(join(home, 'scripts', 'hook-errors.mjs'), readFileSync(HOOK_ERRORS, 'utf8'), 'utf8')
  writeFileSync(join(home, 'scripts', 'hook-runtime.mjs'), readFileSync(HOOK_RUNTIME, 'utf8'), 'utf8')
  writeFileSync(
    join(home, 'spine.json'),
    `${JSON.stringify(
      {
        node: overrides.node ?? process.execPath,
        daemon: overrides.daemon ?? stubDaemon(),
        flags: overrides.flags ?? [],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return shim
}

/** A workspace the recorder would already be writing to, so the spine is allowed to watch it. */
function claim(root = workspace): void {
  mkdirSync(join(root, '.agentgit', 'events'), { recursive: true })
}

/**
 * Run the hook exactly as Codex would: payload on stdin, one JSON object on stdout.
 *
 * `cwd` is pinned to a neutral temporary directory rather than inherited. Without it the hook's
 * own `process.cwd()` is whatever directory the test runner started in - the checkout, when the
 * suite runs from the repository root - and a payload that omits `cwd` would then be acted on
 * against the repository itself. That happened: this suite's malformed-payload case left a
 * `spine.lock` and a `spine.log` inside the checkout's own `.agentgit/state/`. The guard below is
 * the belt to this braces.
 */
function runSpine(payload: unknown, shim: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [shim], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    cwd: neutral,
    env: { ...process.env, AGENTGIT_SPINE_TEST_LOG: launchLog() },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function sessionStart(cwd = workspace): Record<string, unknown> {
  return { hook_event_name: 'SessionStart', session_id: 'session-a', cwd }
}

function prompt(cwd = workspace): Record<string, unknown> {
  return { hook_event_name: 'UserPromptSubmit', session_id: 'session-a', cwd }
}

function launches(): string[] {
  try {
    return readFileSync(launchLog(), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
  } catch {
    return []
  }
}

function lockFile(): string {
  return join(workspace, '.agentgit', 'state', 'spine.lock')
}

async function waitFor(file: string, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return true
    await new Promise((done) => setTimeout(done, 25))
  }
  return existsSync(file)
}

/* -------------------------------------------------------------------------- */

describe('the spine cannot fail a session', () => {
  test('is silent, and leaves a stranger directory byte-for-byte alone', () => {
    const shim = installSpine()
    const result = runSpine(sessionStart(), shim)

    assert.equal(result.status, 0)
    assert.equal(result.stdout, '', 'this hook injects no context, so empty stdout is the output')
    assert.equal(result.stderr, '')
    assert.equal(launches().length, 0)
    // The daemon creates `.agentgit` when it starts, so the permission check has to come first.
    assert.equal(existsSync(join(workspace, '.agentgit')), false, 'a stranger directory must not gain state')
  })

  test('leaves a repository nobody has claimed alone, which is what stops state scattering', () => {
    mkdirSync(join(workspace, '.git'), { recursive: true })
    const shim = installSpine()
    const result = runSpine(sessionStart(), shim)

    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
    assert.equal(existsSync(join(workspace, '.agentgit')), false, 'a bare repository is not fair game')
    assert.equal(launches().length, 0)
  })

  test('survives every malformed payload without failing or printing', () => {
    const shim = installSpine()
    claim()
    for (const payload of ['', '{', 'null', '[]', '"a string"', '{"hook_event_name":"SessionStart"}']) {
      const result = runSpine(payload, shim)
      assert.equal(result.status, 0, `payload ${JSON.stringify(payload)} must not fail the hook`)
      assert.equal(result.stdout, '')
    }
    assert.equal(launches().length, 0)
  })

  test('a payload with no cwd starts nothing, because the directory would be a guess', () => {
    // `cwd` is the one thing this hook must be told rather than infer. Inferring it means using
    // whatever directory the hook process happens to be in, and this hook does not record a line
    // when it is wrong - it starts a process that keeps watching that directory.
    const shim = installSpine()
    claim()

    const result = runSpine({ hook_event_name: 'SessionStart', session_id: 'session-a' }, shim)

    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
    assert.equal(launches().length, 0, 'no cwd means no watcher')
    // The neutral directory the hook ran in must not have been claimed on the way past.
    assert.equal(existsSync(join(neutral, '.agentgit')), false)
  })

  test('does nothing when no config sits beside it, which is a checkout that was never installed', () => {
    // No `spine.json`: written from the shipped script alone, so this does not depend on the
    // repository's own generated state.
    const shim = join(home, 'scripts', 'spine.mjs')
    mkdirSync(join(home, 'scripts'), { recursive: true })
    writeFileSync(shim, readFileSync(SPINE, 'utf8'), 'utf8')
    writeFileSync(join(home, 'scripts', 'hook-errors.mjs'), readFileSync(HOOK_ERRORS, 'utf8'), 'utf8')
    writeFileSync(join(home, 'scripts', 'hook-runtime.mjs'), readFileSync(HOOK_RUNTIME, 'utf8'), 'utf8')
    claim()

    const result = runSpine(sessionStart(), shim)

    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
    assert.equal(launches().length, 0)
    assert.equal(existsSync(lockFile()), false)
  })

  test('finds its config one level up, where install writes it, and not beside the script', () => {
    // The first version of this read `spine.json` from its own directory while `install` wrote it
    // to the plugin root. Both halves looked right and the result was a spine that silently never
    // started anything - the failure mode this whole hook is supposed to remove.
    const shim = installSpine()
    claim()
    // A decoy next to the script: reading this one instead would still work in tests and break
    // in a real install, which is precisely the bug.
    writeFileSync(join(home, 'scripts', 'spine.json'), '{"daemon":"/definitely/not/here.mjs"}', 'utf8')

    const result = runSpine(sessionStart(), shim)

    assert.equal(result.status, 0)
    return waitFor(launchLog()).then((launched) => {
      assert.ok(launched, 'the real config at the plugin root is the one that must be used')
    })
  })

  test('answers only the events that can start or resume a session', () => {
    const shim = installSpine()
    claim()
    for (const event of ['PostToolUse', 'Stop', 'SessionEnd', 'PreCompact']) {
      const result = runSpine({ hook_event_name: event, session_id: 'session-a', cwd: workspace }, shim)
      assert.equal(result.status, 0)
      assert.equal(result.stdout, '', `${event} is not a moment to start a daemon`)
    }
    // The cheapest evidence that it returned before doing any work at all.
    assert.equal(existsSync(lockFile()), false)
    assert.equal(launches().length, 0)
  })
})

describe('exactly one daemon per workspace', () => {
  test('starts one for a claimed workspace, and advertises where the library reads', async () => {
    const shim = installSpine()
    claim()

    const result = runSpine(sessionStart(), shim)

    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
    assert.ok(await waitFor(launchLog()), 'a claimed workspace gets a watcher')
    assert.deepEqual(launches(), [resolve(workspace)], 'the daemon is pointed at the workspace, not at the cwd')
    // The endpoint path is the library's, which is what makes the reuse check work across the
    // hook/library boundary rather than only inside this script.
    assert.ok(existsSync(endpointPathFor(workspace)), 'it must advertise where the library looks')
  })

  test('advertises on a port the kernel chose, so two workspaces cannot collide', async () => {
    const shim = installSpine()
    claim()
    runSpine(sessionStart(), shim)

    assert.ok(await waitFor(endpointPathFor(workspace)))
    const record = JSON.parse(readFileSync(endpointPathFor(workspace), 'utf8')) as { port: number }
    assert.equal(typeof record.port, 'number')
  })

  test('does not start a second daemon while one is still alive', () => {
    const shim = installSpine()
    claim()
    // A live pid: this very test process. `readEndpoint` plus `isProcessAlive` is the whole check.
    writeEndpoint(endpointPathFor(workspace), {
      pid: process.pid,
      port: 4321,
      url: 'http://localhost:4321',
      roots: [workspace],
      startedAt: new Date().toISOString(),
    })

    const result = runSpine(sessionStart(), shim)

    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
    assert.equal(launches().length, 0, 'a running daemon must not be duplicated')
    assert.equal(existsSync(lockFile()), false, 'and the lock must not even be touched')
  })

  test('replaces a daemon whose pid is gone, because a crashed watcher is not a watcher', async () => {
    const shim = installSpine()
    claim()
    writeEndpoint(endpointPathFor(workspace), {
      pid: DEAD_PID,
      port: 4321,
      url: 'http://localhost:4321',
      roots: [workspace],
      startedAt: new Date().toISOString(),
    })

    const result = runSpine(prompt(), shim)

    assert.equal(result.status, 0)
    assert.ok(await waitFor(launchLog()), 'a dead advertisement must be replaced')
    assert.equal(launches().length, 1)
  })

  test('does not spawn twice while the daemon is still starting up', async () => {
    const shim = installSpine()
    claim()

    runSpine(sessionStart(), shim)
    await waitFor(launchLog())
    // The stub exits immediately, so the endpoint it left names a dead pid - exactly the state a
    // second invocation would otherwise read as "start one". The lock is what makes it wait.
    const second = runSpine(prompt(), shim)
    // A second spawn would be asynchronous, so give it a moment to show up before asserting.
    await new Promise((done) => setTimeout(done, 400))

    assert.equal(second.status, 0)
    assert.equal(launches().length, 1, 'the spawn lock covers the window before the endpoint exists')
  })

  test('a stale lock is displaced rather than disabling the spine forever', async () => {
    const shim = installSpine()
    claim()
    const lock = lockFile()
    mkdirSync(join(workspace, '.agentgit', 'state'), { recursive: true })
    writeFileSync(lock, '{"pid":1}\n', 'utf8')
    // Backdate it past the trust window. Without this the lock is honoured and no daemon would
    // ever start again for this workspace - the failure that would make this feature worse than
    // having no lock at all.
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)

    const result = runSpine(sessionStart(), shim)

    assert.equal(result.status, 0)
    assert.ok(await waitFor(launchLog()), 'one unlucky crash must not disable the spine permanently')
  })
})

describe('the hot path stays constant and self-contained', () => {
  test('names no ledger path, so nothing can creep onto the session-start path', () => {
    const source = readFileSync(SPINE, 'utf8')
    // The permission gate does name the `events` *directory*, because "is the ledger here" is a
    // cheap `existsSync` and is how the spine avoids claiming a directory nobody opted in to.
    // What must never appear is a way to *read* it: the cost of starting a session has to stay
    // independent of how much history the workspace has.
    for (const forbidden of ['events.jsonl', 'readdirSync', 'readAllEvents', 'buildBoardView']) {
      assert.equal(source.includes(forbidden), false, `the spine must not reach for ${forbidden}`)
    }
  })

  test('imports nothing outside node: or its own directory, because it runs with no node_modules', () => {
    // The constraint is "no node_modules, no build step, no path back to this repository". A
    // sibling file in the same installed directory satisfies all three; a bare specifier does not.
    const source = readFileSync(SPINE, 'utf8')
    const imports = [...source.matchAll(/^import .*?from '([^']+)'/gm)].map((match) => match[1])
    assert.ok(imports.length > 0, 'it has to import something, or this test proves nothing')
    for (const specifier of imports) {
      const local = specifier.startsWith('./') || specifier.startsWith('../')
      assert.ok(
        specifier.startsWith('node:') || local,
        `${specifier} would not resolve from an installed plugin`,
      )
      if (local) {
        assert.ok(
          existsSync(join(SPINE, '..', specifier)),
          `${specifier} is imported but not shipped in scripts/`,
        )
      }
    }
  })

  test('writes its daemon record nowhere near the work, only under state/', async () => {
    const shim = installSpine()
    claim()
    runSpine(sessionStart(), shim)

    assert.ok(await waitFor(endpointPathFor(workspace)))
    // `state/` is derived and gitignored; a record that landed anywhere else would be committed
    // work, and this daemon's pid is not something a team should merge.
    assert.ok(endpointPathFor(workspace).startsWith(join(workspace, '.agentgit', 'state')))
  })
})

/* -------------------------------------------------------------------------- */
/* The two copies, driven against the library                                  */
/* -------------------------------------------------------------------------- */

/**
 * Compile one or more functions out of the shipped source, with free variables injected.
 *
 * The helpers are copied into `spine.mjs` rather than imported, so a drift test has to run the
 * *shipped* text. `new Function` is used instead of importing the module because the module
 * executes its hook on load and calls `process.exit`, which would take the test runner with it.
 */
function extract<T>(source: string, names: readonly string[], scope: Record<string, unknown>): T {
  const bodies = names.map((name) => {
    const body = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?\\n\\}`, 'm'))?.[0]
    assert.ok(body, `spine.mjs must still declare ${name}, which this test drives`)
    return body
  })
  const keys = Object.keys(scope)
  const last = names[names.length - 1]
  return new Function(...keys, `${bodies.join('\n')}\nreturn ${last}`)(...keys.map((key) => scope[key])) as T
}

/** The literal a top-level `const` was assigned, so a copied constant can be compared. */
function constFromSource(source: string, name: string): string | number {
  const match = source.match(new RegExp(`^const ${name}\\s*=\\s*([^\\n]+)$`, 'm'))
  assert.ok(match, `spine.mjs must still declare ${name}, which this test drives`)
  const raw = match[1].trim()
  if (raw.startsWith("'") || raw.startsWith('"')) return raw.slice(1, -1)
  return Number(raw)
}

describe("the spine's copies of two library rules cannot drift", () => {
  test('it spells the endpoint path the way the library does', () => {
    const source = readFileSync(SPINE, 'utf8')
    const fileName = constFromSource(source, 'ENDPOINT_FILE_NAME')
    const fromHook = extract<(root: string) => string>(source, ['stateDir', 'endpointPathFor'], {
      join,
      ENDPOINT_FILE_NAME: fileName,
    })

    for (const root of [
      workspace,
      join(workspace, 'nested'),
      resolve(workspace),
      'C:\\work\\a-repo',
      '/home/someone/a-repo',
    ]) {
      assert.equal(fromHook(root), endpointPathFor(root), `the hook and the library disagree about ${root}`)
    }
  })

  test('it reads the same endpoint version and file name the library writes', () => {
    const source = readFileSync(SPINE, 'utf8')
    assert.equal(constFromSource(source, 'ENDPOINT_VERSION'), ENDPOINT_VERSION)
    assert.equal(constFromSource(source, 'ENDPOINT_FILE_NAME'), ENDPOINT_FILE_NAME)
    // The library's own name, so this test fails if either side is renamed.
    assert.equal(endpointPathFor('/w').endsWith(ENDPOINT_FILE_NAME), true)
  })
})

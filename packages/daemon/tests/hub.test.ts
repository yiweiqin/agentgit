/**
 * The hub's spine in the daemon: it observes, rules, and publishes exactly once per ruling.
 *
 * The three failures worth a test here are quiet ones:
 *
 * 1. **A republished ruling.** A daemon that appended its conclusion on every tick would make
 *    a stable workspace look like a changing one, and every reader that keys off the ruling id
 *    would re-read on every poll.
 * 2. **A ruling lost by a restart.** The conclusion has to be in the ledger, not in the
 *    process, or killing the daemon silently deletes what every window was coordinating on.
 * 3. **Two readers, two answers.** `/api/hub` is the same bytes for everyone, which is the
 *    property that makes "one conclusion per contention" checkable rather than asserted.
 *
 * Every board binds port 0 and is closed in `afterEach`, so this can run twice in a row.
 */

import { test, describe, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendEvent, acquireLease, buildEvent, HUB_PUBLISH_HOST_EVENT, readAllEvents, workspacePaths } from '@agentgit/core'
import { startBoard, type BoardServer } from '@agentgit/daemon'

let root: string
const boards: BoardServer[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentgit-hub-daemon-'))
})

afterEach(async () => {
  while (boards.length > 0) await boards.pop()!.close()
  rmSync(root, { recursive: true, force: true })
})

async function start(options: { publish?: boolean } = {}): Promise<BoardServer> {
  const board = await startBoard({
    roots: [root],
    port: 0,
    quiet: true,
    watch: false,
    intervalMs: 25,
    publish: options.publish,
  })
  boards.push(board)
  return board
}

/** Two tasks, one file, similar intents: the smallest real contention. */
function collide(): void {
  const paths = workspacePaths(root)
  const at = new Date()
  for (const [taskId, intent] of [
    ['task-a', 'add rate limiting to the login endpoint so repeated failures back off'],
    ['task-b', 'add rate limiting to login so repeated failures are throttled'],
  ] as const) {
    appendEvent(
      paths,
      buildEvent({
        kind: 'file_write',
        timestampUtc: at.toISOString(),
        sessionId: taskId,
        taskId,
        entities: [{ kind: 'file', identifier: 'src/limiter.ts', path: 'src/limiter.ts' }],
        intentText: intent,
        hostEvent: 'test',
      }),
      at,
    )
  }
}

function hubEvents() {
  return readAllEvents(workspacePaths(root)).events.filter((event) => event.hostEvent === HUB_PUBLISH_HOST_EVENT)
}

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition was never met within the deadline')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  }
}

async function hub(url: string): Promise<{ id: string | null; rulings: unknown[]; advisory: string }> {
  const payload = (await (await fetch(`${url}/api/hub`)).json()) as {
    hub: { id: string; rulings: unknown[]; advisory: string } | null
  }
  return payload.hub ?? { id: null, rulings: [], advisory: '' }
}
/* -------------------------------------------------------------------------- */

describe('the spine publishes one conclusion and stays quiet', () => {
  test('a contention is ruled on, and the ruling reaches the ledger', async () => {
    const board = await start()
    collide()
    await until(() => hubEvents().length === 1)

    const ruling = await hub(board.url)
    assert.ok(ruling.id, 'the API must expose the ruling it published')
    assert.equal(hubEvents()[0].detail?.rulingId, ruling.id, 'the ledger and the API must not disagree')
    assert.equal(hubEvents()[0].kind, 'advisory_injected')
    assert.match(ruling.advisory, /src\/limiter\.ts/)
    assert.match(ruling.advisory, /REUSE/)
  })

  test('a workspace that keeps computing the same ruling publishes it once', async () => {
    const board = await start()
    collide()
    await until(() => hubEvents().length === 1)

    // Several ticks, and several API reads, with nothing about the ruling changing.
    for (let index = 0; index < 4; index += 1) await hub(board.url)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))

    assert.equal(hubEvents().length, 1, 'a stable conclusion must not be republished on every tick')
    assert.ok(board.url)
  })

  test('a restart republishes nothing, because the conclusion outlives the process', async () => {
    const first = await start()
    collide()
    await until(() => hubEvents().length === 1)
    const published = await hub(first.url)

    await first.close()
    boards.pop()

    // A brand-new process on the same workspace. Nothing is carried in memory.
    const second = await start()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))

    assert.equal(hubEvents().length, 1, 'killing the daemon must not lose or duplicate a ruling')
    assert.equal((await hub(second.url)).id, published.id, 'the rebuilt ruling must be the same conclusion')
  })

  test('every reader gets the same ruling, which is what "one conclusion" means', async () => {
    const board = await start()
    collide()
    await until(() => hubEvents().length === 1)

    const reads = await Promise.all([hub(board.url), hub(board.url), hub(board.url)])
    assert.equal(new Set(reads.map((read) => read.id)).size, 1)
  })

  test('the ruling is written where the tool-call hook can read it without touching the ledger', async () => {
    const board = await start()
    collide()
    await until(() => hubEvents().length === 1)

    const projection = join(workspacePaths(root).state, 'hub.json')
    assert.ok(existsSync(projection), 'the hook reads this file, so the daemon has to write it')
    const parsed = JSON.parse(readFileSync(projection, 'utf8')) as { id: string; advisory: string; targets: string[] }
    assert.equal(parsed.id, (await hub(board.url)).id)
    assert.ok(parsed.advisory.length > 0)
    assert.deepEqual(parsed.targets, ['src/limiter.ts'], 'the hook matches a pending write against these')
  })
})

describe('a reservation reaches a window before the collision does', () => {
  test('one task claiming one file is published, and the path is a matchable target', async () => {
    const board = await start()
    const paths = workspacePaths(root)
    const at = new Date()
    appendEvent(
      paths,
      buildEvent({
        kind: 'file_write',
        timestampUtc: at.toISOString(),
        sessionId: 'task-a',
        taskId: 'task-a',
        entities: [{ kind: 'file', identifier: 'src/reserved.ts', path: 'src/reserved.ts' }],
        intentText: 'adding the rate limiter',
        hostEvent: 'test',
      }),
      at,
    )
    acquireLease(
      paths,
      { entityKey: 'file::src/reserved.ts', taskId: 'task-a', sessionId: 'task-a', reason: 'adding the rate limiter', minutes: 20 },
      at,
    )

    await until(() => hubEvents().length === 1)
    const ruling = await hub(board.url)

    // The point of the whole reservation path: a ruling can only exist once two tasks collided, so
    // a window about to write this file has to be told from the reservation instead.
    assert.equal(ruling.rulings.length, 0)
    const payload = (await (await fetch(`${board.url}/api/hub`)).json()) as {
      hub: { holders: { taskId: string; path: string }[]; targets: string[] }
    }
    assert.equal(payload.hub.holders[0].taskId, 'task-a')
    assert.deepEqual(payload.hub.targets, ['src/reserved.ts'], 'the hook matches a pending write on this')
    assert.equal(hubEvents()[0].detail?.holderCount, 1)
  })

  test('a claim on ground nobody else wants is the only thing in the ledger, and it says so', async () => {
    const board = await start()
    const paths = workspacePaths(root)
    const at = new Date()
    appendEvent(
      paths,
      buildEvent({
        kind: 'file_write',
        timestampUtc: at.toISOString(),
        sessionId: 'task-a',
        taskId: 'task-a',
        entities: [{ kind: 'file', identifier: 'src/solo.ts', path: 'src/solo.ts' }],
        intentText: 'only me here',
        hostEvent: 'test',
      }),
      at,
    )
    acquireLease(
      paths,
      { entityKey: 'file::src/solo.ts', taskId: 'task-a', sessionId: 'task-a', reason: 'only me here', minutes: 20 },
      at,
    )

    await until(() => hubEvents().length === 1)
    const ruling = await hub(board.url)
    assert.match(ruling.advisory, /held by task-a/)
    assert.match(ruling.advisory, /reuse or extend theirs/)
  })
})

describe('the read-only mode, for a workspace whose ledger someone else owns', () => {  test('still computes and serves the ruling, and appends nothing', async () => {
    const board = await start({ publish: false })
    collide()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))

    assert.equal(hubEvents().length, 0, '--no-publish must not write a ruling')
    assert.ok((await hub(board.url)).id, 'the ruling must still be computed and served')
    assert.ok(existsSync(join(workspacePaths(root).state, 'hub.json')))
  })
})

describe('the ruling is visible on every surface that already existed', () => {
  test('the event stream carries it, so a polling client sees the conclusion without a second call', async () => {
    const board = await start()
    const response = await fetch(`${board.url}/events`, { headers: { accept: 'text/event-stream' } })
    const frames: string[] = []
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const reading = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          frames.push(decoder.decode(value, { stream: true }))
        }
      } catch {
        // Teardown ends the stream; that is the expected way this stops.
      }
    })()

    await until(() => frames.length > 0, 3000)
    collide()
    await until(() => /"hubId":\s*"hub-/.test(frames.join('')), 5000)

    await board.close()
    await reading
  })

  test('healthz names the ruling, so a script can tell "ruled" from "merely up"', async () => {
    const board = await start()
    collide()
    await until(() => hubEvents().length === 1)

    const health = (await (await fetch(`${board.url}/healthz`)).json()) as {
      workspaces: { id: string; hubId: string | null }[]
    }
    assert.equal(health.workspaces.length, 1)
    assert.equal(health.workspaces[0].hubId, hubEvents()[0].detail?.rulingId)
  })
})

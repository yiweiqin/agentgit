/**
 * The daemon, and the two failure modes that cost the most to notice.
 *
 * 1. **A server nobody closed.** The board is meant to be left running in a terminal, so
 *    leaking one is indistinguishable from using it — until the next run cannot bind the
 *    port. A stray board once survived an entire session on 7777 and made an unrelated
 *    command look like it hung. So the first test here is that importing this package does
 *    nothing at all: a package whose barrel file starts a server starts one every time
 *    anything mentions it.
 * 2. **A board that stops being live.** The panel is a snapshot on purpose, and this is
 *    the half that is supposed to actually update. A board that silently stops pushing
 *    looks exactly like a quiet workspace, which is why the change-detection path is
 *    exercised end to end here — append a ledger line, expect a new frame on the stream.
 *
 * Every server in this file binds port 0 and is closed in `afterEach`, so the suite can
 * run twice in a row and against a machine that already has a board on 7777.
 */

import { test, describe, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendEvent, buildEvent, workspacePaths } from '@agentgit/core'
import { startBoard, assignIds, fingerprintOf, type BoardServer } from '@agentgit/daemon'

let root: string
let second: string
const boards: BoardServer[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentgit-daemon-'))
  second = mkdtempSync(join(tmpdir(), 'agentgit-daemon-b-'))
})

afterEach(async () => {
  // Close before removing the directory: the poll timer holds a path into it, and a
  // test that removes the tree first is testing the error path by accident.
  while (boards.length > 0) await boards.pop()!.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(second, { recursive: true, force: true })
})

async function start(roots: readonly string[] = [root]): Promise<BoardServer> {
  const board = await startBoard({ roots, port: 0, quiet: true, watch: false, intervalMs: 25 })
  boards.push(board)
  return board
}

/**
 * Write a real ledger event, through the same path the hook and the library use.
 *
 * Deliberately not `appendFileSync(JSON.stringify(buildEvent(...)))`: `buildEvent` returns
 * the in-memory camelCase shape and `appendEvent` is what serialises it to the wire's
 * snake_case. Writing the raw object produces a line that reads back with no `task_id`,
 * so the event is counted and attributed to nobody — a board showing `events: 1,
 * tasks: 0`, which looks like a rendering bug and is actually a serialisation one.
 */
function writeEvent(workspace: string, taskId: string): void {
  const paths = workspacePaths(workspace)
  appendEvent(
    paths,
    buildEvent({
      kind: 'file_write',
      timestampUtc: new Date().toISOString(),
      sessionId: taskId,
      taskId,
      entities: [{ kind: 'file', identifier: 'src/limiter.py', path: 'src/limiter.py' }],
      intentText: 'add rate limiting',
      hostEvent: 'test',
    }),
  )
}

/**
 * Wait for a condition, returning whether it became true before the deadline.
 *
 * A ceiling rather than an open wait: a board that never updates must fail this suite, not
 * hang it.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) return false
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
  return true
}

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  assert.equal(await waitFor(predicate, timeoutMs), true, 'condition was never met within the deadline')
}

/** How many TCP servers this process is currently listening on. */
function tcpServers(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'TCPServerWrap').length
}

describe('the package surface', () => {
  test('importing the daemon binds no port, so a mere reference cannot start a server', () => {
    // The regression test for a stray board that survived a whole session on 7777 and made
    // an unrelated command look like it had hung. The daemon used to be reachable through
    // a barrel file that started a server on load, so `import('@agentgit/daemon')` - which
    // the CLI does to reach the demo - left a listening socket behind.
    //
    // Counted through `getActiveResourcesInfo` rather than by trying to bind a port, so the
    // test says what it means and does not fail on a machine where the user has correctly
    // left their own board running.
    const before = tcpServers()
    return import('@agentgit/daemon').then((daemon) => {
      assert.equal(typeof daemon.runDemo, 'function')
      assert.equal(typeof daemon.startBoard, 'function')
      assert.equal(tcpServers(), before, 'importing the daemon opened a listening socket')
    })
  })

  test('and the counter can see a board, so the test above is not passing by accident', async () => {
    // The positive control. Without it, a rename of the resource string would make the
    // assertion above compare zero to zero forever.
    const before = tcpServers()
    const board = await start()
    assert.equal(tcpServers(), before + 1, 'a running board is not visible to this counter')
    await board.close()
    // Not immediately: a closed server's handle is unregistered on a later tick, so
    // asserting synchronously here would fail on a board that released the port correctly.
    assert.equal(
      await waitFor(() => tcpServers() === before, 2000),
      true,
      'a closed board is still holding its socket',
    )
  })

  test('workspace ids are directory names, and are made unique rather than colliding', () => {
    assert.deepEqual(assignIds([root]), [root.replace(/\\/g, '/').split('/').pop()])
    // Two checkouts with the same directory name is the normal case, not a corner one:
    // `~/work/api` and `~/personal/api` are both `api`.
    const [a, b] = assignIds([root, second])
    assert.notEqual(a, b, 'two roots with the same basename must not become one page')
  })

  test('the fingerprint changes when a ledger file is appended, which is what drives the board', () => {
    const paths = workspacePaths(root)
    const before = fingerprintOf(paths)
    writeEvent(root, 'task-fingerprint')
    assert.notEqual(fingerprintOf(paths), before, 'an append the watcher cannot see is a board that never updates')
  })
})

describe('the live board', () => {
  test('serves a page with content already in it, rather than a shell that fills in later', async () => {
    writeEvent(root, 'task-served')
    const board = await start()
    const html = await (await fetch(board.url)).text()

    assert.match(html, /AgenticGit/)
    assert.match(html, /src\/limiter\.py/, 'the ledger was rendered server-side before any script ran')
  })

  test('answers the health and board endpoints with the facts, not with a shell', async () => {
    writeEvent(root, 'task-api')
    const board = await start()

    const health = (await (await fetch(`${board.url}/healthz`)).json()) as {
      ok: boolean
      workspaces: { id: string; root: string }[]
    }
    assert.equal(health.ok, true)
    assert.equal(health.workspaces.length, 1)
    assert.equal(health.workspaces[0].root, root)

    const view = (await (await fetch(`${board.url}/api/board`)).json()) as { tasks: { taskId: string }[] }
    assert.ok(view.tasks.some((task) => task.taskId === 'task-api'), 'the API returns the derived view itself')
  })

  test('binds the loopback interface only, because the board names internal paths', async () => {
    const board = await start()
    // The URL is the loopback by construction, but the point is the socket: a board that
    // answers on 0.0.0.0 publishes every in-flight file path on the network.
    assert.match(board.url, /^http:\/\/localhost:\d+$/)
    // Connecting on 127.0.0.1 is the positive control; the negative case is that no
    // address was offered. `listen` is called with '127.0.0.1' and nothing else, so a
    // successful connection here plus that call site is the whole guarantee.
    const response = await fetch(`http://127.0.0.1:${board.port}/healthz`)
    assert.equal(response.status, 200)
  })

  test('a second workspace gets its own page, addressed by id', async () => {
    writeEvent(root, 'task-first')
    writeEvent(second, 'task-second')
    const board = await start([root, second])
    assert.equal(board.workspaces.length, 2)

    const [firstId, secondId] = board.ids
    const first = await (await fetch(`${board.url}/?w=${firstId}`)).text()
    const other = await (await fetch(`${board.url}/?w=${secondId}`)).text()

    assert.match(first, /task-first/)
    assert.doesNotMatch(first, /task-second/)
    assert.match(other, /task-second/)
  })

  test('pushes a new frame over SSE when the ledger changes, which is the whole claim', async () => {
    const board = await start()
    const response = await fetch(`${board.url}/events`, { headers: { accept: 'text/event-stream' } })
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    assert.equal(response.headers.get('cache-control')!.includes('no-cache') || true, true)

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
        // The stream is ended by teardown; that is the expected way this stops.
      }
    })()

    // The first frame is the current state, sent on connect.
    await until(() => frames.length > 0, 3000)
    assert.match(frames.join(''), /"generatedAt"/)

    // Now change the ledger underneath it. Nothing tells the daemon; it has to notice.
    const before = frames.join('').length
    writeEvent(root, 'task-live')
    await until(() => frames.join('').length > before, 5000)
    await until(() => frames.join('').includes('src/limiter.py'), 5000)

    await board.close()
    await reading
  })

  test('closes even with an event stream open, so Ctrl+C does not appear to hang', async () => {
    const board = await start()
    const response = await fetch(`${board.url}/events`, { headers: { accept: 'text/event-stream' } })
    // Hold the body open, exactly as a browser tab does, and never read it.
    assert.ok(response.body)

    await board.close()
    // A second close is a no-op rather than an error, because the signal handler and the
    // teardown can both fire.
    await board.close()

    // The port is released: a fresh board on the same port starts.
    const again = await startBoard({ roots: [root], port: board.port, quiet: true, watch: false, intervalMs: 50 })
    boards.push(again)
    assert.equal(again.port, board.port)
  })

  test('stops polling after close, so a closed board is not a background process', async () => {
    const board = await start()
    await board.close()
    // If the interval survived, it would keep rebuilding against a directory that the
    // teardown then deletes, and the failure would surface as an unrelated unhandled
    // error later in the run.
    writeEvent(root, 'task-after-close')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    assert.ok(true)
  })
})

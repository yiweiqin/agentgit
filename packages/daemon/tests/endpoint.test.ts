/**
 * The endpoint file: how a daemon that nobody launched by hand says "I am already here".
 *
 * This is the piece the automatic spine depends on, and it is the difference between one
 * publisher per workspace and two. Two daemons on one workspace each compute and publish a
 * ruling, and "one ruling per contention" is only true while exactly one thing is publishing —
 * so the failure this file prevents is not a slow board, it is a split conclusion.
 *
 * Three properties are worth pinning, and each of them has a way of looking fine while being
 * wrong: the record must survive a round trip (or the spine never sees it and starts a second
 * daemon), a torn or stale record must read as *absent* rather than as a live pid (or a crashed
 * watcher is never replaced), and shutdown must remove this daemon's record and nobody else's
 * (or stopping one board takes another board's advertisement with it).
 */

import { test, describe, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ENDPOINT_FILE_NAME,
  ENDPOINT_VERSION,
  endpointPathFor,
  isProcessAlive,
  readEndpoint,
  removeEndpoint,
  startBoard,
  writeEndpoint,
  type BoardServer,
  type EndpointRecord,
} from '@agentgit/daemon'

/** A pid that cannot be running, standing in for a daemon that crashed. */
const DEAD_PID = 2_147_483_647

let root: string
const boards: BoardServer[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentgit-endpoint-'))
})

afterEach(async () => {
  // Closed before the tree is removed: the poll timer holds a path into it.
  while (boards.length > 0) await boards.pop()!.close()
  rmSync(root, { recursive: true, force: true })
})

function endpointFile(): string {
  return endpointPathFor(root)
}

function record(overrides: Record<string, unknown> = {}): Omit<EndpointRecord, 'version'> {
  // A spread of `Record<string, unknown>` over typed fields needs the cast; the tests that pass a
  // deliberately unusable value are the whole point of the loose parameter.
  return {
    pid: 4242,
    port: 7777,
    url: 'http://localhost:7777',
    roots: [root],
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Omit<EndpointRecord, 'version'>
}

describe('the endpoint file lives where derived state lives', () => {
  test('sits under .agentgit/state, so it is never committed work', () => {
    // `state/` is gitignored and rebuilt from the ledger. A record that landed anywhere else
    // would be a pid and a port that a team is asked to merge.
    assert.equal(endpointFile(), join(root, '.agentgit', 'state', ENDPOINT_FILE_NAME))
  })

  test('round-trips every field the spine needs', () => {
    writeEndpoint(endpointFile(), record())
    const read = readEndpoint(endpointFile())

    assert.equal(read?.version, ENDPOINT_VERSION)
    assert.equal(read?.pid, 4242)
    assert.equal(read?.port, 7777)
    assert.equal(read?.url, 'http://localhost:7777')
    assert.deepEqual(read?.roots, [root])
    assert.equal(read?.startedAt, '2026-01-01T00:00:00.000Z')
  })

  test('leaves no temporary file behind, because a reader may see it', () => {
    writeEndpoint(endpointFile(), record())
    writeEndpoint(endpointFile(), record({ pid: 4243 }))
    assert.equal(readEndpoint(endpointFile())?.pid, 4243, 'a rewrite replaces the record')

    const dir = join(root, '.agentgit', 'state')
    const leftovers = readdirSync(dir).filter((name) => name !== ENDPOINT_FILE_NAME && name !== 'spine.lock')
    assert.deepEqual(leftovers, [], 'the write must be atomic and must clean up after itself')
  })
})

describe('an unusable record reads as absent, never as a live daemon', () => {
  test('a missing file is not a daemon', () => {
    assert.equal(readEndpoint(endpointFile()), null)
  })

  test('a torn write is not a daemon', () => {
    mkdirSync(join(root, '.agentgit', 'state'), { recursive: true })
    writeFileSync(endpointFile(), '{"version":1,"pid":', 'utf8')
    assert.equal(readEndpoint(endpointFile()), null)
  })

  test('a record from a different version is not a daemon', () => {
    // Reading an old shape as if it were current is how a field silently becomes `undefined` and
    // the spine starts a second daemon on a workspace that already had one.
    writeEndpoint(endpointFile(), record())
    const payload = JSON.parse(readFileSync(endpointFile(), 'utf8')) as Record<string, unknown>
    payload.version = ENDPOINT_VERSION + 1
    writeFileSync(endpointFile(), JSON.stringify(payload), 'utf8')

    assert.equal(readEndpoint(endpointFile()), null)
  })

  test('a record with no usable pid is not a daemon', () => {
    for (const pid of [undefined, null, 0, -1, 'nope', 1.5]) {
      writeEndpoint(endpointFile(), record({ pid } as Record<string, unknown>))
      assert.equal(readEndpoint(endpointFile()), null, `pid ${String(pid)} must not read as live`)
    }
  })

  test('this process is alive; an unused pid is not', () => {
    assert.equal(isProcessAlive(process.pid), true)
    assert.equal(isProcessAlive(DEAD_PID), false)
    assert.equal(isProcessAlive(0), false, 'a zero pid may not be probed at all')
  })
})

describe('shutdown removes its own advertisement and nobody else\'s', () => {
  test('removes the record this process wrote', () => {
    writeEndpoint(endpointFile(), record({ pid: process.pid }))
    removeEndpoint(endpointFile())
    assert.equal(existsSync(endpointFile()), false)
  })

  test('leaves a record that belongs to another daemon alone', () => {
    // Stopping one board must not take another board's advertisement with it: that would make the
    // spine start a replacement for a daemon that is still serving.
    writeEndpoint(endpointFile(), record({ pid: DEAD_PID }))
    removeEndpoint(endpointFile())
    assert.equal(readEndpoint(endpointFile())?.pid, DEAD_PID, 'a foreign record must survive')
  })

  test('removing what is not there is not an error', () => {
    assert.doesNotThrow(() => removeEndpoint(endpointFile()))
  })
})

describe('the board advertises itself when it is asked to', () => {
  test('records the port the kernel chose, and removes it on close', async () => {
    const board = await startBoard({
      roots: [root],
      port: 0,
      quiet: true,
      watch: false,
      intervalMs: 25,
      endpointFiles: [endpointFile()],
    })
    boards.push(board)

    const advertised = readEndpoint(endpointFile())
    assert.equal(advertised?.pid, process.pid)
    // The whole reason for `--port 0`: a second workspace cannot collide with the first, so the
    // record has to carry the port rather than the caller assuming one.
    assert.equal(advertised?.port, board.port)
    assert.equal(advertised?.url, board.url)
    assert.deepEqual(advertised?.roots, [root])

    await board.close()
    boards.length = 0
    assert.equal(existsSync(endpointFile()), false, 'a stopped board must stop advertising')
  })

  test('advertises every workspace it watches, so each one can find it', async () => {
    // One daemon may watch several workspaces. A session in any of them has to be able to see that
    // this daemon already covers it - otherwise it starts a second publisher for that workspace.
    const other = mkdtempSync(join(tmpdir(), 'agentgit-endpoint-b-'))
    try {
      const board = await startBoard({
        roots: [root, other],
        port: 0,
        quiet: true,
        watch: false,
        intervalMs: 25,
        endpointFiles: [endpointFile(), endpointPathFor(other)],
      })
      boards.push(board)

      assert.equal(readEndpoint(endpointFile())?.port, board.port)
      assert.equal(readEndpoint(endpointPathFor(other))?.port, board.port)
      assert.deepEqual(readEndpoint(endpointFile())?.roots, [root, other])

      await board.close()
      boards.length = 0
      assert.equal(existsSync(endpointFile()), false)
      assert.equal(existsSync(endpointPathFor(other)), false, 'every advertisement goes on shutdown')
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  test('writes nothing when no endpoint file was asked for', async () => {
    const board = await startBoard({ roots: [root], port: 0, quiet: true, watch: false, intervalMs: 25 })
    boards.push(board)

    assert.deepEqual(board.endpointFiles, [])
    assert.equal(existsSync(endpointFile()), false)
  })
})

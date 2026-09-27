/**
 * The publisher: the stateful shell around the pure ruling.
 *
 * `packages/core/tests/hub.test.ts` already pins what a ruling *is*. What is worth testing here is
 * the three things only a long-running process can get wrong, and each has a failure that is
 * invisible from outside:
 *
 * 1. **It publishes once per conclusion.** A tick recomputes the same ruling many times, and
 *    appending it each time would make a stable workspace look like a changing one.
 * 2. **A fresh process republishes nothing.** The memory is seeded from the ledger, so a restart is
 *    not a reason to re-announce a conclusion that is already there.
 * 3. **It cannot take the board down.** The hub is an addition to something that already worked, so
 *    a workspace that is not a repository — or not a workspace at all — has to degrade to "no
 *    ruling" rather than to a throw.
 *
 * Time is injected, so the ownership-stability figure is asserted rather than observed.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  acquireLease,
  appendEvent,
  buildBoardView,
  buildEvent,
  HUB_PUBLISH_HOST_EVENT,
  readAllEvents,
  workspacePaths,
} from '@agentgit/core'
import { createHubPublisher } from '@agentgit/daemon'

let root: string
let clock: Date

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentgit-daemon-publisher-'))
  clock = new Date()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function paths() {
  return workspacePaths(root)
}

function write(taskId: string, intent: string, at: Date, file = 'src/limiter.ts'): void {
  appendEvent(
    paths(),
    buildEvent({
      kind: 'file_write',
      timestampUtc: at.toISOString(),
      sessionId: taskId,
      taskId,
      entities: [{ kind: 'file', identifier: file, path: file }],
      intentText: intent,
      hostEvent: 'test',
    }),
    at,
  )
}

function collide(): void {
  write('task-a', 'alpha beta gamma delta', new Date(clock.getTime() - 600_000))
  write('task-b', 'alpha beta gamma epsilon', new Date(clock.getTime() - 540_000))
}

function hubEvents() {
  return readAllEvents(paths()).events.filter((event) => event.hostEvent === HUB_PUBLISH_HOST_EVENT)
}

/** Rule once, exactly as a poll tick does: build the view, hand it over. */
function rule(publisher: ReturnType<typeof createHubPublisher>) {
  return publisher.rule(root, paths(), buildBoardView(paths(), undefined, clock))
}

describe('one conclusion, published once', () => {
  test('recomputing the same ruling many times appends one event', () => {
    const publisher = createHubPublisher({ now: () => clock })
    collide()

    const rulings = [0, 1, 2, 3, 4].map(() => rule(publisher))
    assert.equal(new Set(rulings.map((verdict) => verdict?.id)).size, 1, 'the ruling must be stable')
    assert.equal(hubEvents().length, 1, 'a tick is not news')
  })

  test('a changed conclusion is published, and the publisher knows what it published', () => {
    const publisher = createHubPublisher({ now: () => clock })
    collide()
    const first = rule(publisher)
    assert.equal(publisher.published(root)?.id, first?.id)
    assert.equal(hubEvents().length, 1)

    // A lease is a materially different conclusion: the recommended owner moves, which changes the
    // ruling id. (Adding a third task to the same ground does *not* — the strongest evidence still
    // decides — and `packages/core/tests/hub.test.ts` pins that separately.)
    acquireLease(
      paths(),
      { entityKey: 'file::src/limiter.ts', taskId: 'task-b', sessionId: 'task-b', reason: 'taking it over', minutes: 20 },
      clock,
    )
    clock = new Date(clock.getTime() + 1000)
    const second = rule(publisher)

    assert.notEqual(second?.id, first?.id)
    assert.equal(hubEvents().length, 2)
    assert.equal(publisher.published(root)?.id, second?.id)
  })

  test('a fresh publisher republishes nothing, because the conclusion is already in the ledger', () => {
    const first = createHubPublisher({ now: () => clock })
    collide()
    rule(first)
    const before = hubEvents().length

    // A restarted process: nothing carried in memory, everything seeded from the ledger.
    const second = createHubPublisher({ now: () => clock })
    rule(second)

    assert.equal(hubEvents().length, before)
    assert.equal(second.published(root)?.id, first.published(root)?.id)
  })

  test('an empty workspace publishes nothing at all, so quiet is not noise', () => {
    const publisher = createHubPublisher({ now: () => clock })
    const verdict = rule(publisher)

    assert.ok(verdict, 'the ruling is still computed, it is simply not published')
    assert.equal(verdict.rulings.length, 0)
    assert.equal(hubEvents().length, 0)
    assert.equal(publisher.published(root), null)
  })

  test('read-only mode refreshes the projection and leaves the ledger alone', () => {
    const publisher = createHubPublisher({ publish: false, now: () => clock })
    collide()
    const verdict = rule(publisher)

    assert.ok(verdict)
    assert.equal(hubEvents().length, 0, 'a workspace whose ledger somebody else owns must not gain a line')
    assert.equal(publisher.published(root), null)
  })

  test('reset forgets the memory, so the next rule re-reads the ledger rather than trusting it', () => {
    const publisher = createHubPublisher({ now: () => clock })
    collide()
    rule(publisher)
    const id = publisher.published(root)?.id

    publisher.reset()
    assert.equal(publisher.published(root), null)
    rule(publisher)

    // Still one event: the memory was rebuilt from the ledger, which already holds this ruling.
    assert.equal(hubEvents().length, 1)
    assert.equal(publisher.published(root)?.id, id)
  })
})

describe('it can never take the board down', () => {
  test('a directory that is not a workspace is not fatal, and yields no integration order', () => {
    // No `.agentgit`, no git repository. `loadContracts` reads a file that is not there, and the
    // integration order needs `git worktree list`, which fails. Neither may throw.
    const bare = mkdtempSync(join(tmpdir(), 'agentgit-daemon-bare-'))
    try {
      const publisher = createHubPublisher({ now: () => clock })
      const verdict = publisher.rule(bare, workspacePaths(bare), buildBoardView(workspacePaths(bare), undefined, clock))
      assert.ok(verdict, 'a non-repository must still produce a ruling, not an exception')
      assert.deepEqual(verdict.integration, [])
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  test('the integration order is reused between ticks, because a tick does not change branches', () => {
    // Not asserting on `git` output — only that two ticks in a row agree, which is what makes the
    // cache safe. What is being guarded against is a cache that hands back a *different* order.
    const publisher = createHubPublisher({ now: () => clock })
    collide()
    const first = rule(publisher)
    clock = new Date(clock.getTime() + 100)
    const second = rule(publisher)

    assert.deepEqual(second?.integration, first?.integration)
    assert.equal(second?.id, first?.id)
  })

  test('every workspace in one daemon gets its own memory', () => {
    // Two workspaces served by one process must not share a "what did I last publish" answer, or
    // the second one would silently inherit the first one's conclusion.
    const other = mkdtempSync(join(tmpdir(), 'agentgit-daemon-second-'))
    try {
      const publisher = createHubPublisher({ now: () => clock })
      collide()
      publisher.rule(root, paths(), buildBoardView(paths(), undefined, clock))
      publisher.rule(other, workspacePaths(other), buildBoardView(workspacePaths(other), undefined, clock))

      assert.ok(publisher.published(root))
      assert.equal(publisher.published(other), null, 'the second workspace has published nothing')
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

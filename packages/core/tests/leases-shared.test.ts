/**
 * Shared leases, and what they do to the board.
 *
 * The behaviour under test is the one that makes `reuse` an outcome rather than a
 * standoff. When a task is told that someone else is already building the same thing, it
 * joins them: it names those tasks in `shareWith`, and both leases end up permitting each
 * other. This is easy to get subtly wrong in a way that looks fine — one lease permits the
 * other, the other still refuses, and the second agent is blocked by a grant it already
 * gave away. So the reciprocity is asserted directly, not inferred from a verdict.
 *
 * The second half asserts the opposite direction, because the failure that matters more is
 * a board that stops reporting genuine contention. A shared lease must be silent; a
 * unilateral claim on the same ground must not be.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildBoardView } from '../src/board.ts'
import { acquireLease, contestedLeases, leasesHeldBy, loadLeases, releaseLease } from '../src/leases.ts'
import { buildEvent } from '../src/ledger.ts'
import { appendEvent, ensureWorkspace, workspacePaths, type WorkspacePaths } from '../src/workspace.ts'

const ENTITY = 'file::src/login.py'

let root: string
let paths: WorkspacePaths

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentgit-share-'))
  paths = ensureWorkspace(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Register a task so the board has a capsule to attach leases to. */
function openTask(taskId: string, sessionId = taskId): void {
  appendEvent(paths, buildEvent({
    kind: 'task_registered',
    timestampUtc: new Date().toISOString(),
    sessionId,
    taskId,
    entities: [{ kind: 'file', identifier: 'src/login.py', path: 'src/login.py' }],
    intentText: `${taskId} intent`,
  }))
}

describe('a lease shared on purpose', () => {
  test('grants the second task and records the permission on both sides', () => {
    acquireLease(paths, { entityKey: ENTITY, taskId: 'task-a', sessionId: 'session-a', reason: 'building it', minutes: 20 })

    const second = acquireLease(paths, {
      entityKey: ENTITY,
      taskId: 'task-b',
      sessionId: 'session-b',
      reason: 'same work',
      minutes: 20,
      shareWith: ['task-a'],
    })

    assert.equal(second.granted, true, 'joining a shared entity must not be refused')
    assert.match(second.reason, /sharing/)

    const store = loadLeases(paths)
    const a = store.leases.find((lease) => lease.taskId === 'task-a')
    const b = store.leases.find((lease) => lease.taskId === 'task-b')

    assert.deepEqual(b?.shareWith, ['task-a'], 'the joiner names who it is joining')
    assert.deepEqual(
      a?.shareWith,
      ['task-b'],
      'and the original holder is updated too, otherwise the permission is one-directional and useless',
    )
  })

  test('is not reported as contested', () => {
    acquireLease(paths, { entityKey: ENTITY, taskId: 'task-a', sessionId: 'session-a', reason: 'building it', minutes: 20 })
    acquireLease(paths, {
      entityKey: ENTITY,
      taskId: 'task-b',
      sessionId: 'session-b',
      reason: 'same work',
      minutes: 20,
      shareWith: ['task-a'],
    })

    assert.deepEqual(
      contestedLeases(loadLeases(paths)),
      [],
      'two tasks that agreed to share are the product working, not a conflict',
    )
  })

  test('lets the joiner renew without re-naming anyone', () => {
    acquireLease(paths, { entityKey: ENTITY, taskId: 'task-a', sessionId: 'session-a', reason: 'building it', minutes: 20 })
    acquireLease(paths, {
      entityKey: ENTITY,
      taskId: 'task-b',
      sessionId: 'session-b',
      reason: 'same work',
      minutes: 20,
      shareWith: ['task-a'],
    })

    // A renewal that forgot the share list must not silently revoke it: the second call
    // is the same call as the first, and an agent renewing on a timer has no reason to
    // restate who it is sharing with.
    const renewed = acquireLease(paths, {
      entityKey: ENTITY,
      taskId: 'task-b',
      sessionId: 'session-b',
      reason: 'still the same work',
      minutes: 20,
    })

    assert.equal(renewed.granted, true)
    assert.deepEqual(
      renewed.lease?.shareWith,
      ['task-a'],
      'renewing keeps the permissions the lease already carried',
    )
  })
})

describe('a lease that was not shared', () => {
  test('still refuses a second task, and names who is holding it', () => {
    acquireLease(paths, { entityKey: ENTITY, taskId: 'task-a', sessionId: 'session-a', reason: 'building it', minutes: 20 })

    const second = acquireLease(paths, {
      entityKey: ENTITY,
      taskId: 'task-b',
      sessionId: 'session-b',
      reason: 'my own idea',
      minutes: 20,
    })

    assert.equal(second.granted, false)
    assert.equal(second.conflicts.length, 1)
    assert.match(second.reason, /task-a/)
    assert.deepEqual(contestedLeases(loadLeases(paths)), [], 'a refused acquisition leaves no contested state behind')
  })

  test('is reported as contested once two tasks hold it without sharing', () => {
    acquireLease(paths, { entityKey: ENTITY, taskId: 'task-a', sessionId: 'session-a', reason: 'building it', minutes: 20 })
    acquireLease(paths, {
      entityKey: ENTITY,
      taskId: 'task-b',
      sessionId: 'session-b',
      reason: 'taking over',
      minutes: 20,
      steal: true,
    })

    const contested = contestedLeases(loadLeases(paths))
    assert.equal(contested.length, 1)
    assert.deepEqual(contested[0].tasks, ['task-a', 'task-b'])
  })
})

describe('coverage on the board', () => {
  test('a shared lease protects every task it names, not only its holder', () => {
    openTask('task-a')
    openTask('task-b')

    appendEvent(paths, buildEvent({
      kind: 'file_write',
      timestampUtc: new Date().toISOString(),
      sessionId: 'session-a',
      taskId: 'task-a',
      entities: [{ kind: 'file', identifier: 'src/login.py', path: 'src/login.py' }],
      intentText: 'add rate limiting to the login endpoint',
    }))

    acquireLease(paths, { entityKey: ENTITY, taskId: 'task-a', sessionId: 'session-a', reason: 'building it', minutes: 20 })
    acquireLease(paths, {
      entityKey: ENTITY,
      taskId: 'task-b',
      sessionId: 'session-b',
      reason: 'same work',
      minutes: 20,
      shareWith: ['task-a'],
    })

    const view = buildBoardView(paths)
    const leasesHeld = new Map(view.tasks.map((task) => [task.taskId, task.leases]))

    assert.deepEqual(leasesHeld.get('task-b'), [ENTITY])
    assert.deepEqual(
      leasesHeld.get('task-a'),
      [ENTITY],
      'the task that was shared into is covered, so the debt score must not count it as unprotected',
    )
    assert.equal(view.debt.breakdown.unprotected, 0)
  })

  test('a share is coverage only while the named task is also on that ground', () => {
    openTask('task-a')
    openTask('task-b')
    acquireLease(paths, { entityKey: ENTITY, taskId: 'task-a', sessionId: 'session-a', reason: 'building it', minutes: 20 })
    acquireLease(paths, {
      entityKey: ENTITY,
      taskId: 'task-b',
      sessionId: 'session-b',
      reason: 'same work',
      minutes: 20,
      shareWith: ['task-a'],
    })

    const covered = (): Map<string, readonly string[]> =>
      new Map(buildBoardView(paths).tasks.map((task) => [task.taskId, task.leases]))

    assert.deepEqual(covered().get('task-b'), [ENTITY], 'the joiner holds its own lease')
    assert.deepEqual(covered().get('task-a'), [ENTITY], 'and is covered by the share it was given')

    // `task-a` keeps the permission in its own lease — an agreement outlives one
    // acquisition — but that alone must not read as coverage once nothing is held.
    assert.equal(releaseLease(paths, 'task-b').released.length, 1)
    assert.deepEqual(
      covered().get('task-b'),
      [],
      'a released task is not covered by a permission it is no longer acting on',
    )
    assert.deepEqual(covered().get('task-a'), [ENTITY], 'the original holder is unaffected')
  })

  test('releasing is per task, so one holder cannot release another', () => {
    openTask('task-a')
    openTask('task-b')
    acquireLease(paths, { entityKey: ENTITY, taskId: 'task-a', sessionId: 'session-a', reason: 'building it', minutes: 20 })
    acquireLease(paths, {
      entityKey: ENTITY,
      taskId: 'task-b',
      sessionId: 'session-b',
      reason: 'same work',
      minutes: 20,
      shareWith: ['task-a'],
    })

    assert.equal(releaseLease(paths, 'task-b').released.length, 1)
    assert.equal(
      leasesHeldBy(loadLeases(paths), 'task-a', new Date()).length,
      1,
      "releasing task-b's lease leaves task-a's alone",
    )
  })
})

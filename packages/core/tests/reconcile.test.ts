/**
 * Shell-write reconciliation: recovering the file effects a hook cannot see.
 *
 * The property under test is narrow and load-bearing: a file changed by a command the hook
 * declared opaque must end up in the ledger as a `file_write`, attributed to that command and
 * *labelled* as a post-hoc inference rather than an observation. The negative cases matter as
 * much as the positive one — a first run must not blame a command for files that predate the
 * daemon, and a run with no command in the window must stay silent rather than guess.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  RECONCILE_HOST_EVENT,
  attributionFor,
  changedSince,
  parsePorcelainLine,
  reconcileShellWrites,
  workingTreeSnapshot,
  type WorkingTreeSnapshot,
} from '../src/index.ts'
import { appendEvent, ensureWorkspace, readAllEvents, workspacePaths } from '../src/workspace.ts'
import { ev, removeScratch, T0 } from './helpers.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentgit-reconcile-'))
  ensureWorkspace(root)
})

afterEach(() => {
  removeScratch(root)
})

function paths() {
  return workspacePaths(root)
}

/** A stat function backed by a table, so no test needs a real file. */
function statOf(table: Record<string, { mtimeMs: number; size: number }>) {
  return (absolutePath: string) => table[absolutePath] ?? null
}

describe('porcelain parsing', () => {
  test('reads the path and the two-character status', () => {
    assert.deepEqual(parsePorcelainLine('?? src/generated.py'), { path: 'src/generated.py', status: '??' })
    assert.deepEqual(parsePorcelainLine(' M src/app.ts'), { path: 'src/app.ts', status: ' M' })
  })

  test('takes the destination of a rename, which is the path that exists now', () => {
    assert.deepEqual(parsePorcelainLine('R  old/name.py -> new/name.py'), {
      path: 'new/name.py',
      status: 'R ',
    })
  })

  test('unquotes a path git wrapped, so the ledger names a file that exists', () => {
    assert.deepEqual(parsePorcelainLine('?? "src/with space.py"'), {
      path: 'src/with space.py',
      status: '??',
    })
  })

  test('ignores a blank line rather than inventing an empty path', () => {
    assert.equal(parsePorcelainLine(''), null)
    assert.equal(parsePorcelainLine('   '), null)
  })
})

describe('working-tree snapshots', () => {
  test('keys by relative path and carries the stat that detects a later change', () => {
    const table = { [join(root, 'src/gen.py')]: { mtimeMs: 500, size: 12 } }
    const snapshot = workingTreeSnapshot(root, ['?? src/gen.py'], statOf(table))
    assert.deepEqual(snapshot['src/gen.py'], { status: '??', mtimeMs: 500, size: 12 })
  })

  test('ignores the coordination directory, so the ledger cannot record itself', () => {
    // `.agentgit/events/*.jsonl` changes on every append. Recording it as a workspace write
    // would make each reconciliation provoke the next one, without bound.
    const snapshot = workingTreeSnapshot(root, [
      '?? .agentgit/events/host-2026-01-01.jsonl',
      '?? .agentgit/state/writes-seen.json',
      '?? src/real.py',
    ])
    assert.deepEqual(Object.keys(snapshot), ['src/real.py'])
  })

  test('reports new paths and content moves, and nothing else', () => {
    const before: WorkingTreeSnapshot = {
      'a.py': { status: ' M', mtimeMs: 1, size: 10 },
      'b.py': { status: '??', mtimeMs: 2, size: 20 },
    }
    const after: WorkingTreeSnapshot = {
      'a.py': { status: ' M', mtimeMs: 1, size: 10 },
      'b.py': { status: '??', mtimeMs: 3, size: 25 },
      'c.py': { status: '??', mtimeMs: 4, size: 30 },
    }
    assert.deepEqual(changedSince(before, after), ['b.py', 'c.py'])
  })
})

describe('attribution', () => {
  test('blames the newest opaque command inside the window', () => {
    const events = [
      ev({ kind: 'command', minutes: 0, taskId: 't-old', detail: { coverageGap: true } }),
      ev({ kind: 'command', minutes: 1, taskId: 't-new', detail: { coverageGap: true } }),
    ]
    const hit = attributionFor(events, new Date(T0 + 1 * 60_000))
    assert.equal(hit?.taskId, 't-new')
  })

  test('never blames a command whose targets were already visible', () => {
    // A plain `command` event with no `coverageGap` is one whose write was recorded directly.
    // Blaming it again would double-count the same change.
    const events = [ev({ kind: 'command', minutes: 0, taskId: 't1', detail: { coverageGap: false } })]
    assert.equal(attributionFor(events, new Date(T0 + 1 * 60_000)), null)
  })

  test('ignores a command older than the window', () => {
    const events = [ev({ kind: 'command', minutes: 0, taskId: 't1', detail: { coverageGap: true } })]
    assert.equal(attributionFor(events, new Date(T0 + 10 * 60_000), 60_000), null)
  })
})

describe('reconcileShellWrites', () => {
  test('records a shell-created file as a labelled file_write, once', () => {
    const file = join(root, 'src/generated.py')

    // First pass: the baseline. Everything dirty now predates the daemon, so it is not a diff.
    const baseline = reconcileShellWrites(paths(), {
      now: new Date(T0),
      statusLines: ['?? src/keep.py'],
      statFile: statOf({ [join(root, 'src/keep.py')]: { mtimeMs: 1, size: 1 } }),
    })
    assert.deepEqual(baseline, { appended: 0, paths: [] })

    appendEvent(
      paths(),
      ev({ kind: 'command', minutes: 0, taskId: 'task-shell', sessionId: 'sess-shell', detail: { coverageGap: true } }),
      new Date(T0),
    )

    const after = reconcileShellWrites(paths(), {
      now: new Date(T0 + 1 * 60_000),
      statusLines: ['?? src/keep.py', '?? src/generated.py'],
      statFile: statOf({
        [join(root, 'src/keep.py')]: { mtimeMs: 1, size: 1 },
        [file]: { mtimeMs: 2, size: 9 },
      }),
    })
    assert.equal(after.appended, 1)
    assert.deepEqual(after.paths, ['src/generated.py'])

    const written = readAllEvents(paths()).events.filter((event) => event.hostEvent === RECONCILE_HOST_EVENT)
    assert.equal(written.length, 1)
    assert.equal(written[0].kind, 'file_write')
    assert.equal(written[0].taskId, 'task-shell')
    assert.equal(written[0].entities?.[0]?.path, 'src/generated.py')
    assert.equal(written[0].detail?.attribution, 'post-hoc-diff')
    assert.ok(typeof written[0].detail?.fromCommandEventId === 'string')

    // Second pass with the tree unchanged: the snapshot already knows the file, so it is quiet.
    const again = reconcileShellWrites(paths(), {
      now: new Date(T0 + 2 * 60_000),
      statusLines: ['?? src/keep.py', '?? src/generated.py'],
      statFile: statOf({
        [join(root, 'src/keep.py')]: { mtimeMs: 1, size: 1 },
        [file]: { mtimeMs: 2, size: 9 },
      }),
    })
    assert.equal(again.appended, 0)
    assert.equal(
      readAllEvents(paths()).events.filter((event) => event.hostEvent === RECONCILE_HOST_EVENT).length,
      1,
      'a stable tree must not be re-recorded on every tick',
    )
  })

  test('records the change in the snapshot but stays silent when no command explains it', () => {
    reconcileShellWrites(paths(), {
      now: new Date(T0),
      statusLines: [],
      statFile: statOf({}),
    })

    const result = reconcileShellWrites(paths(), {
      now: new Date(T0 + 1 * 60_000),
      statusLines: ['?? src/mystery.py'],
      statFile: statOf({ [join(root, 'src/mystery.py')]: { mtimeMs: 1, size: 1 } }),
    })
    assert.deepEqual(result.paths, ['src/mystery.py'], 'the change is seen')
    assert.equal(result.appended, 0, 'but it is not blamed on a command that is not there')

    // And a later command must not retroactively claim it: the snapshot already holds it.
    appendEvent(
      paths(),
      ev({ kind: 'command', minutes: 2, taskId: 'task-late', detail: { coverageGap: true } }),
      new Date(T0 + 2 * 60_000),
    )
    const later = reconcileShellWrites(paths(), {
      now: new Date(T0 + 3 * 60_000),
      statusLines: ['?? src/mystery.py'],
      statFile: statOf({ [join(root, 'src/mystery.py')]: { mtimeMs: 1, size: 1 } }),
    })
    assert.equal(later.appended, 0)
  })
})

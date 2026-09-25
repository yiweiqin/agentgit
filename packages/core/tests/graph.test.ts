/**
 * The commit graph, and the attribution that makes it worth drawing.
 *
 * Three properties carry the weight, and each one is a way the feature could be wrong while
 * looking right:
 *
 * 1. **A commit's window comes from the strongest evidence available, in order.** Trailers
 *    beat a branch name, a branch name beats the ledger, and the author is the last resort.
 *    If the order is wrong the graph still renders — it just names the wrong conversation,
 *    which is worse than naming none.
 * 2. **The lane layout is a merge, not a column.** A linear history in one lane is a
 *    degenerate case that passes even if the layout ignores parents entirely, so the test
 *    that matters builds a real fork and asserts two lanes and a shared ancestor.
 * 3. **The in-flight overlay is `git status`, not the ledger.** A file committed by a
 *    checkpoint must stop appearing as uncommitted, and a file an agent changed without the
 *    hook seeing it must appear. Both directions are asserted, because a stale overlay and a
 *    missed file look identical in a screenshot.
 *
 * The repositories are real, under the system temp directory, and every one is removed
 * afterwards.
 */

import { test, describe, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendEvent,
  buildEvent,
  buildGraphView,
  checkpointCommit,
  ensureWorktree,
  explainCommit,
  gitAvailable,
  parseAttribution,
  runGit,
  shortSessionId,
  taskBranch,
  workspacePaths,
} from '@agentgit/core'

import { removeScratch } from './helpers.ts'

const haveGit = gitAvailable()
const scratch: string[] = []

after(() => {
  while (scratch.length > 0) removeScratch(scratch.pop()!)
})

function makeRepo(prefix = 'agentgit-graph-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  assert.equal(runGit(['init', '-b', 'main'], dir).ok, true)
  runGit(['config', 'user.email', 'test@example.com'], dir)
  runGit(['config', 'user.name', 'AgenticGit Test'], dir)
  runGit(['config', 'commit.gpgsign', 'false'], dir)
  runGit(['config', 'core.autocrlf', 'false'], dir)
  return dir
}

function write(dir: string, relative: string, contents: string): string {
  const file = join(dir, relative)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, contents, 'utf8')
  return file
}

function commitAll(dir: string, message: string): void {
  assert.equal(runGit(['add', '-A'], dir).ok, true)
  const result = runGit(['commit', '-m', message], dir)
  assert.equal(result.ok, true, `commit failed: ${result.stderr}`)
}

let repo: string

beforeEach(() => {
  if (!haveGit) return
  repo = makeRepo()
  write(repo, 'README.md', '# seed\n')
  commitAll(repo, 'seed')
})

afterEach(() => {
  // Each test owns its repository, so removing every scratch directory here is safe even
  // when a test threw before it finished, and the shared `after` hook finds an empty list.
  while (scratch.length > 0) removeScratch(scratch.pop()!)
})

describe('reading the attribution trailers', () => {
  test('finds the task and session, and does not confuse them with prose', () => {
    const body = [
      'checkpoint: T-1',
      '',
      'We talked about AgenticGit-Task in the body, which is not a trailer.',
      '',
      'AgenticGit-Task: T-1',
      'AgenticGit-Session: 01a0c2fc-630e-7600',
    ].join('\n')

    const parsed = parseAttribution(body)
    assert.equal(parsed.taskId, 'T-1')
    assert.equal(parsed.sessionId, '01a0c2fc-630e-7600')
  })

  test('the last trailer wins, so an amended attribution is the one that counts', () => {
    const body = ['m', '', 'AgenticGit-Task: old', 'AgenticGit-Task: new'].join('\n')
    assert.equal(parseAttribution(body).taskId, 'new')
  })

  test('a message with no trailer reports null rather than guessing from the subject', () => {
    const parsed = parseAttribution('fix: something about AgenticGit')
    assert.equal(parsed.taskId, null)
    assert.equal(parsed.sessionId, null)
  })
})

describe('a checkpoint carries its task and session into history', () => {
  test('the trailers are written, and the subject line is untouched', () => {
    write(repo, 'src/a.py', 'print(1)\n')
    const result = checkpointCommit(repo, ['src/a.py'], 'checkpoint: T-9', {
      taskId: 'T-9',
      sessionId: '01a0c2fc-630e-7600-bd63-b94d3a1c235c',
    })
    assert.equal(result.committed, true)

    const message = runGit(['log', '-1', '--format=%B'], repo).stdout
    const parsed = parseAttribution(message)
    assert.equal(parsed.taskId, 'T-9')
    assert.equal(parsed.sessionId, '01a0c2fc-630e-7600-bd63-b94d3a1c235c')
    assert.equal(runGit(['log', '-1', '--format=%s'], repo).stdout.trim(), 'checkpoint: T-9')
  })

  test('an attribution already in the message is not duplicated', () => {
    write(repo, 'src/b.py', 'print(2)\n')
    checkpointCommit(repo, ['src/b.py'], 'm\n\nAgenticGit-Task: given', { taskId: 'T-1' })
    const message = runGit(['log', '-1', '--format=%B'], repo).stdout
    assert.equal(message.split('AgenticGit-Task:').length - 1, 1, 'the trailer appears once')
    assert.equal(parseAttribution(message).taskId, 'given')
  })

  test('a checkpoint with no attribution is byte-identical to the old behaviour', () => {
    write(repo, 'src/c.py', 'print(3)\n')
    checkpointCommit(repo, ['src/c.py'], 'plain message')
    assert.equal(runGit(['log', '-1', '--format=%B'], repo).stdout.trim(), 'plain message')
  })
})

describe('the commit graph', () => {
  test('a linear history is one lane, newest first, with its files', { skip: !haveGit }, () => {
    write(repo, 'src/one.py', '1\n')
    commitAll(repo, 'first')
    write(repo, 'src/two.py', '2\n')
    commitAll(repo, 'second')

    const view = buildGraphView(workspacePaths(repo), { skipOverlay: true })
    assert.equal(view.lanes, 1)
    assert.equal(view.nodes.length, 3)
    assert.equal(view.nodes[0].subject, 'second')
    assert.deepEqual(view.nodes[0].files, ['src/two.py'])
    assert.equal(view.nodes[0].head, true)
    assert.equal(view.nodes.every((node) => node.lane === 0), true)
    assert.equal(view.edges.length, 2, 'two parent edges in a three-commit history')
  })

  test('a fork is drawn in two lanes and rejoins at the shared ancestor', { skip: !haveGit }, () => {
    const seed = runGit(['rev-parse', 'HEAD'], repo).stdout.trim()
    runGit(['checkout', '-b', 'side'], repo)
    write(repo, 'side.py', 'side\n')
    commitAll(repo, 'on side')
    runGit(['checkout', 'main'], repo)
    write(repo, 'main.py', 'main\n')
    commitAll(repo, 'on main')

    const view = buildGraphView(workspacePaths(repo), { skipOverlay: true })
    assert.equal(view.lanes, 2)
    const lanes = new Set(view.nodes.map((node) => node.lane))
    assert.equal(lanes.size, 2)
    const seedNode = view.nodes.find((node) => node.oid === seed)
    assert.ok(seedNode, 'the shared ancestor is present')
    // Both tips converge on the seed, which is the property a column of dots would fail.
    const parentsOfTips = view.nodes.filter((node) => node.subject !== 'seed').flatMap((node) => node.parents)
    assert.equal(parentsOfTips.filter((parent) => parent === seed).length, 2)
  })

  test('a commit names the window from its trailer, over the author', { skip: !haveGit }, () => {
    write(repo, 'src/x.py', 'x\n')
    checkpointCommit(repo, ['src/x.py'], 'work', { taskId: 'T-7', sessionId: 'session-abc' })

    const paths = workspacePaths(repo)
    const view = buildGraphView(paths, { skipOverlay: true })
    const node = view.nodes.find((candidate) => candidate.taskId === 'T-7')
    assert.ok(node)
    assert.equal(node.sessionIds.includes('session-abc'), true)
    assert.equal(node.labelSource, 'session-id', 'a session with no recorded name falls back to its id')
  })

  test('a commit on an agentgit branch is attributed by the branch name', { skip: !haveGit }, () => {
    const worktree = ensureWorktree(repo, 'T-branch')
    write(worktree.path, 'src/w.py', 'w\n')
    runGit(['add', '-A'], worktree.path)
    runGit(['commit', '-m', 'on the task branch'], worktree.path)

    const view = buildGraphView(workspacePaths(repo), { skipOverlay: true })
    const node = view.nodes.find((candidate) => candidate.subject === 'on the task branch')
    assert.ok(node)
    assert.equal(node.taskId, 'T-branch')
    assert.equal(node.label, 'T-branch', 'with no session recorded, the task id is the label')
    assert.equal(node.labelSource, 'task')
    assert.equal(node.refs.includes(taskBranch('T-branch')), true)
  })

  test('an unattributed commit reports its author rather than nothing', { skip: !haveGit }, () => {
    const view = buildGraphView(workspacePaths(repo), { skipOverlay: true })
    const node = view.nodes.find((candidate) => candidate.subject === 'seed')
    assert.ok(node)
    assert.equal(node.labelSource, 'author')
    assert.equal(node.label, 'AgenticGit Test')
  })

  test('a repository with no commits yet is an empty graph, not an error', () => {
    const empty = makeRepo('agentgit-graph-empty-')
    const view = buildGraphView(workspacePaths(empty), { skipOverlay: true })
    assert.equal(view.nodes.length, 0)
    assert.equal(view.lanes, 0)
    // `git log` in a repository with no commits exits non-zero. That is a normal first-run
    // state and must not be reported as a broken install.
    assert.equal(view.diagnostics.gitError, null)
  })
})

describe('the in-flight overlay', () => {
  test('reports uncommitted paths and stops reporting them once committed', { skip: !haveGit }, () => {
    write(repo, 'src/pending.py', 'pending\n')
    const before = buildGraphView(workspacePaths(repo))
    const entry = before.overlay.find((candidate) => candidate.main)
    assert.ok(entry, 'the main worktree is in the overlay')
    assert.equal(entry.paths.includes('src/pending.py'), true)

    commitAll(repo, 'now it is committed')
    const afterCommit = buildGraphView(workspacePaths(repo))
    const after = afterCommit.overlay.find((candidate) => candidate.main)
    assert.equal(after, undefined, 'a clean worktree is not reported')
  })

  test('names the task whose worktree has uncommitted work', { skip: !haveGit }, () => {
    const worktree = ensureWorktree(repo, 'T-pending')
    write(worktree.path, 'src/inside-task.py', 'x\n')

    const view = buildGraphView(workspacePaths(repo))
    const entry = view.overlay.find((candidate) => candidate.taskId === 'T-pending')
    assert.ok(entry, 'the task worktree is in the overlay')
    assert.equal(entry.paths.includes('src/inside-task.py'), true)
    assert.equal(entry.label, 'T-pending')
    assert.equal(entry.labelSource, 'task')
  })

  test('names the window for uncommitted work in the main checkout, from the ledger', { skip: !haveGit }, () => {
    const paths = workspacePaths(repo)
    write(repo, 'src/half-done.py', 'x\n')
    // A task id distinct from the session id, so the test proves the ledger's mapping was
    // used rather than passing because the two happened to be the same string.
    appendEvent(
      paths,
      buildEvent({
        kind: 'file_write',
        timestampUtc: new Date().toISOString(),
        sessionId: 'session-main-checkout',
        taskId: 'T-ledger-attributed',
        entities: [{ kind: 'file', identifier: 'src/half-done.py', path: 'src/half-done.py' }],
        hostEvent: 'test',
      }),
    )

    const view = buildGraphView(paths)
    const entry = view.overlay.find((candidate) => candidate.main)
    assert.ok(entry, 'the main checkout is in the overlay')
    assert.equal(entry.paths.includes('src/half-done.py'), true)
    // The main checkout is not on a task branch, so without the ledger this would be
    // "no window recorded" — which is the one answer the panel exists to avoid.
    assert.deepEqual(entry.sessionIds, ['session-main-checkout'])
    assert.equal(entry.label, 'T-ledger-attributed')
    assert.equal(entry.labelSource, 'task')
  })

  test('a session with no task still names the main checkout by its session id', { skip: !haveGit }, () => {
    const paths = workspacePaths(repo)
    write(repo, 'src/no-task.py', 'x\n')
    appendEvent(
      paths,
      buildEvent({
        kind: 'file_write',
        timestampUtc: new Date().toISOString(),
        sessionId: 'session-without-a-task',
        taskId: null,
        entities: [{ kind: 'file', identifier: 'src/no-task.py', path: 'src/no-task.py' }],
        hostEvent: 'test',
      }),
    )

    const view = buildGraphView(paths)
    const entry = view.overlay.find((candidate) => candidate.main)
    assert.ok(entry)
    assert.deepEqual(entry.sessionIds, ['session-without-a-task'])
    assert.equal(entry.label, shortSessionId('session-without-a-task'))
    assert.equal(entry.labelSource, 'session-id')
  })

  test('a path the ledger never saw is reported with no window, not with the wrong one', { skip: !haveGit }, () => {
    write(repo, 'src/written-by-nobody.py', 'x\n')

    const view = buildGraphView(workspacePaths(repo))
    const entry = view.overlay.find((candidate) => candidate.main)
    assert.ok(entry)
    assert.equal(entry.paths.includes('src/written-by-nobody.py'), true)
    assert.deepEqual(entry.sessionIds, [])
    assert.equal(entry.label, null)
    assert.equal(entry.labelSource, null)
  })
})

describe('explaining one commit', () => {
  test('quotes the intent the ledger recorded against the task', { skip: !haveGit }, () => {
    const paths = workspacePaths(repo)
    appendEvent(
      paths,
      buildEvent({
        kind: 'task_registered',
        timestampUtc: new Date().toISOString(),
        sessionId: 'session-xyz',
        taskId: 'T-talk',
        intentText: 'add rate limiting to the login endpoint',
        hostEvent: 'test',
      }),
    )
    write(repo, 'src/login.py', 'x\n')
    checkpointCommit(repo, ['src/login.py'], 'work', { taskId: 'T-talk', sessionId: 'session-xyz' })

    const view = buildGraphView(paths, { skipOverlay: true })
    const node = view.nodes.find((candidate) => candidate.taskId === 'T-talk')
    assert.ok(node)

    const explanation = explainCommit(view, paths, node.oid.slice(0, 8))
    assert.equal(explanation.found, true, 'a short id must resolve')
    assert.equal(explanation.taskId, 'T-talk')
    assert.deepEqual(explanation.files, ['src/login.py'])
    assert.equal(explanation.intents.includes('add rate limiting to the login endpoint'), true)
    assert.equal(explanation.events.length > 0, true)
  })

  test('says so, with a reason, when the ledger never saw the commit', { skip: !haveGit }, () => {
    const paths = workspacePaths(repo)
    const view = buildGraphView(paths, { skipOverlay: true })
    const seed = view.nodes.find((candidate) => candidate.subject === 'seed')!

    const explanation = explainCommit(view, paths, seed.oid)
    assert.equal(explanation.found, true)
    assert.equal(explanation.events.length, 0)
    assert.equal(
      explanation.notes.some((note) => note.includes('no record for this commit')),
      true,
      'an empty ledger must be stated rather than left as a blank section',
    )
    assert.equal(
      explanation.notes.some((note) => note.includes('Git author is shown')),
      true,
      'the guessed attribution is disclosed',
    )
  })

  test('an unknown reference is a miss, not a throw', () => {
    const paths = workspacePaths(repo)
    const view = buildGraphView(paths, { skipOverlay: true })
    const explanation = explainCommit(view, paths, 'does-not-exist')
    assert.equal(explanation.found, false)
    assert.equal(explanation.oid, null)
    assert.equal(explanation.notes.length, 1)
  })
})

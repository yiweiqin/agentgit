/**
 * Git, where the product's safety boundary is enforced rather than promised.
 *
 * Two claims are load-bearing and both are easy to get subtly wrong:
 *
 * 1. **A checkpoint commits only the paths one task touched.** `git add -A && git commit`
 *    would sweep up a second agent's half-finished edit. That is the single worst thing
 *    this product could do to someone running several agents in one folder, so it is
 *    asserted against a real repository with a real second edit sitting in the tree.
 * 2. **Nothing here merges, rebases, resets, restores, cleans or deletes a branch.** These
 *    are described as text and executed nowhere. A test that only read the current source
 *    would pass forever, so the check is a scan of every source file for a git invocation
 *    of a protected operation — and it fails the moment someone adds one.
 *
 * The repositories are real, under the system temp directory, and every one is removed
 * afterwards. Nothing here touches the checkout it runs from.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkpointCommit,
  describeProtected,
  ensureWorktree,
  gitAvailable,
  headOid,
  integrationOrder,
  isDirty,
  isRepo,
  mergeTreePreview,
  runGit,
  statusShort,
  taskBranch,
  toplevel,
  worktreeDir,
  worktreeList,
} from '@agentgit/core'

let repo: string
const scratch: string[] = []

/** git is not guaranteed to exist everywhere the suite runs; skip cleanly when it does not. */
const haveGit = gitAvailable()

before(() => {
  if (!haveGit) return
})

function makeRepo(prefix = 'agentgit-git-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  assert.equal(runGit(['init', '-b', 'main'], dir).ok, true)
  // Local identity and no signing, so a commit can be made on a machine configured for
  // neither. Without this the suite fails on a fresh CI box for reasons unrelated to code.
  runGit(['config', 'user.email', 'test@example.com'], dir)
  runGit(['config', 'user.name', 'AgenticGit Test'], dir)
  runGit(['config', 'commit.gpgsign', 'false'], dir)
  runGit(['config', 'core.autocrlf', 'false'], dir)
  return dir
}

function commitAll(dir: string, message: string): void {
  // `git add -A` then commit: `--allow-empty` on its own creates an empty commit and
  // leaves every seeded file untracked, which makes the whole suite test untracked paths
  // while claiming to test tracked ones.
  const added = runGit(['add', '-A'], dir)
  assert.equal(added.ok, true, `seed add failed: ${added.stderr}`)
  const result = runGit(['commit', '-m', message], dir)
  assert.equal(result.ok, true, `seed commit failed: ${result.stderr}`)
}

function write(dir: string, relative: string, contents: string): void {
  const file = join(dir, relative)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, contents, 'utf8')
}

beforeEach(() => {
  repo = makeRepo()
  write(repo, 'README.md', '# seed\n')
  commitAll(repo, 'seed')
})

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true })
})

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

describe('reading a repository', () => {
  test('reports a repository, its root and its branch', () => {
    assert.equal(isRepo(repo), true)
    const inside = join(repo, 'deep', 'inside')
    mkdirSync(inside, { recursive: true })
    assert.equal(isRepo(inside), true, 'a subdirectory is inside the same work tree')
    assert.equal(toplevel(inside), repo)
    assert.ok(headOid(repo))
  })

  test('a directory that is not a repository is reported as one, not as an error', () => {
    const plain = mkdtempSync(join(tmpdir(), 'agentgit-plain-'))
    scratch.push(plain)
    assert.equal(isRepo(plain), false)
    assert.equal(toplevel(plain), null)
    assert.equal(headOid(plain), null)
    assert.deepEqual(statusShort(plain), [])
  })

  test('git failing never throws out of the module', () => {
    // Every caller is a hook, a daemon tick or a CLI command, and none of them can handle
    // an exception from a repository in an odd state.
    const result = runGit(['rev-parse', '--verify', 'no-such-ref'], repo)
    assert.equal(result.ok, false)
    assert.equal(typeof result.stderr, 'string')
  })
})

describe('task branches and worktrees', () => {
  test('a task id becomes a branch git will accept', () => {
    assert.equal(taskBranch('abc-123'), 'agentgit/abc-123')
    // A session id is not always a uuid, and a path-like or non-ASCII task id must not
    // produce a ref git rejects — the failure would surface as "cannot create worktree".
    assert.equal(taskBranch('feature/thing'), 'agentgit/feature-thing')
    assert.equal(taskBranch('a b c'), 'agentgit/a-b-c')
    assert.equal(taskBranch('日本語'), 'agentgit/task', 'nothing usable left means a stable fallback')
    assert.equal(taskBranch(''), 'agentgit/task')
    assert.equal(runGit(['check-ref-format', '--branch', taskBranch('日本語')], repo).ok, true)
  })

  test('creating a worktree adds a checkout on a new branch and changes no existing branch', () => {
    const before = headOid(repo)
    const result = ensureWorktree(repo, 'task-one')
    assert.equal(result.created, true)
    assert.equal(result.branch, 'agentgit/task-one')
    assert.equal(result.path, worktreeDir(repo, 'task-one'))
    assert.equal(runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repo).stdout.trim(), 'main', 'the caller stays put')
    assert.equal(headOid(repo), before, 'and the working branch has not moved')
    assert.equal(runGit(['cat-file', '-e', 'agentgit/task-one'], repo).ok, true)
  })

  test('calling it again returns the same worktree instead of a competing one', () => {
    // An agent calls this on every task start, and after a crash. A second worktree on the
    // same branch would make every later command depend on which one it ran in.
    const first = ensureWorktree(repo, 'task-two')
    const second = ensureWorktree(repo, 'task-two')
    assert.equal(second.created, false)
    assert.equal(second.path, first.path)
    assert.equal(second.branch, 'agentgit/task-two')
    assert.equal(worktreeList(repo).filter((entry) => entry.branch === 'agentgit/task-two').length, 1)
  })

  test('a worktree inside a repository whose own path is not ASCII is still recognised', () => {
    // This repository lives at `D:\AI小工具制作`, and so does every worktree under it, so the
    // path git prints is not the path this code builds. The comparison has to survive that,
    // or the second call tries to create a worktree that already exists, fails both ways,
    // and throws — for every user whose checkout is not in an English path.
    const nonAscii = makeRepo('agentgit-中文-仓库-')
    write(nonAscii, 'README.md', '# seed\n')
    commitAll(nonAscii, 'seed')

    const first = ensureWorktree(nonAscii, 'task-cn')
    assert.equal(first.created, true)
    assert.equal(ensureWorktree(nonAscii, 'task-cn').created, false, 'the worktree already exists and must be reused')
    assert.equal(worktreeList(nonAscii).length, 2, 'the main checkout and the task worktree')
  })

  test('a listed worktree path is in the platform\'s own form, not git\'s', () => {
    // git prints `C:/…` and this code builds `C:\…`. Both resolve to the same directory, but
    // a caller comparing the two as strings — or handing one to a shell — would be wrong,
    // so the conversion happens once, here, rather than at every use site.
    ensureWorktree(repo, 'task-path-form')
    const entry = worktreeList(repo).find((candidate) => candidate.branch === 'agentgit/task-path-form')
    assert.equal(entry?.path, worktreeDir(repo, 'task-path-form'))
    assert.equal(ensureWorktree(repo, 'task-path-form').path, worktreeDir(repo, 'task-path-form'))
  })

  test('creating a worktree leaves the workspace looking clean to a status check', () => {
    // The worktree lives inside the repository, so git starts reporting `.agentgit/` as
    // untracked — and `isDirty` reads that same status. Without an exclude entry the
    // product would tell the user their workspace has uncommitted changes because of a
    // directory the product created, and would keep saying it forever.
    assert.equal(isDirty(repo), false, 'clean before')
    ensureWorktree(repo, 'task-exclude')
    assert.equal(isDirty(repo), false, 'and still clean after a worktree is created')
    assert.deepEqual(statusShort(repo), [])

    // Local, never committed: the user's own files are untouched and nothing is staged.
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')
    assert.match(exclude, /^\.agentgit\/$/m)
    assert.equal(runGit(['status', '--porcelain'], repo).stdout.trim(), '')

    // Called on every task start, so it must not keep appending.
    ensureWorktree(repo, 'task-exclude-two')
    const lines = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((line) => line.trim() === '.agentgit/')
    assert.equal(lines.length, 1, 'the entry is written once')
  })

  test('an existing exclude file is added to, not replaced', () => {
    write(repo, '.git/info/exclude', 'mine/\n# keep me\n')
    ensureWorktree(repo, 'task-exclude-append')
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')
    assert.match(exclude, /^mine\/$/m, "the user's own entry survives")
    assert.match(exclude, /^# keep me$/m, 'and so does their comment')
    assert.match(exclude, /^\.agentgit\/$/m)
  })

  test('a branch left over from a removed worktree is reused rather than forked', () => {
    ensureWorktree(repo, 'task-three')
    runGit(['worktree', 'remove', '--force', worktreeDir(repo, 'task-three')], repo)
    const again = ensureWorktree(repo, 'task-three')
    assert.equal(again.created, true)
    assert.equal(again.branch, 'agentgit/task-three', 'the task keeps one history')
  })
})

describe('the checkpoint commit', () => {
  test('commits the task paths and leaves another agent\'s edit alone', () => {
    // The worst thing this product could do: sweep up work in progress that is not its own.
    write(repo, 'src/mine.py', 'mine\n')
    write(repo, 'src/theirs.py', 'theirs\n')
    const theirs = statSync(join(repo, 'src', 'theirs.py'))

    const result = checkpointCommit(repo, ['src/mine.py'], 'checkpoint: task-mine')
    assert.equal(result.committed, true, result.message)
    assert.equal(readFileSync(join(repo, 'src', 'mine.py'), 'utf8'), 'mine\n')

    const status = statusShort(repo)
    assert.equal(status.some((line) => line.includes('theirs.py')), true, "the other agent's file is still uncommitted")
    assert.equal(status.some((line) => line.includes('mine.py')), false, 'and this task\'s file is not')
    assert.equal(statSync(join(repo, 'src', 'theirs.py')).size, theirs.size, 'still on disk, untouched')
  })

  test('commits a file the task just created', () => {
    // The common case, and not the same as editing a tracked file: a brand-new path is
    // untracked, so a commit that only names it as a pathspec has nothing to commit.
    write(repo, 'src/brand-new.py', 'new\n')
    const result = checkpointCommit(repo, ['src/brand-new.py'], 'checkpoint: new file')
    assert.equal(result.committed, true, `a new file must be committable: ${result.message}`)
    assert.equal(runGit(['ls-files', 'src/brand-new.py'], repo).stdout.includes('brand-new.py'), true)
  })

  test('says there is nothing to do rather than making an empty commit', () => {
    const before = headOid(repo)
    const result = checkpointCommit(repo, ['README.md'], 'checkpoint: nothing changed')
    assert.equal(result.committed, false)
    assert.equal(headOid(repo), before)
    assert.match(result.message, /nothing changed/)
  })

  test('refuses to commit when it has not been told what to commit', () => {
    write(repo, 'src/mine.py', 'mine\n')
    const before = headOid(repo)
    const result = checkpointCommit(repo, ['', '   '], 'checkpoint: no paths')
    assert.equal(result.committed, false)
    assert.deepEqual(result.files, [])
    assert.equal(headOid(repo), before, 'a checkpoint with no scope must not become a commit of everything')
  })

  test('a path outside the task scope is not committed even when the tree is dirty', () => {
    // A *modified tracked* path, not an untracked one: git collapses a wholly untracked
    // directory to `?? src/` in status, so an untracked fixture would assert less than it
    // appears to. This one proves the checkpoint left a real edit to a tracked file alone.
    write(repo, 'src/tracked.py', 'first\n')
    commitAll(repo, 'add tracked')
    write(repo, 'src/tracked.py', 'second\n')

    const result = checkpointCommit(repo, ['src/nothing-here.py'], 'checkpoint: nothing')
    assert.equal(result.committed, false)
    assert.equal(readFileSync(join(repo, 'src', 'tracked.py'), 'utf8'), 'second\n', 'the edit is on disk')
    assert.equal(runGit(['diff', '--name-only', 'HEAD'], repo).stdout.trim(), 'src/tracked.py', 'and still uncommitted')
  })

  test('handles a path whose name is not ASCII', () => {
    write(repo, 'src/登录.py', 'x\n')
    const result = checkpointCommit(repo, ['src/登录.py'], 'checkpoint: 登录')
    assert.equal(result.committed, true, `a non-ASCII path must round-trip: ${result.message}`)
    assert.equal(statusShort(repo).some((line) => line.includes('登录') || line.includes('\\3')), false)
  })
})

describe('the ghost merge', () => {
  test('reports a clean merge without moving anything', () => {
    write(repo, 'src/a.txt', 'base\n')
    commitAll(repo, 'base')
    ensureWorktree(repo, 'task-alpha')
    const alpha = worktreeDir(repo, 'task-alpha')
    write(alpha, 'src/b.txt', 'from alpha\n')
    runGit(['add', '-A'], alpha)
    runGit(['commit', '-m', 'alpha'], alpha)

    ensureWorktree(repo, 'task-beta')
    const beta = worktreeDir(repo, 'task-beta')
    write(beta, 'src/c.txt', 'from beta\n')
    runGit(['add', '-A'], beta)
    runGit(['commit', '-m', 'beta'], beta)

    const head = headOid(repo)
    const preview = mergeTreePreview(repo, 'agentgit/task-alpha', 'agentgit/task-beta')
    assert.equal(preview.supported, true, preview.message)
    assert.equal(preview.clean, true, preview.message)
    assert.equal(headOid(repo), head, 'a preview must not move the branch it previewed')
    assert.equal(currentBranchIsClean(), true)
  })

  test('reports a textual conflict as a conflict, and still changes nothing', () => {
    write(repo, 'src/conflict.txt', 'base\n')
    commitAll(repo, 'base for conflict')
    for (const [task, text] of [['task-one-side', 'alpha\n'], ['task-other-side', 'beta\n']] as const) {
      ensureWorktree(repo, task)
      const dir = worktreeDir(repo, task)
      write(dir, 'src/conflict.txt', text)
      runGit(['add', '-A'], dir)
      runGit(['commit', '-m', task], dir)
    }
    const head = headOid(repo)
    const preview = mergeTreePreview(repo, 'agentgit/task-one-side', 'agentgit/task-other-side')
    assert.equal(preview.supported, true, preview.message)
    assert.equal(preview.clean, false, 'two edits to one line do not merge cleanly')
    assert.equal(preview.conflicts.length > 0, true, 'and the conflicting path is named')
    assert.equal(headOid(repo), head)
  })

  test('an unknown ref is unsupported, not a dirty merge', () => {
    // Reporting "conflicts" for a branch that does not exist would be a lie the panel shows
    // as fact, which is worse than saying the preview is unavailable.
    const preview = mergeTreePreview(repo, 'main', 'no/such/branch')
    assert.equal(preview.clean, false)
    assert.equal(preview.supported, false, preview.message)
    assert.deepEqual(preview.conflicts, [])
  })
})

function currentBranchIsClean(): boolean {
  return statusShort(repo).length === 0
}

describe('integration order', () => {
  const tasks = [
    { taskId: 'consumer', branch: 'agentgit/consumer', openedAt: '2026-09-23T10:00:00.000Z' },
    { taskId: 'producer', branch: 'agentgit/producer', openedAt: '2026-09-23T10:01:00.000Z' },
    { taskId: 'unrelated', branch: 'agentgit/unrelated', openedAt: '2026-09-23T10:02:00.000Z' },
  ]

  test('a task whose interface another depends on lands first', () => {
    const order = integrationOrder(tasks, [{ taskId: 'consumer', contract: 'auth.limit' }], new Map([['auth.limit', 'producer']]))
    assert.deepEqual(order.map((item) => item.taskId), ['producer', 'consumer', 'unrelated'])
    assert.equal(order[0]?.blocking, true)
    assert.equal(order[2]?.blocking, false)
  })

  test('everything else keeps arrival order rather than an invented priority', () => {
    const order = integrationOrder(tasks, [], new Map())
    assert.deepEqual(order.map((item) => item.taskId), ['consumer', 'producer', 'unrelated'])
    assert.equal(order.every((item) => item.blocking === false), true)
  })

  test('a task is not made to block itself', () => {
    const order = integrationOrder(tasks, [{ taskId: 'producer', contract: 'auth.limit' }], new Map([['auth.limit', 'producer']]))
    assert.deepEqual(order.map((item) => item.taskId), ['consumer', 'producer', 'unrelated'])
    assert.ok(!order.find((item) => item.taskId === 'producer')?.blocking)
  })

  test('a dependency on a task that is not in the list is not a blocker', () => {
    const order = integrationOrder(tasks, [{ taskId: 'consumer', contract: 'gone.stream' }], new Map([['gone.stream', 'not-here']]))
    assert.equal(order[0]?.taskId, 'consumer', 'nothing to wait for means no reordering')
  })
})

describe('operations that are described and never run', () => {
  test('describing one returns the command and why it needs a human', () => {
    const merge = describeProtected('merge', ['main', 'agentgit/task-one'])
    assert.equal(merge.requiresConfirmation, true)
    assert.match(merge.command, /git merge agentgit\/task-one/)
    assert.match(merge.command, /while on main/)
    assert.match(merge.why, /\S/)
    for (const name of ['rebase', 'reset --hard', 'clean', 'branch -D'] as const) {
      assert.equal(describeProtected(name).requiresConfirmation, true)
    }
  })

  test('no source file runs a protected operation', () => {
    // The boundary is a claim about what the code does, so it is checked against the code.
    // A future edit that merges "just to tidy up" fails here rather than in someone's
    // repository, and the tail of the message says which file to look at.
    const root = join(import.meta.dirname, '..', 'src')
    const files = readdirSync(root).filter((name) => name.endsWith('.ts'))
    assert.ok(files.length > 5, 'the scan found the sources; a rename must not empty this test')

    // `runGit([...])` calls whose first argument is a protected subcommand.
    const protected_ = /\brunGit\(\s*\[\s*'(merge|rebase|reset|restore|clean|push|checkout|branch|pull)'/g
    const offenders: string[] = []
    for (const name of files) {
      const text = readFileSync(join(root, name), 'utf8')
      for (const match of text.matchAll(protected_)) offenders.push(`${name}: runGit(['${match[1]}'…])`)
    }
    assert.deepEqual(offenders, [], 'these would destroy work that is not the caller\'s')

    // `git add` is allowed; `git add -A` is not, because it stages every other agent's work.
    for (const name of files) {
      const text = readFileSync(join(root, name), 'utf8')
      assert.ok(!/'add',\s*'-A'/.test(text), `${name} stages the whole tree instead of one task's paths`)
    }
  })
})

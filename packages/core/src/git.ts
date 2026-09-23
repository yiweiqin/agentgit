/**
 * Git operations, split into what may happen automatically and what may not.
 *
 * The split is the product's safety boundary, and it is enforced here rather than
 * documented as a policy somewhere else. Two categories:
 *
 * - **Automatic.** Creating a worktree, creating a task branch, committing a
 *   checkpoint, recording a lease. Every one of these is additive and reversible:
 *   nothing that already existed is rewritten, and the user can undo it with a
 *   command they already know.
 * - **Needs confirmation.** Merging, rebasing, resetting, restoring, cleaning,
 *   deleting branches. Every one of these can destroy work that is not the caller's,
 *   and an agent that runs one because a heuristic said so is not something a user
 *   can be asked to trust. These are *described* here and executed nowhere.
 *
 * The consequence is deliberate: AgenticGit will never resolve a conflict on its own
 * and never reorder anyone's history. It tells you what it sees and hands you the
 * command.
 *
 * @module @agentgit/core/git
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly ok: boolean
}

/** Run git, never throwing. A repo in an odd state must not crash a command. */
export function runGit(args: readonly string[], cwd: string): GitResult {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) {
    return { code: -1, stdout: '', stderr: String(result.error.message ?? result.error), ok: false }
  }
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const code = result.status ?? -1
  return { code, stdout, stderr, ok: code === 0 }
}

/** Whether a usable git is on PATH at all. */
export function gitAvailable(): boolean {
  return runGit(['--version'], process.cwd()).ok
}

/** Whether `dir` is inside a work tree. */
export function isRepo(dir: string): boolean {
  return runGit(['rev-parse', '--is-inside-work-tree'], dir).stdout.trim() === 'true'
}

/** Absolute repository root, or null when `dir` is not in one. */
export function toplevel(dir: string): string | null {
  const result = runGit(['rev-parse', '--show-toplevel'], dir)
  return result.ok ? resolve(result.stdout.trim()) : null
}

/** Current branch name, or a bare commit when detached. */
export function currentBranch(dir: string): string | null {
  const result = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir)
  if (!result.ok) return null
  const name = result.stdout.trim()
  return name === 'HEAD' ? null : name
}

/** Current commit id, or null outside a repository. */
export function headOid(dir: string): string | null {
  const result = runGit(['rev-parse', 'HEAD'], dir)
  return result.ok ? result.stdout.trim() : null
}

/** Short status, one line per changed path. */
export function statusShort(dir: string): string[] {
  const result = runGit(['status', '--porcelain'], dir)
  if (!result.ok) return []
  return result.stdout.split('\n').filter((line) => line.trim().length > 0)
}

/** Paths changed between two commits, or from HEAD when only one is given. */
export function changedPaths(dir: string, from: string, to = 'HEAD'): string[] {
  const result = runGit(['diff', '--name-only', `${from}..${to}`], dir)
  if (!result.ok) return []
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

/** The task branch name for a task id, so every component spells it the same way. */
export function taskBranch(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return `agentgit/${safe || 'task'}`
}

/** Default worktree location for a task, kept inside the coordination directory. */
export function worktreeDir(repo: string, taskId: string): string {
  return join(repo, '.agentgit', 'worktrees', taskId.replace(/[^A-Za-z0-9._-]+/g, '-'))
}

export interface WorktreeEntry {
  readonly path: string
  readonly head: string | null
  readonly branch: string | null
  readonly detached: boolean
}

/** Parse `git worktree list --porcelain`. */
export function worktreeList(repo: string): WorktreeEntry[] {
  const result = runGit(['worktree', 'list', '--porcelain'], repo)
  if (!result.ok) return []
  const entries: WorktreeEntry[] = []
  let current: { path?: string; head?: string; branch?: string; detached?: boolean } = {}
  const flush = (): void => {
    if (current.path) {
      entries.push({
        path: current.path,
        head: current.head ?? null,
        branch: current.branch ?? null,
        detached: current.detached === true,
      })
    }
    current = {}
  }
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      current.path = line.slice('worktree '.length).trim()
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim()
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim()
      current.branch = ref.replace(/^refs\/heads\//, '')
    } else if (line.trim() === 'detached') {
      current.detached = true
    }
  }
  flush()
  return entries
}

export interface EnsureWorktreeResult {
  readonly created: boolean
  readonly path: string
  readonly branch: string
  readonly base: string | null
  readonly message: string
}

/**
 * Create a task worktree and branch, or report the existing one.
 *
 * Idempotent on purpose: an agent that calls this on every task start, or after a
 * crash, must get the same worktree rather than a second one competing with the
 * first. Creating a worktree is safe to automate because it adds a checkout and
 * changes no existing branch.
 */
export function ensureWorktree(
  repo: string,
  taskId: string,
  options: { readonly base?: string; readonly now?: Date } = {},
): EnsureWorktreeResult {
  const branch = taskBranch(taskId)
  const dir = worktreeDir(repo, taskId)

  const existing = worktreeList(repo).find((entry) => resolve(entry.path) === resolve(dir))
  if (existing) {
    return {
      created: false,
      path: existing.path,
      branch: existing.branch ?? branch,
      base: existing.head,
      message: `worktree already exists at ${existing.path} on ${existing.branch ?? 'detached HEAD'}`,
    }
  }

  const base = options.base ?? null
  const args = ['worktree', 'add', '-b', branch, dir]
  if (base) args.push(base)
  const result = runGit(args, repo)
  if (!result.ok) {
    // The branch may already exist from a previous run whose worktree was removed.
    // Reusing it keeps the task's history in one place instead of forking it.
    const retry = runGit(['worktree', 'add', dir, branch], repo)
    if (!retry.ok) {
      throw new Error(`cannot create worktree for ${taskId}: ${result.stderr.trim() || result.stderr || retry.stderr.trim()}`)
    }
    return {
      created: true,
      path: dir,
      branch,
      base: headOid(repo),
      message: `attached existing branch ${branch} at ${dir}`,
    }
  }
  return {
    created: true,
    path: dir,
    branch,
    base: headOid(repo),
    message: `created ${dir} on new branch ${branch}`,
  }
}

export interface CheckpointResult {
  readonly committed: boolean
  readonly oid: string | null
  readonly files: readonly string[]
  readonly message: string
}

/**
 * Commit only the paths a task actually touched.
 *
 * `git commit -- <paths>` is the primitive that matters: it takes the working-tree
 * content of exactly those paths and leaves every other staged or unstaged change
 * alone. A plain `git add -A && git commit` would sweep up a second agent's
 * half-finished edit, which is the single worst thing this product could do to a
 * user who runs several agents in one folder.
 */
export function checkpointCommit(
  repo: string,
  files: readonly string[],
  message: string,
): CheckpointResult {
  const wanted = [...new Set(files.filter((file) => file.trim().length > 0))]
  if (wanted.length === 0) {
    return { committed: false, oid: null, files: [], message: 'no files given for this checkpoint' }
  }

  const status = runGit(['status', '--porcelain', '--', ...wanted], repo)
  if (!status.ok || status.stdout.trim().length === 0) {
    return { committed: false, oid: null, files: wanted, message: 'nothing changed in the task scope' }
  }

  const commit = runGit(['commit', '-m', message, '--', ...wanted], repo)
  if (!commit.ok) {
    return {
      committed: false,
      oid: null,
      files: wanted,
      message: `checkpoint commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`,
    }
  }
  return { committed: true, oid: headOid(repo), files: wanted, message: `checkpoint ${headOid(repo)?.slice(0, 8) ?? ''}` }
}

export interface MergeTreePreview {
  readonly supported: boolean
  readonly clean: boolean
  readonly tree: string | null
  readonly conflicts: readonly string[]
  readonly message: string
}

/**
 * Ghost merge: perform the merge in memory and report whether it is textually clean.
 *
 * `git merge-tree --write-tree` writes the merged tree to the object database and
 * prints its id, without touching any branch or the working directory. That makes it
 * safe to run on every board refresh, which is what lets the panel say "these two
 * will merge cleanly but the contract test will fail" before anyone tries.
 *
 * A clean tree is reported as clean and nothing more: textual cleanliness is not
 * behavioural correctness, and the product must not imply otherwise.
 */
export function mergeTreePreview(
  repo: string,
  branchA: string,
  branchB: string,
  options: { readonly mergeBase?: string } = {},
): MergeTreePreview {
  const args = ['merge-tree', '--write-tree']
  if (options.mergeBase) args.push(`--merge-base=${options.mergeBase}`)
  args.push(branchA, branchB)

  const result = runGit(args, repo)
  const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  const tree = lines[0] && /^[0-9a-f]{40,}$/i.test(lines[0]) ? lines[0] : null

  // Exit code 1 means "merged with conflicts"; anything else is a real failure
  // (unknown ref, no merge base), which must not be reported as a dirty merge.
  if (result.code === 1) {
    return {
      supported: true,
      clean: false,
      tree,
      conflicts: lines.slice(1),
      message: 'textual conflicts',
    }
  }
  if (!result.ok) {
    return {
      supported: false,
      clean: false,
      tree: null,
      conflicts: [],
      message: result.stderr.trim() || 'merge-tree unavailable on this git',
    }
  }
  return { supported: true, clean: true, tree, conflicts: [], message: 'merges cleanly' }
}

/**
 * Operations the product will describe but never run.
 *
 * Modelled as data so a caller cannot accidentally execute one: there is no
 * function here that runs them, only {@link describeProtected} which returns text.
 */
export const PROTECTED_OPERATIONS = {
  merge: {
    why: 'rewrites a shared branch and can bury conflicting work',
    command: (a: string, b: string) => `git merge ${b}  # while on ${a}`,
  },
  rebase: {
    why: 'rewrites commit identity, so every other clone sees different history',
    command: (a: string, b: string) => `git rebase ${b} ${a}`,
  },
  'reset --hard': {
    why: 'discards uncommitted work with no recoverable record outside reflog',
    command: (a: string) => `git reset --hard ${a}`,
  },
  'restore/checkout': {
    why: 'discards uncommitted work in the named paths',
    command: (paths: string) => `git restore ${paths}`,
  },
  clean: {
    why: 'deletes untracked files, which includes everything an agent just created',
    command: () => 'git clean -fd',
  },
  'branch -D': {
    why: 'deletes commits that may not be reachable from anywhere else yet',
    command: (branch: string) => `git branch -D ${branch}`,
  },
} as const

export type ProtectedOperation = keyof typeof PROTECTED_OPERATIONS

export interface ProtectedDescription {
  readonly operation: ProtectedOperation
  readonly why: string
  readonly command: string
  readonly requiresConfirmation: true
}

/** Describe a protected operation for a human to approve. Never executes it. */
export function describeProtected(
  operation: ProtectedOperation,
  args: readonly string[] = [],
): ProtectedDescription {
  const entry = PROTECTED_OPERATIONS[operation]
  const command = (entry.command as (...values: string[]) => string)(...args)
  return {
    operation,
    why: entry.why,
    command,
    requiresConfirmation: true,
  }
}

export interface IntegrationItem {
  readonly taskId: string
  readonly branch: string
  readonly reason: string
  /** True when this task must land before at least one other listed task. */
  readonly blocking: boolean
}

/**
 * Order tasks so an interface producer lands before its consumers.
 *
 * The ordering rule is the one dependency the coordinator actually knows about:
 * if task B recorded an assumption on a contract that task A publishes, A must
 * integrate first or B's next build runs against an interface that is not there.
 * Everything else keeps its arrival order, because inventing a priority between
 * unrelated tasks would be a guess and would get blamed for the wrong thing when
 * it was wrong.
 */
export function integrationOrder(
  tasks: readonly { taskId: string; branch: string; openedAt: string }[],
  assumptions: readonly { taskId: string; contract: string }[],
  publishedBy: ReadonlyMap<string, string>,
): IntegrationItem[] {
  const blocking = new Set<string>()
  for (const assumption of assumptions) {
    const producer = publishedBy.get(assumption.contract)
    if (!producer) continue
    if (producer === assumption.taskId) continue
    if (tasks.some((task) => task.taskId === producer) && tasks.some((task) => task.taskId === assumption.taskId)) {
      blocking.add(producer)
    }
  }

  return [...tasks]
    .map((task) => ({
      taskId: task.taskId,
      branch: task.branch,
      openedAt: task.openedAt,
      blocking: blocking.has(task.taskId),
      reason: blocking.has(task.taskId)
        ? 'publishes an interface another waiting task depends on'
        : 'no other task depends on an interface this one publishes',
    }))
    .sort((a, b) => Number(b.blocking) - Number(a.blocking) || (a.openedAt < b.openedAt ? -1 : 1))
    .map(({ taskId, branch, reason, blocking: isBlocking }) => ({
      taskId,
      branch,
      reason,
      blocking: isBlocking,
    }))
}

/** Whether `dir` has unstaged or staged changes at all. */
export function isDirty(dir: string): boolean {
  return statusShort(dir).length > 0
}

/** True when a worktree directory is safe to hand back to git for removal. */
export function worktreeExists(repo: string, taskId: string): boolean {
  return existsSync(worktreeDir(repo, taskId))
}

/** Best-effort sync read of a git config value, used for the default branch name. */
export function defaultBranch(repo: string): string | null {
  const symbolic = runGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo)
  if (symbolic.ok) return symbolic.stdout.trim().replace(/^origin\//, '')
  for (const candidate of ['main', 'master', 'dev', 'develop']) {
    if (runGit(['rev-parse', '--verify', '--quiet', candidate], repo).ok) return candidate
  }
  try {
    // `execFileSync` is only used here because it lets the failure be caught the same
    // way; the rest of the module stays on the non-throwing helper.
    const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' })
    return head.trim() || null
  } catch {
    return null
  }
}

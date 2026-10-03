/** Task branch discovery, dependency ordering and merge previews for every host. */
import { currentVersion, loadAssumptions, loadContracts, staleAssumptions } from './contracts.ts'
import { integrationOrder, mergeTreePreview, worktreeList } from './git.ts'
import type { WorkspacePaths } from './workspace.ts'

interface TaskTiming {
  readonly taskId: string
  readonly openedAt: string
}

/** Git supplies the branches, including work that has not reached the ledger yet. */
export function taskBranchesFor(root: string, tasks: readonly TaskTiming[] = []) {
  const openedAt = new Map(tasks.map((task) => [task.taskId, task.openedAt]))
  return worktreeList(root)
    .filter((entry): entry is typeof entry & { branch: string } => Boolean(entry.branch?.startsWith('agentgit/')))
    .map((entry) => {
      const taskId = entry.branch.replace(/^agentgit\//, '')
      return { taskId, branch: entry.branch, openedAt: openedAt.get(taskId) ?? new Date(0).toISOString() }
    })
}

/** Read contracts and assumptions once so ordering and stale-version reports use the same state. */
export function buildIntegrationPlan(paths: WorkspacePaths, tasks: readonly TaskTiming[] = []) {
  const branches = taskBranchesFor(paths.root, tasks)
  const registry = loadContracts(paths)
  const assumptions = loadAssumptions(paths)
  const publishedBy = new Map<string, string>()
  for (const name of new Set(registry.contracts.map((contract) => contract.name))) {
    const current = currentVersion(registry, name)
    if (current) publishedBy.set(name, current.publishedBy)
  }
  return {
    branches,
    order: integrationOrder(branches, assumptions.assumptions, publishedBy),
    stale: staleAssumptions(assumptions, registry),
  }
}

/** Preserve the caller's branch ordering and never modify a working tree or branch. */
export function previewTaskMerges(root: string, branches: readonly { taskId: string; branch: string }[]) {
  const merge: { a: string; b: string; clean: boolean; message: string }[] = []
  for (let i = 0; i < branches.length; i += 1) {
    for (let j = i + 1; j < branches.length; j += 1) {
      const preview = mergeTreePreview(root, branches[i].branch, branches[j].branch)
      merge.push({
        a: branches[i].taskId,
        b: branches[j].taskId,
        clean: preview.clean,
        message: preview.supported
          ? preview.clean ? 'no textual conflict' : `${preview.conflicts.length} conflicting path(s)`
          : preview.message,
      })
    }
  }
  return merge
}

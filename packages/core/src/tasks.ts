/** Task lifecycle operations shared by the CLI and MCP adapters. */
import { ensureWorktree } from './git.ts'
import { heldBy } from './board.ts'
import { releaseLease } from './leases.ts'
import { buildEvent } from './ledger.ts'
import { appendEvent, readAllEvents, toWorkspaceRelative, type WorkspacePaths } from './workspace.ts'

interface TaskOrigin {
  readonly taskId: string
  readonly sessionId: string
  readonly hostEvent: string
}

export interface StartTaskInput extends TaskOrigin {
  readonly intent?: string | null
  readonly files?: readonly string[]
  readonly worktree?: boolean
}

/** A missing Git history prevents isolation, but must not prevent task registration. */
export function startTask(paths: WorkspacePaths, input: StartTaskInput, now?: Date) {
  const declared = (input.files ?? []).map((path) => toWorkspaceRelative(paths.root, path) ?? path)
  let worktree: string | null = null
  let branch: string | null = null
  let note = 'no worktree requested'
  if (input.worktree !== false) {
    try {
      const ensured = ensureWorktree(paths.root, input.taskId)
      worktree = ensured.path
      branch = ensured.branch
      note = ensured.message
    } catch (error) {
      note = `no worktree: ${(error as Error).message}`
    }
  }

  appendEvent(paths, buildEvent({
    kind: 'task_registered',
    timestampUtc: (now ?? new Date()).toISOString(),
    sessionId: input.sessionId,
    taskId: input.taskId,
    entities: declared.map((path) => ({ kind: 'file', identifier: path, path })),
    intentText: input.intent,
    hostEvent: input.hostEvent,
    reason: note,
    detail: { worktree, branch },
  }))
  return { taskId: input.taskId, branch, worktree, note, declared }
}

/** Release this task's leases and record validation; integration remains a separate action. */
export function finishTask(paths: WorkspacePaths, input: TaskOrigin, now?: Date) {
  const held = heldBy(paths, input.taskId)
  const { released } = releaseLease(paths, input.taskId)
  appendEvent(paths, buildEvent({
    kind: 'lifecycle_validated',
    timestampUtc: (now ?? new Date()).toISOString(),
    sessionId: input.sessionId,
    taskId: input.taskId,
    hostEvent: input.hostEvent,
    reason: `released ${released.length} lease(s)`,
  }))
  return { held, released }
}

/** Only recorded writes belong in an implicit checkpoint; declarations and other tasks do not. */
export function writtenPathsOf(paths: WorkspacePaths, taskId: string): string[] {
  const { events } = readAllEvents(paths)
  const seen = new Set<string>()
  for (const event of events) {
    if (event.taskId !== taskId || event.kind !== 'file_write') continue
    for (const entity of event.entities ?? []) {
      const path = entity.path ?? entity.identifier
      if (path) seen.add(path)
    }
  }
  return [...seen].sort()
}

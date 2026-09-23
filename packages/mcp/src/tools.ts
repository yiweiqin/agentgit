/**
 * The MCP tools.
 *
 * Two rules shape everything here.
 *
 * **Every tool returns both prose and structure.** The prose is what the model reads
 * and quotes; `structuredContent` is what a host can render without parsing English.
 * They are produced from one pass over one result, so they cannot disagree.
 *
 * **State-changing tools are additive and reversible, and they say so in their
 * descriptions.** The model decides whether to call them, so the description is the
 * contract: a tool that says it may rewrite history will be avoided, and one that
 * hides that it does will be called and then blamed. Nothing here merges, rebases,
 * resets or deletes - {@link PROTECTED_OPERATIONS} lists those, and the reconcile tool
 * returns their commands as text for a human to run.
 *
 * Wording for facts comes from `@agentgit/board`, which the panel and the CLI also use.
 * This module formats *which* facts to show, never how to name them.
 *
 * @module @agentgit/mcp/tools
 */

import {
  acquireLease,
  appendEvent,
  buildBoardView,
  buildEvent,
  checkpointCommit,
  canonicalEntityPath,
  currentBranch,
  currentVersion,
  describeProtected,
  ensureWorktree,
  heldBy,
  integrationOrder,
  isDirty,
  keyOf,
  kindOfVerdict,
  loadAssumptions,
  loadContracts,
  mergeTreePreview,
  preflight,
  preflightAndClaim,
  publishContract,
  readAllEvents,
  recordAssumption,
  registryView,
  releaseLease,
  staleAssumptions,
  symbolKeyOf,
  toWorkspaceRelative,
  worktreeList,
  type PreflightResult,
} from '@agentgit/core'

import {
  defaultPanelDir,
  panelMarkdown,
  truncate,
  until,
  VERDICT_ACTION,
  writePanel,
} from '@agentgit/board'

import { ToolError } from './protocol.ts'
import type { Identity } from './context.ts'

export interface ToolAnnotations {
  readonly readOnlyHint: boolean
  readonly destructiveHint: boolean
  readonly idempotentHint: boolean
  readonly openWorldHint: boolean
}

export interface ToolContext {
  readonly identity: Identity
  readonly now: Date
}

export interface ToolResult {
  readonly text: string
  readonly structured?: unknown
  readonly isError?: boolean
}

export interface ToolDefinition {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations: ToolAnnotations
  readonly handler: (args: Record<string, unknown>, context: ToolContext) => ToolResult | Promise<ToolResult>
}

/* -------------------------------------------------------------------------- */
/* Argument helpers                                                            */
/* -------------------------------------------------------------------------- */

function str(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return null
}

/**
 * An optional string for a result payload, where `undefined` would vanish in
 * serialisation but `null` is an honest "not given".
 */
function nullable(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = args[key]
  return typeof value === 'boolean' ? value : fallback
}

function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return fallback
}

function strArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()]
  return []
}

interface EntityTarget {
  readonly entityKey: string
  readonly entityPath: string | null
  readonly symbol: string | null
}

/**
 * The one place a path or a symbol becomes a ledger key.
 *
 * Both are accepted because they answer different questions - a file is "this ground",
 * a symbol is "this behaviour" - and the caller should not have to know which spelling
 * the ledger uses.
 *
 * The schema documents `path` as workspace-relative, and that is what is honoured: a
 * relative path is resolved against the workspace root, never against the server's own
 * directory. The directory is chosen by the host, so resolving against it would build
 * keys that look right and match nothing - the failure mode that silently reports "no
 * collisions" while an agent edits the same file as someone else.
 */
function targetOf(args: Record<string, unknown>, workspaceRoot: string): EntityTarget {
  const symbol = str(args, 'symbol')
  if (symbol) return { entityKey: symbolKeyOf(symbol), entityPath: null, symbol }

  const path = str(args, 'path') ?? str(args, 'file')
  if (!path) {
    throw new ToolError(
      'This tool needs either `path` or `symbol`.',
      'Use `path` for a file (for example `src/auth.py`) or `symbol` for a name (for example `resolveIdentity`).',
    )
  }

  const relative = canonicalEntityPath(workspaceRoot, path)
  return { entityKey: keyOf(relative), entityPath: relative, symbol: null }
}

/** The intent for a write, drawn from whichever argument the caller supplied. */
function intentOf(args: Record<string, unknown>): string | null {
  return str(args, 'intent') ?? str(args, 'reason') ?? str(args, 'summary') ?? str(args, 'what')
}

/* -------------------------------------------------------------------------- */
/* Read-only tools                                                             */
/* -------------------------------------------------------------------------- */

const whoami: ToolDefinition = {
  name: 'agentgit_whoami',
  title: 'Which workspace and session these calls are attributed to',
  description:
    'Reports the workspace directory, the session id, and the task id that every other tool will use. Call this first ' +
    'when several agents share a workspace, or when the numbers look wrong. Session ids the server could not learn from ' +
    'the host are marked as guesses, and are the reason two agents can appear as one.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (_args, context) => {
    const { identity } = context
    const lines = [
      `workspace : ${identity.paths.root}  (${identity.workspaceSource})`,
      `session   : ${identity.sessionId}  (${identity.sessionSource}${identity.sessionIsGuess ? ', a guess' : ''})`,
      `task      : ${identity.taskId}`,
      '',
      identity.explanation,
    ]
    if (identity.sessionIsGuess) {
      lines.push(
        '',
        'This session id was inferred rather than told to us. If another agent is writing in this',
        'workspace at the same time, pass `session` explicitly on every call, copying it from the',
        'first result you receive.',
      )
    }
    return {
      text: lines.join('\n'),
      structured: {
        workspace: identity.paths.root,
        workspaceSource: identity.workspaceSource,
        sessionId: identity.sessionId,
        sessionSource: identity.sessionSource,
        sessionIsGuess: identity.sessionIsGuess,
        taskId: identity.taskId,
      },
    }
  },
}

const status: ToolDefinition = {
  name: 'agentgit_status',
  title: 'Coordination status for this workspace',
  description:
    'Counts and the coordination-debt score for the workspace: tasks in flight, contested entities, live leases, ' +
    'published interfaces, expired assumptions, and how many ledger lines could not be read. Start here for ' +
    '"what is going on". Safe to call at any time; it writes nothing.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (_args, context) => {
    const view = buildBoardView(context.identity.paths, undefined, context.now)
    const open = view.tasks.filter(
      (task) => task.state === 'proposed' || task.state === 'active' || task.state === 'validated',
    )
    const lines = [
      `coordination debt ${view.debt.score}/100`,
      `${open.length} task(s) in flight, ${view.tasks.length} recorded`,
      `${view.collisions.length} contested entity(ies), ${view.collisions.filter((collision) => collision.live).length} with a live lease`,
      `${view.leases.length} live lease(s), ${view.contracts.length} published interface(s)`,
      `${view.debt.breakdown.staleAssumptions} expired assumption(s), ${view.debt.breakdown.unclaimed} unclaimed write(s)`,
      `${view.diagnostics.events} ledger event(s) in ${view.diagnostics.shards} shard(s)`,
    ]
    if (view.diagnostics.malformedEvents > 0) {
      lines.push(`${view.diagnostics.malformedEvents} ledger line(s) could not be parsed; the rest is unaffected`)
    }
    if (view.debt.drivers.length > 0) lines.push('', `largest contributors: ${view.debt.drivers.join('; ')}`)
    if (open.length === 0) lines.push('', 'Nothing is in flight. Nothing to coordinate.')
    return { text: lines.join('\n'), structured: view }
  },
}

const board: ToolDefinition = {
  name: 'agentgit_board',
  title: 'Every task, collision, lease and interface',
  description:
    'The full coordination board: each task with its state, sessions, intents and held leases; each entity two or more ' +
    'tasks want; every live lease; and every published interface with its current version. Use when you need the ' +
    'detail behind a status count. Writes nothing.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (_args, context) => {
    const view = buildBoardView(context.identity.paths, undefined, context.now)
    return { text: panelMarkdown(view), structured: view }
  },
}

const panel: ToolDefinition = {
  name: 'agentgit_panel',
  title: 'Render the AgenticGit panel',
  description:
    'Writes the panel for this workspace to a file and returns `reference`. Put that value on its own line in your ' +
    'reply, verbatim, where the panel should appear - it is a content reference, not a link, and it will not render ' +
    'if it is edited, wrapped in backticks, or given a different name. Do not describe the file or the mechanism. ' +
    'The panel is a snapshot taken now; for a live view, tell the user to run `agentgit up`.',
  inputSchema: {
    type: 'object',
    properties: {
      out: {
        type: 'string',
        description: 'Directory to write the panel into. Defaults to .agentgit/state/panel in the workspace.',
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (args, context) => {
    const view = buildBoardView(context.identity.paths, undefined, context.now)
    const outDir = str(args, 'out') ?? defaultPanelDir(context.identity.paths.root)
    const artifact = writePanel(view, outDir)

    return {
      text: [
        panelMarkdown(view),
        '',
        'Put the reference below on its own line where the panel belongs. Do not edit it.',
        artifact.reference,
      ].join('\n'),
      structured: artifact,
    }
  },
}

const preflightTool: ToolDefinition = {
  name: 'agentgit_preflight',
  title: 'The verdict for a write you are about to make',
  description:
    'Ask before writing. Give the path or symbol you are about to change and what you intend to do, and get back one ' +
    'of six verdicts: allow, reuse, refresh, replan, wait, or review. Each carries a reason, a `version` and a ' +
    '`ttlSeconds`. Cache on `version`: it changes whenever any input to the verdict changes, so a cached verdict can ' +
    'never be stale. Verdicts are advisory - only `review` is a stop signal, and it never blocks a write by itself. ' +
    'Set `claim` to also take a soft lease on the entity and record the decision in the ledger.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path you are about to write, relative to the workspace.' },
      symbol: { type: 'string', description: 'Name you are about to change, instead of a path.' },
      intent: { type: 'string', description: 'In your own words, what this change is for. This is what duplication is detected against.' },
      contracts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Interface names this change depends on, when you know them.',
      },
      claim: { type: 'boolean', description: 'Also take a lease and record the decision in the ledger.' },
      session: { type: 'string', description: 'Session id, when several agents share this workspace.' },
      task: { type: 'string', description: 'Task id, when you want to continue an earlier task.' },
      workspace: { type: 'string', description: 'Workspace directory, when the default is not the project you mean.' },
    },
    required: [],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  handler: (args, context) => {
    const target = targetOf(args, context.identity.paths.root)
    const identity = context.identity
    const query = {
      taskId: identity.taskId,
      sessionId: identity.sessionId,
      entityKey: target.entityKey,
      entityPath: target.entityPath ?? undefined,
      symbol: target.symbol,
      intentText: intentOf(args),
      contracts: strArray(args, 'contracts'),
    }

    const result = bool(args, 'claim')
      ? preflightAndClaim(identity.paths, query, { symbol: Boolean(target.symbol) })
      : preflight(identity.paths, query)

    return { text: renderPreflightText(result, identity), structured: result }
  },
}

/** The verdict as a model should read it: the word first, then why, then what next. */
function renderPreflightText(result: PreflightResult, identity: Identity): string {
  const lines: string[] = []
  lines.push(`VERDICT: ${result.verdict.toUpperCase()}`)
  lines.push(`what it means: ${VERDICT_ACTION[result.verdict]}`)
  lines.push(`entity: ${result.entityKey}`)
  lines.push(`task: ${result.taskId}   session: ${identity.sessionId}${identity.sessionIsGuess ? ' (inferred)' : ''}`)
  lines.push(`version: ${result.version}   ttlSeconds: ${result.ttlSeconds}`)
  lines.push('')
  lines.push(result.reason)

  if (result.evidence.competitors.length > 0) {
    lines.push('', 'Competing work:')
    for (const record of result.evidence.competitors.slice(0, 5)) {
      lines.push(`  ${record.entityKey} - ${record.tasks.length} task(s), ${record.touches} touch(es)`)
      for (const intent of record.intents.slice(0, 3)) lines.push(`    "${truncate(intent, 130)}"`)
    }
  }
  if (result.evidence.leaseConflicts.length > 0) {
    lines.push('', 'Held by:')
    for (const lease of result.evidence.leaseConflicts) {
      lines.push(`  ${lease.taskId} until ${lease.expiresAt} - ${truncate(lease.reason, 100)}`)
    }
  }
  if (result.evidence.staleAssumptions.length > 0) {
    lines.push('', 'Expired assumptions:')
    for (const stale of result.evidence.staleAssumptions) {
      lines.push(
        `  ${stale.contract}: coded against v${stale.assumedVersion}, current is v${stale.currentVersion}` +
          `${stale.breaking ? ' (breaking)' : ''} - ${truncate(stale.summary, 110)}`,
      )
    }
  }
  if (result.nextActions.length > 0) {
    lines.push('', 'Next:')
    for (const action of result.nextActions) lines.push(`  ${action}`)
  }
  if (kindOfVerdict(result.verdict) !== 'clear') {
    lines.push(
      '',
      'This is advisory. Report it and continue unless the user says otherwise - do not refuse their instruction on the strength of a verdict.',
    )
  }
  return lines.join('\n')
}

const reconcile: ToolDefinition = {
  name: 'agentgit_reconcile',
  title: 'What to integrate, in what order, and what will conflict',
  description:
    'Returns expired assumptions, the order task branches should land in, and a ghost merge of each pair - performed ' +
    'with `git merge-tree`, which writes no branch and touches no working tree. Also returns the exact commands for ' +
    'merging, rebasing or discarding, for the user to run. This tool never runs them.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (_args, context) => {
    const { paths } = context.identity
    const registry = loadContracts(paths)
    const stale = staleAssumptions(loadAssumptions(paths), registry)
    const view = buildBoardView(paths, undefined, context.now)

    const openedAt = new Map(view.tasks.map((task) => [task.taskId, task.openedAt]))
    const branches = worktreeList(paths.root)
      .filter((entry): entry is typeof entry & { branch: string } => Boolean(entry.branch?.startsWith('agentgit/')))
      .map((entry) => ({
        taskId: entry.branch.replace(/^agentgit\//, ''),
        branch: entry.branch,
        openedAt: openedAt.get(entry.branch.replace(/^agentgit\//, '')) ?? new Date(0).toISOString(),
      }))

    const publishedBy = new Map<string, string>()
    for (const name of new Set(registry.contracts.map((contract) => contract.name))) {
      const current = currentVersion(registry, name)
      if (current) publishedBy.set(name, current.publishedBy)
    }

    const order = integrationOrder(
      branches,
      loadAssumptions(paths).assumptions.map((assumption) => ({
        taskId: assumption.taskId,
        contract: assumption.contract,
      })),
      publishedBy,
    )

    const merge: { a: string; b: string; clean: boolean; note: string }[] = []
    for (let i = 0; i < branches.length; i += 1) {
      for (let j = i + 1; j < branches.length; j += 1) {
        const preview = mergeTreePreview(paths.root, branches[i].branch, branches[j].branch)
        merge.push({
          a: branches[i].taskId,
          b: branches[j].taskId,
          clean: preview.clean,
          note: preview.supported
            ? preview.clean
              ? 'no textual conflict'
              : `${preview.conflicts.length} conflicting path(s)`
            : preview.message,
        })
      }
    }

    const commands = order.map((item, index) => ({
      step: index + 1,
      taskId: item.taskId,
      command: describeProtected('merge', [currentBranch(paths.root) ?? '<base branch>', item.branch]).command,
    }))

    const blocked = order.filter((item) => item.blocking).map((item) => item.taskId)
    const structural = {
      stale,
      order,
      merge,
      commands,
      dirty: isDirty(paths.root),
      branch: currentBranch(paths.root),
    }

    const lines: string[] = []
    lines.push(`on branch ${structural.branch ?? '(detached HEAD)'}${structural.dirty ? ', with uncommitted changes' : ''}`)
    if (stale.length > 0) {
      lines.push('', 'Expired assumptions:')
      for (const entry of stale) {
        lines.push(
          `  ${entry.taskId}: ${entry.contract} v${entry.assumedVersion} -> v${entry.currentVersion}` +
            `${entry.breaking ? ' (breaking)' : ''}`,
        )
      }
    }
    if (order.length > 0) {
      lines.push('', `Integration order (${blocked.length} task(s) others depend on):`)
      for (const item of order) lines.push(`  ${item.taskId} (${item.branch}) - ${item.reason}`)
    } else {
      lines.push('', 'No task branch exists yet, so there is nothing to order.')
    }
    if (merge.length > 0) {
      lines.push('', 'Ghost merge:')
      for (const pair of merge) lines.push(`  ${pair.a} + ${pair.b}: ${pair.clean ? 'clean' : 'conflicts'} - ${pair.note}`)
      if (merge.some((pair) => pair.clean)) {
        lines.push(
          '',
          'A clean merge is not a working result. It means no text conflicted; a breaking interface change still merges cleanly and still breaks at run time.',
        )
      }
    }
    if (commands.length > 0) {
      lines.push('', 'These are for the user to run. This tool does not run them:', '')
      for (const item of commands) lines.push(`  # ${item.step}. ${item.taskId}`, `  ${item.command}`)
    }

    return { text: lines.join('\n'), structured: structural }
  },
}

const why: ToolDefinition = {
  name: 'agentgit_why',
  title: 'The events behind one answer',
  description:
    'The ledger history for a path, a symbol, a task id, or a session id, oldest first. Use it when the user asks why ' +
    'the plugin said something, or who touched a file and what they were trying to do. Writes nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'A path, a symbol name, a task id, or a session id.' },
    },
    required: ['target'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (args, context) => {
    const target = str(args, 'target')
    if (!target) throw new ToolError('`target` is required.', 'Pass a path, a symbol, a task id, or a session id.')

    const { events } = readAllEvents(context.identity.paths)
    const asKey = target.includes('::') ? target : keyOf(target)

    const matches = events.filter((event) => {
      if (event.taskId === target || event.sessionId === target) return true
      return (event.entities ?? []).some((entity) => {
        if (entity.kind === 'symbol') return symbolKeyOf(entity.identifier) === asKey
        return keyOf(entity.path ?? entity.identifier) === asKey || entity.identifier === target || entity.path === target
      })
    })

    if (matches.length === 0) {
      return {
        text: `Nothing in the ledger mentions ${target}. That is itself an answer: this verdict came from a lease, an interface version, or the current plan rather than from recorded history.`,
        structured: { target, key: asKey, events: [] },
      }
    }

    const lines = [`${matches.length} event(s) mention ${asKey}`, '']
    for (const event of matches.slice(-40)) {
      lines.push(`${event.timestampUtc}  ${event.kind}  ${event.taskId ?? '(no task)'}  ${event.sessionId}`)
      if (event.reason) lines.push(`    ${truncate(event.reason, 160)}`)
      if (event.intentText) lines.push(`    intent: "${truncate(event.intentText, 150)}"`)
    }
    return { text: lines.join('\n'), structured: { target, key: asKey, events: matches } }
  },
}

const contracts: ToolDefinition = {
  name: 'agentgit_contracts',
  title: 'Published interfaces and their versions',
  description:
    'Every shared interface with its current version, whether the latest change breaks callers, who published it, and ' +
    'where it is declared. Pass `name` for the version history of one interface. Writes nothing.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'One interface name, for its full version history.' } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (args, context) => {
    const registry = loadContracts(context.identity.paths)
    const name = str(args, 'name')

    if (name) {
      const current = currentVersion(registry, name)
      if (!current) {
        return {
          text: `No interface named ${name} has been published. If a change to it is what other tasks depend on, publish it first.`,
          structured: { name, current: null },
        }
      }
      const history = registry.contracts
        .filter((contract) => contract.name === name)
        .sort((a, b) => a.version - b.version)
      const lines = [`${name} v${current.version}${current.breaking ? ' (breaking)' : ' (additive)'}`, current.summary]
      lines.push('', 'History:')
      for (const entry of history) {
        lines.push(`  v${entry.version}  ${entry.publishedAt}  ${entry.publishedBy}${entry.breaking ? '  BREAKING' : ''}`)
        lines.push(`    ${truncate(entry.summary, 150)}`)
      }
      return { text: lines.join('\n'), structured: { name, current, history } }
    }

    const view = registryView(registry)
    if (view.length === 0) {
      return {
        text: 'No shared interface has been published yet. Publish one when a change alters a signature another task relies on; that is what lets the plugin tell that task its assumption expired.',
        structured: { contracts: [] },
      }
    }
    const lines = [`${view.length} published interface(s)`]
    for (const entry of view) {
      lines.push(
        `  ${entry.name}  v${entry.version}${entry.breaking ? '  BREAKING' : ''}  by ${entry.publishedBy}` +
          `  (${entry.versions} version(s))`,
      )
      lines.push(`    ${truncate(entry.summary, 150)}`)
    }
    return { text: lines.join('\n'), structured: { contracts: view } }
  },
}

/* -------------------------------------------------------------------------- */
/* State-changing tools                                                        */
/* -------------------------------------------------------------------------- */

const claim: ToolDefinition = {
  name: 'agentgit_claim',
  title: 'Take or renew a soft lease on an entity',
  description:
    'Declare that you are working on a path or symbol, so other agents can see it. Calling it again renews the lease, ' +
    'which is why a crashed agent cannot wedge anything: the lease simply expires. A conflict is reported rather than ' +
    'refused. Additive and reversible, undo with agentgit_release.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to claim.' },
      symbol: { type: 'string', description: 'Symbol to claim, instead of a path.' },
      reason: { type: 'string', description: 'What you are doing with it. Shown to other agents, so write it for them.' },
      minutes: { type: 'number', description: 'How long the lease lasts without renewal. Defaults to the workspace setting.' },
      steal: { type: 'boolean', description: 'Take over from another task. Recorded, never silent.' },
      session: { type: 'string', description: 'Session id, when several agents share this workspace.' },
      task: { type: 'string', description: 'Task id, when continuing an earlier task.' },
      workspace: { type: 'string', description: 'Workspace directory override.' },
    },
    required: [],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (args, context) => {
    const target = targetOf(args, context.identity.paths.root)
    const identity = context.identity
    const result = acquireLease(identity.paths, {
      entityKey: target.entityKey,
      kind: target.symbol ? 'symbol' : 'file',
      taskId: identity.taskId,
      sessionId: identity.sessionId,
      reason: intentOf(args) ?? 'claimed',
      minutes: num(args, 'minutes', 20),
      steal: bool(args, 'steal'),
    })

    const lines = [
      `${result.granted ? 'granted' : 'not granted'}: ${result.reason}`,
      `entity: ${target.entityKey}`,
      `held by: ${result.lease?.taskId ?? identity.taskId} until ${result.lease?.expiresAt ?? '(unknown)'}`,
    ]
    if (result.conflicts.length > 0) {
      lines.push('', 'Also held by:')
      for (const lease of result.conflicts) {
        lines.push(`  ${lease.taskId} (${lease.sessionId}) until ${until(lease.expiresAt)} - ${truncate(lease.reason, 120)}`)
      }
      lines.push(
        '',
        'A shared entity is not an error. If their work and yours are the same work, stop and reuse theirs; if they differ, agree who owns it before writing.',
      )
    }
    return { text: lines.join('\n'), structured: result }
  },
}

const release: ToolDefinition = {
  name: 'agentgit_release',
  title: 'Give a lease back',
  description:
    'Release the lease this task holds on a path or symbol, or every lease it holds. Use when the work is done, so ' +
    'another agent is not waiting on a lease that will not be renewed.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to release.' },
      symbol: { type: 'string', description: 'Symbol to release, instead of a path.' },
      all: { type: 'boolean', description: 'Release every lease this task holds.' },
      session: { type: 'string', description: 'Session id, when several agents share this workspace.' },
      task: { type: 'string', description: 'Task id, when continuing an earlier task.' },
      workspace: { type: 'string', description: 'Workspace directory override.' },
    },
    required: [],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (args, context) => {
    const identity = context.identity
    const wantAll = bool(args, 'all')
    // Resolved after `all` is known: with `all`, there is no entity to name, and
    // requiring one would make "release everything" impossible to express.
    const entityKey = wantAll ? undefined : targetOf(args, identity.paths.root).entityKey

    const { released } = releaseLease(identity.paths, identity.taskId, entityKey)
    return {
      text:
        released.length === 0
          ? `No lease held by ${identity.taskId}${entityKey ? ` on ${entityKey}` : ''}. Nothing to release.`
          : `Released ${released.length} lease(s): ${released.join(', ')}`,
      structured: { taskId: identity.taskId, released },
    }
  },
}

const publishContractTool: ToolDefinition = {
  name: 'agentgit_publish_contract',
  title: 'Record a new version of a shared interface',
  description:
    'Publish the version of an interface other tasks depend on, so their assumptions can be marked expired. Set ' +
    '`breaking` when existing callers must change. Do this before announcing the change: it is the only mechanism ' +
    'that turns "the signature moved" into a verdict another agent will see. Refuses to reuse or lower a version ' +
    'number, and refuses to write over an unreadable registry.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Interface name, for example `auth.token`.' },
      summary: { type: 'string', description: 'What changed, in one sentence, for the tasks that will read it.' },
      breaking: { type: 'boolean', description: 'True when existing callers must change.' },
      symbol: { type: 'string', description: 'The symbol this interface names, when it maps to one.' },
      declaredIn: { type: 'string', description: 'Where the interface is declared, so readers can find it.' },
      version: { type: 'number', description: 'Explicit version. Omit to increment from the current one.' },
      consumers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tasks known to depend on it, beyond those that recorded an assumption.',
      },
      session: { type: 'string', description: 'Session id, when several agents share this workspace.' },
      task: { type: 'string', description: 'Task id, when continuing an earlier task.' },
      workspace: { type: 'string', description: 'Workspace directory override.' },
    },
    required: ['name', 'summary'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  handler: (args, context) => {
    const name = str(args, 'name')
    const summary = str(args, 'summary') ?? str(args, 'intent')
    if (!name) throw new ToolError('`name` is required.', 'Use the interface name other tasks refer to, for example `auth.token`.')
    if (!summary) {
      throw new ToolError(
        '`summary` is required.',
        'One sentence, written for the tasks that will read it and have to decide whether their code still works.',
      )
    }

    const identity = context.identity
    const version = args.version === undefined ? undefined : num(args, 'version', 0)
    const result = publishContract(identity.paths, {
      name,
      summary,
      breaking: bool(args, 'breaking'),
      symbol: str(args, 'symbol'),
      declaredIn: str(args, 'declaredIn'),
      publishedBy: identity.taskId,
      consumers: strArray(args, 'consumers'),
      version,
    })

    appendEvent(identity.paths, buildEvent({
      kind: 'decision',
      timestampUtc: context.now.toISOString(),
      sessionId: identity.sessionId,
      taskId: identity.taskId,
      intentText: summary,
      hostEvent: 'mcp',
      reason: `published ${name} v${result.contract.version}${result.contract.breaking ? ' (breaking)' : ''}`,
      detail: { contract: name, version: result.contract.version, breaking: result.contract.breaking },
    }))

    const lines = [
      `${name} v${result.contract.version}${result.contract.breaking ? ' published as BREAKING' : ' published as additive'}`,
      `by task ${result.contract.publishedBy}`,
    ]
    if (result.previous) lines.push(`replaces v${result.previous.version}`)
    if (result.newlyStale.length > 0) {
      lines.push('', `${result.newlyStale.length} task(s) are now coded against an older version:`)
      for (const entry of result.newlyStale) {
        lines.push(`  ${entry.taskId} holds v${entry.assumedVersion}`)
      }
      lines.push('', 'Their next preflight on the affected paths will return refresh or review.')
    } else {
      lines.push('', 'No task has a recorded assumption on this interface, so nothing became stale. Tasks that declare one later will read the new version.')
    }

    return { text: lines.join('\n'), structured: result }
  },
}

const assume: ToolDefinition = {
  name: 'agentgit_assume',
  title: 'Record which interface version this task is coded against',
  description:
    'Declare that this task relies on a specific version of an interface. Recording it is the only way the plugin can ' +
    'later tell you that interface moved - without a recorded assumption there is nothing to compare, and the task ' +
    'will look fresh forever. Additive and reversible; re-recording replaces the previous belief.',
  inputSchema: {
    type: 'object',
    properties: {
      contract: { type: 'string', description: 'Interface name.' },
      version: { type: 'number', description: 'Version this task is coded against. Defaults to the current published one.' },
      path: { type: 'string', description: 'The file where this task depends on it.' },
      session: { type: 'string', description: 'Session id, when several agents share this workspace.' },
      task: { type: 'string', description: 'Task id, when continuing an earlier task.' },
      workspace: { type: 'string', description: 'Workspace directory override.' },
    },
    required: ['contract'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  handler: (args, context) => {
    const contract = str(args, 'contract')
    if (!contract) throw new ToolError('`contract` is required.', 'Pass the interface name you depend on.')

    const identity = context.identity
    const registry = loadContracts(identity.paths)
    const current = currentVersion(registry, contract)
    const version = args.version === undefined ? current?.version ?? 0 : num(args, 'version', 0)

    if (version === 0) {
      throw new ToolError(
        `${contract} has never been published, so there is no version to be coded against.`,
        `Publish it first with agentgit_publish_contract, then record the assumption. Otherwise nothing can ever become stale.`,
      )
    }

    recordAssumption(identity.paths, {
      taskId: identity.taskId,
      sessionId: identity.sessionId,
      contract,
      version,
      recordedAt: context.now.toISOString(),
      source: 'declared',
      path: str(args, 'path'),
    })

    const drift = current && current.version > version ? current : null

    return {
      text: [
        `${identity.taskId} is recorded against ${contract} v${version}.`,
        drift
          ? `This is already behind: the current published version is v${drift.version}${drift.breaking ? ' (breaking)' : ''}. Re-read the interface before writing.`
          : 'You will be told if it moves.',
      ].join('\n'),
      structured: { taskId: identity.taskId, contract, version, current: current?.version ?? null, behind: Boolean(drift) },
    }
  },
}

const task: ToolDefinition = {
  name: 'agentgit_task',
  title: 'Start a task, checkpoint it, or finish it',
  description:
    'start: create a worktree and a task branch so this work cannot collide with another agent mid-edit. ' +
    'checkpoint: commit only the paths this task touched, leaving every other agent\'s in-progress edit alone. ' +
    'finish: release leases and report the commands to integrate. ' +
    'integrate: say that the merge actually happened, which is what stops other tasks waiting on this one. ' +
    'Merging is not among these actions and never will be - the commands are returned for the user to run.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'checkpoint', 'finish', 'integrate'], description: 'What to do.' },
      intent: { type: 'string', description: 'For `start`: what this task is for.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'For `start`: files this task will touch.' },
      message: { type: 'string', description: 'For `checkpoint`: the commit message.' },
      revision: { type: 'string', description: 'For `integrate`: the commit the merge produced, if known.' },
      worktree: { type: 'boolean', description: 'For `start`: create a worktree. Defaults to true.' },
      session: { type: 'string', description: 'Session id, when several agents share this workspace.' },
      task: { type: 'string', description: 'Task id, when continuing an earlier task.' },
      workspace: { type: 'string', description: 'Workspace directory override.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  handler: (args, context) => {
    const action = str(args, 'action')
    const identity = context.identity
    const paths = identity.paths
    const root = paths.root

    if (action === 'start') {
      const declared = strArray(args, 'paths').map((path) => toWorkspaceRelative(root, path) ?? path)
      let worktree: string | null = null
      let branch: string | null = null
      let note = 'no worktree requested'
      if (bool(args, 'worktree', true)) {
        try {
          const ensured = ensureWorktree(root, identity.taskId)
          worktree = ensured.path
          branch = ensured.branch
          note = ensured.message
        } catch (error) {
          note = `no worktree: ${(error as Error).message}`
        }
      }

      appendEvent(paths, buildEvent({
        kind: 'task_registered',
        timestampUtc: context.now.toISOString(),
        sessionId: identity.sessionId,
        taskId: identity.taskId,
        entities: declared.map((path) => ({ kind: 'file', identifier: path, path })),
        intentText: intentOf(args),
        hostEvent: 'mcp',
        reason: note,
        detail: { worktree, branch },
      }))

      return {
        text: [
          `task ${identity.taskId} started`,
          `branch: ${branch ?? '(none)'}`,
          `worktree: ${worktree ?? '(none)'}`,
          note,
          '',
          'Record the interfaces this task relies on with agentgit_assume, so the plugin can tell you if they move.',
        ].join('\n'),
        structured: { taskId: identity.taskId, branch, worktree, note, declared },
      }
    }

    if (action === 'checkpoint') {
      const files = writtenPathsOf(paths, identity.taskId)
      if (files.length === 0) {
        return {
          text: `Nothing to checkpoint for ${identity.taskId}: the ledger records no file write by this task yet.`,
          isError: false,
        }
      }
      const result = checkpointCommit(root, files, str(args, 'message') ?? `checkpoint: ${identity.taskId}`)
      return {
        text: `${result.message}${result.committed ? '' : ` (${result.files.length} file(s) in scope)`}\n${result.files.map((file) => `  ${file}`).join('\n')}`,
        structured: result,
        isError: !result.committed,
      }
    }

    if (action === 'finish') {
      const held = heldBy(paths, identity.taskId)
      const { released } = releaseLease(paths, identity.taskId)
      appendEvent(paths, buildEvent({
        kind: 'lifecycle_validated',
        timestampUtc: context.now.toISOString(),
        sessionId: identity.sessionId,
        taskId: identity.taskId,
        hostEvent: 'mcp',
        reason: `released ${released.length} lease(s)`,
      }))

      const ordered = integrationOrder(
        worktreeList(root)
          .filter((entry): entry is typeof entry & { branch: string } => Boolean(entry.branch?.startsWith('agentgit/')))
          .map((entry) => ({
            taskId: entry.branch.replace(/^agentgit\//, ''),
            branch: entry.branch,
            openedAt: new Date(0).toISOString(),
          })),
        [],
        new Map(),
      )

      const lines = [
        `${identity.taskId} finished. Released ${released.length} lease(s)${held.length > 0 ? ` (${held.map((lease) => lease.entityKey).join(', ')})` : ''}.`,
        '',
        'This is what remains, and it is yours to run:',
        `  git checkout <base branch>`,
        `  git merge agentgit/${identity.taskId}`,
        `  git worktree remove .agentgit/worktrees/${identity.taskId}`,
      ]
      if (ordered.length > 1) {
        lines.push('', 'Other task branches exist. Run agentgit_reconcile before merging, so you land them in dependency order.')
      }
      lines.push(
        '',
        'This tool does not run merges.',
        `Once the merge is really in, call agentgit_task with action "integrate" for ${identity.taskId}. Until you do, ` +
          'anyone coded against a breaking change this task published keeps getting "wait" instead of "review", ' +
          'because the ledger still believes the interface is being landed.',
      )
      return { text: lines.join('\n'), structured: { taskId: identity.taskId, released, order: ordered } }
    }

    if (action === 'integrate') {
      // The only way a capsule closes. Without this, `wait` is permanent: a publisher
      // that merged by hand looks identical to one still typing, and every consumer of
      // its interface is told to hold off forever.
      const already = readAllEvents(paths).events.some(
        (event) => event.kind === 'lifecycle_integrated' && event.taskId === identity.taskId,
      )
      if (already) {
        return {
          text: `${identity.taskId} was already marked integrated. Nothing to do.`,
          structured: { taskId: identity.taskId, marked: false, alreadyIntegrated: true },
        }
      }

      const { released } = releaseLease(paths, identity.taskId)
      appendEvent(paths, buildEvent({
        kind: 'lifecycle_integrated',
        timestampUtc: context.now.toISOString(),
        sessionId: identity.sessionId,
        taskId: identity.taskId,
        hostEvent: 'mcp',
        reason: `integrated${typeof args.revision === 'string' ? ` as ${args.revision}` : ''}`,
        detail: { revision: nullable(args.revision) },
      }))

      return {
        text: [
          `${identity.taskId} is recorded as integrated${typeof args.revision === 'string' ? ` at ${args.revision}` : ''}.`,
          released.length > 0 ? `Released ${released.length} leftover lease(s).` : '',
          '',
          'Tasks waiting on a breaking change this one published will now get "review" - a stable version to replan ' +
            'against - instead of "wait".',
        ].filter((line) => line !== '').join('\n'),
        structured: { taskId: identity.taskId, marked: true, released, revision: nullable(args.revision) },
      }
    }

    throw new ToolError(
      `Unknown action '${action ?? ''}'.`,
      'Use one of: start, checkpoint, finish, integrate.',
    )
  },
}

/** Every workspace-relative path this task has written, per the ledger. */
function writtenPathsOf(paths: Identity['paths'], taskId: string): string[] {
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

/* -------------------------------------------------------------------------- */

/**
 * Tool order matters a little: read-only tools first, so a model scanning the list
 * sees the cheap ones before the ones that change state.
 */
export const TOOLS: readonly ToolDefinition[] = [
  whoami,
  status,
  board,
  panel,
  preflightTool,
  reconcile,
  why,
  contracts,
  claim,
  release,
  publishContractTool,
  assume,
  task,
]

export function findTool(name: string): ToolDefinition | null {
  return TOOLS.find((tool) => tool.name === name) ?? null
}

/** Descriptions for `tools/list`, in the shape MCP expects. */
export function toolDescriptors(): Array<Record<string, unknown>> {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }))
}

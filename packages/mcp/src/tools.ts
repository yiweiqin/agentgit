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
  buildBrief,
  buildEvent,
  buildGraphView,
  canonicalEntityPath,
  checkpointCommit,
  contentionSignature,
  currentBranch,
  currentVersion,
  DESKTOP_OFFER_COOLDOWN_MS,
  describeProtected,
  desktopStatePath,
  desktopTaskTitle,
  ensureWorktree,
  explainCommit,
  heldBy,
  HUB_RESOLVE_HOST_EVENT,
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
  readDesktopState,
  readHubMarker,
  readHubVerdict,
  recordAssumption,
  registryView,
  releaseLease,
  staleAssumptions,
  symbolKeyOf,
  toWorkspaceRelative,
  VERDICT_SEVERITY,
  worktreeList,
  writeDesktopState,
  type DesktopStatePatch,
  type HubRuling,
  type HubHolder,
  type HubVerdict,
  type PreflightResult,
} from '@agentgit/core'

import {
  defaultPanelDir,
  explanationMarkdown,
  graphMarkdown,
  panelMarkdown,
  truncate,
  until,
  VERDICT_ACTION,
  writePanel,
} from '@agentgit/board'

import { APP_RESOURCE_URI } from '@agentgit/app'

import { ToolError } from './protocol.ts'
import type { Identity } from './context.ts'
import { IMPACT_TOOLS } from './impact.ts'

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
  /**
   * MCP `_meta` for the tool descriptor.
   *
   * Carries `ui.resourceUri` for the tools whose result is rendered as an MCP App. It lives
   * on the tool rather than on the result because that is what lets a host preload the panel
   * before the tool is even called, and because `_meta.ui.visibility` is how this server
   * decides which tools the UI may call directly.
   */
  readonly meta?: Record<string, unknown>
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
  const rawPath = str(args, 'path') ?? str(args, 'file')

  if (symbol && !rawPath) return { entityKey: symbolKeyOf(symbol), entityPath: null, symbol }
  if (!rawPath) {
    throw new ToolError(
      'This tool needs either `path` or `symbol`.',
      'Use `path` for a file (for example `src/auth.py`) or `symbol` for a name (for example `resolveIdentity`).',
    )
  }

  const relative = canonicalEntityPath(workspaceRoot, rawPath)
  // A caller who names both gets the finer key, and the file is kept rather than dropped.
  // Dropping it would be the bug this pairing exists to prevent: the symbol-level claim and
  // the path-level claim from the other agent would then sit on keys that never compare
  // equal, so the more precise answer would be the less useful one.
  if (symbol) return { entityKey: symbolKeyOf(symbol), entityPath: relative, symbol }
  return { entityKey: keyOf(relative), entityPath: relative, symbol: null }
}

/** The intent for a write, drawn from whichever argument the caller supplied. */
function intentOf(args: Record<string, unknown>): string | null {
  return str(args, 'intent') ?? str(args, 'reason') ?? str(args, 'summary') ?? str(args, 'what')
}

/* -------------------------------------------------------------------------- */
/* The hub's unified ruling                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The hub's current ruling, read from its projection.
 *
 * Read, never recomputed. Recomputing here would make one tool call's cost grow with the
 * ledger, and would also risk this window answering from a subtly different state than the
 * window next to it — which is the one thing the hub exists to prevent. The projection is
 * written by the daemon and is the same bytes for every reader.
 */
function hubOf(context: ToolContext): HubVerdict | null {
  return readHubVerdict(context.identity.paths)
}

/** The hub's ruling for one exact entity key, when it is among the ruled set. */
function hubRulingFor(verdict: HubVerdict, entityKey: string): HubRuling | null {
  return verdict.rulings.find((ruling) => ruling.entityKey === entityKey) ?? null
}

/** Ground somebody is holding right now, when they are holding this entity. */
function hubHolderFor(verdict: HubVerdict, entityKey: string): HubHolder | null {
  return verdict.holders.find((holder) => holder.entityKey === entityKey) ?? null
}

/**
 * What the hub concluded about this entity, in one line.
 *
 * Always rendered next to a verdict, because the two answer different questions: `preflight`
 * answers "what does *this* proposal meet", and the hub answers "what has every window already
 * agreed about this ground". A window that saw only the first could believe it was the first to
 * ask. A reservation is reported too, and it is the more urgent of the two — a ruling can only
 * exist once two tasks collided, while a reservation is ground somebody is on *now*.
 */
function hubRulingLine(verdict: HubVerdict, entityKey: string): string {
  const ruling = hubRulingFor(verdict, entityKey)
  if (ruling) {
    const owner = ruling.owner.taskId
      ? `owner ${ruling.owner.taskId} (${ruling.owner.basis})`
      : 'no owner recommended'
    return `${entityKey}: ${ruling.word.toUpperCase()} (${ruling.basis}); ${owner}`
  }
  const holder = hubHolderFor(verdict, entityKey)
  if (holder) {
    return `${entityKey}: reserved by ${holder.taskId} until ${holder.expiresAt} — coordinate before writing`
  }
  return `the hub has not ruled on ${entityKey} yet`
}

/** The unified ruling, appended to a tool result. Deliberately the same text the hook injects. */
function hubSuffix(hub: HubVerdict, entityKey: string): string {
  return [
    '',
    '── hub ruling (one conclusion, shared by every window) ──',
    hubRulingLine(hub, entityKey),
    '',
    hub.advisory,
  ].join('\n')
}

/** The hub facts that belong in a tool's structured payload: bounded, never the whole advisory. */
function hubStructure(hub: HubVerdict, entityKey: string) {
  return {
    id: hub.id,
    generatedAt: hub.generatedAt,
    authority: hub.authority,
    metrics: hub.metrics,
    ruling: hubRulingFor(hub, entityKey),
    holder: hubHolderFor(hub, entityKey),
  }
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
        'This session id was neither passed in nor read from the host, so it came from this',
        'workspace rather than from the session itself. Two windows resolve to two different ids',
        'on their own; if the numbers still look wrong, run `agentgit doctor` to see which',
        'sessions this workspace recorded, and pass `session` explicitly only if that shows the',
        'wrong one.',
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
    const parallelism = view.report.parallelism
    const lines = [
      `coordination debt ${view.debt.score}/100`,
      `${open.length} task(s) in flight, ${view.tasks.length} recorded`,
      `${view.collisions.length} contested entity(ies), ${view.collisions.filter((collision) => collision.live).length} with a live lease`,
      `${view.leases.length} live lease(s), ${view.contracts.length} published interface(s)`,
      `${view.debt.breakdown.staleAssumptions} expired assumption(s), ${view.debt.breakdown.unclaimed} unclaimed write(s)`,
      // Reported next to the collision count because it is what that count has to be read
      // against: fewer collisions bought by less parallelism is throttling, not coordination.
      `effective parallelism P ${parallelism.mean.toFixed(2)} mean, ${parallelism.peak} peak` +
        `${
          parallelism.observedHours > 0
            ? `, ${Math.round(parallelism.parallelFraction * 100)}% of the window with 2+ in flight`
            : ''
        }`,
      `${view.diagnostics.events} ledger event(s) in ${view.diagnostics.shards} shard(s)`,
    ]
    const verdicts = view.report.verdicts
    if (Object.keys(verdicts).length > 0) {
      // Most severe first, so a cost is read before a pass — the same order the CLI uses.
      const ordered = [
        ...VERDICT_SEVERITY.filter((word) => verdicts[word] !== undefined),
        ...Object.keys(verdicts)
          .filter((word) => !(VERDICT_SEVERITY as readonly string[]).includes(word))
          .sort(),
      ]
      lines.push(`preflight verdicts: ${ordered.map((word) => `${word} ${verdicts[word]}`).join(', ')}`)
    }
    if (view.diagnostics.malformedEvents > 0) {
      lines.push(`${view.diagnostics.malformedEvents} ledger line(s) could not be parsed; the rest is unaffected`)
    }
    if (view.debt.drivers.length > 0) lines.push('', `largest contributors: ${view.debt.drivers.join('; ')}`)
    if (open.length === 0) lines.push('', 'Nothing is in flight. Nothing to coordinate.')

    /*
     * The hub's ruling, with its cost next to it.
     *
     * `parallelismMean` is restated from the hub's own metrics rather than taken from the
     * board here, because the two can be derived from different moments and a ruling count
     * read against the wrong denominator is worse than no denominator at all.
     */
    const hub = hubOf(context)
    if (hub) {
      lines.push(
        '',
        `hub ruling ${hub.id}`,
        `  ${hub.metrics.rulings} contention(s), ${hub.metrics.ambiguous} undecided, ` +
          `${hub.metrics.owned} with a recommended owner, ${hub.metrics.holders} reserved`,
        `  effective parallelism P ${hub.metrics.parallelismMean.toFixed(2)} ` +
          `(reported with the rulings, because a quiet workspace bought by throttling is not coordination)`,
        `  ruling lag ${hub.metrics.inputLagMinutes}m behind the newest ledger fact ` +
          `(a ruling is never fresher than the last thing that happened)`,
        `  longest-standing owner recommendation ${hub.metrics.longestOwnershipMinutes}m; ` +
          `${hub.metrics.waitingTasks} task(s) waiting on ground someone else holds`,
        `  ${hub.metrics.published} ruling(s) published to the ledger; authority ${hub.authority} ` +
          '(it reports one conclusion and never blocks a write)',
      )
    } else {
      lines.push('', 'hub: no ruling yet. A daemon starts with each session; if none is running, `agentgit hub --refresh` publishes once from here, or `agentgit up` starts the board.')
    }
    return { text: lines.join('\n'), structured: { ...view, hub } }
  },
}

/*
 * The desktop task's bookkeeping.
 *
 * It sits here, next to `status`, rather than in the block of state-changing tools below, and the
 * distinction is worth stating: this tool creates nothing, starts nothing and changes nothing about
 * the workspace. What it writes is one small file saying whether this workspace has already been
 * offered a pinned coordination task, and what the heartbeat covering it has already reported.
 *
 * It exists because the offer is made by a hook but answered in a conversation. The hook can notice
 * that a workspace has opted into coordination, but only the conversation can create a task, and
 * only after the user agrees - the host's own rules make `create_thread` a user-initiated tool. So
 * the two halves need somewhere to agree, and that is this file.
 */
const desktop: ToolDefinition = {
  name: 'agentgit_desktop',
  title: 'Record the workspace coordination task, or report it',
  description:
    'Keeps the note that ties this workspace to its pinned coordination task: the task id, the heartbeat automation that ' +
    'watches it, the conversation pinned to the top of the workspace by `/agentgit`, whether the workspace was enabled, ' +
    'and the last ruling that task has already reported. Call it with no arguments to see whether this workspace has ' +
    'one. Call it with `threadId` once a task has been created for this workspace, with `decision: "declined"` when the ' +
    'user has said no, with `pinnedThreadId` after `/agentgit` pinned a conversation, with `enabled: true` when the ' +
    'workspace was switched on, or with `lastRulingId` after a heartbeat run has reported (or looked at) a ruling. It ' +
    'only writes this note down: it never creates a task, never posts anything, and never blocks a write. Recording a ' +
    '`threadId`, a `pinnedThreadId` or a `declinedAt` is what stops the corresponding offer being repeated, so it is ' +
    'the last step of setting one up rather than an optional one.',
  inputSchema: {
    type: 'object',
    properties: {
      threadId: {
        type: 'string',
        description: 'The task created for this workspace, so it is never offered again.',
      },
      automationId: {
        type: 'string',
        description: 'The heartbeat automation that keeps that task reporting, if one was created.',
      },
      decision: {
        type: 'string',
        enum: ['declined'],
        description: 'The user was asked and said no. Recorded, so the question is not asked again.',
      },
      lastRulingId: {
        type: 'string',
        description: 'The hub ruling a heartbeat run has just reported, so the same one is not reported twice.',
      },
      lastReportedAt: {
        type: 'string',
        description: 'ISO instant of that run. Recorded even when the run had nothing to say, so a quiet task can be told from a broken one.',
      },
      pinnedThreadId: {
        type: 'string',
        description:
          'A conversation that `/agentgit` pinned to the top of this workspace. Recorded per conversation, so a second one can be pinned and a repeat of the same one is a no-op.',
      },
      enabled: {
        type: 'boolean',
        description:
          'Record that this workspace was enabled. The first instant is kept, so the field answers "since when" and a second call does not move it.',
      },
      workspace: { type: 'string', description: 'Workspace directory override.' },
      session: { type: 'string', description: 'Session id, when several agents share this workspace.' },
      task: { type: 'string', description: 'Task id, when continuing an earlier task.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (args, context) => {
    const { identity } = context
    const paths = identity.paths

    const decision = str(args, 'decision')
    if (decision !== null && decision !== 'declined') {
      throw new ToolError(
        `\`decision\` is only for a refusal, and must be "declined", not ${JSON.stringify(decision)}.`,
        'To record a task that was created, pass `threadId` instead. There is no way to record an acceptance without one, because a task the user never got is not a task.',
      )
    }

    const threadId = str(args, 'threadId')
    const automationId = str(args, 'automationId')
    const lastRulingId = str(args, 'lastRulingId')
    const lastReportedAt = str(args, 'lastReportedAt')
    const pinnedThreadId = str(args, 'pinnedThreadId')
    const enabled = bool(args, 'enabled')
    const before = readDesktopState(paths)

    // Only write when there is something to write. A bare call is a question, and answering it must
    // not create the very record that suppresses the offer.
    const patch: DesktopStatePatch = {}
    if (threadId !== null) patch.threadId = threadId
    if (automationId !== null) patch.automationId = automationId
    if (lastRulingId !== null) patch.lastRulingId = lastRulingId
    if (lastReportedAt !== null) patch.lastReportedAt = lastReportedAt
    if (decision === 'declined') patch.declinedAt = context.now.toISOString()
    if (pinnedThreadId !== null) {
      // Merged rather than replaced: a workspace has many conversations, and pinning a second one
      // must not unpin the first.
      patch.pinnedThreads = { ...(before?.pinnedThreads ?? {}), [pinnedThreadId]: context.now.toISOString() }
    }
    // The field answers "since when", so an instant already recorded is kept rather than moved.
    if (enabled && !before?.enabledAt) patch.enabledAt = context.now.toISOString()

    const state = Object.keys(patch).length > 0 ? writeDesktopState(paths, patch) : before

    const lines = [`coordination task for "${desktopTaskTitle(paths.root)}"`]
    lines.push(`  state  : ${desktopStatePath(paths)}`)
    if (!state) {
      lines.push('', 'This workspace has no record yet, so it will be offered one at the next session start.')
    } else {
      lines.push(`  task   : ${state.threadId ?? '(none)'}`)
      lines.push(`  watcher: ${state.automationId ?? '(none)'}`)
      lines.push(`  asked  : ${state.offeredAt ?? '(never)'}${state.declinedAt ? `, declined ${state.declinedAt}` : ''}`)
      lines.push(
        `  last   : ${state.lastRulingId ?? '(no ruling reported yet)'}` +
          `${state.lastReportedAt ? `, looked at ${state.lastReportedAt}` : ''}`,
      )
      const pinned = Object.keys(state.pinnedThreads)
      lines.push(`  pinned : ${pinned.length > 0 ? pinned.join(', ') : '(no conversation pinned yet)'}`)
      lines.push(`  enabled: ${state.enabledAt ?? '(not enabled through /agentgit yet)'}`)
      lines.push('')
      if (state.threadId) {
        lines.push('A task is recorded, so this workspace will not be offered another one.')
      } else if (state.declinedAt) {
        lines.push('A refusal is recorded, so the offer will not be made again. `agentgit desktop --reset` clears it.')
      } else {
        const remaining = state.offeredAt
          ? Date.parse(state.offeredAt) + DESKTOP_OFFER_COOLDOWN_MS - context.now.getTime()
          : 0
        lines.push(
          remaining > 0
            ? `An offer has been made and not answered; it is not repeated for another ${Math.ceil(remaining / 60_000)} minute(s).`
            : 'An offer is due at the next session start.',
        )
      }
    }
    if (Object.keys(patch).length > 0) lines.push('', `recorded: ${Object.keys(patch).join(', ')}`)
    return { text: lines.join('\n'), structured: { desktop: state, changed: Object.keys(patch) } }
  },
}

const briefTool: ToolDefinition = {
  name: 'agentgit_brief',
  title: 'What is in flight, for a session that just lost its context',
  description:
    'A short brief on the coordination facts this session may no longer be holding: the entities more than one task or ' +
    'session is changing, any interface it is coded against that has since moved, and what the hub has ruled since ' +
    'this window was last shown a ruling. Call it after a context compaction, or whenever the conversation is ' +
    'suspected of having dropped something that only ever lived in the conversation. Returns a line saying there is ' +
    'nothing to re-state when that is the case, so calling it is cheap. Writes nothing.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (_args, context) => {
    const { identity } = context
    const brief = buildBrief(identity.paths, identity.sessionId, context.now)
    const hub = hubOf(context)

    const parts: string[] = []
    if (brief.text) parts.push(brief.text)

    let hubChanged: boolean | null = null
    if (hub) {
      /*
       * The delta is measured against what this window has *already been shown*, tracked by the
       * same marker the hook writes. That is a better question than "since you last called this
       * tool": a window that was pushed the ruling on its last write already has it, and
       * repeating it would spend the tokens this tool exists to save.
       */
      const marker = readHubMarker(identity.paths, identity.sessionId)
      hubChanged = marker?.rulingId !== hub.id
      parts.push(
        hubChanged
          ? `Hub ruling changed since this window was last shown one ` +
            `(${marker?.rulingId ?? 'nothing shown yet'} -> ${hub.id}).\n\n${hub.advisory}`
          : `Hub ruling unchanged since this window was last shown it (${hub.id}).`,
      )
    }

    const fallback =
      'Nothing to re-state: no other task or session is on a recorded entity, and no interface has moved.'
    return {
      text: parts.length === 0 ? fallback : parts.join('\n\n'),
      structured: { ...brief, hub, hubChanged },
    }
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
    'Give both `path` and `symbol` when you know them: a claim about a function and a claim about the file it lives ' +
    'in are then recognised as being about the same thing, which naming only one of them cannot achieve. Every ' +
    'verdict except `allow` also carries `replan` - the competing intents in full, the order the entity was touched ' +
    'in, and the interfaces involved - so you can change your plan without asking again. ' +
    'Set `claim` to also take a soft lease on the entity and record the decision in the ledger.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path you are about to write, relative to the workspace. Give `symbol` as well when you know it.' },
      symbol: { type: 'string', description: 'Name you are about to change. Combine with `path` to say which file it lives in.' },
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

    /*
     * The unified ruling rides along with every verdict.
     *
     * This is the degradation path that needs no host cooperation at all: whatever else is
     * true of the environment, a window that asks before writing is handed the conclusion
     * every other window is working from. It is read, not recomputed, so it costs one small
     * file read rather than a pass over the ledger.
     */
    const hub = hubOf(context)
    const text = hub ? `${renderPreflightText(result, identity)}\n${hubSuffix(hub, result.entityKey)}` : renderPreflightText(result, identity)

    return {
      text,
      structured: hub ? { ...result, hub: hubStructure(hub, result.entityKey) } : result,
    }
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
  /*
   * The replan material is rendered in full, unlike the summary above it.
   *
   * A truncated quote is enough to recognise the collision and not enough to do anything
   * about it, and the whole point of these three blocks is that the caller can change its
   * plan without asking again.
   */
  if (result.replan) {
    if (result.replan.competingIntents.length > 0) {
      lines.push('', 'What the competing work is for, in full:')
      for (const entry of result.replan.competingIntents.slice(0, 5)) {
        lines.push(`  [${entry.taskId}] ${entry.intent}`)
      }
    }
    if (result.replan.recentTouches.length > 0) {
      lines.push('', 'Recent touches on this entity, oldest first:')
      for (const touch of result.replan.recentTouches) {
        lines.push(
          `  ${touch.timestampUtc}  ${touch.kind}  ${touch.taskId ?? '(no task)'}  ${touch.sessionId}` +
            `${touch.intentText ? `  "${truncate(touch.intentText, 90)}"` : ''}`,
        )
      }
    }
    if (result.replan.contracts.length > 0) {
      lines.push('', 'Interfaces involved:')
      for (const contract of result.replan.contracts) {
        lines.push(`  ${contract.name} v${contract.version}${contract.breaking ? ' (breaking)' : ''}`)
      }
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

/**
 * The brain's one write.
 *
 * Reached only for a ruling the hub could not decide: two intents are on one entity and the
 * recorded wording cannot say whether they are one job. Any window may answer, and answering
 * is a normal ledger append — no new protocol, no long-lived process, and the answer survives
 * a restart because it is in the ledger rather than in whichever conversation produced it.
 *
 * The earliest answer for a given contention stands. That is what stops two windows from
 * each getting their own conclusion: a later answer is recorded and ignored, so the hub still
 * publishes exactly one ruling.
 */
const hubResolve: ToolDefinition = {
  name: 'agentgit_hub_resolve',
  title: 'Answer an undecided hub ruling, once',
  description:
    'Answer a hub ruling whose recorded evidence could not decide it. Use it when a tool result or an injected note ' +
    'says an entity is AMBIGUOUS and names this tool. Give `decision` as `reuse` (the two changes are one job, so ' +
    'extend the existing one) or `replan` (they are different work on shared ground, so scope yours away or agree an ' +
    'order), and say why in `reason`. The answer is appended to the ledger, so it holds across sessions and survives ' +
    'a restart. The earliest answer for a contention is the conclusion; a later one is recorded and ignored rather ' +
    'than replacing it. Does not block anything and does not take a lease.',
  inputSchema: {
    type: 'object',
    properties: {
      entityKey: {
        type: 'string',
        description: 'The entity key the ruling named, for example `file::src/limiter.ts` or `symbol::throttle`.',
      },
      path: { type: 'string', description: 'A path, instead of `entityKey`. Resolved the same way a claim is.' },
      symbol: { type: 'string', description: 'A symbol, instead of `entityKey`.' },
      decision: { type: 'string', enum: ['reuse', 'replan'], description: 'Which way the ambiguity resolves.' },
      reason: { type: 'string', description: 'One sentence a later reader can act on. Recorded as the ledger reason.' },
      session: { type: 'string', description: 'Session id, when several agents share this workspace.' },
      task: { type: 'string', description: 'Task id, when continuing an earlier task.' },
      workspace: { type: 'string', description: 'Workspace directory override.' },
    },
    required: ['decision'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  handler: (args, context) => {
    const { identity } = context
    const decision = str(args, 'decision')
    if (decision !== 'reuse' && decision !== 'replan') {
      throw new ToolError(
        `\`decision\` must be "reuse" or "replan", not ${JSON.stringify(decision ?? null)}.`,
        '`reuse` means the two changes are one job; `replan` means they are different work on shared ground.',
      )
    }

    const hub = hubOf(context)
    if (!hub) {
      throw new ToolError(
        'The hub has not published a ruling for this workspace, so there is nothing to answer.',
        'A daemon starts with each session and publishes rulings; if none has run yet, `agentgit up` starts one. Without a published ruling there is no agreed set of entities to resolve.',
      )
    }

    const explicit = str(args, 'entityKey')
    const entityKey = explicit ?? targetOf(args, identity.paths.root).entityKey
    const ruling = hubRulingFor(hub, entityKey)

    if (!ruling) {
      throw new ToolError(
        `${entityKey} is not in the hub's current ruling, so there is nothing to answer.`,
        'Ask again with `agentgit_preflight` to see the hub ruling for the ground you are on, or take a lease if this ground should be ruled.',
      )
    }
    if (!ruling.needsResolution) {
      throw new ToolError(
        `${entityKey} is already ruled ${ruling.word.toUpperCase()} (${ruling.basis}), so there is nothing ambiguous to answer.`,
        'The hub will not reopen a collision that recorded evidence already decided: that is what keeps one conclusion per contention.',
      )
    }

    const reason = intentOf(args) ?? `${decision} (answered by ${identity.taskId})`
    appendEvent(
      identity.paths,
      buildEvent({
        kind: 'decision',
        timestampUtc: context.now.toISOString(),
        sessionId: identity.sessionId,
        taskId: identity.taskId,
        entities: [{ kind: ruling.kind, identifier: ruling.entityKey, path: ruling.path }],
        intentText: reason,
        hostEvent: HUB_RESOLVE_HOST_EVENT,
        reason: `${decision}: ${reason}`,
        detail: {
          entityKey,
          decision,
          // The contention this answers. A third task joining makes it a different question,
          // so an answer to the old one cannot silently bind the new one.
          signature: contentionSignature(ruling),
          rulingId: hub.id,
        },
      }),
    )

    return {
      text: [
        `${entityKey} answered ${decision.toUpperCase()}.`,
        `reason: ${reason}`,
        '',
        'Recorded in the ledger, so every window reads the same conclusion. The earliest answer for a',
        'contention is the one that stands: if another window already answered this one, this answer is',
        'kept and ignored, and `agentgit hub` shows which conclusion is in force.',
        'The hub republishes within a couple of seconds; nothing here blocks a write.',
      ].join('\n'),
      structured: {
        entityKey,
        decision,
        reason,
        signature: contentionSignature(ruling),
        answeredRulingId: hub.id,
        republished: false,
      },
    }
  },
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
      const result = checkpointCommit(root, files, str(args, 'message') ?? `checkpoint: ${identity.taskId}`, {
        taskId: identity.taskId,
        sessionId: identity.sessionId,
      })
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
/* The commit graph, and the panel that draws it                               */
/* -------------------------------------------------------------------------- */

const graphTool: ToolDefinition = {
  name: 'agentgit_graph',
  title: 'The commit graph, attributed to the conversations that produced it',
  description:
    'Every commit across all branches, each one attributed to the Codex conversation (window) that produced it, with ' +
    'the files it changed, the lanes a graph needs to draw it, and what is uncommitted in each worktree right now. ' +
    'Attribution comes from the commit\'s AgenticGit trailers first, then the agentgit/<task> branch, then the ' +
    'ledger\'s task-to-session mapping; each node reports which of those answered, because a recorded name and a ' +
    'guessed one must not look alike. This is the data tool for the AgenticGit panel: it has no UI of its own and is ' +
    'safe to call on a timer. Writes nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      maxCommits: { type: 'number', description: 'How many commits to read. Defaults to 400.' },
      skipOverlay: { type: 'boolean', description: 'Skip reading `git status` in each worktree.' },
      workspace: { type: 'string', description: 'Workspace directory override.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (args, context) => {
    const view = buildGraphView(context.identity.paths, {
      maxCommits: num(args, 'maxCommits', 400),
      skipOverlay: bool(args, 'skipOverlay', false),
    })
    return { text: graphMarkdown(view), structured: view }
  },
}

const panelApp: ToolDefinition = {
  name: 'agentgit_ui',
  title: 'Open the AgenticGit panel for this workspace',
  description:
    'Renders the AgenticGit panel: a live commit graph for this workspace where every commit is attributed to the ' +
    'Codex conversation that made it, each commit can be asked about, and uncommitted work in every worktree is ' +
    'listed. Call this once when the user asks for the panel, the window list, "who did what", or when a session ' +
    'first works in a workspace several agents share. The panel refreshes itself; it does not need to be called ' +
    'again. Prefer a persistent side panel or picture-in-picture when the host offers one.',
  inputSchema: {
    type: 'object',
    properties: {
      maxCommits: { type: 'number', description: 'How many commits to read. Defaults to 400.' },
      workspace: { type: 'string', description: 'Workspace directory override.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  meta: { ui: { resourceUri: APP_RESOURCE_URI } },
  handler: (args, context) => {
    const view = buildGraphView(context.identity.paths, { maxCommits: num(args, 'maxCommits', 400) })
    return { text: graphMarkdown(view), structured: view }
  },
}

const explainTool: ToolDefinition = {
  name: 'agentgit_explain',
  title: 'What one commit was, and who made it',
  description:
    'Explains a single commit without a model in the loop: which window it is attributed to and on what evidence, ' +
    'the task and sessions behind it, what the agent said it was doing, every file it changed, and the ledger events ' +
    'that mention it. Accepts a full commit id, a short id, or a task id. Use it when the user asks what a window ' +
    'did, how something was committed, or which conversation a change came from. Writes nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      oid: { type: 'string', description: 'Commit id (full or short) or task id to explain.' },
      maxEvents: { type: 'number', description: 'How many ledger events to list. Defaults to 20.' },
      workspace: { type: 'string', description: 'Workspace directory override.' },
    },
    required: ['oid'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: (args, context) => {
    const reference = str(args, 'oid')
    if (!reference) {
      throw new ToolError(
        'agentgit_explain needs `oid`.',
        'Pass a commit id, a short commit id, or a task id, as shown in the AgenticGit panel.',
      )
    }
    const view = buildGraphView(context.identity.paths, { skipOverlay: true })
    const explanation = explainCommit(view, context.identity.paths, reference, {
      maxEvents: num(args, 'maxEvents', 20),
    })
    return {
      text: explanationMarkdown(explanation),
      structured: explanation,
      isError: !explanation.found,
    }
  },
}

/* -------------------------------------------------------------------------- */

/**
 * Tool order matters a little: read-only tools first, so a model scanning the list
 * sees the cheap ones before the ones that change state.
 */
export const TOOLS: readonly ToolDefinition[] = [
  ...IMPACT_TOOLS,
  whoami,
  status,
  desktop,
  briefTool,
  board,
  graphTool,
  explainTool,
  panelApp,
  panel,
  preflightTool,
  hubResolve,
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
  return TOOLS.map((tool) => {
    const descriptor: Record<string, unknown> = {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    }
    // Omitted rather than set to `{}` so a host that checks for the key does not treat an
    // empty object as a declared UI resource.
    if (tool.meta !== undefined) descriptor._meta = tool.meta
    return descriptor
  })
}

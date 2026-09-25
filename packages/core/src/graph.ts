/**
 * The commit graph, attributed to the conversations that produced it.
 *
 * This is what a developer looks at to answer three questions about a workspace where
 * several agents worked: what landed, which window did it, and what is still in flight.
 * Git can answer the first on its own; the other two need the ledger, and that is the
 * whole reason this module exists rather than a call to `git log --graph`.
 *
 * Three decisions shape it.
 *
 * **The layout is computed here, not in the renderer.** Lane assignment is the one part of
 * a commit graph that is easy to get subtly wrong and hard to notice, and a renderer that
 * derives it cannot be tested without a browser. Doing it server-side means the panel, the
 * board and the terminal all draw the same picture, and a unit test can assert it.
 *
 * **Attribution is a chain, and the chain is visible.** A commit's window comes from its
 * own trailers first, then from the `agentgit/<task>` branch it sits on, then from the
 * ledger's task-to-session mapping. Each node carries where its label came from, because a
 * name that was guessed and a name that was recorded must not look identical.
 *
 * **In-flight work is real, not inferred.** The overlay is `git status` in each worktree,
 * so it reports what is actually uncommitted rather than what the ledger believes was
 * written. A ledger write that was already committed is not shown, and a file an agent
 * changed through a route the hook could not see still is.
 *
 * @module @agentgit/core/graph
 */

import { basename } from 'node:path'

import { loadContracts } from './contracts.ts'
import { buildCapsules } from './ledger.ts'
import { loadLeases } from './leases.ts'
import {
  currentBranch,
  logAll,
  parseAttribution,
  statusShortAll,
  subjectOf,
  taskFromRefs,
  toplevel,
  worktreeList,
  type GitCommitRecord,
} from './git.ts'
import { resolveSessionLabels, type SessionLabelSource } from './sessions.ts'
import type { Capsule, CoordEvent } from './types.ts'
import { AGENTGIT_DIR, loadConfig, readAllEvents, type WorkspacePaths } from './workspace.ts'

/** One commit, positioned and attributed. */
export interface GraphNode {
  readonly oid: string
  readonly short: string
  readonly parents: readonly string[]
  readonly subject: string
  readonly committedAt: string
  /** Column the node occupies. Always assigned, so the renderer never has to guess. */
  readonly lane: number
  /** Branch and tag names pointing here, with `HEAD -> ` stripped. */
  readonly refs: readonly string[]
  /** True when a ref decoration marked this commit as the current HEAD. */
  readonly head: boolean
  readonly taskId: string | null
  readonly sessionIds: readonly string[]
  /** Display names for this commit: one window name per session, in ledger order. */
  readonly labels: readonly string[]
  /** The single name to show, resolved so a node is never unlabelled. */
  readonly label: string
  readonly labelSource: SessionLabelSource
  readonly authorName: string
  readonly files: readonly string[]
  readonly filesChanged: number
}

export interface GraphEdge {
  readonly from: string
  readonly to: string
}

/** One worktree's uncommitted work, read from `git status` rather than from the ledger. */
export interface GraphOverlay {
  readonly worktree: string
  readonly branch: string | null
  readonly taskId: string | null
  readonly sessionIds: readonly string[]
  readonly label: string | null
  /**
   * Where `label` came from, so a guessed name is not shown as a recorded one.
   *
   * `task` means the worktree is on an `agentgit/<task>` branch; anything else means the
   * label was resolved from a session, which for a worktree with no task comes from the
   * ledger's record of who wrote those paths.
   */
  readonly labelSource: SessionLabelSource | null
  readonly paths: readonly string[]
  readonly main: boolean
}

export interface GraphLabelSummary {
  readonly label: string
  readonly sessionId: string | null
  readonly taskId: string | null
  readonly source: SessionLabelSource
  readonly commits: number
}

export interface GraphView {
  readonly workspace: string
  /** Directory name, which is what the panel title uses: `AgenticGit for "<name>"`. */
  readonly workspaceName: string
  readonly repo: string
  readonly branch: string | null
  readonly generatedAt: string
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
  /** Number of lanes the layout used, so a renderer can size its gutter. */
  readonly lanes: number
  readonly labels: readonly GraphLabelSummary[]
  readonly overlay: readonly GraphOverlay[]
  /** True when `git log` hit the cap and older commits are not shown. */
  readonly truncated: boolean
  readonly diagnostics: {
    readonly commits: number
    readonly maxCommits: number
    readonly gitError: string | null
  }
}

export interface BuildGraphOptions {
  readonly maxCommits?: number
  readonly home?: string
  readonly now?: Date
  /** Skip `git status` per worktree. Used by tests and by callers that only want history. */
  readonly skipOverlay?: boolean
}

const DEFAULT_MAX_COMMITS = 400

/**
 * Build the whole graph for one workspace.
 *
 * Read-only: every git call underneath is a query, so this is safe on the board's timer
 * and while agents are mid-write.
 */
export function buildGraphView(paths: WorkspacePaths, options: BuildGraphOptions = {}): GraphView {
  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS
  const repo = toplevel(paths.root) ?? paths.root
  const log = logAll(repo, { maxCommits })

  const { events } = readAllEvents(paths)
  const capsules = buildCapsules(events)
  const taskSessions = sessionsByTask(capsules)

  const records = log.commits
  const lanes = assignLanes(records)

  // In-flight work is collected before labels are resolved, not after. A session whose only
  // trace is an uncommitted file appears in no commit, so resolving labels from the commit
  // list alone would leave the main checkout's work permanently unnamed — which is exactly
  // the case the overlay exists for.
  const pending = options.skipOverlay
    ? []
    : collectOverlay(repo, taskSessions, loadConfig(paths).ignore, buildPathOwners(events))

  // One pass over every session the graph could possibly name, then one label resolution for
  // all of them: resolving per commit would re-read the thread index per node.
  const sessionIds = collectSessions(records, taskSessions, pending)
  const labels = resolveSessionLabels(sessionIds, {
    home: options.home,
    taskIdForSession: (sessionId) => taskOfSession(capsules, sessionId),
  })

  const nodes = records.map((record) => nodeFor(record, { lanes, taskSessions, labels }))
  const edges = buildEdges(records)

  return {
    workspace: paths.root,
    workspaceName: basename(paths.root) || paths.root,
    repo,
    branch: currentBranch(repo),
    generatedAt: (options.now ?? new Date()).toISOString(),
    nodes,
    edges,
    lanes: lanes.width,
    labels: summariseLabels(nodes),
    overlay: pending.map((entry) => finaliseOverlay(entry, labels)),
    truncated: log.ok && records.length >= maxCommits,
    diagnostics: { commits: records.length, maxCommits, gitError: log.error },
  }
}

/* -------------------------------------------------------------------------- */
/* Attribution                                                                 */
/* -------------------------------------------------------------------------- */

/** task id -> session ids, folded from the ledger's capsules. */
function sessionsByTask(capsules: Map<string, Capsule>): Map<string, string[]> {
  const byTask = new Map<string, string[]>()
  for (const capsule of capsules.values()) {
    byTask.set(capsule.taskId, [...capsule.sessions])
  }
  return byTask
}

/** The task a session belongs to, when the ledger knows one. */
function taskOfSession(capsules: Map<string, Capsule>, sessionId: string): string | null {
  for (const capsule of capsules.values()) {
    if (capsule.sessions.includes(sessionId)) return capsule.taskId
  }
  return null
}

function collectSessions(
  records: readonly GitCommitRecord[],
  taskSessions: Map<string, string[]>,
  pending: readonly PendingOverlay[],
): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  const push = (sessionId: string): void => {
    if (!sessionId || seen.has(sessionId)) return
    seen.add(sessionId)
    ordered.push(sessionId)
  }
  for (const record of records) {
    const trailer = parseAttribution(record.body)
    if (trailer.sessionId) push(trailer.sessionId)
    const taskId = trailer.taskId ?? taskFromRefs(record.refs)
    if (taskId) for (const sessionId of taskSessions.get(taskId) ?? []) push(sessionId)
  }
  for (const entry of pending) {
    for (const sessionId of entry.sessionIds) push(sessionId)
  }
  return ordered
}

function nodeFor(
  record: GitCommitRecord,
  context: {
    lanes: { of: Map<string, number> }
    taskSessions: Map<string, string[]>
    labels: Map<string, { label: string; source: SessionLabelSource }>
  },
): GraphNode {
  const trailer = parseAttribution(record.body)
  const taskId = trailer.taskId ?? taskFromRefs(record.refs)

  const sessionIds: string[] = []
  const push = (value: string | null): void => {
    if (value && !sessionIds.includes(value)) sessionIds.push(value)
  }
  push(trailer.sessionId)
  if (taskId) for (const sessionId of context.taskSessions.get(taskId) ?? []) push(sessionId)

  const labels = sessionIds.map((sessionId) => context.labels.get(sessionId)?.label ?? sessionId)

  // The primary name, and where it came from. A node is never left unlabelled: the author
  // of a commit that carries no attribution is still a true and useful thing to show.
  let label = labels[0] ?? ''
  let labelSource: SessionLabelSource = labels[0] ? (context.labels.get(sessionIds[0]!)?.source ?? 'session-id') : 'session-id'
  if (label === '' && taskId) {
    label = taskId
    labelSource = 'task'
  }
  if (label === '') {
    label = record.authorName || record.authorEmail || record.short
    labelSource = 'author'
  }

  const refs = record.refs.map((ref) => ref.replace(/^HEAD\s*->\s*/, '').trim())

  return {
    oid: record.oid,
    short: record.short,
    parents: record.parents,
    subject: subjectOf(record.body),
    committedAt: record.committedAt,
    lane: context.lanes.of.get(record.oid) ?? 0,
    refs,
    head: record.refs.some((ref) => /^HEAD\s*->/.test(ref)),
    taskId,
    sessionIds,
    labels,
    label,
    labelSource,
    authorName: record.authorName,
    files: record.files,
    filesChanged: record.files.length,
  }
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Assign every commit a lane, and report how many lanes were used.
 *
 * The walk is newest-first, which is the order `git log --date-order` already returns, and
 * each lane is a promise: it holds the id of the commit it is waiting to draw next. A
 * commit takes the lane waiting for it, or a free one when it is a branch tip; its first
 * parent then inherits that lane and its other parents get lanes of their own. That is what
 * makes a merge look like a merge instead of a column of disconnected dots.
 *
 * Duplicate promises are collapsed. Two lanes can be waiting for the same parent when two
 * branches merge into one, and leaving the second lane waiting forever would draw a lane
 * that never ends — the classic artefact of a layout that only looks right on a linear
 * history.
 */
function assignLanes(records: readonly GitCommitRecord[]): { of: Map<string, number>; width: number } {
  const of = new Map<string, number>()
  const waiting: (string | null)[] = []

  for (const record of records) {
    let lane = waiting.indexOf(record.oid)
    if (lane === -1) {
      const free = waiting.indexOf(null)
      lane = free === -1 ? waiting.length : free
    }
    of.set(record.oid, lane)

    waiting[lane] = record.parents[0] ?? null
    // Any other lane promised the same commit has nothing left to draw.
    for (let other = 0; other < waiting.length; other += 1) {
      if (other !== lane && waiting[other] === record.oid) waiting[other] = null
    }

    for (let index = 1; index < record.parents.length; index += 1) {
      const parent = record.parents[index]
      if (!parent || waiting.includes(parent)) continue
      const free = waiting.indexOf(null)
      if (free === -1) waiting.push(parent)
      else waiting[free] = parent
    }
  }

  return { of, width: waiting.length }
}

function buildEdges(records: readonly GitCommitRecord[]): GraphEdge[] {
  const present = new Set(records.map((record) => record.oid))
  const edges: GraphEdge[] = []
  for (const record of records) {
    for (const parent of record.parents) {
      // A parent outside the window is still an edge in the repository, but drawing it
      // would need a node that was not fetched. The node says `parents` regardless.
      if (present.has(parent)) edges.push({ from: record.oid, to: parent })
    }
  }
  return edges
}

/* -------------------------------------------------------------------------- */
/* In-flight overlay                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One worktree's uncommitted work, before its sessions have been turned into display names.
 *
 * Split from {@link finaliseOverlay} because label resolution has to happen once, over the
 * union of every session the graph might name — commits and uncommitted work alike. Collecting
 * first and naming afterwards is what lets a session that has committed nothing still be
 * named on the overlay.
 */
interface PendingOverlay {
  readonly worktree: string
  readonly branch: string | null
  readonly taskId: string | null
  readonly sessionIds: readonly string[]
  readonly labelSource: SessionLabelSource | null
  readonly paths: readonly string[]
  readonly main: boolean
}

/**
 * Uncommitted work per worktree.
 *
 * `git status` is the source rather than the ledger on purpose: the question this answers
 * is "what would a checkpoint commit right now", and only the working tree can answer it.
 * A path the ledger recorded but that is already committed does not appear, and a path an
 * agent wrote through a route the hook never saw does.
 *
 * Paths the workspace has excluded are dropped. `.agentgit/` in particular is created by
 * this product and is untracked by design, so reporting it would put the coordination
 * directory at the top of a list about work in progress — and a `.git/info/exclude` entry
 * only exists once a worktree has been created, which is exactly the case where it is absent.
 *
 * A worktree on an `agentgit/<task>` branch is attributed by that branch. The main checkout
 * usually is not, so it falls back to the ledger: whoever recorded writing those paths is
 * who they belong to. Without that, the most common case — several agents working in the
 * main checkout with nothing committed yet — would read as "no window recorded", which is
 * the one answer the panel exists to avoid.
 */
function collectOverlay(
  repo: string,
  taskSessions: Map<string, string[]>,
  ignore: readonly string[],
  pathOwners: Map<string, string[]>,
): PendingOverlay[] {
  const entries = worktreeList(repo)
  if (entries.length === 0) return []

  const overlay: PendingOverlay[] = []
  for (const entry of entries) {
    const changed = statusShortAll(entry.path)
      .map(stripStatus)
      .filter((path) => path.length > 0 && !isExcluded(path, ignore))
    if (changed.length === 0) continue

    const taskId = entry.branch?.match(/^agentgit\/(.+)$/)?.[1] ?? null
    let sessionIds = taskId ? (taskSessions.get(taskId) ?? []) : []
    let labelSource: SessionLabelSource | null = taskId ? 'task' : null

    if (!taskId) {
      // The ledger's own record of who wrote these paths, in the order the paths appear, so
      // the window shown is the one that wrote the first file listed.
      const owners: string[] = []
      for (const path of changed) {
        for (const sessionId of pathOwners.get(path) ?? []) {
          if (!owners.includes(sessionId)) owners.push(sessionId)
        }
      }
      sessionIds = owners
    }

    overlay.push({
      worktree: entry.path,
      branch: entry.branch,
      taskId,
      sessionIds,
      labelSource,
      paths: changed,
      main: entry.path === repo,
    })
  }
  return overlay
}

/** Attach display names to the collected overlay, once every session has one. */
function finaliseOverlay(
  entry: PendingOverlay,
  labels: Map<string, { label: string; source: SessionLabelSource }>,
): GraphOverlay {
  const first = entry.sessionIds[0] ? labels.get(entry.sessionIds[0]) : undefined
  return {
    worktree: entry.worktree,
    branch: entry.branch,
    taskId: entry.taskId,
    sessionIds: entry.sessionIds,
    label: first?.label ?? entry.taskId,
    labelSource: first?.source ?? entry.labelSource,
    paths: entry.paths,
    main: entry.main,
  }
}

/**
 * Which sessions recorded writing each path, newest first.
 *
 * Only `file_write` events count: that is the kind the ledger writes when an agent is about
 * to change a file, and it is the same subset the Python analyser counts entity touches for.
 * A bounded number of recent events is enough because the question is about uncommitted work,
 * and uncommitted work by definition has not aged out of the ledger.
 */
function buildPathOwners(events: readonly CoordEvent[], maxEvents = 5000): Map<string, string[]> {
  const owners = new Map<string, string[]>()
  const recent = events.slice(-maxEvents)
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const event = recent[index]!
    if (event.kind !== 'file_write') continue
    for (const entity of event.entities ?? []) {
      const path = entity.path ?? entity.identifier
      if (!path) continue
      const list = owners.get(path) ?? []
      if (!list.includes(event.sessionId)) list.push(event.sessionId)
      owners.set(path, list)
    }
  }
  return owners
}

/**
 * True when a path is coordination state or matches the workspace's ignore list.
 *
 * Reuses the same rules the ledger applies, plus `.agentgit/` itself: the configured list
 * names `.agentgit/state/` because that is the regenerable part, but the whole directory
 * is this product's, so none of it is work in progress.
 */
function isExcluded(path: string, ignore: readonly string[]): boolean {
  const normalized = path.replace(/\\/g, '/')
  if (normalized === AGENTGIT_DIR || normalized.startsWith(`${AGENTGIT_DIR}/`)) return true
  return ignore.some((entry) => normalized.startsWith(entry) || normalized.includes(`/${entry}`))
}

/** ` M src/a.ts` and `?? src/b.ts` both reduce to the path after the two status columns. */
function stripStatus(line: string): string {
  return line.replace(/^.{2}\s?/, '').trim()
}

/* -------------------------------------------------------------------------- */
/* Summaries                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One row per window that appears in the graph, with its commit count.
 *
 * This is the legend. A reader scanning the graph needs to know which names are present and
 * how much each one did before they scroll, and computing it from the nodes means the legend
 * cannot disagree with the picture.
 */
function summariseLabels(nodes: readonly GraphNode[]): GraphLabelSummary[] {
  const byLabel = new Map<string, GraphLabelSummary & { commits: number }>()
  for (const node of nodes) {
    const key = node.label
    const existing = byLabel.get(key)
    if (existing) {
      existing.commits += 1
      continue
    }
    byLabel.set(key, {
      label: key,
      sessionId: node.sessionIds[0] ?? null,
      taskId: node.taskId,
      source: node.labelSource,
      commits: 1,
    })
  }
  return [...byLabel.values()].sort(
    (a, b) => b.commits - a.commits || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  )
}

/**
 * Everything the ledger knows about one commit, for the panel's question box.
 *
 * The point of this function is to answer "who did this, why, and what changed" without a
 * model in the loop. A developer who asks the panel about a commit should get an answer
 * that is reproducible and offline: the commit's own metadata, the windows it is attributed
 * to, the intents recorded against those windows, and the ledger events that mention them.
 *
 * `notes` carries the caveats. They are part of the answer rather than an afterthought,
 * because the two things a reader must not get wrong here are *where the name came from*
 * and *whether the ledger actually saw this work* — a commit made before the plugin was
 * installed has a perfectly good answer with no ledger events at all, and saying so is more
 * useful than an empty section.
 */
export interface CommitExplanation {
  readonly found: boolean
  readonly oid: string | null
  readonly short: string | null
  readonly subject: string | null
  readonly label: string | null
  readonly labelSource: SessionLabelSource | null
  readonly taskId: string | null
  readonly sessionIds: readonly string[]
  readonly authorName: string | null
  readonly committedAt: string | null
  readonly refs: readonly string[]
  readonly files: readonly string[]
  /** What the agent said it was doing, taken from the ledger's intent text. */
  readonly intents: readonly string[]
  readonly events: readonly ExplanationEvent[]
  readonly leases: readonly string[]
  readonly contracts: readonly string[]
  readonly notes: readonly string[]
}

export interface ExplanationEvent {
  readonly kind: string
  readonly at: string
  readonly taskId: string | null
  readonly sessionId: string
  readonly summary: string
}

export interface ExplainOptions {
  readonly maxEvents?: number
  readonly home?: string
}

/**
 * Resolve a commit from a full id, a short id, or a task id.
 *
 * Accepting a prefix matters because every surface that shows a commit shows it shortened,
 * and asking a developer to paste 40 hex characters from a panel they are looking at is the
 * kind of small friction that stops a feature being used.
 */
export function findGraphNode(view: GraphView, reference: string): GraphNode | null {
  const wanted = reference.trim().toLowerCase()
  if (!wanted) return null
  for (const node of view.nodes) {
    if (node.oid.toLowerCase() === wanted) return node
  }
  for (const node of view.nodes) {
    if (node.oid.toLowerCase().startsWith(wanted)) return node
  }
  for (const node of view.nodes) {
    if (node.taskId && node.taskId.toLowerCase() === wanted) return node
  }
  return null
}

export function explainCommit(
  view: GraphView,
  paths: WorkspacePaths,
  reference: string,
  options: ExplainOptions = {},
): CommitExplanation {
  const node = findGraphNode(view, reference)
  if (!node) {
    return {
      found: false,
      oid: null,
      short: null,
      subject: null,
      label: null,
      labelSource: null,
      taskId: null,
      sessionIds: [],
      authorName: null,
      committedAt: null,
      refs: [],
      files: [],
      intents: [],
      events: [],
      leases: [],
      contracts: [],
      notes: [`No commit in this graph matches '${reference}'.`],
    }
  }

  const { events } = readAllEvents(paths)
  const scoped = events.filter((event) => mentions(event, node))
  const intents: string[] = []
  for (const event of scoped) {
    const text = event.intentText?.trim()
    if (text && !intents.includes(text)) intents.push(text)
  }

  const maxEvents = options.maxEvents ?? 20
  const timeline: ExplanationEvent[] = scoped.slice(-maxEvents).map((event) => ({
    kind: event.kind,
    at: event.timestampUtc,
    taskId: event.taskId ?? null,
    sessionId: event.sessionId,
    summary: summariseEvent(event),
  }))

  const leases = loadLeases(paths).leases
    .filter((lease) => matchesNode(lease.taskId, node))
    .map((lease) => `${lease.entityKey} (held by ${lease.taskId}, expires ${lease.expiresAt})`)

  const contracts = loadContracts(paths).contracts
    .filter((contract) => matchesNode(contract.publishedBy, node))
    .map((contract) => `${contract.name} v${contract.version}${contract.breaking ? ' (breaking)' : ''}`)

  return {
    found: true,
    oid: node.oid,
    short: node.short,
    subject: node.subject,
    label: node.label,
    labelSource: node.labelSource,
    taskId: node.taskId,
    sessionIds: node.sessionIds,
    authorName: node.authorName,
    committedAt: node.committedAt,
    refs: node.refs,
    files: node.files,
    intents,
    events: timeline,
    leases,
    contracts,
    notes: explanationNotes(node, scoped.length),
  }
}

function mentions(event: CoordEvent, node: GraphNode): boolean {
  if (node.taskId && event.taskId === node.taskId) return true
  return node.sessionIds.includes(event.sessionId)
}

function matchesNode(value: string | null | undefined, node: GraphNode): boolean {
  if (!value) return false
  if (node.taskId && value === node.taskId) return true
  return node.sessionIds.includes(value)
}

/** A one-line description of a ledger event, in the vocabulary the ledger records it in. */
function summariseEvent(event: CoordEvent): string {
  const entities = (event.entities ?? []).map((entity) => entity.path ?? entity.identifier).filter(Boolean)
  const parts: string[] = [event.kind]
  if (entities.length > 0) parts.push(entities.slice(0, 4).join(', '))
  if (event.reason) parts.push(`(${event.reason})`)
  return parts.join(' · ')
}

/**
 * What the answer does not prove.
 *
 * Each note names a specific way the reader could over-read the result, rather than a
 * generic disclaimer: a guessed label, a commit the ledger never saw, and an attribution
 * that came from a branch name are three different levels of certainty and a reader deciding
 * whether to act needs to know which one they have.
 */
function explanationNotes(node: GraphNode, ledgerEvents: number): string[] {
  const notes: string[] = []
  if (node.labelSource === 'index') {
    notes.push('The window name is the conversation name Codex recorded for this session.')
  } else if (node.labelSource === 'first-prompt') {
    notes.push('The window name came from the first prompt in the session transcript, not from the thread index.')
  } else if (node.labelSource === 'task') {
    notes.push('No conversation name was recorded for this work, so the task id is shown instead.')
  } else if (node.labelSource === 'author') {
    notes.push('This commit carries no AgenticGit attribution, so the Git author is shown. It may predate the plugin.')
  }
  if (ledgerEvents === 0) {
    notes.push('The ledger has no record for this commit. It was made before the plugin was installed, outside a recorded session, or on another machine.')
  }
  if (node.taskId && node.sessionIds.length === 1) {
    notes.push('One session is recorded for this task. A task can span several windows, and this commit names only the first.')
  }
  return notes
}


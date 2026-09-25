/**
 * The commit graph and a commit's explanation, as text.
 *
 * Rendered here rather than in `@agentgit/core` for the same reason every other wording in
 * this package lives here: the core decides what is true, and this decides how to say it.
 * The CLI, the MCP tools and the daemon all print from these functions, so a change to how
 * a window is named cannot reach one surface and miss another.
 *
 * The lane gutter is drawn from `node.lane`, which the core already computed. That is why
 * the graph reads as a graph in a terminal and not just as a list: the columns are the same
 * columns the panel draws, from the same numbers.
 *
 * @module @agentgit/board/graph
 */

import { shortenLabel, type CommitExplanation, type GraphNode, type GraphView } from '@agentgit/core'

/** Two characters per lane, capped so a busy repository does not push the text off screen. */
const MAX_GUTTER_LANES = 6
const LABEL_WIDTH = 26

export interface GraphMarkdownOptions {
  /** How many commits to show. Defaults to 40; pass 0 for all of them. */
  readonly limit?: number
}

/**
 * The graph as aligned lines.
 *
 * `head` and branch names are appended after the subject rather than before it, because a
 * decoration is the least important thing on the line and a reader scanning the subject
 * column should not have to skip past `HEAD -> main, origin/main, origin/HEAD` to reach it.
 */
export function graphMarkdown(view: GraphView, options: GraphMarkdownOptions = {}): string {
  const limit = options.limit ?? 40
  const nodes = limit > 0 ? view.nodes.slice(0, limit) : view.nodes
  const width = Math.min(view.lanes, MAX_GUTTER_LANES)
  const lines: string[] = []

  lines.push(
    `AgenticGit for "${view.workspaceName}" — ${view.branch ?? 'detached HEAD'}, ` +
      `${view.nodes.length} commit(s), ${view.lanes} lane(s)`,
  )
  if (view.labels.length > 0) {
    lines.push(
      `windows: ${view.labels.map((entry) => `${entry.label} (${entry.commits})`).join(', ')}`,
    )
  }
  lines.push('')

  for (const node of nodes) {
    lines.push(graphLine(node, width))
  }

  if (limit > 0 && view.nodes.length > limit) {
    lines.push('', `${view.nodes.length - limit} older commit(s) not shown.`)
  }
  if (view.overlay.length > 0) {
    lines.push('', 'in flight:')
    for (const entry of view.overlay) {
      const who = entry.label ? `${entry.label} (${entry.labelSource})` : (entry.taskId ?? 'no window recorded')
      lines.push(
        `  ${who} — ${entry.paths.length} uncommitted in ${entry.main ? 'the main checkout' : entry.worktree}`,
      )
    }
  }
  if (view.truncated) {
    lines.push('', `The repository has more commits than the ${view.diagnostics.maxCommits} this view reads.`)
  }
  return lines.join('\n')
}

/**
 * One row: the lane gutter, the window, the id, the files touched, and the subject.
 *
 * The gutter is indentation only, with no trailing padding: the short id that follows it is
 * a fixed eight characters, so every column after it lines up without the first lane paying
 * for a gutter it does not use.
 */
export function graphLine(node: GraphNode, laneWidth: number): string {
  const gutter = ' '.repeat(Math.min(node.lane, Math.max(laneWidth - 1, 0)) * 2)
  const marks = [node.head ? 'HEAD' : null, ...node.refs.filter((ref) => ref !== 'HEAD')]
    .filter((value): value is string => Boolean(value))
    .join(', ')
  const parts = [
    `${gutter}${node.short}`,
    shortenLabel(node.label, LABEL_WIDTH - 2).padEnd(LABEL_WIDTH, ' '),
    `${node.filesChanged}f`.padStart(4, ' '),
    node.subject || '(no message)',
  ]
  if (marks) parts.push(`(${marks})`)
  return parts.join(' ')
}

/**
 * One commit's explanation, as text.
 *
 * The caveats come before the ledger timeline, not after it. A reader who stops reading
 * after the first screen has already seen how much the attribution is worth, and a reader
 * who scrolls has the ordering they wanted anyway — whereas the reverse buries the one
 * sentence that says the name was guessed.
 */
export function explanationMarkdown(explanation: CommitExplanation): string {
  if (!explanation.found) {
    return explanation.notes.join('\n') || 'No such commit.'
  }

  const lines: string[] = []
  lines.push(`${explanation.short}  ${explanation.subject ?? '(no message)'}`)
  lines.push('')
  lines.push(`window : ${explanation.label ?? '(unknown)'}  (${explanation.labelSource ?? 'unknown'})`)
  if (explanation.taskId) lines.push(`task   : ${explanation.taskId}`)
  if (explanation.sessionIds.length > 0) lines.push(`session: ${explanation.sessionIds.join(', ')}`)
  lines.push(`author : ${explanation.authorName ?? '(unknown)'}`)
  if (explanation.committedAt) lines.push(`when   : ${explanation.committedAt}`)
  if (explanation.refs.length > 0) lines.push(`refs   : ${explanation.refs.join(', ')}`)

  if (explanation.intents.length > 0) {
    lines.push('', 'what it was for, in the agent\'s own words:')
    for (const intent of explanation.intents.slice(0, 3)) lines.push(`  ${intent}`)
  }

  lines.push('', `changed (${explanation.files.length}):`)
  if (explanation.files.length === 0) lines.push('  nothing — this commit is empty or a merge')
  for (const file of explanation.files.slice(0, 40)) lines.push(`  ${file}`)
  if (explanation.files.length > 40) lines.push(`  … ${explanation.files.length - 40} more`)

  if (explanation.events.length > 0) {
    lines.push('', 'ledger:')
    for (const event of explanation.events) {
      lines.push(`  ${event.at}  ${event.kind.padEnd(18, ' ')} ${event.summary}`)
    }
  }

  if (explanation.leases.length > 0) {
    lines.push('', 'leases:')
    for (const lease of explanation.leases) lines.push(`  ${lease}`)
  }
  if (explanation.contracts.length > 0) {
    lines.push('', 'interfaces published by this task:')
    for (const contract of explanation.contracts) lines.push(`  ${contract}`)
  }

  if (explanation.notes.length > 0) {
    lines.push('', 'notes:')
    for (const note of explanation.notes) lines.push(`  - ${note}`)
  }

  return lines.join('\n')
}

#!/usr/bin/env node
/**
 * `agentgit` - the command line.
 *
 * This file is dispatch, and nothing else. Every decision it could make lives in
 * `@agentgit/core`, and every word it prints lives in `./output.ts` or
 * `@agentgit/board`, because the same facts are read by the panel, the live board and
 * the MCP tools. A CLI that formatted its own copy of a verdict would be the first
 * place the surfaces started disagreeing.
 *
 * Exit codes are part of the interface, because this is called from hooks and from
 * CI: `0` means nothing needs attention, `1` means the command ran and found something
 * worth acting on, `2` means a usage or environment error. Only `1` is unusual for a
 * shell, which is why it reads as "look at the output" rather than as "failed".
 *
 * @module @agentgit/cli
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import {
  adoptWorkspace,
  appendEvent,
  buildBoardView,
  buildBrief,
  buildEvent,
  buildGraphView,
  buildIntegrationPlan,
  checkpointCommit,
  clearInitOffer,
  computeHubVerdict,
  contractsTouchingPath,
  coreModules,
  currentBranch,
  currentVersion,
  defaultBranch,
  DEFAULT_CONFIG,
  DESKTOP_OFFER_COOLDOWN_MS,
  describeArms,
  describeProtected,
  describeTunables,
  desktopStatePath,
  desktopTaskTitle,
  ensureWorkspace,
  explainCommit,
  findWorkspaceRoot,
  finishTask,
  hubSeenCount,
  initOfferFor,
  initOffersPath,
  markEnabled,
  isDirty,
  keyOf,
  kindOfVerdict,
  loadConfig,
  loadContracts,
  loadLeases,
  machineId,
  moduleDetail,
  moduleGraphFor,
  moduleGraphView,
  parseTunable,
  preflight,
  preflightAndClaim,
  previewTaskMerges,
  publishContract,
  publishHubVerdict,
  readAllEvents,
  readDesktopState,
  readHubVerdict,
  recordAssumption,
  recordPinnedThread,
  registryView,
  releaseLease,
  resetDesktopState,
  startTask,
  symbolKeyOf,
  updateConfig,
  writeInitOffer,
  writtenPathsOf,
  type Entity,
  type WorkspaceConfig,
  type WorkspacePaths,
} from '@agentgit/core'

import { defaultPanelDir, explanationMarkdown, graphMarkdown, panelMarkdown, truncate, writePanel } from '@agentgit/board'
import { APP_HTML_FILENAME, APP_RESOURCE_URI, renderAppPanel } from '@agentgit/app'

import { USAGE, parseArgs, type ParsedArgs } from './args.ts'
import { cmdChecks } from './checks.ts'
import { cmdImpact } from './impact.ts'
import { install, installReportJson, runDoctor, uninstall, writePluginEnabled } from './install.ts'
import {
  renderArms,
  renderBoard,
  renderConfig,
  renderContract,
  renderContracts,
  renderDoctor,
  renderLeases,
  renderModuleDetail,
  renderModules,
  renderPreflight,
  renderReconcile,
  renderStatus,
  renderWhy,
} from './output.ts'

const VERSION = '0.1.0'

/** Raised for anything the user can fix by changing the command. Exits `2`. */
class UsageError extends Error {}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)

  switch (args.command) {
    case 'help':
    case '--help':
      process.stdout.write(USAGE)
      return 0

    case 'version':
    case '--version':
      process.stdout.write(`agentgit ${VERSION} (node ${process.versions.node})\n`)
      return 0

    case 'status':
      return cmdStatus(args)
    case 'brief':
      return cmdBrief(args)
    case 'board':
      return cmdBoard(args)
    case 'graph':
      return cmdGraph(args)
    case 'panel':
      return cmdPanel(args)
    case 'app':
      return cmdApp(args)
    case 'preflight':
      return cmdPreflight(args)
    case 'why':
      return cmdWhy(args)
    case 'hub':
      return cmdHub(args)
    case 'modules':
      return cmdModules(args)
    case 'impact':
      return cmdImpact(args, workspaceOf(args), identityOf(args, 'impact'))
    case 'desktop':
      return cmdDesktop(args)
    case 'checks':
      return cmdChecks(args, workspaceOf(args))
    case 'reconcile':
      return cmdReconcile(args)
    case 'config':
      return cmdConfig(args)
    case 'contracts':
      return cmdContracts(args)
    case 'lease':
      return cmdLease(args)
    case 'task':
      return cmdTask(args)
    case 'up':
      return cmdUp(args)
    case 'install':
      return cmdInstall(args)
    case 'uninstall':
      return cmdUninstall(args)
    case 'doctor':
      return cmdDoctor(args)
    case 'demo':
      return cmdDemo(args)

    default:
      process.stderr.write(`agentgit: unknown command '${args.command}'\n${USAGE}`)
      return 2
  }
}

/* -------------------------------------------------------------------------- */
/* Workspace and identity                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The workspace this command is about.
 *
 * An explicit `--workspace` wins over the environment, which in turn wins over the
 * directory. The environment variable exists because the MCP server is spawned by
 * Codex with a directory that is not always the session's, and the tools need a way
 * to be told the truth rather than guessing it.
 *
 * Directories are created here rather than at first write, so a read-only command
 * against a fresh repository reports "nothing recorded yet" instead of failing on a
 * missing path.
 */
function workspaceOf(args: ParsedArgs): WorkspacePaths {
  return ensureWorkspace(rootWithoutClaiming(args))
}

/**
 * The workspace root, resolved without creating anything in it.
 *
 * For the one answer that must not opt a repository in: declining the offer to enable AgenticGit
 * here. `workspaceOf` creates `.agentgit`, and doing that while recording a refusal would make the
 * refusal do the very thing it declined - so the machine-level record is written from this root
 * instead, and the repository stays untouched.
 */
function rootWithoutClaiming(args: ParsedArgs): string {
  const explicit = args.value('workspace') ?? process.env.AGENTGIT_WORKSPACE ?? null
  const root = explicit ? resolve(explicit) : findWorkspaceRoot(process.cwd())
  if (!existsSync(root)) throw new UsageError(`workspace does not exist: ${root}`)
  return root
}

interface Identity {
  readonly sessionId: string
  readonly taskId: string
}

/**
 * Who is asking.
 *
 * `AGENTGIT_TASK` and `AGENTGIT_SESSION` are read first because the Codex hooks set
 * them per tool call, and a verdict attributed to the wrong task is worse than no
 * verdict at all: it makes the real task look idle while looking busy itself.
 *
 * The fallback task id is derived from the session id rather than generated fresh, so
 * running `preflight` twice from one shell does not invent two tasks that then collide
 * with each other. It is the session id *unchanged*: the hook and the MCP server fall
 * back the same way, and any prefix added here (`t-<session>`) would attribute this
 * command's writes to a different task than the hook recorded for the same agent.
 */
function identityOf(args: ParsedArgs, kind = 'cli'): Identity {
  const sessionId =
    args.value('session') ??
    process.env.AGENTGIT_SESSION ??
    process.env.CODEX_SESSION_ID ??
    `${kind}-${machineId()}-${process.pid}`
  const taskId = args.value('task') ?? process.env.AGENTGIT_TASK ?? sessionId
  return { sessionId, taskId }
}

/* -------------------------------------------------------------------------- */
/* Read-only views                                                             */
/* -------------------------------------------------------------------------- */

function cmdStatus(args: ParsedArgs): number {
  const paths = workspaceOf(args)
  const view = buildBoardView(paths)

  if (args.boolean('json')) {
    process.stdout.write(`${JSON.stringify(view, null, 2)}\n`)
  } else {
    process.stdout.write(renderStatus(view, loadConfig(paths)))
  }

  // Anything worth acting on is exit 1, so `agentgit status` composes in a script
  // without anyone having to parse English.
  const needsAttention = view.collisions.length > 0 || view.debt.breakdown.staleAssumptions > 0
  return needsAttention ? 1 : 0
}

/**
 * `agentgit brief` - the facts a truncated context cannot hold.
 *
 * Exit 1 when there is something to act on and 0 when there is not, so a caller can wire it
 * to a re-entry step without parsing the text.
 */
function cmdBrief(args: ParsedArgs): number {
  const paths = workspaceOf(args)
  const identity = identityOf(args, 'brief')
  const brief = buildBrief(paths, identity.sessionId)

  if (args.boolean('json')) {
    process.stdout.write(`${JSON.stringify(brief, null, 2)}\n`)
  } else if (brief.text === null) {
    process.stdout.write(
      'Nothing to re-state: no other task or session is on a recorded entity, and no interface has moved.\n',
    )
  } else {
    process.stdout.write(brief.text.endsWith('\n') ? brief.text : `${brief.text}\n`)
  }

  return brief.text === null ? 0 : 1
}

function cmdBoard(args: ParsedArgs): number {
  const paths = workspaceOf(args)
  const view = buildBoardView(paths)

  if (args.boolean('json')) {
    process.stdout.write(`${JSON.stringify(view, null, 2)}\n`)
    return 0
  }

  process.stdout.write(renderBoard(view))

  if (args.boolean('open')) {
    const artifact = writePanel(view, args.value('out') ?? defaultPanelDir(paths.root))
    const url = fileUrl(artifact.path)
    process.stdout.write(`\nPanel written to ${artifact.path}\n`)
    if (!openInBrowser(url)) process.stdout.write(`Open it at: ${url}\n`)
  }

  return view.debt.score > 0 ? 1 : 0
}

function cmdPanel(args: ParsedArgs): number {
  const paths = workspaceOf(args)
  const view = buildBoardView(paths)
  const outDir = args.value('out') ?? defaultPanelDir(paths.root)
  const artifact = writePanel(view, outDir)

  if (args.boolean('json')) {
    process.stdout.write(`${JSON.stringify({ ...artifact, summary: panelMarkdown(view) }, null, 2)}\n`)
    return 0
  }

  if (args.boolean('print')) {
    // Only the token, on its own line. The token is bracketed by private-use
    // codepoints, so a caller that pipes this into a reply must not have to strip a
    // banner off it first.
    process.stdout.write(`${artifact.reference}\n`)
    return 0
  }

  process.stdout.write(`${panelMarkdown(view)}\n`)
  process.stdout.write(`\npanel    : ${artifact.path}\n`)
  process.stdout.write(`fragment : ${artifact.fragmentPath}\n`)
  process.stdout.write(`\nPut this line into the reply, verbatim:\n${artifact.reference}\n`)
  return 0
}

function cmdGraph(args: ParsedArgs): number {
  const paths = workspaceOf(args)
  const view = buildGraphView(paths, {
    maxCommits: args.number('max-commits', 400),
    skipOverlay: args.boolean('no-overlay', false),
  })

  if (args.boolean('json')) {
    process.stdout.write(`${JSON.stringify(view, null, 2)}\n`)
    return 0
  }

  const explain = args.value('explain')
  if (explain) {
    const explanation = explainCommit(view, paths, explain)
    process.stdout.write(`${explanationMarkdown(explanation)}\n`)
    return explanation.found ? 0 : 1
  }

  process.stdout.write(`${graphMarkdown(view, { limit: args.number('limit', 40) })}\n`)
  if (args.boolean('open')) {
    const out = args.value('out') ?? defaultPanelDir(paths.root)
    const artifact = writePanel(buildBoardView(paths), out)
    process.stdout.write(`\nPanel written to ${artifact.path}\n`)
  }
  return 0
}

/**
 * Write the panel document so a human can look at it without a host.
 *
 * The MCP App is normally served from memory over `resources/read`, so this exists for the
 * two cases where that is not available: verifying the markup after a change, and looking at
 * a workspace's graph when the host does not render MCP Apps at all. Opened from disk, the
 * panel finds no host and reads the daemon on port 7777 instead, which is why the hint
 * names `agentgit up`.
 */
function cmdApp(args: ParsedArgs): number {
  const paths = workspaceOf(args)
  const html = renderAppPanel({
    workspaceName: basename(paths.root) || paths.root,
    transport: 'http',
    httpBase: 'http://localhost:7777',
  })
  const out = args.value('out') ?? join(defaultPanelDir(paths.root), APP_HTML_FILENAME)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, html, 'utf8')

  if (args.boolean('json')) {
    process.stdout.write(`${JSON.stringify({ path: out, resource: APP_RESOURCE_URI, bytes: Buffer.byteLength(html) }, null, 2)}\n`)
    return 0
  }

  process.stdout.write(`panel    : ${out}\n`)
  process.stdout.write(`resource : ${APP_RESOURCE_URI}\n`)
  process.stdout.write(
    '\nA host that renders MCP Apps serves this from resources/read and never needs the file.\n' +
      'Opened directly it reads the live board, so start that first:  agentgit up\n',
  )
  if (args.boolean('open')) {
    if (!openInBrowser(fileUrl(out))) process.stdout.write(`Open it at: ${fileUrl(out)}\n`)
  }
  return 0
}

function cmdPreflight(args: ParsedArgs): number {
  const paths = workspaceOf(args)
  const identity = identityOf(args, 'preflight')
  const symbol = args.value('symbol')
  const targets = args.positionals
  const json = args.boolean('json')

  if (!symbol && targets.length === 0) {
    throw new UsageError('preflight needs at least one path, or --symbol <name>')
  }
  if (!symbol && targets.length > 1) {
    // One caller, one path, one verdict. A verdict per path would have to be a list,
    // and a list is the thing the six-verdict design exists to avoid.
    throw new UsageError('preflight takes one path at a time; the verdict is per entity. Run it once per path.')
  }

  const query = {
    taskId: identity.taskId,
    sessionId: identity.sessionId,
    entityKey: symbol ? symbolKeyOf(symbol) : keyOf(targets[0]),
    /*
     * The path is the *place*, and it is carried even when the key is a symbol.
     *
     * `WriteProposal` keeps the two apart on purpose: a file key says "this ground", a symbol
     * says "this behaviour". Dropping the path whenever `--symbol` was passed used to leave the
     * module layer with nothing to place the change in, so a symbol-level preflight could never
     * see a dependency edge. Passing both is strictly more information, and it is what the
     * host already knows — it read the path to find the symbol.
     */
    entityPath: targets[0],
    symbol: symbol ?? null,
    intentText: args.value('intent') ?? args.value('reason'),
    contracts: args.values('contract').filter((flag) => flag !== 'true'),
    windowHours: args.number('window', 24),
  }

  const result = args.boolean('claim')
    ? preflightAndClaim(paths, query, { symbol: Boolean(symbol) })
    : preflight(paths, query)

  process.stdout.write(renderPreflight(result, { json }))
  return kindOfVerdict(result.verdict) === 'clear' ? 0 : 1
}

function cmdWhy(args: ParsedArgs): number {
  const paths = workspaceOf(args)
  const target = args.positionals[0]
  if (!target) throw new UsageError('why needs an entity key, a path, or a task id')

  const { events } = readAllEvents(paths)

  /*
   * How the target matched decides how the answer is worded, and the order matters.
   *
   * A target can be a task id, a session id, or an entity key, and the same string can be
   * more than one of those. Deriving the label from the string alone turned `why demo-a`
   * into "5 events mention file::demo-a" — a sentence about a file the ledger never
   * recorded a write to, about a task whose timeline it had just printed. The matched
   * events say which one it was, so they decide the label.
   */
  const asTask = events.some((event) => event.taskId === target || event.sessionId === target)
  const asKey = asTask || target.includes('::') ? target : keyOf(target)

  const matches = events.filter((event) => {
    if (event.taskId === target) return true
    if (event.sessionId === target) return true
    return (event.entities ?? []).some(
      (entity) => keyOfEntity(entity) === asKey || entity.identifier === target || entity.path === target,
    )
  })

  if (args.boolean('json')) {
    process.stdout.write(`${JSON.stringify(matches, null, 2)}\n`)
  } else {
    process.stdout.write(renderWhy(target, asKey, matches))
  }
  return matches.length === 0 ? 1 : 0
}

function keyOfEntity(entity: Entity): string {
  return entity.kind === 'symbol' ? symbolKeyOf(entity.identifier) : keyOf(entity.path ?? entity.identifier)
}

/**
 * `agentgit hub` — the one ruling per contention, and the switch that publishes it by hand.
 *
 * Reading is the default, and it reads the projection the daemon maintains, so asking the
 * question never costs a pass over the ledger and never answers from a different moment than the
 * window next to you. `--refresh` is the manual path for a workspace whose daemon is not running:
 * it recomputes from the ledger and publishes, which is the one place this command pays the full
 * cost — and it is explicit, so nobody pays it by accident.
 *
 * Publishing by hand does not make the daemon redundant, and the distinction is worth keeping
 * straight: the daemon publishes *when a ruling changes*, which is a fact that depends on noticing
 * a file change rather than on somebody remembering to ask.
 */
function cmdHub(args: ParsedArgs): number {
  const paths = workspaceOf(args)
  const json = args.boolean('json')
  const read = readHubVerdict(paths)

  /*
   * Effective parallelism, derived here rather than passed in as zero.
   *
   * The ruling and its cost have to be read together — a quiet workspace bought by throttling the
   * work is not coordination — so a hub answer that reported `P 0.00` because nobody filled the
   * number in would be worse than one that reported no number at all.
   */
  const view = buildBoardView(paths)
  const parallelism = {
    mean: view.report.parallelism.mean,
    peak: view.report.parallelism.peak,
    parallelFraction: view.report.parallelism.parallelFraction,
  }

  let verdict = read
  let published: { readonly published: boolean; readonly reason: string } | null = null
  if (args.boolean('refresh')) {
    const computed = computeHubVerdict(paths, new Date(), { integration: buildIntegrationPlan(paths, view.tasks).order, parallelism })
    const result = publishHubVerdict(paths, computed)
    published = { published: result.published, reason: result.reason }
    verdict = computed
  } else if (!verdict) {
    // No projection yet, so the only honest answer is to compute one. It is not published: a read
    // must not change the ledger, and the note below says so.
    verdict = computeHubVerdict(paths, new Date(), { integration: buildIntegrationPlan(paths, view.tasks).order, parallelism })
  } else {
    verdict = { ...verdict, parallelism }
  }

  const shown = hubSeenCount(paths, verdict.id)

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ...verdict, source: read && !args.boolean('refresh') ? 'projection' : 'computed', published, shownToWindows: shown }, null, 2)}\n`,
    )
    return verdict.metrics.ambiguous > 0 ? 1 : 0
  }

  process.stdout.write(`hub ruling    : ${verdict.id}  (${verdict.authority})\n`)
  process.stdout.write(`recomputed at : ${verdict.generatedAt}\n`)
  process.stdout.write(
    `published     : ${
      published
        ? published.published
          ? `yes (${published.reason})`
          : `no (${published.reason})`
        : 'read from the projection'
    }\n`,
  )
  process.stdout.write(`shown to      : ${shown} window(s)\n`)
  process.stdout.write(
    `metrics       : ${verdict.metrics.rulings} contention(s), ${verdict.metrics.ambiguous} undecided, ` +
      `${verdict.metrics.owned} with a recommended owner\n`,
  )
  process.stdout.write(
    `              : longest-standing owner recommendation ${verdict.metrics.longestOwnershipMinutes}m; ` +
      `${verdict.metrics.waitingTasks} task(s) waiting\n`,
  )
  process.stdout.write(
    `              : effective parallelism P ${verdict.metrics.parallelismMean.toFixed(2)} ` +
      `(reported with the rulings: a quiet workspace bought by throttling is not coordination)\n`,
  )
  process.stdout.write(
    `              : lag ${verdict.metrics.inputLagMinutes}m behind the newest ledger fact; ` +
      `${verdict.metrics.published} ruling(s) published\n`,
  )
  process.stdout.write(`\n${verdict.advisory}\n`)

  if (args.boolean('seen')) {
    process.stdout.write(
      `\n${shown} window(s) have been shown this ruling. The line above is the same text the\n` +
        'tool-call hook injects, which is why it is printed and not re-worded here.\n',
    )
  }
  if (!read) {
    process.stdout.write(
      '\nNothing had been published for this workspace, so the ruling above was computed for this\n' +
        'one answer and not written. Start `agentgit up` to have it published and pushed to the\n' +
        'windows, or pass --refresh to publish it once from here.\n',
    )
  }

  // Exit 1 when something needs a decision, so this composes in a script without parsing English.
  return verdict.metrics.ambiguous > 0 ? 1 : 0
}

/**
 * `agentgit modules` — the coupling graph the code declares, and where a change can reach.
 *
 * Read-only, derived, and rebuildable: it parses imports, groups them into modules, and reports
 * the result plus what it could not resolve. It never edits a file and never decides anything on
 * its own — the graph is an input to the impact analysis, which is where a shared module is
 * still only evidence when a real import points one way.
 */
function cmdModules(args: ParsedArgs): number {
  const paths = workspaceOf(args)
  const limit = args.number('limit', 5)
  // Co-change is on by default because it is the only signal for the dependencies that are not
  // imports; `--no-co-change` turns the git walk off for a repository where it is slow.
  const graph = moduleGraphFor(paths, { coChange: !args.boolean('no-co-change') })

  const target = args.positionals[0]
  if (target) {
    const detail = renderModuleDetail(graph, target)
    if (detail === null) {
      process.stderr.write(
        `agentgit: no module '${target}'. Known modules: ${graph.modules.map((module) => module.id).join(', ')}\n`,
      )
      return 2
    }
    process.stdout.write(
      args.boolean('json') ? `${JSON.stringify(moduleDetail(graph, target), null, 2)}\n` : detail,
    )
    return 0
  }

  if (args.boolean('json')) {
    process.stdout.write(`${JSON.stringify(moduleGraphView(graph, { limit }), null, 2)}\n`)
    return 0
  }
  process.stdout.write(renderModules(graph, coreModules(graph, limit)))
  return 0
}

/**
 * `agentgit desktop` — the coordination task's bookkeeping, and the way back from a refusal.
 *
 * Read-only by default, and the read is the useful half: it answers "has this workspace been
 * offered a task, and is the heartbeat still reporting?" - which is the question that separates a
 * quiet task from a dead one, and the one the injected advice cannot answer because it only ever
 * appears when there is something to say.
 *
 * `--reset` exists because the offer is remembered whether it was accepted, refused, or ignored,
 * and a refusal is permanent by design. Someone who said no to get an interruption out of the way,
 * and then wanted the task after all, would otherwise have no way back short of editing state by
 * hand. It clears only this one record; nothing in the ledger moves.
 */
function cmdDesktop(args: ParsedArgs): number {
  const json = args.boolean('json')

  /*
   * The machine-level record is answered before the workspace is touched, and that order is the
   * point: a repository that has not opted in has no `.agentgit`, and recording a refusal must not
   * create one. `--clear-init` is the way back for someone who declined by accident.
   */
  if (args.boolean('decline-init') || args.boolean('clear-init')) {
    const root = rootWithoutClaiming(args)
    const file = initOffersPath()
    if (args.boolean('clear-init')) {
      const removed = clearInitOffer(root)
      if (json) {
        process.stdout.write(`${JSON.stringify({ workspace: root, cleared: removed, file }, null, 2)}\n`)
        return 0
      }
      process.stdout.write(
        removed
          ? `cleared the record for ${root} in ${file}\nThe next session start may offer to enable it here again.\n`
          : `nothing to clear for ${root} in ${file}.\n`,
      )
      return 0
    }
    const offeredAt = initOfferFor(root)?.offeredAt ?? null
    writeInitOffer(root, { declinedAt: new Date().toISOString() })
    if (json) {
      process.stdout.write(`${JSON.stringify({ workspace: root, declined: true, offeredAt, file }, null, 2)}\n`)
      return 0
    }
    process.stdout.write(`AgenticGit will not be enabled in ${root}.\n`)
    process.stdout.write(`  recorded : ${file}\n`)
    process.stdout.write('  note     : nothing was created in the repository itself.\n')
    process.stdout.write('To change that: agentgit desktop --clear-init\n')
    return 0
  }

  const paths = workspaceOf(args)
  const title = desktopTaskTitle(paths.root)

  if (args.boolean('reset')) {
    const removed = resetDesktopState(paths)
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ workspace: paths.root, reset: removed, state: readDesktopState(paths) }, null, 2)}\n`,
      )
      return 0
    }
    process.stdout.write(
      removed
        ? `cleared ${desktopStatePath(paths)}\n` +
            'The next session start will offer this workspace a coordination task again.\n'
        : `nothing to clear: ${desktopStatePath(paths)} does not exist.\n`,
    )
    return 0
  }

  /*
   * The two records `/agentgit` writes, exposed here as well so a user who did not go through the
   * injected block can still see and set them. Both are additive and idempotent: pinning a
   * conversation twice records one instant, and enabling an enabled workspace keeps the first.
   */
  const pin = args.value('pin')
  const enable = args.boolean('enable')
  if (pin !== null && pin !== '') recordPinnedThread(paths, pin)
  if (enable) markEnabled(paths)

  const state = readDesktopState(paths)
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ workspace: paths.root, title, state, path: desktopStatePath(paths) }, null, 2)}\n`,
    )
    return 0
  }

  process.stdout.write(`coordination task for "${title}"\n`)
  process.stdout.write(`  workspace : ${paths.root}\n`)
  process.stdout.write(`  state     : ${desktopStatePath(paths)}\n`)
  if (!state) {
    process.stdout.write('\nNo record yet, so a session start will offer this workspace one task.\n')
    process.stdout.write('The offer is a question, never an action: a task is only created if you agree.\n')
    return 0
  }

  process.stdout.write(`  task      : ${state.threadId ?? '(none)'}\n`)
  process.stdout.write(`  watcher   : ${state.automationId ?? '(none)'}\n`)
  process.stdout.write(
    `  asked     : ${state.offeredAt ?? '(never)'}${state.declinedAt ? `, declined ${state.declinedAt}` : ''}\n`,
  )
  process.stdout.write(
    `  last      : ${state.lastRulingId ?? '(no ruling reported yet)'}` +
      `${state.lastReportedAt ? `, looked at ${state.lastReportedAt}` : ''}\n`,
  )
  const pinned = Object.keys(state.pinnedThreads)
  process.stdout.write(`  pinned    : ${pinned.length > 0 ? pinned.join(', ') : '(no conversation pinned yet)'}\n`)
  process.stdout.write(`  enabled   : ${state.enabledAt ?? '(not enabled through /agentgit yet)'}\n`)

  if (state.threadId) {
    process.stdout.write('\nA task is recorded for this workspace, so no further offer will be made.\n')
    if (!state.automationId) {
      process.stdout.write('No watcher is recorded, so nothing will re-report on its own until one is attached.\n')
    }
  } else if (state.declinedAt) {
    process.stdout.write('\nThis workspace was offered a task and it was refused, so it will not be offered again.\n')
    process.stdout.write('To change that: agentgit desktop --reset\n')
    return 1
  } else {
    const offeredAt = state.offeredAt ? Date.parse(state.offeredAt) : Number.NaN
    const remaining = Number.isFinite(offeredAt) ? offeredAt + DESKTOP_OFFER_COOLDOWN_MS - Date.now() : 0
    process.stdout.write(
      remaining > 0
        ? `\nAn offer has been made and not answered, so it is not repeated for another ${Math.ceil(remaining / 60_000)} minute(s).\n`
        : '\nAn offer is due at the next session start.\n',
    )
  }
  return 0
}

function cmdReconcile(args: ParsedArgs): number {
  const paths = workspaceOf(args)
  const { stale, order } = buildIntegrationPlan(paths, buildBoardView(paths).tasks)
  const merge = previewTaskMerges(paths.root, order)

  const rendered = {
    stale,
    order,
    merge,
    dirty: isDirty(paths.root),
    branch: currentBranch(paths.root),
  }

  if (args.boolean('json')) {
    process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`)
    return stale.length > 0 || merge.some((pair) => !pair.clean) ? 1 : 0
  }

  process.stdout.write(renderReconcile(rendered))

  if (order.length > 0) {
    process.stdout.write('\nAgenticGit will not run these. It describes them and stops:\n')
    for (const operation of ['merge', 'rebase', 'reset --hard', 'branch -D'] as const) {
      const described = describeProtected(operation, operation === 'merge' || operation === 'rebase' ? ['agentgit/<task>', '<task>'] : [])
      process.stdout.write(`  ${operation.padEnd(14)} ${truncate(described.why, 96)}\n`)
    }
  }

  return stale.length > 0 || merge.some((pair) => !pair.clean) ? 1 : 0
}

function cmdContracts(args: ParsedArgs): number {
  const paths = workspaceOf(args)
  const registry = loadContracts(paths)
  const verb = args.subcommand ?? 'list'
  const json = args.boolean('json')

  if (verb === 'list') {
    if (json) {
      process.stdout.write(`${JSON.stringify(registry, null, 2)}\n`)
      return 0
    }
    process.stdout.write(renderContracts(registryView(registry)))
    return 0
  }

  if (verb === 'show') {
    const name = args.positionals[0]
    if (!name) throw new UsageError('contracts show needs an interface name')
    process.stdout.write(json ? `${JSON.stringify(currentVersion(registry, name), null, 2)}\n` : renderContract(registry, name))
    return currentVersion(registry, name) ? 0 : 1
  }

  if (verb === 'publish') {
    const name = args.positionals[0]
    if (!name) throw new UsageError('contracts publish needs an interface name')
    const identity = identityOf(args, 'contract')
    const summary = args.value('summary') ?? args.value('intent') ?? name

    const result = publishContract(paths, {
      name,
      summary,
      breaking: args.boolean('breaking'),
      symbol: nullable(args.value('symbol')),
      declaredIn: nullable(args.value('declared-in')),
      publishedBy: args.value('by') ?? identity.taskId,
      consumers: args.values('consumer').filter((consumer) => consumer !== 'true'),
    })

    // The published version is a fact other tasks must be able to find, so it goes
    // into the ledger as well as the registry. The registry is the source of truth;
    // the ledger event is what lets `why` explain who moved it and when.
    appendEvent(paths, buildEvent({
      kind: 'decision',
      timestampUtc: new Date().toISOString(),
      sessionId: identity.sessionId,
      taskId: identity.taskId,
      intentText: summary,
      hostEvent: 'cli',
      reason: `published ${name} v${result.contract.version}${result.contract.breaking ? ' (breaking)' : ''}`,
      detail: { contract: name, version: result.contract.version, breaking: result.contract.breaking },
    }))

    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return 0
    }
    process.stdout.write(`${name} v${result.contract.version}${result.contract.breaking ? ' (breaking)' : ' (additive)'} published by ${result.contract.publishedBy}\n`)
    if (result.newlyStale.length > 0) {
      process.stdout.write(`\nThis breaks ${result.newlyStale.length} recorded assumption(s):\n`)
      for (const entry of result.newlyStale) {
        process.stdout.write(`  ${entry.taskId} is coded against v${entry.assumedVersion}\n`)
      }
    }
    return 0
  }

  if (verb === 'assume') {
    const name = args.positionals[0]
    if (!name) throw new UsageError('contracts assume needs an interface name')
    const identity = identityOf(args, 'contract')
    const current = currentVersion(registry, name)
    const version = args.number('version', current?.version ?? 0)
    if (version === 0) {
      throw new UsageError(`${name} has never been published, so there is no version to be coded against. Publish it first.`)
    }

    recordAssumption(paths, {
      taskId: identity.taskId,
      sessionId: identity.sessionId,
      contract: name,
      version,
      recordedAt: new Date().toISOString(),
      source: 'declared',
      path: nullable(args.value('path')),
    })

    process.stdout.write(
      `${identity.taskId} recorded against ${name} v${version}` +
        `${current ? ` (current is v${current.version})` : ''}\n`,
    )
    return 0
  }

  if (verb === 'touching') {
    const target = args.positionals[0]
    if (!target) throw new UsageError('contracts touching needs a path')
    process.stdout.write(`${JSON.stringify(contractsTouchingPath(registry, target), null, 2)}\n`)
    return 0
  }

  throw new UsageError(`unknown contracts verb '${verb}'`)
}

function cmdLease(args: ParsedArgs): number {
  const paths = workspaceOf(args)
  const verb = args.subcommand ?? 'list'

  if (verb === 'list') {
    const leases = loadLeases(paths).leases
    process.stdout.write(args.boolean('json') ? `${JSON.stringify(leases, null, 2)}\n` : renderLeases(leases))
    return 0
  }

  if (verb === 'release') {
    const taskId = args.positionals[0]
    if (!taskId) throw new UsageError('lease release needs a task id')
    const { released } = releaseLease(paths, taskId, args.positionals[1])
    process.stdout.write(`released ${released.length} lease(s) held by ${taskId}\n`)
    for (const entityKey of released) process.stdout.write(`  ${entityKey}\n`)
    return 0
  }

  throw new UsageError(`unknown lease verb '${verb}'`)
}

/* -------------------------------------------------------------------------- */
/* Task lifecycle                                                              */
/* -------------------------------------------------------------------------- */

function cmdTask(args: ParsedArgs): number {
  const paths = workspaceOf(args)
  const verb = args.subcommand ?? 'list'
  const identity = identityOf(args, 'task')

  if (verb === 'list') {
    const view = buildBoardView(paths)
    process.stdout.write(args.boolean('json') ? `${JSON.stringify(view.tasks, null, 2)}\n` : renderBoard(view))
    return 0
  }

  if (verb === 'start') {
    const taskId = args.positionals[0] ?? identity.taskId
    const { branch, worktree, note } = startTask(paths, {
      taskId,
      sessionId: identity.sessionId,
      hostEvent: 'cli',
      intent: args.value('intent'),
      files: args.values('path').filter((path) => path !== 'true'),
      worktree: args.boolean('worktree', true),
    })

    process.stdout.write(`task ${taskId}\n`)
    process.stdout.write(`  branch   : ${branch ?? '(none)'}\n`)
    process.stdout.write(`  worktree : ${worktree ?? '(none)'}\n`)
    process.stdout.write(`  ${note}\n`)
    if (branch) {
      process.stdout.write('\nRegister the interfaces this task will rely on, so the plugin can tell you if they move:\n')
      process.stdout.write(`  agentgit contracts assume <name> --task ${taskId}\n`)
    }
    return 0
  }

  if (verb === 'checkpoint') {
    const taskId = args.positionals[0] ?? identity.taskId
    const explicit = args.values('path').filter((path) => path !== 'true')
    const files = explicit.length > 0 ? explicit : writtenPathsOf(paths, taskId)

    if (files.length === 0) {
      process.stdout.write(
        `Nothing to checkpoint for ${taskId}: the ledger records no write by this task.\n` +
          'Pass explicit paths with --path if the ledger has not caught up yet.\n',
      )
      return 1
    }

    const result = checkpointCommit(paths.root, files, args.value('message') ?? `checkpoint: ${taskId}`, {
      taskId,
      sessionId: identity.sessionId,
    })
    if (args.boolean('json')) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      process.stdout.write(`${result.message}\n`)
      for (const file of result.files) process.stdout.write(`  ${file}\n`)
    }
    return result.committed ? 0 : 1
  }

  if (verb === 'finish') {
    const taskId = args.positionals[0] ?? identity.taskId
    const { held, released } = finishTask(paths, { taskId, sessionId: identity.sessionId, hostEvent: 'cli' })

    const base = defaultBranch(paths.root)
    process.stdout.write(`${taskId} finished. Released ${released.length} lease(s)${held.length > 0 ? ` (${held.join(', ')})` : ''}.\n`)
    process.stdout.write('\nWhat remains is yours, and this is the whole of it:\n')
    process.stdout.write(`  git checkout ${base ?? '<base branch>'}\n`)
    process.stdout.write(`  git merge agentgit/${taskId}\n`)
    process.stdout.write(`  git worktree remove .agentgit/worktrees/${taskId}\n`)
    process.stdout.write('\nAgenticGit does not run merges. Run `agentgit reconcile` first if more than one task is open.\n')
    return 0
  }

  throw new UsageError(`unknown task verb '${verb}'`)
}

/* -------------------------------------------------------------------------- */
/* Daemon                                                                      */
/* -------------------------------------------------------------------------- */

async function cmdUp(args: ParsedArgs): Promise<number> {
  const watched = args.values('watch').filter((value) => value !== 'true')
  const roots = watched.length > 0 ? watched.map((value) => resolve(value)) : [workspaceOf(args).root]
  const port = args.number('port', 7777)

  const daemon = await import('@agentgit/daemon')

  /*
   * Reuse a daemon that is already watching one of these roots.
   *
   * `spine.mjs` starts one automatically at session start, so by the time a user types `agentgit
   * up` there is very often one already there. Two daemons on one workspace would each publish
   * their own ruling, and "one ruling per contention" only holds while exactly one thing is
   * publishing - so a covered root is reported and left alone, and only the rest go to a new board.
   */
  const covered: { root: string; url: string; pid: number }[] = []
  const uncovered: string[] = []
  for (const root of roots) {
    const record = daemon.readEndpoint(daemon.endpointPathFor(root))
    if (record && daemon.isProcessAlive(record.pid)) {
      covered.push({ root, url: record.url, pid: record.pid })
    } else {
      uncovered.push(root)
    }
  }

  for (const entry of covered) {
    process.stdout.write(`already watching  ${entry.root}\n`)
    process.stdout.write(`  board         : ${entry.url} (pid ${entry.pid})\n`)
  }

  if (uncovered.length === 0) {
    process.stdout.write(
      '\nA daemon that started with a session is already watching every workspace asked for, so\n' +
        'this command started nothing. Stop that process, or delete\n' +
        '.agentgit/state/daemon.json, to have `agentgit up` start its own.\n',
    )
    return 0
  }

  if (args.boolean('adopt')) {
    for (const root of uncovered) {
      const paths = ensureWorkspace(root)
      const result = adoptWorkspace(paths)
      process.stdout.write(
        `adopted ${result.appended} event(s) from ${result.sessions} session(s) in ${root}` +
          `${result.skippedAsDuplicate > 0 ? `, ${result.skippedAsDuplicate} already known` : ''}\n`,
      )
    }
  }

  return daemon.serve({
    roots: uncovered,
    port,
    open: args.boolean('open'),
    watch: !args.boolean('no-watch'),
    // Advertise for exactly the roots this daemon watches, so the next session in any of them
    // reuses it instead of starting a second publisher of its own.
    endpointFiles: uncovered.map((root) => daemon.endpointPathFor(root)),
  })
}

/* -------------------------------------------------------------------------- */
/* Install                                                                     */
/* -------------------------------------------------------------------------- */

function cmdInstall(args: ParsedArgs): number {
  const home = args.value('home') ?? undefined
  const report = install({
    home,
    copy: args.boolean('copy'),
    stamp: args.value('stamp') ?? undefined,
  })

  // Off by default. Writing to `config.toml` is the one part of an install that edits
  // something the user wrote and that another tool may also own, so it takes an
  // explicit flag rather than happening as a side effect of asking to install.
  const enableRequested = args.boolean('enable')
  const config = enableRequested ? writePluginEnabled({ home, enabled: true }) : null

  if (args.boolean('json')) {
    process.stdout.write(
      `${JSON.stringify({ ...installReportJson(report), config: config ?? null }, null, 2)}\n`,
    )
    return 0
  }

  process.stdout.write('AgenticGit plugin installed\n\n')
  process.stdout.write(`  plugin      : ${report.paths.target}\n`)
  process.stdout.write(`  link        : ${report.link.kind} - ${report.link.detail}\n`)
  process.stdout.write(`  hooks       : ${report.files.hooks}\n`)
  process.stdout.write(`  mcp         : ${report.files.mcp}\n`)
  process.stdout.write(`  spine       : ${report.files.spine}\n`)
  process.stdout.write(`  marketplace : ${report.marketplace.file}${report.marketplace.created ? ' (created)' : ''}\n`)
  process.stdout.write(`  version     : ${report.version.from} -> ${report.version.to}\n`)
  process.stdout.write(`                (the cachebuster; without a change here Codex keeps the cached copy)\n`)
  process.stdout.write(`  node        : ${report.files.node}${report.files.flags.length > 0 ? ` ${report.files.flags.join(' ')}` : ''}\n`)

  if (config) {
    process.stdout.write(`  config      : ${config.detail}\n`)
    process.stdout.write(`                ${config.file}\n`)
  }

  if (config) {
    process.stdout.write('\nOne step is left, and it is yours because it changes your configuration:\n\n')
    process.stdout.write('  1. Register the plugin in its marketplace:\n')
    process.stdout.write(`       ${report.installCommand}\n`)
    process.stdout.write('\n  Then start a NEW Codex session. Hooks are read when a session starts, so a\n')
    process.stdout.write('  session that is already open will record nothing. If Codex asks you to review\n')
    process.stdout.write('  and trust the hook handlers, accept: an untrusted handler never runs, and the\n')
    process.stdout.write('  spine handler is what starts the daemon the hub publishes from.\n')
  } else {
    process.stdout.write('\nTwo steps are left, and both are yours because both change your configuration:\n\n')
    process.stdout.write('  1. Register the plugin in its marketplace:\n')
    process.stdout.write(`       ${report.installCommand}\n`)
    process.stdout.write('\n  2. Enable it in ~/.codex/config.toml:\n')
    for (const line of report.enableLine.split('\n')) process.stdout.write(`       ${line}\n`)
    process.stdout.write('\n  Or let this command do step 2 for you:\n')
    process.stdout.write('       agentgit install --enable\n')
    process.stdout.write('\n  Then start a NEW Codex session. Hooks are read when a session starts, so a\n')
    process.stdout.write('  session that is already open will record nothing. If Codex asks you to review\n')
    process.stdout.write('  and trust the hook handlers, accept: an untrusted handler never runs, and the\n')
    process.stdout.write('  spine handler is what starts the daemon the hub publishes from.\n')
  }

  if (report.warnings.length > 0) {
    process.stdout.write('\nWorth knowing:\n')
    for (const warning of report.warnings) process.stdout.write(`  - ${warning}\n`)
  }

  process.stdout.write('\nVerify with: agentgit doctor\n')
  return 0
}

function cmdUninstall(args: ParsedArgs): number {
  const home = args.value('home') ?? undefined
  const report = uninstall({ home })
  // Disabling writes `enabled = false` rather than deleting the section: a visible
  // switch that is off is better than a file that silently changed shape.
  const config = args.boolean('disable') ? writePluginEnabled({ home, enabled: false }) : null

  if (args.boolean('json')) {
    process.stdout.write(`${JSON.stringify({ ...report, config: config ?? null }, null, 2)}\n`)
    return 0
  }

  process.stdout.write('AgenticGit plugin removed\n\n')
  for (const item of report.removed) process.stdout.write(`  removed : ${item}\n`)
  for (const item of report.kept) process.stdout.write(`  kept    : ${item}\n`)

  if (config) {
    process.stdout.write(`  config  : ${config.detail}\n`)
    process.stdout.write(`            ${config.file}\n`)
  } else {
    process.stdout.write(`\n~/.codex/config.toml still contains:\n  ${report.enableLine}\n`)
    process.stdout.write('It is still enabled. Run `agentgit uninstall --disable` to switch it off, or the next\n')
    process.stdout.write('session will look for a plugin that is gone.\n')
  }

  process.stdout.write('\nYour ledger under .agentgit/ was left untouched.\n')
  return 0
}

function cmdDoctor(args: ParsedArgs): number {
  const report = runDoctor({ home: args.value('home') ?? undefined })
  if (args.boolean('json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(renderDoctor(report.checks, report.version))
  }
  return report.checks.every((check) => check.ok) ? 0 : 1
}

/* -------------------------------------------------------------------------- */
/* Demo                                                                        */
/* -------------------------------------------------------------------------- */

async function cmdDemo(args: ParsedArgs): Promise<number> {
  const { runDemo } = await import('@agentgit/daemon')
  return runDemo({ workspace: workspaceOf(args).root, json: args.boolean('json') })
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `agentgit config` — read and change what the product does.
 *
 * Three shapes, one command: with no key it lists everything and what each does, with a key
 * it shows that one, with a key and a value it changes it. The value is parsed and validated
 * before anything is written, so a rejected setting leaves the file exactly as it was
 * rather than half-applied.
 *
 * Nothing here needs a separate command per setting. `git config` is the model: one verb, a
 * key, an optional value, and the whole surface discoverable by asking with no arguments.
 */
function cmdConfig(args: ParsedArgs): number {
  const paths = workspaceOf(args)
  const current = loadConfig(paths)

  if (args.boolean('arms')) {
    const arms = describeArms(current.arm)
    process.stdout.write(
      args.boolean('json') ? `${JSON.stringify(arms, null, 2)}\n` : renderArms(arms),
    )
    return 0
  }

  const key = args.subcommand
  const rows = describeTunables(current, DEFAULT_CONFIG)

  // No key: show everything, with what each one does.
  if (key === null) {
    process.stdout.write(args.boolean('json') ? `${JSON.stringify(rows, null, 2)}\n` : renderConfig(rows))
    return 0
  }

  const row = rows.find((candidate) => candidate.key === key)
  if (!row) {
    throw new UsageError(
      `unknown setting '${key}'. Known settings: ${rows.map((candidate) => candidate.key).join(', ')}`,
    )
  }

  const next = args.positionals[0]
  // Key with no value: report the current one. Same output shape as the list, so a caller
  // that reads one setting and a caller that reads all of them parse the same way.
  if (next === undefined) {
    process.stdout.write(args.boolean('json') ? `${JSON.stringify(row, null, 2)}\n` : renderConfig([row]))
    return 0
  }

  const parsed = parseTunable(key, next)
  const written = updateConfig(paths, { [parsed.key]: parsed.value } as Partial<WorkspaceConfig>)
  const after = describeTunables(written, DEFAULT_CONFIG).find((candidate) => candidate.key === key)!

  if (args.boolean('json')) {
    process.stdout.write(`${JSON.stringify({ file: paths.config, ...after }, null, 2)}\n`)
    return 0
  }
  process.stdout.write(`${key} = ${String(after.value)}\n`)
  if (after.note) process.stdout.write(`  ${after.note}\n`)
  process.stdout.write(`  written to ${paths.config}\n`)
  return 0
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function nullable(value: string | null): string | null {
  if (value === null || value.trim() === '' || value === 'true') return null
  return value
}

function fileUrl(path: string): string {
  return `file:///${path.replace(/\\/g, '/')}`
}

function openInBrowser(url: string): boolean {
  const [command, argv] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(command, argv, { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

/** Exported so tests can drive the dispatcher without spawning a process. */
export { main }

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`agentgit: ${error.message}\n`)
      process.exitCode = 2
      return
    }
    /*
     * A domain error gets its message, not its stack.
     *
     * Everything this tool throws about a bad setting, a refused operation or an unreadable
     * config is a sentence written for a person, and burying it under eight frames of
     * `file:///` paths makes a fixable typo look like a crash. `AGENTGIT_DEBUG` restores the
     * stack, so the frames are still one environment variable away when they are what is
     * wanted.
     */
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`agentgit: ${message}\n`)
    if (process.env.AGENTGIT_DEBUG === '1' && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`)
    }
    process.exitCode = 2
  })

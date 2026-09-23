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
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  adoptWorkspace,
  appendEvent,
  buildBoardView,
  buildEvent,
  checkpointCommit,
  contractsTouchingPath,
  currentBranch,
  currentVersion,
  defaultBranch,
  DEFAULT_CONFIG,
  describeArms,
  describeProtected,
  describeTunables,
  ensureWorkspace,
  ensureWorktree,
  findWorkspaceRoot,
  heldBy,
  integrationOrder,
  isDirty,
  keyOf,
  kindOfVerdict,
  loadAssumptions,
  loadConfig,
  loadContracts,
  loadLeases,
  machineId,
  mergeTreePreview,
  parseTunable,
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
  updateConfig,
  worktreeList,
  type Entity,
  type WorkspaceConfig,
  type WorkspacePaths,
} from '@agentgit/core'

import { defaultPanelDir, panelMarkdown, truncate, writePanel } from '@agentgit/board'

import { USAGE, parseArgs, type ParsedArgs } from './args.ts'
import { install, installReportJson, runDoctor, uninstall, writePluginEnabled } from './install.ts'
import {
  renderArms,
  renderBoard,
  renderConfig,
  renderContract,
  renderContracts,
  renderDoctor,
  renderLeases,
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
    case 'board':
      return cmdBoard(args)
    case 'panel':
      return cmdPanel(args)
    case 'preflight':
      return cmdPreflight(args)
    case 'why':
      return cmdWhy(args)
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
  const explicit = args.value('workspace') ?? process.env.AGENTGIT_WORKSPACE ?? null
  const root = explicit ? resolve(explicit) : findWorkspaceRoot(process.cwd())
  if (!existsSync(root)) throw new UsageError(`workspace does not exist: ${root}`)
  return ensureWorkspace(root)
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
    entityPath: symbol ? undefined : targets[0],
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

function cmdReconcile(args: ParsedArgs): number {
  const paths = workspaceOf(args)
  const registry = loadContracts(paths)
  const stale = staleAssumptions(loadAssumptions(paths), registry)

  // Task branches come from Git rather than from the ledger: a branch that exists is
  // work that exists, whether or not anything recorded it.
  const view = buildBoardView(paths)
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
    loadAssumptions(paths).assumptions.map((assumption) => ({ taskId: assumption.taskId, contract: assumption.contract })),
    publishedBy,
  )

  const merge: { a: string; b: string; clean: boolean; message: string }[] = []
  for (let i = 0; i < branches.length; i += 1) {
    for (let j = i + 1; j < branches.length; j += 1) {
      const preview = mergeTreePreview(paths.root, branches[i].branch, branches[j].branch)
      merge.push({
        a: branches[i].taskId,
        b: branches[j].taskId,
        clean: preview.clean,
        message: preview.supported
          ? preview.clean
            ? 'no textual conflict'
            : `${preview.conflicts.length} conflicting path(s)`
          : preview.message,
      })
    }
  }

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

  if (branches.length > 0) {
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
    const intent = args.value('intent')
    const declared = args.values('path')
      .filter((path) => path !== 'true')
      .map((path) => toWorkspaceRelative(paths.root, path) ?? path)

    let worktree: string | null = null
    let branch: string | null = null
    let note = 'no worktree requested'
    if (args.boolean('worktree', true)) {
      try {
        const ensured = ensureWorktree(paths.root, taskId)
        worktree = ensured.path
        branch = ensured.branch
        note = ensured.message
      } catch (error) {
        // A repository with no commits yet cannot host a worktree. That is a normal
        // first-run state, not an error: the task is still worth registering.
        note = `no worktree: ${(error as Error).message}`
      }
    }

    appendEvent(paths, buildEvent({
      kind: 'task_registered',
      timestampUtc: new Date().toISOString(),
      sessionId: identity.sessionId,
      taskId,
      entities: declared.map((path) => ({ kind: 'file', identifier: path, path })),
      intentText: intent,
      hostEvent: 'cli',
      reason: note,
      detail: { worktree, branch },
    }))

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

    const result = checkpointCommit(paths.root, files, args.value('message') ?? `checkpoint: ${taskId}`)
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
    const held = heldBy(paths, taskId)
    const { released } = releaseLease(paths, taskId)

    appendEvent(paths, buildEvent({
      kind: 'lifecycle_validated',
      timestampUtc: new Date().toISOString(),
      sessionId: identity.sessionId,
      taskId,
      hostEvent: 'cli',
      reason: `released ${released.length} lease(s)`,
    }))

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

/** Every workspace-relative path this task has written, newest last. */
function writtenPathsOf(paths: WorkspacePaths, taskId: string): string[] {
  const { events } = readAllEvents(paths)
  const seen = new Set<string>()
  for (const event of events) {
    if (event.taskId !== taskId) continue
    if (event.kind !== 'file_write') continue
    for (const entity of event.entities ?? []) {
      const path = entity.path ?? entity.identifier
      if (path) seen.add(path)
    }
  }
  return [...seen].sort()
}

/* -------------------------------------------------------------------------- */
/* Daemon                                                                      */
/* -------------------------------------------------------------------------- */

async function cmdUp(args: ParsedArgs): Promise<number> {
  const watched = args.values('watch').filter((value) => value !== 'true')
  const roots = watched.length > 0 ? watched.map((value) => resolve(value)) : [workspaceOf(args).root]
  const port = args.number('port', 7777)

  const daemon = await import('@agentgit/daemon')

  if (args.boolean('adopt')) {
    for (const root of roots) {
      const paths = ensureWorkspace(root)
      const result = adoptWorkspace(paths)
      process.stdout.write(
        `adopted ${result.appended} event(s) from ${result.sessions} session(s) in ${root}` +
          `${result.skippedAsDuplicate > 0 ? `, ${result.skippedAsDuplicate} already known` : ''}\n`,
      )
    }
  }

  return daemon.serve({
    roots,
    port,
    open: args.boolean('open'),
    watch: !args.boolean('no-watch'),
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
    process.stdout.write('  session that is already open will record nothing.\n')
  } else {
    process.stdout.write('\nTwo steps are left, and both are yours because both change your configuration:\n\n')
    process.stdout.write('  1. Register the plugin in its marketplace:\n')
    process.stdout.write(`       ${report.installCommand}\n`)
    process.stdout.write('\n  2. Enable it in ~/.codex/config.toml:\n')
    for (const line of report.enableLine.split('\n')) process.stdout.write(`       ${line}\n`)
    process.stdout.write('\n  Or let this command do step 2 for you:\n')
    process.stdout.write('       agentgit install --enable\n')
    process.stdout.write('\n  Then start a NEW Codex session. Hooks are read when a session starts, so a\n')
    process.stdout.write('  session that is already open will record nothing.\n')
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

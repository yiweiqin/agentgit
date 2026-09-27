/**
 * The live board, and the coordination hub's spine.
 *
 * Why a daemon exists at all, given that the panel already exists
 * -----------------------------------------------------------------
 * The conversation sandbox forbids `fetch`, XHR and WebSocket, and its content policy
 * allows only a short list of CDNs. A panel that tried to poll would fail silently and
 * show a permanently empty table, which is worse than showing nothing. So the panel is
 * a snapshot that is correct at the moment it was written, and everything that has to
    10| * be true *now* lives here, on `localhost`, where none of those restrictions apply.
 *
 * Two properties make this safe to leave running:
 *
 * - **It reads, and it publishes one conclusion at a time.** The daemon calls
 *   {@link buildBoardView} and, for the hub, {@link computeHubVerdict}. It writes no lease
 *   and no contract, and it never refuses anything. What it does write is a single
 *   `advisory_injected` ledger event *when a ruling actually changes* — that event is the
 *   hub's conclusion, so it has to outlive the process. Deleting the process loses nothing
 *   that has already been concluded; a restart reads the last published ruling back and
 *   publishes nothing again. `--no-publish` restores the strictly read-only behaviour.
 * - **It binds to the loopback interface only.** A coordination board names internal
 *   file paths and describes unmerged work. Exposing that to the network by default
 *   would be a real leak, so `0.0.0.0` is deliberately not offered.
 * - **Change detection is by file signature, not by trust.** Shards are watched by
 *   size and mtime, so a write from an editor, a `git checkout` or a second agent is
 *   picked up even though nothing told the daemon about it.
 *
 * @module @agentgit/daemon/serve
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import {
  adoptWorkspace,
  buildBoardView,
  buildGraphView,
  ensureWorkspace,
  explainCommit,
  type GraphView,
  type HubVerdict,
  type WorkspacePaths,
} from '@agentgit/core'
import { explanationMarkdown, renderBoardPage, renderEmptyPage, renderPanel } from '@agentgit/board'
import { renderAppPanel } from '@agentgit/app'

import { createHubPublisher } from './hub.ts'
import { createChecksDispatcher } from './checks.ts'
import { removeEndpoint, writeEndpoint } from './endpoint.ts'

export interface ServeOptions {
  readonly roots: readonly string[]
  readonly port: number
  readonly open?: boolean
  /** Adopt Codex session transcripts on a timer. Defaults to true. */
  readonly watch?: boolean
  /** Milliseconds between change checks. Defaults to 2000. */
  readonly intervalMs?: number
  /** Milliseconds between session adoptions. Defaults to 15000. */
  readonly adoptIntervalMs?: number
  /** Set by tests to run without holding the process open. */
  readonly quiet?: boolean
  /**
   * Publish rulings to the ledger. Defaults to true.
   *
   * Off restores the strictly read-only daemon: the projection is still refreshed so readers
   * see the current conclusion, and nothing is appended. Useful for watching a workspace whose
   * ledger someone else owns.
   */
  readonly publish?: boolean
  /**
   * Where to advertise this daemon's pid and bound port - one file per watched workspace.
   *
   * Whoever starts a daemon writes it: the automatic spine (`plugins/agentgit/scripts/spine.mjs`)
   * and `agentgit up` alike. That symmetry is the point. If only the spine advertised, then a
   * human who ran `agentgit up` first would be invisible to the next session, which would start a
   * second daemon on the same workspace - and "one ruling per contention" only holds while exactly
   * one thing is publishing.
   */
  readonly endpointFiles?: readonly string[]
}

interface WatchedWorkspace {
  readonly id: string
  readonly paths: WorkspacePaths
}

interface BoardState {
  readonly fingerprint: string
  readonly html: string
  readonly generatedAt: string
  readonly view: ReturnType<typeof buildBoardView>
  /** The hub's ruling as of this rebuild. `null` only if computing it failed. */
  readonly hub: HubVerdict | null
}

type Listener = (state: BoardState) => void

/**
 * The commit graph, cached briefly.
 *
 * Separate from {@link BoardState} because the two change for different reasons. The board
 * fragment is rebuilt when a ledger shard changes, which the fingerprint detects cheaply. A
 * commit graph also changes when a `git commit` or a branch move happens, which writes no
 * ledger line — and detecting that needs the repository's HEAD, which is a `git rev-parse`
 * per tick. Rather than pay that on a 2-second timer, the graph is built on request and
 * memoized for a second: the panel polls every four, so a poll almost never pays twice, and
 * a commit shows up within one poll even when nothing was written to the ledger.
 */
interface GraphCache {
  readonly at: number
  readonly graph: GraphView
}

const GRAPH_TTL_MS = 1000

export interface BoardServer {
  /** The URL to open. Always loopback. */
  readonly url: string
  /** The port actually bound, which is not `options.port` when `0` was asked for. */
  readonly port: number
  readonly ids: readonly string[]
  readonly workspaces: readonly { readonly id: string; readonly root: string }[]
  /** Where this daemon advertised itself, one entry per watched workspace. */
  readonly endpointFiles: readonly string[]
  /**
   * Stop polling, end every open event stream, and release the port.
   *
   * Idempotent, because the two callers are a signal handler and a test teardown, and
   * either can fire twice.
   */
  close(): Promise<void>
}

/**
 * A cheap signature of everything the board depends on.
 *
 * Deliberately not a hash of the rendered output: that would require rendering on every
 * tick, and rendering on every tick is what makes a "real-time" board burn a core. This
 * reads directory entries and a few `stat` calls, which is enough because every source
 * of change here is a file append or a file replace.
 */
function fingerprintOf(paths: WorkspacePaths): string {
  const parts: string[] = []

  if (existsSync(paths.events)) {
    for (const name of readdirSync(paths.events).sort()) {
      if (!name.endsWith('.jsonl')) continue
      try {
        const stat = statSync(`${paths.events}/${name}`)
        parts.push(`e:${name}:${stat.size}:${stat.mtimeMs}`)
      } catch {
        // A file removed between listing and stat is not an error; the next tick sees
        // the new state.
      }
    }
  }

  for (const [label, file] of [
    ['c', `${paths.contracts}/index.json`],
    ['l', `${paths.state}/leases.json`],
    ['a', `${paths.state}/assumptions.json`],
    ['g', paths.config],
  ] as const) {
    try {
      const stat = statSync(file)
      parts.push(`${label}:${stat.size}:${stat.mtimeMs}`)
    } catch {
      parts.push(`${label}:-`)
    }
  }

  return parts.join('|')
}

/** Workspace ids are directory names, made unique when two roots share one. */
function assignIds(roots: readonly string[]): string[] {
  const taken = new Map<string, number>()
  return roots.map((root) => {
    const base = basename(resolve(root)) || 'workspace'
    const seen = taken.get(base) ?? 0
    taken.set(base, seen + 1)
    return seen === 0 ? base : `${base}-${seen + 1}`
  })
}

/**
 * Start the board and return a handle, without waiting for anything.
 *
 * Split out of {@link serve} so the running board can be reached from a test or from a
 * host that wants to embed it. Before this, the only way to stop the server was to signal
 * the process, which meant no test could start one without taking the test runner down
 * with it — which is why this package had no tests and why a stray board could sit on
 * port 7777 across an entire session without anyone noticing.
 */
export async function startBoard(options: ServeOptions): Promise<BoardServer> {
  const roots = options.roots.map((root) => resolve(root))
  const ids = assignIds(roots)
  const watched: WatchedWorkspace[] = roots.map((root, index) => ({
    id: ids[index],
    paths: ensureWorkspace(root),
  }))

  const states = new Map<string, BoardState>()
  const listeners = new Map<string, Set<Listener>>()
  /**
   * Open SSE responses, kept so shutdown can end them.
   *
   * `server.close()` waits for open connections, and an `EventSource` holds one open
   * indefinitely. Without this, Ctrl+C would appear to hang until the browser tab was
   * closed, which reads as a daemon that will not stop.
   */
  const streams = new Set<ServerResponse>()
  const graphs = new Map<string, GraphCache>()

  /**
   * The graph for one workspace, memoized for {@link GRAPH_TTL_MS}.
   *
   * `buildGraphView` is read-only, so a concurrent request racing this one produces the
   * same answer; the cache exists to keep a poll from running `git log` and a `git status`
   * per worktree more often than the display can change.
   */
  const graphFor = (workspace: WatchedWorkspace): GraphView => {
    const now = Date.now()
    const cached = graphs.get(workspace.id)
    if (cached && now - cached.at < GRAPH_TTL_MS) return cached.graph
    const graph = buildGraphView(workspace.paths)
    graphs.set(workspace.id, { at: now, graph })
    return graph
  }

  /*
   * One publisher per daemon, shared by every watched workspace.
   *
   * It owns the three things a pure function cannot: the memory of what was last published
   * (seeded from the ledger, so a restart republishes nothing), a one-second cache of the `git`
   * reads the integration order needs, and the containment that turns a defect here into "no
   * ruling" rather than into a board that will not render. See `./hub.ts`.
   */
  const hubPublisher = createHubPublisher({ publish: options.publish })
  const checksDispatcher = createChecksDispatcher()

  const hubFor = (workspace: WatchedWorkspace, view: ReturnType<typeof buildBoardView>): HubVerdict | null =>
    hubPublisher.rule(workspace.id, workspace.paths, view)

  const rebuild = (workspace: WatchedWorkspace): BoardState => {
    const view = buildBoardView(workspace.paths)
    const hub = hubFor(workspace, view)
    const state: BoardState = {
      fingerprint: fingerprintOf(workspace.paths),
      html: renderPanel(view),
      generatedAt: view.generatedAt,
      view,
      hub,
    }
    states.set(workspace.id, state)
    return state
  }

  const broadcast = (id: string, state: BoardState): void => {
    for (const listener of listeners.get(id) ?? []) listener(state)
  }

  for (const workspace of watched) rebuild(workspace)

  const tick = (): void => {
    for (const workspace of watched) {
      const next = fingerprintOf(workspace.paths)
      const previous = states.get(workspace.id)
      if (!previous || previous.fingerprint !== next) broadcast(workspace.id, rebuild(workspace))
      // Queue/timeout changes do not touch the ledger. Check even when its fingerprint is stable.
      if (options.publish !== false) void checksDispatcher.tick(workspace.paths).catch(() => {
        // A busy or corrupt queue must never interrupt a board tick. Its state is retained.
      })
    }
  }

  const intervalMs = options.intervalMs ?? 2000
  const poll = setInterval(tick, intervalMs)

  // Session adoption is slower than the ledger poll on purpose: it walks every rollout
  // file for the workspace, and the event ids it writes are content hashes, so running
  // it more often would cost more and add nothing.
  let adoption: NodeJS.Timeout | null = null
  if (options.watch !== false) {
    adoption = setInterval(() => {
      for (const workspace of watched) {
        try {
          adoptWorkspace(workspace.paths)
        } catch {
          // A transcript format change must never take the board down. Degrading to
          // hooks-only is the documented behaviour; the ledger keeps working either way.
        }
      }
      tick()
    }, options.adoptIntervalMs ?? 15_000)
  }

  const server = createHttpServer((request, response) => {
    try {
      handleRequest(request, response, { watched, states, listeners, streams, rebuild, graphFor })
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`agentgit daemon: ${(error as Error).message}\n`)
    }
  })

  const port = await listen(server, options.port)
  const workspaces = watched.map((workspace) => ({ id: workspace.id, root: workspace.paths.root }))

  /*
   * Advertise as soon as the port is known.
   *
   * This has to happen after `listen`, because the whole point is to record the port the kernel
   * actually chose for `--port 0`. It is best effort per file: a workspace whose state directory is
   * not writable still gets a working board, and the only consequence of a failed write is that the
   * spine may start one more daemon than it strictly needed.
   */
  const endpointFiles = [...(options.endpointFiles ?? [])]
  for (const file of endpointFiles) {
    try {
      writeEndpoint(file, {
        pid: process.pid,
        port,
        url: `http://localhost:${port}`,
        roots,
        startedAt: new Date().toISOString(),
      })
    } catch {
      // See above: advertising is best effort, never a reason to fail the board.
    }
  }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    clearInterval(poll)
    if (adoption) clearInterval(adoption)
    // Before releasing the port, so a reader that sees the port free also stops seeing a pid. Each
    // removal is ownership-checked, so stopping one board cannot delete another board's record.
    for (const file of endpointFiles) removeEndpoint(file)
    // Ending each stream before closing the server is what stops `close()` from waiting
    // on a browser tab that may never go away.
    for (const stream of streams) {
      try {
        stream.end()
      } catch {
        // Already closed; nothing to do.
      }
    }
    streams.clear()
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise())
      // A socket that was mid-write when the stream ended can keep the server open.
      server.closeAllConnections?.()
    })
  }

  return {
    url: `http://localhost:${port}`,
    port,
    ids,
    workspaces,
    endpointFiles,
    close,
  }
}

/**
 * Start the board, print where it is, and run until interrupted.
 *
 * The CLI entry point. Everything it does beyond {@link startBoard} is presentation and
 * signal handling.
 */
export async function serve(options: ServeOptions): Promise<number> {
  const board = await startBoard(options)

  if (!options.quiet) {
    process.stdout.write(`AgenticGit board: ${board.url}\n`)
    for (const workspace of board.workspaces) {
      process.stdout.write(`  ${workspace.id.padEnd(20)} ${workspace.root}\n`)
    }
    process.stdout.write('\nBound to the loopback interface only. Press Ctrl+C to stop.\n')
  }

  if (options.open) openInBrowser(board.url)

  await new Promise<void>((resolvePromise) => {
    const stop = (): void => {
      void board.close().then(() => resolvePromise())
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })

  return 0
}

interface RequestContext {
  readonly watched: readonly WatchedWorkspace[]
  readonly states: Map<string, BoardState>
  readonly listeners: Map<string, Set<Listener>>
  readonly streams: Set<ServerResponse>
  readonly rebuild: (workspace: WatchedWorkspace) => BoardState
  readonly graphFor: (workspace: WatchedWorkspace) => GraphView
}

function resolveWorkspace(context: RequestContext, url: URL): WatchedWorkspace | null {
  const wanted = url.searchParams.get('w')
  if (!wanted) return context.watched[0] ?? null
  return context.watched.find((workspace) => workspace.id === wanted) ?? null
}

function handleRequest(request: IncomingMessage, response: ServerResponse, context: RequestContext): void {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const workspace = resolveWorkspace(context, url)

  if (!workspace) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(renderEmptyPage('Start the daemon from a workspace, or pass --watch <path>.'))
    return
  }

  if (url.pathname === '/events') {
    streamEvents(request, response, workspace, context)
    return
  }

  if (url.pathname === '/api/panel') {
    const state = context.states.get(workspace.id) ?? context.rebuild(workspace)
    respondJson(response, { workspace: workspace.id, html: state.html, generatedAt: state.generatedAt })
    return
  }

  if (url.pathname === '/api/board') {
    const state = context.states.get(workspace.id) ?? context.rebuild(workspace)
    respondJson(response, state.view)
    return
  }

  if (url.pathname === '/api/hub') {
    // The same bytes every window reads, which is what makes "one conclusion" checkable
    // rather than merely asserted: two clients polling this endpoint see one ruling.
    const state = context.states.get(workspace.id) ?? context.rebuild(workspace)
    respondJson(response, {
      workspace: workspace.id,
      root: workspace.paths.root,
      hub: state.hub ?? null,
    })
    return
  }

  if (url.pathname === '/api/graph') {
    respondJson(response, context.graphFor(workspace))
    return
  }

  if (url.pathname === '/api/explain') {
    const reference = url.searchParams.get('oid') ?? url.searchParams.get('task') ?? ''
    const graph = context.graphFor(workspace)
    const explanation = explainCommit(graph, workspace.paths, reference)
    respondJson(response, {
      workspace: workspace.id,
      found: explanation.found,
      oid: explanation.oid,
      text: explanationMarkdown(explanation),
      explanation,
    })
    return
  }

  if (url.pathname === '/panel') {
    // The panel served from here reads this origin and nothing else, which is why every
    // fetch the runtime makes is a same-origin path rather than a call to the bridge.
    const html = renderAppPanel({
      workspaceName: basename(workspace.paths.root) || workspace.id,
      workspaceId: workspace.id,
      transport: 'http',
      httpBase: '',
      intervalMs: 2000,
    })
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(html)
    return
  }

  if (url.pathname === '/healthz') {
    respondJson(response, {
      ok: true,
      workspaces: context.watched.map((candidate) => ({
        id: candidate.id,
        root: candidate.paths.root,
        // Named here so a script can tell "the hub has ruled" from "the hub is up" without
        // pulling the whole ruling.
        hubId: context.states.get(candidate.id)?.hub?.id ?? null,
      })),
    })
    return
  }

  // Everything else is the board itself, rendered server-side so the page has content
  // before any script runs. A blank shell that fills in later is what makes a dashboard
  // look broken on a slow machine.
  const state = context.states.get(workspace.id) ?? context.rebuild(workspace)
  const html = renderBoardPage({
    workspace: workspace.paths.root,
    workspaceId: workspace.id,
    workspaces: context.watched.map((candidate) => ({
      id: candidate.id,
      root: candidate.paths.root,
      active: candidate.id === workspace.id,
    })),
    initialHtml: state.html,
  })

  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(html)
}

/**
 * Server-sent events.
 *
 * SSE rather than WebSocket because the traffic is one-directional and the browser half
 * is three lines of `EventSource` with automatic reconnection, which a hand-rolled
 * WebSocket client would have to reimplement badly.
 */
function streamEvents(
  request: IncomingMessage,
  response: ServerResponse,
  workspace: WatchedWorkspace,
  context: RequestContext,
): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    // Without this a proxy can buffer the stream and the board silently stops updating.
    'x-accel-buffering': 'no',
  })

  const current = context.states.get(workspace.id) ?? context.rebuild(workspace)
  response.write(`data: ${JSON.stringify(frameOf(current))}\n\n`)

  const listener: Listener = (state) => {
    response.write(`data: ${JSON.stringify(frameOf(state))}\n\n`)
  }

  const set = context.listeners.get(workspace.id) ?? new Set<Listener>()
  set.add(listener)
  context.listeners.set(workspace.id, set)
  context.streams.add(response)

  // A comment frame every 25 seconds. An idle SSE connection is closed by some
  // intermediate proxies after 30 seconds of silence, and a board that dies when nobody
  // is editing is exactly when nobody is watching to notice.
  const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 25_000)

  const cleanup = (): void => {
    clearInterval(keepAlive)
    set.delete(listener)
    context.streams.delete(response)
  }
  request.on('close', cleanup)
  request.on('error', cleanup)
  response.on('error', cleanup)
}

function respondJson(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(`${JSON.stringify(payload)}\n`)
}

/**
 * One SSE frame.
 *
 * Carries the hub ruling alongside the panel fragment, because a frame is a "the workspace
 * changed" signal and the ruling is part of what changed. That makes the stream the second
 * way a ruling reaches a reader that is not an agent, next to `/api/hub`.
 */
function frameOf(state: BoardState): Record<string, unknown> {
  return {
    html: state.html,
    generatedAt: state.generatedAt,
    hubId: state.hub?.id ?? null,
    hub: state.hub,
  }
}

/** Bind, and report the port actually used when `0` was requested. */
function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolvePromise(typeof address === 'object' && address ? address.port : port)
    })
  })
}

function openInBrowser(url: string): void {
  // Imported lazily so the daemon's HTTP path has no dependency on process spawning.
  void import('node:child_process').then(({ spawn }) => {
    const [command, argv] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]]
    try {
      const child = spawn(command, argv, { detached: true, stdio: 'ignore' })
      child.unref()
    } catch {
      process.stdout.write(`Open ${url} in a browser.\n`)
    }
  })
}

export { fingerprintOf, assignIds }

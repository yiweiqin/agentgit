/**
 * The live board: an HTTP server for one or more workspaces.
 *
 * Why a daemon exists at all, given that the panel already exists
 * -----------------------------------------------------------------
 * The conversation sandbox forbids `fetch`, XHR and WebSocket, and its content policy
 * allows only a short list of CDNs. A panel that tried to poll would fail silently and
 * show a permanently empty table, which is worse than showing nothing. So the panel is
 * a snapshot that is correct at the moment it was written, and everything that has to
 * be true *now* lives here, on `localhost`, where none of those restrictions apply.
 *
 * Three properties make this safe to leave running:
 *
 * - **It only reads.** The daemon calls {@link buildBoardView} and writes no ledger,
 *   no lease and no contract. Deleting the process loses nothing.
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

import { adoptWorkspace, buildBoardView, ensureWorkspace, type WorkspacePaths } from '@agentgit/core'
import { renderBoardPage, renderEmptyPage, renderPanel } from '@agentgit/board'

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
}

type Listener = (state: BoardState) => void

export interface BoardServer {
  /** The URL to open. Always loopback. */
  readonly url: string
  /** The port actually bound, which is not `options.port` when `0` was asked for. */
  readonly port: number
  readonly ids: readonly string[]
  readonly workspaces: readonly { readonly id: string; readonly root: string }[]
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

  const rebuild = (workspace: WatchedWorkspace): BoardState => {
    const view = buildBoardView(workspace.paths)
    const state: BoardState = {
      fingerprint: fingerprintOf(workspace.paths),
      html: renderPanel(view),
      generatedAt: view.generatedAt,
      view,
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
      if (previous && previous.fingerprint === next) continue
      broadcast(workspace.id, rebuild(workspace))
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
      handleRequest(request, response, { watched, states, listeners, streams, rebuild })
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`agentgit daemon: ${(error as Error).message}\n`)
    }
  })

  const port = await listen(server, options.port)
  const workspaces = watched.map((workspace) => ({ id: workspace.id, root: workspace.paths.root }))

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    clearInterval(poll)
    if (adoption) clearInterval(adoption)
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

  if (url.pathname === '/healthz') {
    respondJson(response, {
      ok: true,
      workspaces: context.watched.map((candidate) => ({ id: candidate.id, root: candidate.paths.root })),
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
  response.write(`data: ${JSON.stringify({ html: current.html, generatedAt: current.generatedAt })}\n\n`)

  const listener: Listener = (state) => {
    response.write(`data: ${JSON.stringify({ html: state.html, generatedAt: state.generatedAt })}\n\n`)
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

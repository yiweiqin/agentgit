/**
 * The MCP server: request dispatch and nothing else.
 *
 * The tool surface is described in `./tools.ts`; this file only decides how a request
 * becomes a response. It is deliberately small, because the interesting failures here
 * are protocol ones — a response with no `id`, a notification answered with a result,
 * a tool failure reported as a transport failure — and each of those is visible in a
 * short function and invisible in a long one.
 *
 * @module @agentgit/mcp/server
 */

import type { Readable, Writable } from 'node:stream'

import { describeIdentity, resolveIdentity, type Identity, type ResolveInput } from './context.ts'
import {
  ErrorCodes,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  ToolError,
  failure,
  serveStdio,
  success,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './protocol.ts'
import { findTool, toolDescriptors } from './tools.ts'

export const SERVER_NAME = 'agentgit'
export const SERVER_VERSION = '0.1.0'

export interface ServerOptions {
  /** Force a workspace, ignoring discovery. Normally used by tests. */
  readonly workspace?: string
  /** Override the clock, so tests can pin lease expiry. */
  readonly now?: () => Date
}

export interface Server {
  handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null>
  serve(options: { input: Readable; output: Writable }): Promise<void>
  resolveIdentity(input?: ResolveInput): Identity
}

export function createServer(options: ServerOptions = {}): Server {
  const clock = options.now ?? (() => new Date())

  const identityFrom = (request: JsonRpcRequest): Identity => {
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>
    const asString = (value: unknown): string | null =>
      typeof value === 'string' && value.trim() !== '' ? value.trim() : null

    // A tool call may name its own workspace and session. That matters because the MCP
    // server's own directory is chosen by the host, and because a host that runs two
    // agents in one workspace needs some way to tell them apart.
    return resolveIdentity({
      workspace: asString(args.workspace) ?? options.workspace ?? null,
      session: asString(args.session),
      task: asString(args.task),
      now: clock(),
    })
  }

  return {
    resolveIdentity: (input = {}) =>
      resolveIdentity({ workspace: options.workspace ?? null, now: clock(), ...input }),

    async handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
      const isNotification = request.id === null || request.id === undefined
      const respond = (result: unknown): JsonRpcResponse | null => (isNotification ? null : success(request.id, result))

      switch (request.method) {
        case 'initialize': {
          const requested = request.params?.protocolVersion
          // Echo the revision the host asked for when we can speak it. Insisting on the
          // newest would make this server unusable against an older host for no gain:
          // the tool surface here uses nothing that changed between revisions.
          const protocolVersion =
            typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
              ? requested
              : LATEST_PROTOCOL_VERSION

          return respond({
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions:
              'Coordination state for a workspace where several agents share one filesystem. Call ' +
              'agentgit_preflight before writing to something another agent may also want, and agentgit_panel ' +
              'when the user asks for the AgenticGit panel or board. Verdicts are advisory: report them, and ' +
              'only treat `review` as a stop signal.',
          })
        }

        // A host sends this after `initialize`. Answering it with a result would be a
        // protocol error, which is why `respond` returns null for notifications.
        case 'notifications/initialized':
        case 'initialized':
          return null

        case 'notifications/cancelled':
        case 'notifications/roots/list_changed':
          return null

        case 'ping':
          return respond({})

        case 'tools/list':
          return respond({ tools: toolDescriptors() })

        case 'tools/call': {
          const name = request.params?.name
          if (typeof name !== 'string') {
            return isNotification
              ? null
              : failure(request.id, ErrorCodes.invalidParams, 'params.name is required for tools/call')
          }

          const tool = findTool(name)
          if (!tool) {
            return isNotification
              ? null
              : failure(request.id, ErrorCodes.methodNotFound, `Unknown tool '${name}'.`, {
                  available: toolDescriptors().map((descriptor) => descriptor.name),
                })
          }

          const rawArguments = request.params?.arguments
          const args =
            typeof rawArguments === 'object' && rawArguments !== null
              ? (rawArguments as Record<string, unknown>)
              : {}

          try {
            const result = await tool.handler(args, { identity: identityFrom(request), now: clock() })
            const payload: Record<string, unknown> = {
              content: [{ type: 'text', text: result.text }],
            }
            if (result.structured !== undefined) payload.structuredContent = result.structured
            if (result.isError) payload.isError = true
            return respond(payload)
          } catch (error) {
            if (error instanceof ToolError) {
              // A tool failure is a successful call that reports failure: the model
              // should see the message and can act on it. Returning a JSON-RPC error
              // instead would make most hosts show a transport fault and hide the hint.
              const text = error.hint ? `${error.message}\n\n${error.hint}` : error.message
              return respond({ content: [{ type: 'text', text }], isError: true })
            }
            throw error
          }
        }

        case 'resources/list':
          return respond({ resources: [] })

        case 'prompts/list':
          return respond({ prompts: [] })

        case 'logging/setLevel':
          return respond({})

        default:
          if (isNotification) return null
          return failure(request.id, ErrorCodes.methodNotFound, `Unsupported method '${request.method}'.`)
      }
    },

    async serve(streams: { input: Readable; output: Writable }): Promise<void> {
      // Anything written to stdout outside this function would corrupt the stream, so
      // the only permitted printing is inside the protocol writer.
      await serveStdio(
        {
          input: streams.input,
          output: streams.output,
          onError: (message) => process.stderr.write(`[agentgit-mcp] ${message}\n`),
        },
        (request) => this.handle(request),
      )
    },
  }
}

/** Diagnostic used by `agentgit doctor` and by the server's own `--selftest` flag. */
export function selftest(): Record<string, unknown> {
  const server = createServer()
  const identity = server.resolveIdentity()
  return {
    server: { name: SERVER_NAME, version: SERVER_VERSION },
    tools: toolDescriptors().map((descriptor) => descriptor.name),
    identity: describeIdentity(identity),
    node: process.versions.node,
  }
}

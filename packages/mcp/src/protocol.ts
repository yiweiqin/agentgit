/**
 * JSON-RPC 2.0 over stdio, which is the whole of the MCP wire protocol.
 *
 * Hand-written rather than pulled from the official SDK for one reason: this server
 * is spawned by Codex on every session, and its failure mode when a dependency is
 * missing is silence. A server that never completes `initialize` looks identical to a
 * plugin with no tools, and the user has no way to tell which. A few hundred lines
 * with no dependencies cannot fail that way.
 *
 * The transport is newline-delimited JSON: one message per line, no `Content-Length`
 * headers, and no embedded newlines in a message. Any implementation that writes
 * pretty-printed JSON will produce a stream the host cannot read, so
 * {@link writeMessage} always compacts.
 *
 * @module @agentgit/mcp/protocol
 */

import type { Readable, Writable } from 'node:stream'

export const JSONRPC_VERSION = '2.0'

/**
 * Protocol revisions this server can speak.
 *
 * The host names the revision it wants in `initialize`. Echoing an older revision it
 * asked for is more compatible than insisting on the newest: the tool surface here
 * uses nothing that changed between them.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id?: string | number | null
  readonly method: string
  readonly params?: Record<string, unknown>
}

export interface JsonRpcSuccess {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly result: unknown
}

export interface JsonRpcFailure {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown }
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

/** Standard JSON-RPC codes, plus the two MCP-specific ones callers branch on. */
export const ErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** A tool ran and failed. The message is shown to the model. */
  toolError: -32000,
} as const

/** Thrown by a tool handler to fail the call with a message the model should read. */
export class ToolError extends Error {
  readonly hint: string | null

  constructor(message: string, hint: string | null = null) {
    super(message)
    this.name = 'ToolError'
    this.hint = hint
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse one line into a request, or `null` when it is not a usable message. */
export function parseMessage(line: string): JsonRpcRequest | null {
  const trimmed = line.trim()
  if (trimmed === '') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new ToolError('the input stream is not valid JSON')
  }
  if (!isRecord(parsed)) return null
  if (typeof parsed.method !== 'string') return null

  const id = parsed.id
  if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') {
    throw new ToolError('a request id must be a string, a number, or absent')
  }

  return {
    jsonrpc: '2.0',
    id: id ?? null,
    method: parsed.method,
    params: isRecord(parsed.params) ? parsed.params : {},
  }
}

/**
 * Serialize one response.
 *
 * `JSON.stringify` cannot emit a raw newline inside a string, so a single-line result
 * is guaranteed as long as nothing writes to stdout directly. That is why every log
 * line in this package goes to stderr.
 */
export function serializeResponse(response: JsonRpcResponse): string {
  return `${JSON.stringify(response)}\n`
}

export function success(id: JsonRpcRequest['id'], result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id: id ?? null, result }
}

export function failure(
  id: JsonRpcRequest['id'],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return data === undefined
    ? { jsonrpc: JSONRPC_VERSION, id: id ?? null, error: { code, message } }
    : { jsonrpc: JSONRPC_VERSION, id: id ?? null, error: { code, message, data } }
}

export interface StdioOptions {
  readonly input: Readable
  readonly output: Writable
  readonly onError?: (message: string) => void
}

/**
 * Read newline-delimited messages and hand each to `handle`.
 *
 * Requests are processed strictly in order and awaited before the next is read. MCP
 * permits concurrency, but every tool here reads and writes one ledger, and running
 * two of them at once would let `claim` and `release` interleave into a state neither
 * call asked for.
 *
 * A notification — a request with no `id` — produces no response, and an invalid
 * message produces an error response rather than killing the stream, because a single
 * malformed frame from a host bug should not take the session's tools down.
 */
export async function serveStdio(
  options: StdioOptions,
  handle: (request: JsonRpcRequest) => Promise<JsonRpcResponse | null>,
): Promise<void> {
  const report = options.onError ?? ((message: string) => process.stderr.write(`[agentgit] ${message}\n`))

  let buffer = ''
  const queue: string[] = []
  let draining = false

  const drain = async (): Promise<void> => {
    if (draining) return
    draining = true
    try {
      while (queue.length > 0) {
        const line = queue.shift()!
        let request: JsonRpcRequest | null
        try {
          request = parseMessage(line)
        } catch (error) {
          options.output.write(serializeResponse(failure(null, ErrorCodes.parseError, (error as Error).message)))
          continue
        }
        if (!request) continue

        try {
          const response = await handle(request)
          if (response) options.output.write(serializeResponse(response))
        } catch (error) {
          report(`unhandled error for ${request.method}: ${(error as Error).message}`)
          if (request.id !== null && request.id !== undefined) {
            options.output.write(
              serializeResponse(failure(request.id, ErrorCodes.internalError, (error as Error).message)),
            )
          }
        }
      }
    } finally {
      draining = false
    }
  }

  options.input.setEncoding('utf8')
  for await (const chunk of options.input) {
    buffer += chunk as string
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      queue.push(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
    await drain()
  }

  // A final line with no trailing newline is still a message; the host may close the
  // pipe immediately after writing a complete request.
  if (buffer.trim() !== '') {
    queue.push(buffer)
    buffer = ''
  }
  await drain()
}

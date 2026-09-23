/**
 * Public surface of the AgenticGit MCP package.
 *
 * Side-effect free, unlike `./main.ts`, which speaks the protocol as soon as it loads.
 * The distinction matters because `main.ts` is also what `.mcp.json` points at: the
 * host needs a program that runs, and tests need a module that does not.
 *
 * @module @agentgit/mcp
 */

export { createServer, selftest, SERVER_NAME, SERVER_VERSION } from './server.ts'
export type { Server, ServerOptions } from './server.ts'

export { TOOLS, findTool, toolDescriptors } from './tools.ts'
export type { ToolContext, ToolDefinition, ToolResult, ToolAnnotations } from './tools.ts'

export { describeIdentity, resolveIdentity, resolveWorkspace, newestSessionId } from './context.ts'
export type { Identity, SessionSource, WorkspaceSource, WhoAmI } from './context.ts'

export {
  ErrorCodes,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  ToolError,
  failure,
  parseMessage,
  serializeResponse,
  serveStdio,
  success,
} from './protocol.ts'
export type { JsonRpcFailure, JsonRpcRequest, JsonRpcResponse, JsonRpcSuccess } from './protocol.ts'

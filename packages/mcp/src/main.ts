#!/usr/bin/env node
/**
 * stdio entry point for the AgenticGit MCP server.
 *
 * `--selftest` exists because the failure mode of a stdio MCP server is silence: when
 * it cannot start, the host simply shows a plugin with no tools, and there is nothing
 * to look at. The flag prints the tool list and the resolved identity to stderr and
 * exits, so `node main.ts --selftest` answers "is this thing alive" in one command.
 *
 * @module @agentgit/mcp
 */

import { createServer, selftest } from './server.ts'

async function main(): Promise<number> {
  const args = process.argv.slice(2)

  if (args.includes('--selftest') || args.includes('--help')) {
    // stderr, not stdout: stdout is the protocol stream, and a diagnostic printed
    // there would be read by the host as a malformed message.
    process.stderr.write(`${JSON.stringify(selftest(), null, 2)}\n`)
    return 0
  }

  const workspaceFlag = args.indexOf('--workspace')
  const workspace = workspaceFlag >= 0 ? args[workspaceFlag + 1] : undefined

  const server = createServer(workspace ? { workspace } : {})
  await server.serve({ input: process.stdin, output: process.stdout })
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`[agentgit-mcp] fatal: ${(error as Error)?.stack ?? String(error)}\n`)
    process.exitCode = 1
  })

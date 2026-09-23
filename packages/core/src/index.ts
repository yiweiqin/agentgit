/**
 * Public surface of the AgenticGit coordination core.
 *
 * Everything below is host-independent and depends only on Node builtins. That is
 * a deliberate constraint: the same modules back the CLI, the MCP tools, the
 * daemon and the Codex hooks, so a decision cannot differ depending on which door
 * the caller came in through.
 *
 * @module @agentgit/core
 */

export * from './types.ts'
export * from './ledger.ts'
export * from './policy.ts'
export * from './store.ts'
export * from './adapter.ts'
export * from './config.ts'
export * from './workspace.ts'
export * from './contracts.ts'
export * from './leases.ts'
export * from './preflight.ts'
export * from './board.ts'
export * from './git.ts'
export * from './codex-rollout.ts'
export * from './governor.ts'

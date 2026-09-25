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
export * from './tunables.ts'
export * from './contracts.ts'
export * from './leases.ts'
export * from './preflight.ts'
export * from './board.ts'
export * from './git.ts'
export * from './graph.ts'
export * from './sessions.ts'
export * from './codex-rollout.ts'
export * from './rollout-patches.ts'
export * from './governor.ts'
// The E2 harness, exported because a published accuracy number has to be reproducible from
// outside the package. `examples/real/measure.mjs` scores a real pack through this, and a
// reader checking the figure needs the same function the figure was produced by — not a
// reimplementation of it.
export * from './e2.ts'

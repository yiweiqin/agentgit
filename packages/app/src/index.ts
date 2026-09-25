/**
 * Public surface of the AgenticGit panel package.
 *
 * Kept separate from `@agentgit/board` because the two answer different constraints. The
 * board renders a snapshot into markup with no scripting, because the conversation
 * sandbox blocks it. This renders an MCP App that polls and converses, because an MCP App
 * runs in an iframe the host controls. One is a picture; the other is a surface.
 *
 * @module @agentgit/app
 */

export * from './panel.ts'

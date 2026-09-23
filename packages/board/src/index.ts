/**
 * Public surface of the AgenticGit rendering package.
 *
 * Kept separate from `@agentgit/core` for one reason: the core is what decides, and
 * this is what shows. A rendering change — a new column, a different tone for a
 * warning — must never require re-reading a decision, and a decision change must
 * never be reviewed as a CSS diff.
 *
 * @module @agentgit/board
 */

export * from './format.ts'
export * from './panel.ts'
export * from './panel-file.ts'
export * from './page.ts'
export * from './story.ts'

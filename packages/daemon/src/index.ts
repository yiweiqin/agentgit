/**
 * Public surface of the AgenticGit daemon.
 *
 * This file exists so importing the package has no effect. `./main.ts` starts a server
 * when it loads — that is what an entry point is for — and the CLI reaches the daemon
 * through `import('@agentgit/daemon')` to get `serve` and `runDemo`. When the package
 * entry pointed at `main.ts`, `agentgit demo` finished its walkthrough and then printed
 * `AgenticGit board: http://localhost:7777`, because importing the demo had started the
 * daemon as a side effect. A package whose barrel file does something is a package that
 * does something every time it is mentioned.
 *
 * @module @agentgit/daemon
 */

export { serve, fingerprintOf, assignIds } from './serve.ts'
export type { BoardServer, ServeOptions } from './serve.ts'

export { runDemo } from './demo.ts'
export type { DemoOptions } from './demo.ts'

#!/usr/bin/env node
/**
 * Entry point for the AgenticGit daemon.
 *
 * The CLI reaches this package through `import('@agentgit/daemon')`, which is why the
 * exports below are the CLI's contract: `serve` for `agentgit up`, and `runDemo` for
 * `agentgit demo`. This file exists so the package can also be started on its own,
 * which is what a user does when they want the board without the CLI.
 *
 * @module @agentgit/daemon
 */

import { resolve } from 'node:path'

import { runDemo, type DemoOptions } from './demo.ts'
import { serve, type ServeOptions } from './serve.ts'

export { runDemo, serve }
export type { DemoOptions, ServeOptions }

async function main(): Promise<number> {
  const args = process.argv.slice(2)

  if (args.includes('--help')) {
    process.stdout.write(
      'agentgit daemon\n\n' +
        '  --watch <path>   workspace to watch (repeatable; defaults to the current directory)\n' +
        '  --port <n>       port to bind on 127.0.0.1 (default 7777; 0 picks a free one)\n' +
        '  --open           open the board in a browser\n' +
        '  --no-adopt       do not read Codex session history; use hooks only\n' +
        '  --demo           run the two-agent collision walkthrough instead of serving\n\n' +
        'The board binds to the loopback interface only, and only ever reads.\n',
    )
    return 0
  }

  const roots: string[] = []
  let port = 7777
  let open = false
  let watch = true
  let demo = false

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '--watch') roots.push(resolve(args[++index] ?? '.'))
    else if (token === '--port') port = Number(args[++index] ?? port)
    else if (token === '--open') open = true
    else if (token === '--no-adopt') watch = false
    else if (token === '--demo') demo = true
  }

  if (demo) return runDemo({ workspace: roots[0] ?? process.cwd(), json: args.includes('--json') })

  return serve({ roots: roots.length > 0 ? roots : [process.cwd()], port, open, watch })
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`agentgit daemon: ${(error as Error)?.stack ?? String(error)}\n`)
    process.exitCode = 2
  })

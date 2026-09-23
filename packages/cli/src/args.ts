/**
 * A small argument parser.
 *
 * Hand-rolled rather than pulled from npm because this package is the one a user is
 * asked to trust before they have read any of it, and a command-line tool that
 * installs a dependency tree to parse six flags is a poor first impression. The
 * grammar is deliberately tiny: `--flag`, `--flag=value`, `--flag value`, repeated
 * flags accumulate, and everything else is positional.
 *
 * @module @agentgit/cli/args
 */

export interface ParsedArgs {
  readonly command: string
  readonly subcommand: string | null
  readonly positionals: readonly string[]
  readonly flags: ReadonlyMap<string, readonly string[]>
  /** A flag present with no value at all. */
  has(name: string): boolean
  /** The last value given for a flag, or null. */
  value(name: string): string | null
  /** Every value given for a flag, in order. */
  values(name: string): readonly string[]
  /** A flag that may be given bare, for example `--json` or `--json=false`. */
  boolean(name: string, fallback?: boolean): boolean
  number(name: string, fallback: number): number
}

/**
 * Flags that never consume the next argument, so `--json status` cannot eat `status`.
 *
 * Exported because the rule is only correct as a set: every flag read with
 * `args.boolean(...)` must appear here, and a missing entry is invisible until the flag
 * happens to be followed by a positional. `packages/cli/tests/args.test.ts` reads this
 * set against the source to keep the two in step.
 */
export const BARE_SAFE = new Set([
  'json',
  'print',
  'open',
  'no-open',
  'force',
  'link',
  'copy',
  'enable',
  'disable',
  'quiet',
  'verbose',
  'help',
  'watch',
  'adopt',
  'worktree',
  'no-worktree',
  'no-watch',
  'dry-run',
  'steal',
  'breaking',
  'symbol',
  // `--claim` turns a question into a recorded decision, and it is given bare
  // (`preflight src/a.ts --claim`). Left off this list it would swallow the next
  // positional and the entity under discussion would become the flag's value.
  'claim',
])

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string[]>()

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const body = token.slice(2)
    const equals = body.indexOf('=')
    if (equals >= 0) {
      push(flags, body.slice(0, equals), body.slice(equals + 1))
      continue
    }
    const next = argv[index + 1]
    if (!BARE_SAFE.has(body) && next !== undefined && !next.startsWith('--')) {
      push(flags, body, next)
      index += 1
      continue
    }
    push(flags, body, 'true')
  }

  const command = positionals[0] ?? 'help'
  // A second positional is a subcommand only for the commands that have one, so
  // `agentgit preflight src/a.ts` does not silently read `src/a.ts` as a verb.
  const subcommand = COMMANDS_WITH_SUBCOMMANDS.has(command) ? positionals[1] ?? null : null
  const consumed = subcommand ? 2 : 1

  return {
    command,
    subcommand,
    positionals: positionals.slice(consumed),
    flags,
    has: (name) => flags.has(name),
    value: (name) => flags.get(name)?.[flags.get(name)!.length - 1] ?? null,
    values: (name) => flags.get(name) ?? [],
    boolean: (name, fallback = false) => {
      if (!flags.has(name)) return fallback
      const raw = flags.get(name)!.slice(-1)[0]
      if (raw === 'false' || raw === '0' || raw === 'no') return false
      return true
    },
    number: (name, fallback) => {
      const raw = flags.get(name)?.slice(-1)[0]
      if (raw === undefined) return fallback
      const parsed = Number(raw)
      return Number.isFinite(parsed) ? parsed : fallback
    },
  }
}

const COMMANDS_WITH_SUBCOMMANDS = new Set(['task', 'contracts', 'contract', 'lease'])

function push(flags: Map<string, string[]>, name: string, value: string): void {
  const list = flags.get(name) ?? []
  list.push(value)
  flags.set(name, list)
}

/** The usage text. Kept next to the parser so the two cannot drift silently. */
export const USAGE = `agentgit - coordination for agents sharing one repository

  agentgit status [--json]                     what is in flight, and what the ledger is missing
  agentgit board [--json] [--open]             every task, collision, lease and contract
  agentgit panel [--out <dir>] [--print]       write the inline panel fragment
  agentgit up [--port 7777] [--watch <path>]   live board, one page per workspace
  agentgit preflight [<path>|--symbol <name>] [--intent <text>] [--task <id>] [--session <id>]
                    [--claim] [--json]         the verdict for one entity
                                               --claim also takes the lease and records the decision,
                                               which is what puts the interception on the board
  agentgit why <entity|task> [--json]          the events behind one decision
  agentgit reconcile [--json]                  stale assumptions, integration order, ghost merge
  agentgit contracts list|show <name>|publish|assume
  agentgit lease list|release <task> [<entity>]
  agentgit task start|checkpoint|finish
  agentgit install [--copy] [--enable] [--json]  install the Codex plugin from this checkout
                                               --enable also sets [plugins."agentgit@personal"] in
                                               ~/.codex/config.toml, which is otherwise left alone
  agentgit uninstall [--disable] [--json]      remove hooks, MCP config and the marketplace entry
  agentgit doctor [--json]                     check that the install can actually work
  agentgit demo                                run the two-agent collision walkthrough

Every command accepts --json for machine consumption, and --help.

Exit codes: 0 success - 1 the command ran and found something to act on - 2 usage or environment error.
`

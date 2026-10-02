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
  // `agentgit graph --no-overlay` is a bare switch that turns a step off, so without this
  // entry it would swallow the next positional and the command would silently change shape.
  'no-overlay',
  'dry-run',
  'steal',
  'breaking',
  'symbol',
  // `agentgit hub --refresh` recomputes and publishes on demand, for a workspace whose daemon is
  // not running. Bare, so without this entry it would swallow the next positional.
  'refresh',
  'seen',
  // `agentgit config arm --arms` reads `--arms` as a boolean, so without this entry it would
  // swallow whatever came next and the listing would silently become a different command.
  'arms',
  // `agentgit desktop --reset` clears the record of the offer, which is the way back from a refusal
  // and therefore has no positional argument to consume.
  'reset',
  // The machine-level answers for a repository that has not opted in. Both are bare, and both are
  // the whole command, so without these entries they would swallow the next argument and the
  // refusal would be recorded against a path the user never named.
  'decline-init',
  'clear-init',
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

const COMMANDS_WITH_SUBCOMMANDS = new Set(['task', 'contracts', 'contract', 'lease', 'config', 'checks', 'impact'])

function push(flags: Map<string, string[]>, name: string, value: string): void {
  const list = flags.get(name) ?? []
  list.push(value)
  flags.set(name, list)
}

/** The usage text. Kept next to the parser so the two cannot drift silently. */
export const USAGE = `agentgit - coordination for agents sharing one repository

  agentgit status [--json]                     what is in flight, and what the ledger is missing
  agentgit brief [--json]                      re-state what a truncated context cannot hold
  agentgit board [--json] [--open]             every task, collision, lease and contract
  agentgit graph [--limit N] [--json] [--no-overlay] [--explain <oid|task>]
                                               the commit graph, each commit attributed to the
                                               Codex conversation that produced it; --explain
                                               answers "who, why, what changed" for one commit
  agentgit panel [--out <dir>] [--print]       write the inline panel fragment
  agentgit app [--out <file>] [--open] [--json]  write the MCP App panel document, for a host
                                               that renders it and for looking at it directly
  agentgit up [--port 7777] [--watch <path>]   live board, one page per workspace; reuses a
                                               daemon a session already started, so it starts
                                               nothing when one is already watching
  agentgit preflight [<path>|--symbol <name>] [--intent <text>] [--task <id>] [--session <id>]
                    [--claim] [--json]         the verdict for one entity
                                               --claim also takes the lease and records the decision,
                                               which is what puts the interception on the board
  agentgit why <entity|task> [--json]          the events behind one decision
  agentgit hub [--refresh] [--seen] [--json]   the hub's one ruling per contention: who is on
                                               what, what each collision resolved to, the
                                               integration order, and the interfaces that moved.
                                               Read from the projection the daemon writes.
                                               --refresh recomputes and publishes it, which is
                                               what to use when no daemon is running
  agentgit reconcile [--json]                  stale assumptions, integration order, ghost merge
  agentgit impact state|publish --file <json> --session <id> [--task <id>]
                                               declare current state or a versioned change
  agentgit impact analyze|inbox [--session <id>] [--refresh] [--json]
                                               directional evidence, severity and delivery policy
  agentgit impact ack <notification-id> --session <id>
                                               acknowledge a current notification for this session
  agentgit checks enable --coordinator <chat-uuid> --codex <absolute-exe>
                                               opt in to automatic cross-chat checks
  agentgit checks scan|status|disable           durable queue, receipts and delivery errors
  agentgit checks reserve|sent|reply|fail        coordinator protocol; see references/coordinate.md
  agentgit desktop [--reset] [--pin <id>] [--enable] [--json]
                                               the pinned coordination task for this workspace:
                                               which task it is, whether a watcher is keeping it
                                               alive, which conversations /agentgit pinned, whether
                                               the workspace was enabled, and the last ruling it
                                               reported. --reset clears the record, so the offer can
                                               be made again after a refusal; --pin and --enable
                                               record what /agentgit records
  agentgit desktop --decline-init | --clear-init
                                               the machine-level record for a repository that has
                                               NOT opted in. --decline-init refuses the offer
                                               without creating anything in the repository;
                                               --clear-init forgets that refusal
  agentgit contracts list|show <name>|publish|assume
  agentgit lease list|release <task> [<entity>]
  agentgit task start|checkpoint|finish
  agentgit config [<setting>] [<value>] [--arms]  what is adjustable, and what it is set to
                                               no argument lists every setting with what it does;
                                               'config arm A1-instrument' switches the experiment arm
  agentgit install [--copy] [--enable] [--json]  install the Codex plugin from this checkout
                                               --enable also sets [plugins."agentgit@personal"] in
                                               ~/.codex/config.toml, which is otherwise left alone
  agentgit uninstall [--disable] [--json]      remove hooks, MCP config and the marketplace entry
  agentgit doctor [--json]                     check that the install can actually work
  agentgit demo                                run the two-agent collision walkthrough

Every command accepts --json for machine consumption, and --help.

Exit codes: 0 success - 1 the command ran and found something to act on - 2 usage or environment error.
`

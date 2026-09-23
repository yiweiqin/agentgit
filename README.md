# AgenticGit

**Coordination for coding agents that share one repository.**

Git tells you two branches touched the same line — after both are finished. It cannot tell
you that two agents are working on the same thing *right now*, that the interface one of
them is changing is the one the other has already coded against, or that the second agent's
half-written file is about to be swept into the first one's commit.

Those three failures merge cleanly. They break at run time, or at review, or never — which
is worse, because you keep doing it.

AgenticGit is a Codex plugin that watches what is in flight in a workspace and answers one
question before a write happens: **is this work already being done, and is the ground under
it still moving?** It keeps a ledger of tasks, code, contracts and validation, exposes it as
MCP tools, renders an inline panel in the conversation, and serves a live board at
`localhost:7777`.

---

## The case Git cannot see

Two agents are asked to add rate limiting to login. They describe it in their own words, so
nothing matches textually and Git has nothing to report. Both edits merge cleanly.

```
1. Agent A opens a task and writes src/login.py
   A intent: "add rate limiting to the login endpoint so repeated failures back off"

2. Agent B is about to write the same file, for what it thinks is its own reason
   B intent: "add rate limiting to login so repeated failures are throttled"
   verdict : REUSE
   reason  : an in-flight change on file::src/login.py is doing the same thing:
             "add rate limiting to the login endpoint so repeated failures back off"
             (task demo-a, similarity 0.56).

3. Agent A publishes auth.limit v1; agent B records that it is coded against v1
4. Agent A publishes v2 with a breaking signature change
5. Agent B asks again, before writing
   verdict : WAIT
   reason  : task demo-a is still landing auth.limit v2 in src/login.py. Code against
             the published signature and stub the rest, or wait for it to land.
6. Agent A integrates. Agent B asks a third time.
   verdict : REVIEW
   reason  : auth.limit moved to v2 (breaking) and this change touches src/login.py.
             You are coded against v1. Published by task demo-a.
```

Nobody was blocked on a merge conflict, because there never was one. The second agent was
told, three times, at the only three moments when the answer had changed.

Run it yourself, in a scratch repository that is deleted afterwards:

```bash
node examples/collision/run.mjs          # add --keep to inspect the repo it builds
```

The walkthrough is real: it writes to a real ledger in a real repository with real commits,
and it reports a step as `FAIL` if the verdict it expected is not the verdict it got.

## Checkpoints that stay inside a task

The part that is actually dangerous to get wrong, and the reason the git layer has a test
suite of its own:

```
$ agentgit task checkpoint demo-a --path src/login.py
checkpoint 6f713480
  src/login.py

$ git status --short
 M src/config.py
```

Agent B was halfway through editing the config module in the same tree. It is still there,
still uncommitted, still B's. `git add -A && git commit` — the obvious implementation, and
the one most tools reach for — would have taken it. A checkpoint stages exactly the paths its
own task wrote and names them on the commit, so no other path can be included.

## Install

Requires **Node 22.19 or newer** (the packages are TypeScript run directly by Node) and
**git**. Codex must support local plugins and MCP servers.

```bash
git clone https://github.com/agentgit/agentgit.git
cd agentgit
npm install
node packages/cli/src/main.ts install          # link the plugin, write hooks and MCP config
node packages/cli/src/main.ts doctor           # every check must say "ok"
```

`install` does the four things Codex cannot do for a local plugin, and nothing else:

1. links `~/plugins/agentgit` to this checkout, so edits to the checkout are live;
2. generates `hooks.json` and `.mcp.json` with absolute paths, because Codex does no command
   substitution and does not resolve a relative path on Windows;
3. adds the `agentgit` entry to `~/.agents/plugins/marketplace.json`, preserving every other
   entry and the marketplace's own name;
4. bumps the cachebuster, because Codex caches a plugin by version and an edit with an
   unchanged version is invisible.

Then enable it, either way:

```bash
codex plugin add agentgit@personal                 # the marketplace route
node packages/cli/src/main.ts install --enable     # or write the config.toml block for you
```

`--enable` edits exactly one table in `~/.codex/config.toml` and leaves every other byte,
including comments, alone. It refuses rather than guesses if `plugins` is already an inline
table, because appending a `[plugins."x"]` section to that file produces invalid TOML and
Codex would refuse to start with the cause several lines from the symptom.

To undo: `node packages/cli/src/main.ts uninstall --disable`.

## What it does by itself, and what it will not

The split is the product's safety boundary, and it is enforced in `packages/core/src/git.ts`
by two tests: one commits a file in a tree full of another agent's work, and the other scans
every source file for a git invocation of a protected operation.

| Automatic — additive and reversible | Never automatic — described, not run |
|---|---|
| Creating a task branch and worktree | `merge`, `rebase` |
| Committing a checkpoint scoped to a task | `reset --hard`, `restore`, `clean` |
| Recording a lease, an assumption, a contract version | `branch -D`, `push` |
| One line in `.git/info/exclude` for `.agentgit/` | Anything that rewrites history |

When a merge is due, `agentgit reconcile` prints the integration order, the ghost-merge
preview, and the exact commands — and stops. It never resolves a conflict and never reorders
anyone's history. An agent that merges because a heuristic said so is not something anyone
should be asked to trust.

The ghost merge (`git merge-tree --write-tree`) is safe to run on every board refresh
because it writes the result to the object database and touches no branch and no working
directory. But a clean tree is reported as clean and nothing more: **textual cleanliness is
not behavioural correctness**, and `reconcile` says so in the output rather than implying
otherwise.

## What this does not claim

- It does not prevent conflicts. It tells you the collision is coming while it is still
  cheap to change course, which is a different and more modest thing.
- The duplicate-work verdict is a similarity judgement over intent text, with a threshold
  and a reason string in every answer. It will be wrong sometimes; it is designed to be
  cheap to overrule, and every verdict is recorded so you can see why it was made.
- The demo is a walkthrough, not a benchmark. It asserts the three verdicts it is built to
  produce, and nothing about how often they occur in real repositories.

## Layout

```
packages/core       the ledger, contracts, leases, preflight verdicts, rollout ingestion, git
packages/board      the inline panel fragment and the standalone page, from one view
packages/cli        agentgit status | board | panel | preflight | why | reconcile | task | up | install
packages/mcp        the stdio MCP server: agentgit_preflight, agentgit_task, agentgit_contracts
packages/daemon     the live board on localhost:7777, one page per workspace, SSE
plugins/agentgit    the Codex plugin: manifest, hook wiring, the track.mjs fast path, the skill
examples/collision  the two-agent walkthrough above
```

The hook script is the only thing on the hot path of every tool call, so it is a single
process with no dependencies beyond Node's standard library, and it appends one line to the
workspace's event shard. Everything else — the board, the panel, the verdicts — is derived
from those events and can be thrown away and rebuilt.

Session transcripts are adopted as well as tool calls, because a hook cannot see what a shell
command touched. Adoption deduplicates against the hook stream: the same write recorded
twice would inflate every collision count by the fraction both streams saw, and the numbers
would stop meaning anything.

## Tests

```bash
npm test          # 391 tests: core, board, cli, mcp, daemon
npm run test:py   #  45 tests: the Python ledger, checked against the same fixtures
npm run typecheck
```

MIT licensed.

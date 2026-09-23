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
git clone https://github.com/yiweiqin/agentgit.git
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
- The A/B run below is a fixture with scripted agents. It shows the mechanism works and that
  the arms differ. It is not an effect size.
- The before/after report in `examples/real/run.mjs` is **one** case, so it is not a frequency.
  The frequency over the same pool is what experiment 4 counts, and the two are kept apart on
  purpose.
- When that report says git merges cleanly, read the route it names. On the `reversed`
  reconstruction route a clean merge is only reachable when the two changes occupy
  non-overlapping regions of the file — so a clean merge there is the expected result, not a
  discovery about how blind git is. On the `anchored` route, where both patches apply to a
  common base, the answer is the case's own.

## What you can tune

The verdicts are heuristics, so every one of them is a knob — and a product that will be
wrong for somebody's repository owes them the knob, the default, and the reason the default
was chosen. All three are in one command:

```
$ agentgit config
settings  (0 changed from the default)

  arm
    value   : A3-advisory  (default)
    means   : record cross-session, report what was seen, offer next actions (default)
    effect  : Which experimental arm this workspace runs: what is recorded, and whether this
              session can see other sessions at all.
    caution : A non-default arm makes this workspace incomparable with one running another arm...

  duplicateIntentThreshold
    value   : 0.42  (default)
    effect  : How similar two agents' own words for their intent must be before their work is
              called the same. This is the number behind the REUSE verdict.
    caution : Too low and unrelated work is flagged as duplicate, which is how a team learns to
              ignore the tool. The matcher is lexical, so two agents describing one job in
              different words score low no matter where this is set: raising it hides the miss
              rather than fixing it.
```

Set one with `agentgit config <setting> <value>`; the value is validated before anything is
written, and a rejected setting leaves the file exactly as it was. `--json` gives the same
fields to a tool, and `agentgit status`, `agentgit board`, `doctor` and the inline panel all
print which arm produced the numbers they are showing.

The `arm` setting is the interesting one, and it is the experiment's unit of analysis:

| arm | what it does |
|---|---|
| `A3-advisory` (default) | record cross-session, report what was seen, offer next actions |
| `A1-instrument` | record cross-session and decide, but offer no next actions |
| `A4-session-only` | record, but see only this session |
| `A0-baseline` | record nothing, see nothing, always allow |

Two of the research arms are deliberately **not** offered. `A4-gated` refuses writes, and this
product never does — it reports what it sees and hands you the command — so naming it is
refused with that reason rather than quietly downgraded. `A2-inert` and `A4-detect-only` are
not offered either: in a product without a gate they are byte-for-byte identical to
`A0-baseline` and `A1-instrument`, and two arm names for one behaviour would make the labels
meaningless.

## The A/B run, and how to read it

```bash
node examples/ab/run.mjs                      # about half a minute
node examples/ab/run.mjs --compliance 0,0.25,0.5,0.75,1
```

It builds a scratch repository per arm, runs the same six-round two-agent scenario through
the real CLI, and reports what happened to the code in a real ghost merge — not in the
ledger's opinion of itself.

```
what each arm knew, and what it said
------------------------------------
  A0-baseline       b-agent verdicts: allow x6
                    usable next actions: 0/6   ledger events written: 0
  A4-session-only   b-agent verdicts: allow x6
                    usable next actions: 0/6   ledger events written: 12
  A1-instrument     b-agent verdicts: reuse x3, replan x2, allow x1
                    usable next actions: 0/6   ledger events written: 12
  A3-advisory       b-agent verdicts: reuse x3, replan x2, allow x1
                    usable next actions: 5/6   ledger events written: 12

outcome by arm and obedience rate
---------------------------------
  arm                obey   dup closed   indep stopped   untouched   files left in conflict
  A0-baseline       0      0/3          0/2             1/1         5
  A0-baseline       1      0/3          0/2             1/1         5
  A4-session-only   0.5    0/3          0/2             1/1         5
  A1-instrument     1      0/3          0/2             1/1         5
  A3-advisory       0.5    1/3          1/2             1/1         3
  A3-advisory       1      3/3          2/2             1/1         0
```

Six of the twelve rows are shown; the rest repeat the same two shapes.

Read it in this order, because the honest reading is not the flattering one:

1. **The last row is arithmetic, not evidence.** An arm that closes all three duplicates when
   every agent obeys is showing you what "obeyed" means. A harness cannot discover that.
2. **The row that carries information is `obey 0.5`** — one duplicate closed, three files
   still conflicted — and it is only informative if the obedience rate is real. Nobody has
   measured a real agent's rate here, and that rate is the only thing that would turn this
   into an effect size.
3. **Two ablations collapse to the baseline, for different reasons.** `A4-session-only` writes
   all 12 events and cannot see them, so it answers `allow` six times. `A1-instrument` sees
   everything and says `reuse` and `replan`, but offers no next action, so nothing changes
   either. What the product needs is the shared ledger *and* an actionable step; either one
   alone leaves all five files conflicted.
4. **`untouched` is a floor, not a detail.** One round has the second agent working on an
   entity the first never touched, and no arm at any obedience rate may interfere. If that
   number moved, a detector is firing on ground nobody is on, and the duplicate column would
   be uninterpretable.
5. **`indep stopped` is the cost side.** Those rounds share an entity for genuinely different
   reasons. The product says `REPLAN` there, which means split the entity or agree an order —
   a deferral, not a loss — and the number is printed beside the duplicate column because a
   tool that closed duplicates by stopping everything would look identical on it alone.

Obedience is applied only to a verdict that came with a usable next action. That is an
assumption, and it is what separates the instrument arm from the default; if it is wrong, the
`A1-instrument` row is the one to distrust, not the others.

## Four experiments, on this machine's own history

The demo above is a walkthrough: it proves the mechanism runs, and it says nothing about how
often the three failures happen to you. For that there is a second set of scripts, run over the
real session transcripts in `~/.codex/sessions`, with the criteria computed mechanically from
the patch bodies rather than chosen by hand. Each experiment answers one question:

| | The question | The one number it reports |
|---|---|---|
| 1 | Can it see? On real history, how often does it speak and how often is it right? | precision and recall, always beside `entityVisibleCeiling` |
| 2 | Does listening help? If the warned agent obeys, how much better is the outcome? | the drop in duplicates closed at the obedience 0.5 row |
| 3 | Does it cry wolf? On a day with no collision, how many times a day does it speak? | one advisory per N session-hours, and zero refusals |
| 4 | Could git have seen it? For these cases, would git have spoken at the time? | cases with zero conflicts, and the gap between the two timestamps |

Every one of them carries a control that must not move, and is written down with the value that
counts as failure. The full write-up — the analogy it is all built on, the numbers as measured,
the two reconstruction routes behind the before/after, the sandbox constraints, and what was
redacted before publication — is in [`docs/EXPERIMENTS.md`](docs/EXPERIMENTS.md).

```bash
node examples/real/cases.mjs    # scan the pool: candidates, and the three concurrency windows
node examples/real/run.mjs      # one real case, as a before/after report
```

`cases.mjs` takes its scope from the transcripts — the workspaces it reports on are every
directory the sessions recorded, so the source contains no path from any one machine. Narrow
it with `--workspaces a,b` when the pool contains scratch directories.

`run.mjs` clones the repository into a temporary directory, replays both real sessions up to the
moment of the write, asks `preflight()` and `git merge-tree` the same question, and renders the
two answers side by side. It prints a content token; paste the whole line into a Codex reply
and the report renders inside the conversation. It exits non-zero rather than inventing a case
if no candidate qualifies, or if the product's verdict is `allow` — silence is a finding, not a
demo.

## Layout

```
packages/core       the ledger, contracts, leases, preflight verdicts, rollout ingestion, git
packages/board      the inline panel fragment and the standalone page, from one view
packages/cli        agentgit status | board | panel | preflight | why | reconcile | task | config | up | install
packages/mcp        the stdio MCP server: agentgit_preflight, agentgit_task, agentgit_contracts
packages/daemon     the live board on localhost:7777, one page per workspace, SSE
plugins/agentgit    the Codex plugin: manifest, hook wiring, the track.mjs fast path, the skill
examples/collision  the two-agent walkthrough above
examples/ab         the A/B run: the same scenario under two arms, with an obedience dial
examples/real       the experiments below, run over this machine's own session transcripts
docs                EXPERIMENTS.md, and the reasoning behind the numbers it reports
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
npm test          # 475 tests: runs lint:encoding first, then core, board, cli, mcp, daemon
npm run test:py   #  45 tests: the Python ledger, checked against the same fixtures
npm run typecheck
```

`npm test` begins with `npm run lint:encoding`, which fails if any text file has a UTF-8 BOM
or CRLF endings. That is not tidiness: a BOM makes `json.loads` reject a plugin manifest that
looks correct, and a CRLF checkout makes a committed ledger diff on every line. Fix with
`node scripts/strip-bom.mjs`.

The arm tests are the ones worth knowing about, because an arm is easy to get wrong in the
one way that produces a plausible-looking result: `packages/core/tests/arm.test.ts` drives the
same ledger under two arms and fails if the verdicts agree. `packages/cli/tests/ab.test.ts`
runs the A/B harness and fails if the arms stop differing, if the ablation stops recording, or
if untouched ground is ever disturbed. `packages/cli/tests/hooks.test.ts` pins the hook's own
copy of the arm table against core's, because the hook cannot import the library and a drifted
copy would silently keep recording in a workspace that had been switched off.

MIT licensed.

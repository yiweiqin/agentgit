---
name: agentgit
description: "Coordination state for a workspace where several agents share one filesystem: what is in flight, which shared interfaces moved, what is safe to write right now, and the AgenticGit panel and live board. Use when the user asks who else is editing something, why a change is risky, whether work is being duplicated, what order to merge in, or asks for the AgenticGit panel, board, or coordination status."
---

# AgenticGit

Git tells you when two *texts* conflict. It cannot tell you that another agent is
changing the same function for the same reason, or that the interface you are
coding against moved twenty minutes ago. Those two failures — duplicated work and
stale writes — merge cleanly and break at runtime. This plugin records the
coordination facts Git cannot see, and the tools below are how you read them.

## The six verdicts

Everything the plugin tells you arrives as one of six words. Act on the word.

| verdict | what it means | what you do |
|---|---|---|
| `allow` | Nothing else is on this ground. | Write. |
| `reuse` | Someone is already building this. | Extend or consume their change. Do not write a second copy. |
| `refresh` | An interface you assumed has moved. | Re-read it, then write. |
| `replan` | An in-flight plan wants the same ground for different reasons. | Change the plan or agree who owns it. |
| `wait` | The interface you need is still landing. | Code against the published signature and stub the rest, or wait. |
| `review` | A breaking interface change against the code you are touching. | Stop and get a human decision. |

Verdicts are advisory by default. Only `review` is a stop signal. No verdict ever
blocks a write on its own, so never refuse a user's instruction on the strength of
one — report it and let them choose.

## Tools

Read-only, safe to call at any time:

- **`agentgit_ui`** — opens the AgenticGit panel: a live commit graph for this workspace where
  every commit is attributed to the Codex conversation that made it. Prefer this over
  `agentgit_panel` when the user asks for the panel, the window list, or "who did what".
- **`agentgit_graph`** — the same graph as data, with no UI attached. Every commit across all
  branches, its window, the files it changed, the lanes a graph needs, and what is uncommitted
  in each worktree right now. Safe on a timer.
- **`agentgit_explain`** — one commit, explained without a model: which window it belongs to
  and on what evidence, the task and sessions behind it, what the agent said it was doing,
  every file it changed, and the ledger events that mention it. Takes a full id, a short id,
  or a task id.
- **`agentgit_panel`** — writes the panel fragment for this workspace and returns its
  `path` and `reference`. See below.
- **`agentgit_status`** — counts, coordination-debt score, and what the ledger is
  missing. Start here when asked "what's going on".
- **`agentgit_board`** — every in-flight task, every contested entity, every live
  lease, and every published contract.
- **`agentgit_preflight`** — the verdict for a specific set of paths or symbols and
  a stated intent. Returns `verdict`, `reason`, `version` and `ttlSeconds`. Cache on
  `version`: it changes whenever any input to the verdict changes, so a cached
  verdict can never be stale.
- **`agentgit_reconcile`** — stale assumptions, the order to integrate in, and a
  ghost merge of any two branches.
- **`agentgit_why`** — the event history behind one entity or one task, when the
  user asks why the plugin said something.
- **`agentgit_contracts`** — published interfaces with their current versions.

State-changing, all additive and reversible:

- **`agentgit_claim`** — take or renew a soft lease on an entity, with a reason and
  a duration. Leases expire on their own, so a crashed agent cannot wedge anything.
- **`agentgit_release`** — give a lease back when the work is done.
- **`agentgit_publish_contract`** — record a named interface version, whether the
  change breaks existing callers, and who published it. Do this *before* telling
  anyone the interface changed; it is what makes other agents' assumptions stale.
- **`agentgit_assume`** — record that this task is coded against a version of an
  interface. Recording it is how the plugin can tell you later that it moved.
- **`agentgit_task`** — `start` creates a worktree and task branch, `checkpoint`
  commits only the paths this task touched, `finish` reports what to do next.

## The panel, and the windows on the graph

When the user asks for the AgenticGit panel, the window list, "who did what", or which
conversation a change came from, call **`agentgit_ui`**. It renders a live commit graph
where each commit is labelled with the Codex conversation that produced it, each row can
be asked about, and the uncommitted work in every worktree is listed.

The panel keeps itself up to date, so call it once and do not call it again for the same
workspace. If the host offers a persistent side panel or picture-in-picture, say that the
panel is there; do not paste its contents into the reply.

Attribution is a chain, and where a name came from is part of the answer:

1. the `AgenticGit-Task` / `AgenticGit-Session` trailers on the commit itself;
2. the `agentgit/<task>` branch the commit sits on;
3. the ledger's task-to-session mapping;
4. the session's recorded Codex thread name, its first prompt, the task id, or the short
   session id;
5. for a commit that carries no attribution at all, the Git author.

A name that came from the last two steps is *not* a recorded window name, and the graph
shows it in italics for that reason. When you explain a commit to a user, say which step
answered rather than presenting a guess as a fact. `agentgit_explain` returns that
provenance in its `notes`, and repeating the relevant note is usually the useful part.

## Rendering the fragment panel

When the user asks for the panel as a *snapshot* — for a reply that must render a picture
where the MCP App cannot — use `agentgit_panel`:

1. Call `agentgit_panel`. It writes an HTML fragment to a durable file and returns
   `path` and `reference`.
2. Put the returned `reference` on its own line in your final response, exactly as
   returned, at the point where the panel should appear.
3. Say nothing about the file, the fragment, the directory, or how it rendered. One
   short sentence about what the panel shows is enough, and only if it helps.

The reference is a content reference, not a link or an attachment. It is the token
below, copied verbatim — it is bracketed by two private-use control characters that
carry no visible width, so it looks like plain text but is not:

`visualize{"path":"<absolute-path>/agentgit-panel.html"}`

The token is the same one the built-in `visualize` capability uses, because that is
the only inline-render capability the client is guaranteed to have. Substituting the
plugin's own name for `visualize` produces a token nothing renders.

If `agentgit_panel` is unavailable because the MCP server did not start, fall back
to the CLI and hand the user the URL rather than inventing a panel:

```
npx agentgit panel --print     # writes the fragment, prints its path
npx agentgit graph             # the same graph as text, in any terminal
npx agentgit graph --explain <oid|task>
npx agentgit up                # live board on http://localhost:7777, panel at /panel
```

## What you may do without asking

Creating a worktree, creating a task branch, committing a checkpoint, taking or
renewing a lease, publishing a contract, and generating the panel or the board.
Every one of these is additive: nothing that already exists is rewritten, and the
user can undo it with a command they already know.

A checkpoint is the one that writes something new into history, and it writes two
trailers — `AgenticGit-Task` and `AgenticGit-Session`. They are how a commit carries its
own attribution into Git, where every later reader can see it, and why the panel can name
a window without consulting the ledger. Pass `task` and `session` when you checkpoint so
they are recorded; never amend or rewrite an existing commit to add them.

## What you must never do yourself

Merging, rebasing, `reset --hard`, `restore`, `clean`, deleting a branch, and
changing a contract someone else published. These can destroy work that is not
yours. Describe the operation, give the exact command, and ask.

`agentgit_reconcile` returns an `integrationOrder` and a `mergeCommand` for exactly
this reason: the plugin has already worked out what should happen, and the user is
the one who decides whether it does.

## Reading the ledger directly

When a tool is unavailable, the state is on disk and readable with ordinary tools:

- `.agentgit/events/<machine>-<date>.jsonl` — append-only ledger, one JSON event per
  line, sharded per machine so two machines pushing never conflict.
- `.agentgit/contracts/index.json` — published interface versions. Committed to Git.
- `.agentgit/state/leases.json`, `.agentgit/state/assumptions.json` — derived state,
  not committed, safe to delete; it is rebuilt from the ledger and the contracts.

Never edit `events/` by hand: it is append-only by contract, and a rewritten line
changes the `event_id` every other reader deduplicates on.

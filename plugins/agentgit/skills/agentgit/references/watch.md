# The coordination task: what to do each time it wakes

This is the protocol for the pinned `AgenticGit — <workspace>` task the plugin offers. That task
has one job: say something when the hub's ruling for its workspace changes, and say nothing
otherwise. It is a monitor, not a status feed.

## Read the projection, never the ledger

Read `<workspace>/.agentgit/state/hub.json`. That is the bounded file the daemon writes: one
ruling, its contentions, and any reservations, already rendered.

Do not read `.agentgit/events/`. The ledger grows without limit and the projection does not, and a
task that woke hourly to parse history would get slower every week the workspace stayed busy. The
same file is what the tool-call hook reads, so the text here and the text a working session sees
can never disagree.

## Decide, then almost always stay quiet

Compare `hub.json`'s `id` with `lastRulingId` in `<workspace>/.agentgit/state/desktop.json`.

- **The same id** - nothing has been concluded since last time. Post nothing. Record the check by
  calling `agentgit_desktop` with `lastRulingId` set to that id and `lastReportedAt` set to now,
  and stop.
- **A different id** - the ruling moved. Report it, then record the new `lastRulingId`.
- **No `hub.json`** - no daemon has published for this workspace. Say nothing. The spine hook
  starts one at session start, so this is almost always a workspace nobody has opened recently,
  and that is not news.

Say nothing also means: no "still nothing to report", no "checked again", no summary of the check
itself. A monitor that speaks on every run is one people mute, and a muted monitor is worse than
no monitor because it looks like coverage.

## When the ruling did change

Keep it short and lead with what needs a decision. Cover, in this order and only what applies:

1. The ruling itself: `reuse` (one job on this ground), `replan` (different work on shared ground),
   or `ambiguous` (the recorded wording cannot tell - a human or a session has to answer it with
   `agentgit_hub_resolve`).
2. The entities involved and who is on them - the tasks and sessions from the ruling.
3. Reservations, if any. These matter earlier than a ruling does: a reservation exists from the
   moment one task says it is working somewhere, while a ruling only exists once two have already
   collided.
4. The suggested next action, which the ruling already carries. Repeat it rather than inventing
   one.

If the ruling is `ambiguous`, say so plainly and say that it needs an answer - that is the one case
where the plugin deliberately stops and asks, because guessing would be worse than asking.

## What this task must never do

- Never refuse or gate a write. Verdicts are advisory; `review` is the only stop signal and it is
  for a human to act on.
- Never merge, rebase, reset or delete anything, and never rewrite history. If integration is
  needed, point at `agentgit_reconcile` and let the user run what it prints.
- Never report on a workspace other than the one in its title.

## Recording the check

`agentgit_desktop` is the tool for this. It only writes down what happened; it never creates a
task and never talks to the hub:

```
agentgit_desktop with lastRulingId="hub-..." lastReportedAt="<now>"
```

Call it on every run, including the quiet ones. That is what makes "has this task been looking?"
answerable, which is the difference between a quiet task and a broken one.

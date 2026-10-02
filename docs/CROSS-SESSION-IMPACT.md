# Cross-session impact analysis

AgentGit now separates candidate recall, directional inference, impact severity and
delivery timing. It answers **whether A's change invalidates B's current work**.
Matching goals alone never establishes a conflict and never triggers a notification.

The implementation is deterministic and local. Scores are explicitly labelled
`heuristic`, **not calibrated probabilities**. There is no embedding service, model
call or automatic full-program call-graph analysis in this release. Qualified
dependencies can be supplied by an agent or a static-analysis adapter through the
same declaration API.

## Inputs and evidence

The analyzer combines ordinary ledger reads/writes, published contract history and
recorded assumptions with explicit session snapshots and change events:

| Input | Contents |
| --- | --- |
| Session state | Goal, phase, active flag, entity read/write access, dependencies, contract versions and consumed parts, artifact versions, worktree and branch |
| Change | Event ID, producer session/task, stream/revision, planned/in-progress/completed/cancelled status, before/after, compatibility, changed entities/contracts/artifacts, evidence references and optional expiry |
| Relationship | Same entity, caller/callee, shared contract, shared artifact, or producer/consumer dependency |
| Result | Directed source/target IDs, category, evidence, confidence, heuristic score, severity, urgency, delivery policy and recommended action |

Use qualified keys such as `file::src/auth.ts`, `symbol::Auth.login` and
`artifact::schema`. File paths are normalized relative to the workspace; symbols
retain their qualified spelling. Branch names alone do not prove that two writes
share a filesystem. Supply `worktree` when simultaneous overwrite risk is known.
Session declarations **replace** previous declarations, allowing removed
dependencies and completed work to disappear from subsequent analysis.

Ordinary write hooks prove that a write was observed, not that a particular API
broke or that the write completed. Such observations have unknown compatibility.
Publishing structured evidence or an explicitly breaking contract is necessary to
establish a breaking dependency. Inferred assumptions remain uncertain.

## Classification and routing

| Category | Evidence required | Default routing threshold |
| --- | --- | --- |
| `hard_conflict` | Explicitly incompatible writes to the same entity or artifact in the same known worktree | 0.85 |
| `breaking_dependency` | Receiver uses a changed entity/output or holds an older assumption across an incompatible contract version | 0.80 |
| `soft_relevance` | Relevant entity, compatible dependency or artifact evidence | 0.60 |
| `background_only` | No actionable relationship; goal similarity is only a recall signal | Never pushed |

Contract `parts` narrow inference to what a receiver actually uses. An additive v3
does not erase a breaking v2 for a receiver still using v1. Explicit source streams
also retain intervening completed breaking versions when revisions are coalesced.
Unknown or inactive receivers, other workspaces and self-notifications are excluded.
The default receiver inactivity timeout is 30 minutes; the core API accepts a
different `sessionTtlMs` and per-category `thresholds` through `ImpactOptions`.

`interrupt` means an urgent **advisory at a host-provided safe boundary**, never a
process kill, tool cancellation or filesystem lock. Completed breaking changes
affecting a working receiver, and confirmed concurrent overwrite risks, qualify.
Planned changes and idle receivers defer. Thresholds decide routing independently
of the recorded severity.

- `PreToolUse` delivers urgent advisories before an edit starts.
- `PostToolUse` delivers deferred or urgent updates after the tool finishes.
- `SessionStart` and `UserPromptSubmit` deliver at a new session/turn boundary.
- `store-only` stays available through explicit queries without being injected.

Hosts that cannot expose these boundaries can query `agentgit_impacts` or the CLI
inbox at their own safe point. No model or tool is forcibly interrupted.

## CLI walkthrough

Run from the workspace root, using the receiving session's actual ID:

Save this as `consumer.json`:

```json
{
  "goal": "Implement login client",
  "phase": "working",
  "worktree": ".",
  "entities": [{"key": "file::src/client.ts", "access": "write"}],
  "contracts": [{"name": "auth.login", "version": 1, "parts": ["return.token"]}]
}
```

Save this as `change.json`:

```json
{
  "stream": "auth.login",
  "revision": 1,
  "summary": "Auth.login now returns an object",
  "before": "Token",
  "after": "{token, expires_at}",
  "status": "completed",
  "contracts": [{"name": "auth.login", "version": 2, "breaking": true, "parts": ["return.token"]}],
  "evidence": ["src/auth.ts:42", "commit:abc123"]
}
```

```bash
agentgit impact state --session caller --task login-client --file consumer.json
agentgit impact publish --session auth --task login-api --file change.json
agentgit impact inbox --session caller --json
agentgit impact ack impact-<id-from-inbox> --session caller
agentgit impact analyze --refresh --json
```

`--file -` reads JSON from stdin. `inbox` returns only the receiver's notifications;
`analyze` is the explicit workspace-wide diagnostic view. Reading an inbox never
acknowledges it. Publishing/state commands refresh the delivery projection, and
the daemon refreshes it while running. Existing `contracts publish` and
`contracts assume` commands also feed this analyzer.

## MCP tools

- `agentgit_impact_state({state, session, task?, workspace?})`: replace current state.
- `agentgit_impact_publish({change, session, task?, workspace?})`: append a structured change.
- `agentgit_impacts({session, workspace?})`: recompute this receiver's current impacts.
- `agentgit_impact_ack({id, session, workspace?})`: record that this receiver handled an impact.

Use `agentgit_assume` or a new state declaration to record the actual adaptation;
acknowledging a notification alone does not change an interface assumption.

## Persistence, freshness and migration

Structured declarations and acknowledgements are append-only `decision` events
with `impact/session`, `impact/change` and `impact/ack` host events. The existing
ledger wire schema is unchanged. Event retries are idempotent; reusing an event ID
or revision with different contents fails. Source revisions are serialized by a
short process-owned writer lock and must increase. Cancellation/expiry of the latest
revision does not resurrect its predecessor.

The daemon derives per-session files under `.agentgit/state/impact-inbox/` and the
hook records only displayed IDs under `impact-seen/`. A notification remains
`pending`, `delivered` or `acknowledged`; restart and repeated polls do not create
new IDs. Superseded changes and updated assumptions are re-evaluated on queries.
Losing derived receipt files can redisplay an unacknowledged item; ledger-backed
acknowledgements survive cache loss.

The hook reads a bounded inbox of at most 20 items, caps each delivery at 1500
characters and marks only items actually included. Remaining items stay pending.
Cached delivery is rejected after 10 seconds, or when a declaration or contract
assumption changed. Ordinary tool observations can lag by a daemon poll; consumers
should declare changed assumptions to invalidate obsolete advice immediately.
The hook never scans ledger history. Missing/corrupt caches are silent; the CLI and
MCP query paths still recompute directly. Malformed observations are counted.

Once a workspace has the new `impact-protocol.json` marker, automatic hook delivery
uses its selective inbox instead of broadcasting the legacy global advisory. The
global Hub remains queryable. Existing opt-in cross-chat checks only enqueue
confirmed urgent impacts for the actual receiver; deferred updates use safe-point
hooks. This feature does not enable cross-chat sending or create a coordinator.

## Validation

`npm test`, `npm run typecheck` and `npm run test:py` cover regression and wire
compatibility. The impact suites exercise directionality, high semantic similarity
without dependency evidence, low-similarity dependency recall, same-worktree risks,
partial contracts, intervening breaking versions, inactive sessions, replay,
acknowledgements, safe-point delivery, output limits and CLI/MCP round trips.

Run a real-ledger example with `node examples/impact/run.mjs`.

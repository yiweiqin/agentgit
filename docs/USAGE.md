# AgenticGit usage guide

[简体中文](USAGE.zh-cn.md) · [README](../README.md) · [Documentation index](INDEX.md)

This guide covers installation, permission, automatic checks, commands and limitations. See [architecture](ARCHITECTURE.md) for internals and [experiments](EXPERIMENTS.md) for validation.

## Install from source

Requires Node 22.19+, Git to obtain the checkout, and Codex with local plugins, hooks and MCP support. Ordinary folders support coordination; Git history features require a repository. Automatic coordination also needs the native Codex CLI's `queue` command and desktop cross-chat tools. Codex must remain running and authenticated.

```sh
git clone https://github.com/yiweiqin/agentgit.git
cd agentgit
npm ci
node packages/cli/bin/agentgit.mjs install
codex plugin add agentgit@personal
node packages/cli/bin/agentgit.mjs install --enable
node packages/cli/bin/agentgit.mjs doctor --workspace <absolute-workspace>
```

Use the marketplace name printed by the installer instead of `personal` if different. The installer generates local absolute paths for hooks, MCP and the background service. Keep the checkout, trust the hooks through Codex, and start a new chat. This is a private source package, not an npm release: do not use `npx agentgit`.

Commands below use `agentgit` for brevity. Run `npm link` if you want that executable on PATH; otherwise use `node packages/cli/bin/agentgit.mjs`. Run the wrapper from the checkout, and pass `--workspace <absolute-workspace>` for the project being coordinated.

Uninstall with `node packages/cli/bin/agentgit.mjs uninstall --disable`. Generated `.mcp.json`, `spine.json` and hook files contain machine-specific paths and should be generated locally rather than copied from another machine.

## First-time permission and setup

The plugin offers an explanation and a choice at session start, user prompt submission, or a completed write in an already-running session. There is no native file-open or folder-selection event. The offer instructs the agent to use the host's input panel when available; it does not directly create an OS popup.

After explicit workspace-scoped consent, the chat follows [setup.md](../plugins/agentgit/skills/agentgit/references/setup.md): verify the project and host tools, reserve setup, create or reuse one pinned `AgenticGit — <workspace>` coordinator, immediately save its actual ID, enable checks, start or reuse the background service, verify health, and tell the coordinator to scan.

An ordinary folder must be registered as a Codex project for this setup. If required tools or `queue` are missing, report the missing capability rather than claiming automatic coordination is active. The native `.exe` is needed on Windows, not a `.cmd` or `.ps1` launcher.

Declining creates no coordinator or workspace files in an unclaimed folder. The machine-level decision lives in `~/.agentgit/offers.json`. Ignored offers have a seven-day cooldown; explicit refusal is not periodically repeated. Existing opted-in workspace decisions live in `desktop.json`.

`/agentgit` separately enables tracking, pins the current chat and opens the panel. It does not itself authorize automatic messages or creation of a dedicated coordinator.

## Automatic checks and replies

Hooks record work; the background service finds relevant issues and writes `.agentgit/state/checks.json`. It wakes the configured coordinator through `codex queue`. The coordinator follows [coordinate.md](../plugins/agentgit/skills/agentgit/references/coordinate.md), verifies the target's workspace, reserves a check, sends it and saves a matching final reply.

| Stage | Meaning |
| --- | --- |
| `pending` | A valid check is waiting |
| `reserved` | One coordinator has reserved it using a token |
| `sent` | The message tool accepted delivery to the target |
| `replied` | An actual final reply matching the ID, target and timing was recorded |
| `failed` / `timed_out` / `cancelled` | Sending failed, a reply timed out, or the issue became invalid |

A reserved or sent check times out after ten minutes. A verified late reply remains acceptable. Uncertain sends and timeouts are not blindly resent; coordinator wake failures have bounded retries. For multiple checks to one chat, process each reply before sending the next check. Participants include the check ID, evidence, agreement or disagreement in their final response; they do not need to message the coordinator separately.

A queue acceptance is not an inspection result. A reply can dispute the issue, and does not prove it was resolved. Automatic checks use model calls in coordinator and participant chats. They do not automatically edit business code or merge results. No hourly automation is installed for the default workflow.

```sh
agentgit checks status --workspace <absolute-workspace>
agentgit checks disable --workspace <absolute-workspace>
agentgit desktop --clear-init --workspace <absolute-workspace>
```

Disabling preserves replies. `--clear-init` only clears the machine-level offer record for an unclaimed folder; it does not reset an existing workspace's coordinator or checks configuration. To resume checks, follow setup.md and reuse the recorded coordinator. Do not erase `desktop.json` or the durable queue as a recovery shortcut.

## Everyday operations

| Purpose | CLI | MCP tool |
| --- | --- | --- |
| Status and recent context | `status`, `brief`, `board` | `agentgit_status`, `agentgit_brief`, `agentgit_board` |
| Check a proposed write | `preflight <path> --intent <text>` | `agentgit_preflight` |
| Record or release work scope | `preflight <path> --claim`, `lease release <task>` | `agentgit_claim`, `agentgit_release` |
| Publish or depend on an interface | `contracts publish`, `contracts assume` | `agentgit_publish_contract`, `agentgit_assume` |
| Record changes and affected tasks | `impact state`, `impact publish`, `impact inbox` | `agentgit_impact_state`, `agentgit_impact_publish`, `agentgit_impacts` |
| Show code ownership and progress | `graph`, `graph --explain <oid-or-task>`, `up` | `agentgit_ui`, `agentgit_graph`, `agentgit_explain` |
| Inspect module dependencies | `modules [<module>]` | `agentgit_modules` |
| Resolve uncertain shared-work evidence | `hub` for inspection | `agentgit_hub_resolve` for an `ambiguous` ruling |
| Task branch, checkpoint and completion | `task start`, `task checkpoint`, `task finish` | `agentgit_task` |
| Review integration advice | `reconcile` | `agentgit_reconcile` |
| Inspect or tune settings | `config`, `config <setting> <value>` | CLI |

Use `agentgit help` for command syntax and `--workspace` to select the workspace. Pass both `path` and `symbol` to preflight when the function is known; function and file declarations can then be recognized as sharing a file.

| Write advice | Suggested response |
| --- | --- |
| `allow` | Continue within the stated scope |
| `reuse` | Check whether existing work can be reused |
| `refresh` | Read the changed interface and adapt |
| `replan` | Adjust assignments or agree on an order |
| `wait` | Work against the published interface or wait for it |
| `review` | Inspect the risk before proceeding |

Advice does not enforce a write lock. Task checkpoints stage only recorded task paths, and add `AgenticGit-Task` and `AgenticGit-Session` trailers. Two members editing the same file can still have mixed changes within that path; use clear ownership or separate worktrees. Old commits are not rewritten to add attribution. `reconcile` previews integration; the team decides the actual Git operation.

The panel labels commits using available provenance: commit trailers, task branches, ledger mappings, recorded chat names or fallback identifiers and Git authors. A fallback label is not proof of a recorded chat-to-commit assignment. Use `graph --explain` to inspect the evidence.

## Detection limits

Shared-file checks use recent work declarations, not proof of a merge conflict. Intent matching is lexical and can miss paraphrases or flag unrelated work. Renamed-code checks compare bounded, recent JS/TS files at file level; this is not general semantic equivalence detection. Templates, ambiguous slash syntax and insufficient samples are skipped. Exact bounds are documented in [architecture](ARCHITECTURE.md).

Interface impact requires registered dependencies, assumptions or structured change evidence. A generic write alone does not establish a breaking interface change. See [cross-session impact](CROSS-SESSION-IMPACT.md). Missing alerts do not prove absence of duplicate work or risk.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No initial offer | Plugin enabled, trusted hooks, actual lifecycle event, earlier refusal or recorded coordinator |
| Preflight warns but no message arrives | Enabled checks, valid coordinator ID, active service and actionable queued jobs |
| Service or wake fails | Actual PID and port in `daemon.json`, health response, native Codex path and `queue` |
| Check remains pending or reserved | Target routing, authorization scope and coordinator progress; do not guess delivery |
| Sent without a recorded reply | Target status, exact check ID in final reply and ten-minute timeout |
| Similar code not flagged | Recent supported files, sample bounds and skipped syntax |

Read `.agentgit/state/daemon.json` for the actual address and `.agentgit/state/spine.log` for startup diagnostics. Hook-started services select an available port. A manually started service defaults to 7777 when none exists; `up` may reuse an already-running service on another port. Never assume a fixed URL.

Without trusted hooks, history adoption observes completed writes and cannot replace pre-write warnings. Hook trust must be granted in Codex. Local chat IDs, executable paths and replies should not be published as reusable setup data. Review task descriptions and paths before sharing the ledger.

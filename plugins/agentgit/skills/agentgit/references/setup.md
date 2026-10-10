# Enable one workspace coordinator

Use this workflow after the user explicitly agrees to enable AgenticGit, create a dedicated
coordinator chat, and let it notify affected chats and read their inspection replies in this
workspace. The offer is a question; it does not itself authorize creation or messaging. Reuse
consent already given in this conversation. Never enable other workspaces on that consent.

Hooks can offer at SessionStart, UserPromptSubmit or after a completed write (PostToolUse). The current host has no folder-selection
hook: merely selecting a folder without starting a conversation cannot trigger this workflow.
An ordinary folder is supported; Git history features require a Git repository.

## Prepare without creating a chat

1. Resolve the exact workspace from the offer. Discover `list_projects`, `create_thread`,
   `read_thread`, `set_thread_title`, `move_thread_to_sidebar_section`, `send_message_to_thread`, `wait_threads`
   and `agentgit_desktop`. If these host tools are unavailable, explain which capability is missing.
   Do not claim a coordinator has been created.
2. Locate this plugin's generated `spine.json` (at the plugin root, three levels above this
   reference). Its `node` is the installed Node executable; `daemon` identifies
   `<checkout>/packages/daemon/src/main.ts`. Resolve the CLI from that checkout as
   `packages/cli/bin/agentgit.mjs`. Use this wrapper so Node 22 receives its required flags.
   Alternatively use `agentgit` on PATH. Quote paths for the actual shell; do not interpolate
   chat text into shell code. All commands below take `--workspace <absolute-workspace>`.
3. Find the native Codex executable using `Get-Command codex.exe -All` on Windows or
   `command -v codex` on POSIX. Verify its `queue --help` succeeds. On Windows the daemon needs
   the actual `.exe`, not a `.cmd` or `.ps1` launcher. If only a launcher is found, inspect its
   installed package to locate the native executable. Do not guess or hardcode another user's
   path. If this host has no `queue` command, explain that automatic wakeups are unavailable.
4. Call `list_projects` and select the project on this host whose workspace matches this folder.
   Never choose an unrelated project or silently create a projectless coordinator. If it is not
   listed, ask the user to add the folder as a Codex project, then resume setup.

## Reserve, create, and record

5. Run `checks begin-setup --thread <current-chat-uuid>`. This writes the first workspace state
   only after consent and holds a 15-minute setup reservation. If another chat owns it, wait
   for its result and reuse it; do not create another. If `result.coordinator` is present,
   inspect that chat and resume configuration with it. An inaccessible existing chat needs a
   user decision, never an automatic replacement.
6. If no coordinator is recorded, call `create_thread` once, targeting the matching project
   with `environment: {type: "local"}`. Title it `AgenticGit — <folder-name>`. Its prompt must
   name the absolute workspace and this skill's absolute `references/coordinate.md` path and
   state: "The user authorized this dedicated coordinator to detect conflicts, send inspection
   requests to affected chats in this workspace, wait for replies and summarize them. Setup is
   still running; wait for the setup-complete message before processing checks. No code edits,
   merges or messages to unrelated chats are authorized."
7. Immediately record the returned real `threadId` with `agentgit_desktop` for this workspace,
   before other setup steps. This makes an interrupted setup recoverable. Do not pass a
   `clientThreadId` as a thread ID; if creation is pending, wait for the real ID. If the create
   call has an ambiguous outcome, inspect recent chats for the exact setup prompt before any
   retry; an expired reservation alone is not proof that no chat was created.
8. Set its title and pin it with `move_thread_to_sidebar_section`, using its `threadId` and
   `sectionId: "pinned"`. Run `checks enable --coordinator <id> --codex
   <absolute-native-codex-executable>`. Then record `enabled: true` with `agentgit_desktop`.
   A previously recorded coordinator is configured using the same steps, without creating one.

## Start and verify

9. Invoke this plugin's `scripts/spine.mjs` with the installed Node and a JSON stdin payload
   containing `hook_event_name: "SessionStart"` and `cwd: <absolute-workspace>`. Use a structured
   process call with JSON serialization, not shell interpolation. The script starts the daemon
   detached and reuses an existing one. Read `.agentgit/state/daemon.json`, verify its process
   and HTTP health, then run `checks status` to verify the exact coordinator and enabled flag.
   Check `spine.log` if startup fails. Do not report automatic detection as active without this.
10. Send the setup-complete message to the coordinator, naming the workspace, installed Node,
    CLI wrapper and coordinate.md path. Tell it to run `checks scan`, follow that protocol,
    resume outstanding checks and stay quiet if nothing requires action. The user's setup
    consent covers this message and the continuing same-workspace inspection workflow.
11. Report the result and emit `::created-thread{threadId="..."}` when a chat was created.
    Explain any remaining host hook trust prompt: the user approves it in Codex, never by
    editing trust records. Without trusted hooks, history adoption sees completed writes;
    it does not provide pre-write warnings. Do not create an hourly heartbeat for this workflow.

On failure, retain any created chat ID, report the failed step and run `checks end-setup
--thread <current-chat-uuid>`. If checks were enabled but setup cannot finish, run `checks disable`
so the partial configuration does not send wakeups. Resume the recorded coordinator on retry.
If the user declines before setup, use `desktop --decline-init` for an unclaimed folder, or
`agentgit_desktop` with `decision: "declined"` for an existing workspace. No chat is created.

`checks disable` stops future automatic wakeups and preserves receipts. `desktop --clear-init`
allows another offer for an unclaimed folder. The panel-only `/agentgit` shortcut is separate:
pinning the current chat is not consent to automatic cross-chat messaging.

#!/usr/bin/env node
/**
 * Hook: the three moments this plugin speaks to a workspace before anything is in flight.
 *
 *   1. `/agentgit` in a prompt - the user asks to be enabled, so this is carried out rather than
 *      asked about: initialise, pin this conversation, and show the commit chain.
 *   2. An opted-in workspace is offered a pinned coordination task, at most once, and only ever as
 *      a question.
 *   3. An unclaimed folder or repository is offered the chance to be enabled, at most once per machine.
 *
 * Why this is a hook and not something the plugin does itself
 * ----------------------------------------------------------
 * A plugin cannot create a Codex task. The host's own rules say so: `create_thread` is only to be
 * used when the user *explicitly asks* for one, and a task made that way is user-owned - it appears
 * in the sidebar and the user is expected to follow up with it directly. No hook, MCP server or
 * automation can reach around that, and trying to would be the plugin doing something to the user
 * rather than for them.
 *
 * So this script does the half it is allowed to do: it notices, and puts one short block in front of
 * the user. The other half happens in the conversation, with the user's consent. That is the same
 * shape OpenAI's own Data Analytics plugin uses, and it is why two of the three blocks read as
 * instructions to ask rather than to act. The `/agentgit` block is the exception, and only because
 * typing the command is itself the explicit request the host's rules require.
 *
 * Once, and never again
 * ---------------------
 * The decision for an opted-in workspace is remembered in `state/desktop.json` whether the answer
 * was yes, no, or nothing. For a repository that has not opted in there is nowhere in it to write,
 * so that question is remembered on the machine instead - and the repository is left untouched.
 * The reason for both is the same: the plugin's output also carries rulings, which are the actual
 * product, and a hook that asked on every session would be the nag that teaches people to stop
 * reading all of it. `agentgit desktop --reset` is the way back for someone who refused by accident.
 *
 * The same three constraints as `track.mjs`, for the same reason
 * --------------------------------------------------------------
 * 1. **Only Node builtins and sibling scripts.** It runs from the installed plugin directory, which has no
 *    `node_modules` and no build step.
 * 2. **It reads no ledger.** Two small bounded files decide everything: the workspace's
 *    `state/desktop.json` and the machine-level offers record. Anything that grew with the size of
 *    the workspace would make a session start cost more as the project got bigger, which is the one
 *    thing this design forbids.
 * 3. **It cannot fail loudly.** Every path ends in `exit 0`, and silence is the normal output
 *    rather than a fallback - this hook is silent in every case except the three blocks above.
 *
 * The rules and the spellings they need are duplicated from `@agentgit/core/desktop`, because this
 * script cannot import the library. Copies drift, so `packages/cli/tests/desktop-hook.test.ts`
 * drives both against one table - the arrangement `canonicalEntityPath`, the arm table and the
 * endpoint file already use.
 *
 * @module agentgit/hook-desktop
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { isDirectRun, noteFailure } from './hook-errors.mjs'
import { firstString, findWorkspace, normalizePayload, readStdin } from './hook-runtime.mjs'

/** Must match `DESKTOP_VERSION` in `packages/core/src/desktop.ts`. */
const DESKTOP_VERSION = 2

/** Must match `DESKTOP_OFFER_COOLDOWN_MS` in `packages/core/src/desktop.ts`. */
const DESKTOP_OFFER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000

/** Must match `INIT_OFFERS_VERSION` in `packages/core/src/desktop.ts`. */
const INIT_OFFERS_VERSION = 1

/** Must match `INIT_OFFERS_MAX` in `packages/core/src/desktop.ts`. */
const INIT_OFFERS_MAX = 500

/** The state file's name inside `.agentgit/state/`, mirrored as literal text in the library. */
const DESKTOP_FILE_NAME = 'desktop.json'

/** The machine-level record's name, mirrored as literal text in the library. */
const OFFERS_FILE_NAME = 'offers.json'

/**
 * Belt-and-braces cap, and deliberately above what the offer actually measures.
 *
 * `packages/cli/tests/desktop-hook.test.ts` asserts the shipped text fits with room to spare, so
 * this is a backstop against a future edit rather than the thing that shapes the text. It used to
 * be the thing that shaped it, and the paragraph it cut was the one about getting consent.
 */
const MAX_OFFER_CHARS = 1200

/**
 * Caps for the two newer injections, kept separate from the offer's.
 *
 * A shared cap would let one block's growth silently cut another's last paragraph, and the
 * paragraphs these blocks end on are load-bearing: the enable block ends by saying not to rewrite
 * history, and the init offer ends by saying a refusal is a decision. Each is measured on its own.
 */
const MAX_ENABLE_CHARS = 1500
const MAX_INIT_CHARS = 1500

/**
 * Hook events this script answers.
 *
 * Both are moments where a human is about to read something anyway. `SessionStart` is where the
 * offer belongs; `UserPromptSubmit` is here so a session that started before the workspace was
 * claimed still gets asked on the next turn rather than at the next session.
 */
const EVENTS = new Set(['SessionStart', 'UserPromptSubmit'])

/** The conversation this process is running in, from the host environment. */
function hostThreadId() {
  return firstString(process.env, ['CODEX_THREAD_ID', 'CODEX_CONVERSATION_ID'])
}

/** The one spelling of the state file's path, mirroring `desktopStatePath` in the library. */
function desktopStatePath(root) {
  return join(root, '.agentgit', 'state', DESKTOP_FILE_NAME)
}

/** What the task is called in the sidebar, mirroring `desktopTaskTitle` in the library. */
function desktopTaskTitle(root) {
  const name = basename(resolve(root)) || resolve(root)
  return `AgenticGit — ${name}`
}

/* -------------------------------------------------------------------------- */
/* the decision                                                                */
/* -------------------------------------------------------------------------- */

function readState(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    if (raw.version !== DESKTOP_VERSION) return null
    return raw
  } catch {
    return null
  }
}

/**
 * Whether to offer this workspace a task, now. Mirrors `shouldOfferDesktop` in the library.
 *
 * Pure, and that is the point: it is the one part of this script the test suite can drive from a
 * table against the library's copy, so the two cannot drift into disagreeing about whether to ask.
 */
function shouldOfferDesktop(state, now) {
  if (!state) return true
  if (state.threadId) return false
  if (state.declinedAt) return false
  if (!state.offeredAt) return true
  const offeredAt = Date.parse(state.offeredAt)
  // An unreadable timestamp is treated as "just offered", so a corrupt field costs one cooldown
  // rather than an offer on every single session.
  if (!Number.isFinite(offeredAt)) return false
  return now.getTime() - offeredAt >= DESKTOP_OFFER_COOLDOWN_MS
}

/** Record that an offer was made. Merges, so a field this copy does not know about survives. */
function writeOfferedAt(file, previous, stateDir, root, now) {
  try {
    mkdirSync(stateDir, { recursive: true })
    /*
     * Every field is written, including the nulls.
     *
     * A partial record would still be read correctly - both readers treat a missing field as unset -
     * but this file is one a person may well open while working out why they were or were not asked,
     * and a record that omits the very fields that decide that is a worse thing to find than a long
     * one.
     *
     * `workspace` comes from the root rather than from the previous record, because the first offer
     * has no previous record and the field would otherwise be written as null - the one field that
     * says which workspace this decision is about.
     */
    const next = {
      version: DESKTOP_VERSION,
      workspace: resolve(root),
      threadId: textOrNull(previous && previous.threadId),
      automationId: textOrNull(previous && previous.automationId),
      offeredAt: now.toISOString(),
      declinedAt: textOrNull(previous && previous.declinedAt),
      lastRulingId: textOrNull(previous && previous.lastRulingId),
      lastReportedAt: textOrNull(previous && previous.lastReportedAt),
      // Carried through rather than rebuilt. This write happens on a session start that is
      // unrelated to `/agentgit`, and dropping these two would silently unpin every conversation
      // and forget that the workspace was ever enabled - a state the user never asked to change.
      pinnedThreads:
        previous && typeof previous.pinnedThreads === 'object' && previous.pinnedThreads
          ? previous.pinnedThreads
          : {},
      enabledAt: textOrNull(previous && previous.enabledAt),
    }
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch {
    // Failing to record the offer costs one repeated offer, which is better than failing a session.
  }
}

function textOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/* -------------------------------------------------------------------------- */
/* the machine-level record, for repositories that have not opted in yet       */
/* -------------------------------------------------------------------------- */

/*
 * Why this record is not in the repository
 * ---------------------------------------
 * A repository that has not opted in has nowhere to write: creating `.agentgit` just to remember
 * having asked would scatter coordination state across every repository an agent was ever opened
 * in, which is the failure the plugin's other rules are built to avoid. So the question is
 * remembered on the machine, under `AGENTGIT_HOME` (or the home directory), and the repository is
 * left byte for byte as it was.
 */

/** The directory the machine-level record lives in, honouring `AGENTGIT_HOME` for tests. */
function agentgitHome() {
  const configured = (process.env.AGENTGIT_HOME ?? '').trim()
  return configured !== '' ? resolve(configured) : join(homedir(), '.agentgit')
}

/** The one spelling of the machine-level record's path, mirroring `initOffersPath` in the library. */
function initOffersPath() {
  return join(agentgitHome(), OFFERS_FILE_NAME)
}

function emptyInitOffers() {
  return { version: INIT_OFFERS_VERSION, workspaces: {} }
}

/** Read the record, treating anything unreadable as "nothing remembered" - the safe direction. */
function readInitOffers() {
  try {
    const raw = JSON.parse(readFileSync(initOffersPath(), 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyInitOffers()
    if (raw.version !== INIT_OFFERS_VERSION) return emptyInitOffers()
    const workspaces = {}
    const source = raw.workspaces
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      for (const [dir, entry] of Object.entries(source)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
        workspaces[dir] = {
          offeredAt: textOrNull(entry.offeredAt),
          declinedAt: textOrNull(entry.declinedAt),
        }
      }
    }
    return { version: INIT_OFFERS_VERSION, workspaces }
  } catch {
    return emptyInitOffers()
  }
}

/** One repository's record, or `null` when this machine has not offered it. */
function initOfferFor(root) {
  return findInitOffer(readInitOffers().workspaces, root)?.record ?? null
}

/**
 * The machine-level record's key for a directory, mirroring `rootKey` in `packages/core/src/paths.ts`.
 *
 * On Windows `C:\repo` and `c:\repo` are one directory but two strings, and keying by the string
 * asked the same repository to opt in twice — the nag this record exists to prevent. Case is
 * folded exactly where the filesystem folds it, so two genuinely distinct directories on Linux
 * stay distinct.
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

function rootKey(input) {
  const absolute = resolve(input)
  let canonical = absolute
  try {
    canonical = realpathSync.native(absolute)
  } catch {
    // The path does not exist, or cannot be read; `resolve` is as much as can be known.
  }
  return CASE_INSENSITIVE_FS ? canonical.toLowerCase() : canonical
}

/** The record for one root, tolerating a key an older build wrote with the caller's spelling. */
function findInitOffer(workspaces, root) {
  const key = rootKey(root)
  const direct = workspaces[key]
  if (direct) return { key, record: direct }
  for (const [dir, record] of Object.entries(workspaces)) {
    if (rootKey(dir) === key) return { key: dir, record }
  }
  return null
}

/** The most recent timestamp a record carries, for ordering, or `0` when it has none. */
function initOfferStamp(record) {
  const value = record.offeredAt ?? record.declinedAt
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Drop records for directories that are gone, then cap what is left at the newest few.
 *
 * The key is an absolute path and a machine opens many repositories, so the record is bounded by
 * forgetting what it can no longer act on. A directory that no longer exists cannot be offered
 * again anyway, and timestamps order the survivors so the cap keeps the likely ones.
 */
function pruneInitOffers(workspaces) {
  const live = Object.entries(workspaces).filter(([dir]) => {
    try {
      return existsSync(dir)
    } catch {
      return false
    }
  })
  if (live.length <= INIT_OFFERS_MAX) return Object.fromEntries(live)
  live.sort((a, b) => initOfferStamp(b[1]) - initOfferStamp(a[1]))
  return Object.fromEntries(live.slice(0, INIT_OFFERS_MAX))
}

/** Apply a patch to one repository's record. A failure costs one repeated question, nothing more. */
function writeInitOffer(root, patch) {
  const current = readInitOffers()
  const found = findInitOffer(current.workspaces, root)
  // Re-key under the canonical spelling so the next read does not have to search.
  const existing = found?.record ?? { offeredAt: null, declinedAt: null }
  const withoutStaleKey = { ...current.workspaces }
  if (found && found.key !== rootKey(root)) delete withoutStaleKey[found.key]
  const workspaces = pruneInitOffers({
    ...withoutStaleKey,
    [rootKey(root)]: { ...existing, ...patch },
  })
  try {
    const file = initOffersPath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ version: INIT_OFFERS_VERSION, workspaces }, null, 2)}\n`, 'utf8')
  } catch {
    // See above: recording an offer is never worth failing a session over.
  }
}

/* -------------------------------------------------------------------------- */
/* the two newer rules, mirrored from `packages/core/src/desktop.ts`           */
/* -------------------------------------------------------------------------- */

/**
 * Whether to offer a not-yet-opted-in repository the chance to enable AgenticGit.
 *
 * Mirrors `shouldOfferInit` in the library. `kind` is a parameter rather than something the caller
 * filters on, so the hook and the library cannot disagree about which directories are asked.
 */
function shouldOfferInit(state, kind, now) {
  if (kind !== 'repo' && kind !== 'folder') return false
  if (!state) return true
  if (state.declinedAt) return false
  if (!state.offeredAt) return true
  const offeredAt = Date.parse(state.offeredAt)
  // An unreadable timestamp is treated as "just offered", so a corrupt field costs one cooldown
  // rather than a question on every single prompt.
  if (!Number.isFinite(offeredAt)) return false
  return now.getTime() - offeredAt >= DESKTOP_OFFER_COOLDOWN_MS
}

/**
 * Whether a user's message is the `/agentgit` command.
 *
 * Mirrors `promptEnablesAgentGit` in the library. Anchored to the first token: a message that
 * merely mentions the command while asking about something else must not enable a workspace.
 */
function promptEnablesAgentGit(prompt) {
  if (typeof prompt !== 'string') return false
  return /^\s*\/agentgit\b/i.test(prompt)
}

/**
 * Whether this conversation still needs pinning. Mirrors `shouldPinOnEnable` in the library.
 *
 * A workspace has many conversations and the pin is per conversation, so enabling from a second
 * one pins that one too, while re-running the command in one already pinned does not.
 */
function shouldPinOnEnable(state, threadId) {
  if (typeof threadId !== 'string' || threadId.trim() === '') return false
  if (!state || !state.pinnedThreads) return true
  return !state.pinnedThreads[threadId]
}

/* -------------------------------------------------------------------------- */
/* the offer                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The text put in front of the user, with the instructions the model needs to carry it out.
 *
 * Two things about its shape are deliberate, and both are the result of getting it wrong once:
 *
 * - **The consent requirement is in the first line.** An earlier version put "never create a task
 *   without an explicit yes" at the bottom, where the length cap silently removed it - the one
 *   instruction this whole design is drawn around was the one thing that could be cut. It now
 *   appears in the header and again at the end, so no single truncation can take both.
 * - **It is kept well inside the cap.** `packages/cli/tests/desktop-hook.test.ts` asserts the
 *   shipped text fits with room to spare, so an edit that grew it fails loudly here instead of
 *   quietly losing its last paragraph in a session.
 */
function offerText(title) {
  return [
    '## AgenticGit — offer a coordination task (ask the user first; never create one unasked)',
    `Ask in the user's language: enable AgenticGit here and create one pinned chat "${title}"`,
    'to detect conflicts, notify affected chats, wait for their checks and summarize replies?',
    'An explicit yes authorizes that same-workspace inspection workflow; silence does not.',
    'After yes, read references/setup.md and finish the setup without asking again:',
    '`list_projects`, `create_thread`, `set_thread_title`, `set_thread_pinned`,',
    '`send_message_to_thread`, `agentgit_desktop`; enable checks and start the daemon.',
    'Emit `::created-thread{threadId="<id>"}`. The new chat follows references/coordinate.md.',
    'Reserve setup first and reuse a recorded coordinator; never create a second one.',
    'If declined, call `agentgit_desktop` with decision="declined" and drop the subject.',
    'If host tools are unavailable, explain the limitation; do not claim setup succeeded.',
  ].join('\n')
}

function initOfferText(title) {
  return [
    '## AgenticGit — this workspace is not coordinating yet (ask the user first; never create one unasked)',
    `Ask in the user's language: enable AgenticGit for this folder and create a pinned chat "${title}"`,
    'to detect conflicts, notify affected chats, wait for their checks and summarize replies?',
    'Create nothing without an explicit yes. Consent covers only this workspace, not other projects.',
    'After yes, read references/setup.md: reserve setup, call `agentgit_status`, `list_projects`,',
    '`create_thread`, `set_thread_title`, `set_thread_pinned`; enable checks and start the daemon.',
    'Emit `::created-thread{threadId="<id>"}`; `send_message_to_thread` with references/coordinate.md.',
    '`agentgit_desktop`: record the new threadId immediately, then enabled:true; `agentgit_ui` shows the panel.',
    'Do not start an hourly monitor: the daemon wakes the coordinator on actionable changes.',
    'If they say no, run `agentgit desktop --decline-init --workspace <this-folder>`; it records',
    'the refusal on this machine without changing the folder. `--clear-init` allows another offer.',
    'Never create a second one. This also supports ordinary folders without Git history.',
  ].join('\n')
}

/**
 * The text for `/agentgit`: enable this workspace, and pin the conversation it was typed in.
 *
 * This is the one injection that is not a question. Typing the command is the explicit request the
 * host's rules require, so the block reads as instructions to carry out rather than an offer to
 * relay - and it says so in the first line, because the last line is where a length cap lands.
 *
 * `needsPin` is false when this conversation is already recorded as pinned, which makes the block
 * idempotent instead of pinning the same window twice.
 */
function enableText(title, pinnedThreadId, pinNow) {
  // The host does not always hand a hook the conversation's id. `pinNow` is true in that case too,
  // because a pin the record cannot be checked against is not the same as a pin already recorded -
  // the block still asks for it, and the model supplies the id it is running in.
  const pinTarget = pinnedThreadId ? `threadId "${pinnedThreadId}"` : "this conversation's own threadId"
  const record = pinnedThreadId
    ? `3. Record it: \`agentgit_desktop\` with \`enabled: true\` and \`pinnedThreadId="${pinnedThreadId}"\`.`
    : '3. Record it: `agentgit_desktop` with `enabled: true` and `pinnedThreadId` for this conversation.'
  const lines = [
    '## AgenticGit — enable this workspace (the user typed /agentgit: carry this out, and ask nothing further)',
    '',
    `\`/agentgit\` is the user's explicit request to turn AgenticGit on for "${title}" and pin this`,
    'conversation to the top of that workspace. Do this, in order:',
    '',
    '1. Initialise: call `agentgit_status` once. It creates `.agentgit/` for this workspace, which',
    '   is what "enabled" means here.',
    pinNow
      ? `2. Pin this conversation: \`set_thread_pinned\` with ${pinTarget}. That is what keeps`
      : '2. This conversation is already recorded as pinned, so `set_thread_pinned` is a no-op here;',
    pinNow ? "   this window at the top of the workspace's conversation list." : '   do not repeat it.',
    record,
    '4. Show the chain: call `agentgit_ui`, which draws this workspace\'s commit graph with every',
    '   commit attributed to the conversation that made it.',
    '5. Attribution starts now. Commits made before this moment keep the attribution the graph',
    '   already gives them - the task branch, the trailers, the Git author. Never rewrite history,',
    '   never amend an existing commit to add attribution, and never reorder the existing chain.',
  ]
  return lines.join('\n')
}

/* -------------------------------------------------------------------------- */
/* main                                                                        */
/* -------------------------------------------------------------------------- */

/** The one hook response, capped, as a string the dispatcher can merge. */
function emit(eventName, advisory, maxChars) {
  const capped = advisory.length <= maxChars ? advisory : `${advisory.slice(0, maxChars - 3)}...`
  return `${JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: capped },
  })}\n`
}

/**
 * Three injected blocks, and exactly one of them per event.
 *
 * The order is the policy:
 *
 * 1. **`/agentgit` on a prompt.** The only route a repository can take without having opted in
 *    first, because the user asking for it *is* the opt-in. It answers before anything else, so a
 *    user who types the command never gets an offer to do what they just asked for.
 * 2. **An opted-in workspace** gets the existing offer of a pinned coordination task. Permission to
 *    ask is the same rule `track.mjs` uses to decide whether to record - a workspace that has
 *    claimed itself with `.agentgit` - so all three hooks agree about which directory it is.
 * 3. **A bare repository** gets the offer to enable coordination here. The question is remembered
 *    on the machine, so the repository is left byte for byte as it was.
 *
 * A directory that is neither is not spoken to at all.
 */
/**
 * The hook-output object to print, or `null` when no block applies.
 *
 * Returns the string rather than printing it so `hook.mjs` can merge this with the hub's context
 * into one response. Standalone use is unchanged — see {@link isDirectRun} below.
 */
export function run(payloadText) {
  const payload = normalizePayload(payloadText)
  if (!payload) return null
  if (!EVENTS.has(payload.eventName)) return null
  if (!payload.cwd) return null

  const found = findWorkspace(payload.cwd, { allowFolder: true })
  if (!found.root) return null

  const now = new Date()
  const threadId = hostThreadId() ?? payload.threadId

  if (
    payload.eventName === 'UserPromptSubmit' &&
    found.kind !== 'none' &&
    promptEnablesAgentGit(payload.prompt)
  ) {
    const state = found.kind === 'claimed' ? readState(desktopStatePath(found.root)) : null
    // No id means the record cannot be consulted, so the pin is asked for rather than skipped; an
    // id means the workspace's own record decides, which is what makes the block idempotent.
    const pinNow = !threadId || shouldPinOnEnable(state, threadId)
    return emit(payload.eventName, enableText(desktopTaskTitle(found.root), threadId, pinNow), MAX_ENABLE_CHARS)
  }

  if (found.kind === 'claimed') {
    const file = desktopStatePath(found.root)
    const stateDir = join(found.root, '.agentgit', 'state')
    const state = readState(file)
    if (!shouldOfferDesktop(state, now)) return null

    // Recorded before printing, so a crash between the two costs an unanswered offer rather than
    // the same offer on every subsequent session.
    writeOfferedAt(file, state, stateDir, found.root, now)
    return emit(payload.eventName, offerText(desktopTaskTitle(found.root)), MAX_OFFER_CHARS)
  }

  if (['repo', 'folder'].includes(found.kind) && shouldOfferInit(initOfferFor(found.root), found.kind, now)) {
    // Recorded before printing, for the same reason as above.
    writeInitOffer(found.root, { offeredAt: now.toISOString() })
    return emit(payload.eventName, initOfferText(desktopTaskTitle(found.root)), MAX_INIT_CHARS)
  }
  return null
}

if (isDirectRun(import.meta.url)) {
  let output = null
  try {
    output = run(readStdin())
  } catch (error) {
    // Offering a task is never worth failing a session over, but the failure is worth writing
    // down: an offer that never prints and an offer that was declined both look like silence.
    noteFailure('desktop', error, { cwd: process.cwd() })
  }
  if (output) process.stdout.write(output)
  process.exit(0)
}

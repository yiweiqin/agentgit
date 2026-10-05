/**
 * The offer hook: the one moment the plugin asks for something, and the many where it must not.
 *
 * This is the highest-risk script in the plugin, and not because of what it does when it fires -
 * a block of text is harmless. It is what it must not do:
 *
 * 1. **It must never create anything.** The host reserves `create_thread` for an explicit user
 *    request, so an injected block that read as authorisation would be the plugin acting on the
 *    user rather than for them. The tests below pin that the output is an *offer to ask*, and one
 *    of them asserts the script contains no way to create a task at all.
 * 2. **It must never repeat.** The plugin's other output is the rulings, which are the actual
 *    product, and a hook that asked on every session is the nag that teaches people to stop
 *    reading all of it. So: once, remembered whether the answer was yes, no, or nothing.
 * 3. **It must never decide about the wrong workspace.** It writes a "do not ask again" record, so
 *    a guessed directory would permanently silence the offer for whatever project the hook process
 *    happened to be standing in.
 *
 * The two rules and two spellings it needs are copied into the script rather than imported, because
 * it runs from an installed plugin directory with no `node_modules`. The drift tests at the bottom
 * drive the shipped source against `@agentgit/core` over one table - the same arrangement
 * `canonicalEntityPath`, the arm table and the endpoint file already use.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  DESKTOP_OFFER_COOLDOWN_MS,
  DESKTOP_VERSION,
  INIT_OFFERS_MAX,
  INIT_OFFERS_VERSION,
  desktopStatePath,
  desktopTaskTitle,
  initOfferFor,
  initOffersPath,
  promptEnablesAgentGit,
  shouldOfferDesktop,
  shouldOfferInit,
  shouldPinOnEnable,
  workspacePaths,
  writeInitOffer,
  type DesktopState,
  type InitOfferRecord,
  type WorkspaceKind,
} from '@agentgit/core'

import { removeScratch } from './housekeeping.ts'

/** The checkout root, found from this file rather than from the working directory. */
const REPO = join(import.meta.dirname, '..', '..', '..')
const DESKTOP = join(REPO, 'plugins', 'agentgit', 'scripts', 'desktop.mjs')
const HOOK_ERRORS = join(REPO, 'plugins', 'agentgit', 'scripts', 'hook-errors.mjs')
const HOOK_RUNTIME = join(REPO, 'plugins', 'agentgit', 'scripts', 'hook-runtime.mjs')

let home: string
let workspace: string
let neutral: string
let shim: string
let offersHome: string

beforeEach(() => {
  // `home` stands in for the installed plugin directory. The script needs no generated config of
  // its own - unlike the spine, which needs to be told where the daemon is - so this is a copy of
  // the script and nothing else.
  home = mkdtempSync(join(tmpdir(), 'agentgit-desktop-home-'))
  workspace = mkdtempSync(join(tmpdir(), 'agentgit-desktop-ws-'))
  neutral = mkdtempSync(join(tmpdir(), 'agentgit-desktop-cwd-'))
  // The machine-level record must never land in the real home directory when this suite runs, so
  // every hook is pointed at a scratch one. That is the same reason the plugin honours the
  // variable in the first place.
  offersHome = mkdtempSync(join(tmpdir(), 'agentgit-desktop-offers-'))
  shim = join(home, 'scripts', 'desktop.mjs')
  mkdirSync(join(home, 'scripts'), { recursive: true })
  writeFileSync(shim, readFileSync(DESKTOP, 'utf8'), 'utf8')
  // Include the sibling modules shipped by an installed plugin.
  writeFileSync(join(home, 'scripts', 'hook-errors.mjs'), readFileSync(HOOK_ERRORS, 'utf8'), 'utf8')
  writeFileSync(join(home, 'scripts', 'hook-runtime.mjs'), readFileSync(HOOK_RUNTIME, 'utf8'), 'utf8')
})

afterEach(() => {
  removeScratch(home)
  removeScratch(workspace)
  removeScratch(offersHome)
  // This one was the cwd of a process the test just spawned, which is the case Windows keeps a
  // handle on for a moment. See `housekeeping.ts`.
  removeScratch(neutral)
})

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** A workspace that has opted in, which is what every real offer is made in. */
function claim(root = workspace): void {
  mkdirSync(join(root, '.agentgit', 'state'), { recursive: true })
}

/** A record of a previous decision, written exactly as the script writes it. */
function seed(overrides: Partial<DesktopState>): void {
  const base: DesktopState = {
    version: DESKTOP_VERSION,
    workspace: resolve(workspace),
    threadId: null,
    automationId: null,
    offeredAt: null,
    declinedAt: null,
    lastRulingId: null,
    lastReportedAt: null,
    pinnedThreads: {},
    enabledAt: null,
    ...overrides,
  }
  mkdirSync(join(workspace, '.agentgit', 'state'), { recursive: true })
  writeFileSync(desktopStatePath(workspacePaths(workspace)), `${JSON.stringify(base, null, 2)}\n`, 'utf8')
}

function readState(): DesktopState | null {
  try {
    return JSON.parse(readFileSync(desktopStatePath(workspacePaths(workspace)), 'utf8')) as DesktopState
  } catch {
    return null
  }
}

/**
 * Run the hook as the host would: payload on stdin, at most one JSON object on stdout.
 *
 * `overrides` exists for the one case the environment decides: whether the host told the hook which
 * conversation it is running in. An empty `CODEX_THREAD_ID` stands in for a host that did not.
 */
function runHook(
  payload: unknown,
  overrides: Record<string, string | undefined> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [shim], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    // Never the checkout: a payload without `cwd` must not be able to reach the repository this
    // suite runs from. That bug has already happened once in this package.
    cwd: neutral,
    // The machine-level record for repositories that have not opted in must land here, not in the
    // real home directory of whoever is running the suite.
    env: { ...process.env, AGENTGIT_HOME: offersHome, CODEX_THREAD_ID: 'thread-a', ...overrides },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function sessionStart(cwd: string | null = workspace): Record<string, unknown> {
  const payload: Record<string, unknown> = { hook_event_name: 'SessionStart', session_id: 'session-a' }
  if (cwd !== null) payload.cwd = cwd
  return payload
}

function prompt(cwd = workspace): Record<string, unknown> {
  return { hook_event_name: 'UserPromptSubmit', session_id: 'session-a', cwd }
}

/** The injected text, or `null` when the hook chose to say nothing. */
function injected(result: { stdout: string }): string | null {
  if (result.stdout.trim() === '') return null
  const parsed = JSON.parse(result.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string }
  }
  return parsed.hookSpecificOutput.additionalContext
}

/** How many state files exist, for asserting that nothing was written. */
function stateFiles(): string[] {
  try {
    return readdirSync(join(workspace, '.agentgit', 'state'))
  } catch {
    return []
  }
}

/* -------------------------------------------------------------------------- */

describe('the offer hook cannot fail a session', () => {
  test('offers an ordinary folder without modifying it', () => {
    const result = runHook(sessionStart())

    assert.equal(result.status, 0)
    assert.match(injected(result) ?? '', /enable AgenticGit/)
    assert.equal(result.stderr, '')
    assert.equal(existsSync(join(workspace, '.agentgit')), false, 'a stranger directory must not gain state')
  })

  test('offers a bare repository, and leaves the repository byte for byte alone', () => {
    // A repository that has not opted in is now worth offering to - that is the moment a new
    // workspace appears - but where the answer is remembered must not change. Creating `.agentgit`
    // here would be the plugin opting a repository in so that it could ask about opting in, and
    // would scatter state across every repository an agent was ever opened in.
    mkdirSync(join(workspace, '.git'), { recursive: true })
    const result = runHook(sessionStart())

    assert.equal(result.status, 0)
    const text = injected(result)
    assert.ok(text, 'a bare repository should be offered the chance to enable AgenticGit')
    assert.match(text, /AgenticGit/)
    assert.equal(existsSync(join(workspace, '.agentgit')), false, 'the repository itself is untouched')
    // Recorded on the machine, so the question is not asked again at the next session.
    assert.ok(initOfferFor(workspace, { AGENTGIT_HOME: offersHome })?.offeredAt)
    assert.equal(existsSync(initOffersPath({ AGENTGIT_HOME: offersHome })), true)
    assert.equal(runHook(sessionStart()).stdout, '')
  })

  test('an ordinary folder is offered once per cooldown', () => {
    // `none` is not a repository, so there is nothing to enable and nowhere to record an offer.
    const result = runHook(sessionStart())

    assert.equal(result.status, 0)
    assert.match(injected(result) ?? '', /ordinary folders/)
    assert.equal(existsSync(join(workspace, '.agentgit')), false)
    assert.ok(initOfferFor(workspace, { AGENTGIT_HOME: offersHome })?.offeredAt)
    assert.equal(runHook(sessionStart()).stdout, '')
  })

  test('survives every malformed payload without failing or printing', () => {
    claim()
    for (const payload of ['', '{', 'null', '[]', '"a string"', '{"hook_event_name":"SessionStart"}']) {
      const result = runHook(payload)
      assert.equal(result.status, 0, `payload ${JSON.stringify(payload)} must not fail the hook`)
      assert.equal(result.stdout, '')
    }
    assert.deepEqual(stateFiles(), [], 'a malformed payload must not record a decision')
  })

  test('a payload with no cwd offers nothing, because the workspace would be a guess', () => {
    // The record this script writes means "never ask again". Writing it for a guessed directory
    // would silence the offer for whatever project the hook process happened to be in, and would
    // also let a test reach into the checkout.
    const result = runHook(sessionStart(null))

    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
    assert.deepEqual(stateFiles(), [])
    assert.equal(existsSync(join(neutral, '.agentgit')), false)
  })

  test('answers only the events where a human is about to read something', () => {
    claim()
    for (const event of ['PreToolUse', 'Stop', 'SessionEnd', 'PreCompact']) {
      const result = runHook({ hook_event_name: event, session_id: 'session-a', cwd: workspace })
      assert.equal(result.status, 0)
      assert.equal(result.stdout, '', `${event} is not a moment to ask a question`)
    }
    // A `PostToolUse` payload is only worth answering when it reports a write; one that names no
    // tool, or a read, is not. Both are covered directly in the describe block below.
    assert.equal(runHook({ hook_event_name: 'PostToolUse', session_id: 'session-a', cwd: workspace }).stdout, '')
    assert.deepEqual(stateFiles(), [])
  })

  test('an unreadable record does not throw, and does not silence the offer', () => {
    claim()
    writeFileSync(desktopStatePath(workspacePaths(workspace)), '{"version":1,"threadId":', 'utf8')

    const result = runHook(sessionStart())

    assert.equal(result.status, 0)
    // A torn record reads as "nothing decided", so the offer is made rather than lost.
    assert.ok(injected(result), 'a torn record must not permanently lose the offer')
  })
})

describe('what reaches the user, and what it asks for', () => {
  test('a claimed workspace is offered exactly once, as a question', () => {
    claim()
    const result = runHook(sessionStart())

    assert.equal(result.status, 0)
    const text = injected(result)
    assert.ok(text, 'a claimed workspace should be offered a task')

    const parsed = JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string } }
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart')

    // The offer has to be recognisable and has to name the task it would create.
    assert.match(text, /AgenticGit/)
    assert.match(text, new RegExp(desktopTaskTitle(workspace).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })

  test('the offer tells the model to ask, and to stop if the answer is no', () => {
    claim()
    const text = injected(runHook(sessionStart())) ?? ''

    // Three separate ways of saying "do not act without consent", because the host's rule that a
    // task is only created on an explicit request is the boundary this feature is drawn against.
    assert.match(text, /ask/i)
    assert.match(text, /explicit/i)
    assert.match(text, /declined/)
  })

  test('the offer carries the directive that makes the task appear', () => {
    // `create_thread` alone does not put anything in the sidebar; the host needs this line in the
    // reply, and an offer that omitted it would produce work with no visible result.
    claim()
    const text = injected(runHook(sessionStart())) ?? ''
    assert.match(text, /::created-thread\{threadId="<id>"\}/)
  })

  test('the offer names the tools it needs and the cadence the heartbeat should use', () => {
    claim()
    const text = injected(runHook(sessionStart())) ?? ''
    for (const needle of [
      'create_thread',
      'set_thread_title',
      'set_thread_pinned',
      'send_message_to_thread',
      'references/setup.md',
      'agentgit_desktop',
      'references/coordinate.md',
      'daemon',
    ]) {
      assert.ok(text.includes(needle), `the offer must mention ${needle}`)
    }
  })

  test('the shipped text fits the cap with room to spare, so nothing is silently cut', () => {
    // The first version of this hook put "never create a task without an explicit yes" in its last
    // line, and the cap removed it. An offer that had lost the sentence it was built around looked
    // exactly like one that had not. So the text is measured here, against a title as long as this
    // workspace's, and the consent requirement is asserted to survive into what reaches a session.
    claim()
    const text = injected(runHook(sessionStart())) ?? ''
    const cap = Number(constFromSource(readFileSync(DESKTOP, 'utf8'), 'MAX_OFFER_CHARS'))

    assert.ok(text.length <= cap, `the offer is ${text.length} chars, over the cap of ${cap}`)
    assert.ok(text.length > 900, 'a cap that never binds is not being tested; the text really is this long')
    assert.match(text, /explicit yes/, 'the consent requirement must survive to the end')
    assert.match(text, /never create one unasked/, 'and it must be in the header, where nothing can cut it')
  })

  test('it records that it asked, so a crash after printing cannot ask twice', () => {
    claim()
    runHook(sessionStart())

    const state = readState()
    assert.ok(state?.offeredAt, 'the offer must be recorded, not just printed')
    assert.equal(state?.threadId, null, 'offering is not the same as creating')
    // The record is written whole, including the fields that are still unset: it is a file a person
    // may open while working out why they were asked, and a partial one is a worse thing to find.
    assert.equal(state?.declinedAt, null)
    assert.equal(state?.workspace, resolve(workspace))
  })

  test('offering a task does not unpin a conversation or forget the workspace was enabled', () => {
    // The offer writes this file on a session start that has nothing to do with `/agentgit`. If it
    // rebuilt the record from the fields it knows, every pin and the enabled instant would be gone -
    // and the symptom would be a pin that quietly stops working, with nothing recording why.
    claim()
    seed({
      pinnedThreads: { 'thread-a': '2026-01-01T00:00:00.000Z' },
      enabledAt: '2026-01-02T00:00:00.000Z',
    })

    assert.ok(injected(runHook(sessionStart())), 'the task offer is still due')

    const state = readState()
    assert.deepEqual(state?.pinnedThreads, { 'thread-a': '2026-01-01T00:00:00.000Z' })
    assert.equal(state?.enabledAt, '2026-01-02T00:00:00.000Z')
  })

  test('a prompt in an already-offered workspace is not a second offer', () => {
    claim()
    assert.ok(injected(runHook(sessionStart())))
    assert.equal(runHook(prompt()).stdout, '', 'the second event must not ask again')
  })

  test('says what AgenticGit is, not only that it wants to be enabled', () => {
    // The offer used to read as a request with no explanation, so the user had to enable
    // something to find out what it was. The description has to survive into what reaches the
    // session, or the question is being asked without an answer available.
    claim()
    const text = injected(runHook(sessionStart())) ?? ''
    assert.match(text, /coordination layer/)
    assert.match(text, /notifies only the affected chats/)
  })
})

describe('a completed write can still reach a session that missed SessionStart', () => {
  function postTool(toolName: string, cwd = workspace): Record<string, unknown> {
    return { hook_event_name: 'PostToolUse', session_id: 'session-a', cwd, tool_name: toolName }
  }

  test('a completed write is offered, because the session may have started before it was enabled', () => {
    claim()
    const text = injected(runHook(postTool('apply_patch')))
    assert.ok(text, 'a completed write should be able to trigger the offer')
    assert.match(text, /offer a coordination task/)
    assert.ok(readState()?.offeredAt, 'offering must still be recorded')
  })

  test('a completed read is not a moment to ask', () => {
    claim()
    for (const tool of ['read', 'grep', 'list_dir']) {
      assert.equal(runHook(postTool(tool)).stdout, '', `${tool} is not a write`)
    }
    assert.deepEqual(stateFiles(), [])
  })

  test('a second completed write does not ask again', () => {
    claim()
    assert.ok(injected(runHook(postTool('apply_patch'))))
    assert.equal(runHook(postTool('apply_patch')).stdout, '')
  })
})

describe('once decided, the question is over', () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  test('a recorded task ends it for good', () => {
    seed({ threadId: 'thread-1', automationId: 'auto-1', offeredAt: daysAgo(30) })
    assert.equal(runHook(sessionStart()).stdout, '')
  })

  test('a refusal ends it too, and is not repeated a week later', () => {
    const declinedAt = daysAgo(1)
    seed({ declinedAt, offeredAt: declinedAt })
    for (const event of [sessionStart(), prompt()]) {
      assert.equal(runHook(event).stdout, '')
    }
    // A hook that decided not to speak must not have rewritten the decision on its way past.
    assert.equal(readState()?.declinedAt, declinedAt)
    assert.equal(readState()?.threadId, null)
  })

  test('an unanswered offer waits out the cooldown, then is made again', () => {
    seed({ offeredAt: daysAgo(1) })
    assert.equal(runHook(sessionStart()).stdout, '', 'one day in is inside the cooldown')

    seed({ offeredAt: daysAgo(8) })
    assert.ok(injected(runHook(sessionStart())), 'past the cooldown it is offered again')
  })

  test('the cooldown restarts from a fresh offer rather than from the first one', () => {
    // Otherwise an offer made eight days ago and ignored would re-ask on every session from then
    // on, which is the nag this rule exists to prevent.
    seed({ offeredAt: daysAgo(8) })
    assert.ok(injected(runHook(sessionStart())))
    assert.equal(runHook(sessionStart()).stdout, '', 'the new offer starts a new window')
  })

  test('a record from another version is not trusted, so the workspace is offered again', () => {
    // The safe direction. Every field in this file means "do not ask again", so honouring one whose
    // meaning may have changed is the only way it can do harm; losing it costs one repeated offer.
    // This is the opposite of what the *library's* reader does, which is checked here so the two
    // cannot drift apart silently.
    seed({ version: DESKTOP_VERSION + 1, threadId: 'thread-1' })

    assert.ok(injected(runHook(sessionStart())), 'an unreadable version must not silently drop the offer')
    assert.equal(readState()?.version, DESKTOP_VERSION, 'and the record is rewritten in the current shape')
  })
})

describe('the offer to enable a repository that has not opted in', () => {
  function asRepo(): void {
    mkdirSync(join(workspace, '.git'), { recursive: true })
  }

  test('names the tools that initialise, pin, record and refuse it', () => {
    asRepo()
    const text = injected(runHook(sessionStart())) ?? ''
    for (const needle of [
      'agentgit_status',
      'create_thread',
      'set_thread_pinned',
      'agentgit_ui',
      'agentgit_desktop',
      '--decline-init',
    ]) {
      assert.ok(text.includes(needle), `the init offer must mention ${needle}`)
    }
  })

  test('keeps the consent requirement in the first line, where nothing can cut it', () => {
    asRepo()
    const text = injected(runHook(sessionStart())) ?? ''
    const first = text.split('\n')[0]
    assert.match(first, /ask the user first/i)
    assert.match(first, /never create one unasked/)
    assert.match(text, /::created-thread\{threadId="<id>"\}/)
  })

  test('the shipped text fits its own cap with room to spare', () => {
    asRepo()
    const text = injected(runHook(sessionStart())) ?? ''
    const cap = Number(constFromSource(readFileSync(DESKTOP, 'utf8'), 'MAX_INIT_CHARS'))
    assert.ok(text.length <= cap, `the init offer is ${text.length} chars, over the cap of ${cap}`)
    assert.ok(text.length > 900, 'a cap that never binds is not being tested; the text really is this long')
  })

  test('claiming the workspace ends the init offer, because the workspace offer takes over', () => {
    asRepo()
    assert.ok(injected(runHook(sessionStart())))
    claim()
    const text = injected(runHook(sessionStart())) ?? ''
    assert.match(text, /offer a coordination task/, 'an opted-in workspace gets the task offer instead')
  })

  test('a machine-level refusal is terminal, and is remembered outside the repository', () => {
    asRepo()
    writeInitOffer(workspace, { declinedAt: new Date().toISOString() }, { AGENTGIT_HOME: offersHome })
    for (const event of [sessionStart(), prompt()]) {
      assert.equal(runHook(event).stdout, '', 'a refusal is not asked again')
    }
    assert.equal(existsSync(join(workspace, '.agentgit')), false)
  })

  test('the next prompt after a bare-repo offer is not a second one', () => {
    asRepo()
    assert.ok(injected(runHook(sessionStart())))
    assert.equal(runHook(prompt()).stdout, '')
  })
})

describe('the /agentgit command', () => {
  function command(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { hook_event_name: 'UserPromptSubmit', session_id: 'session-a', cwd: workspace, prompt: '/agentgit', ...extra }
  }

  test('enables the workspace and pins this conversation, naming the tools and the thread', () => {
    claim()
    const text = injected(runHook(command())) ?? ''
    for (const needle of ['set_thread_pinned', 'agentgit_ui', 'agentgit_desktop', 'pinnedThreadId', 'thread-a']) {
      assert.ok(text.includes(needle), `the enable block must mention ${needle}`)
    }
    assert.match(text, /never rewrite history/i, 'and it must say the history is not rewritten')
    assert.match(text.split('\n')[0], /the user typed \/agentgit/i)
  })

  test('works in a repository that has not opted in, without opting it in on its way past', () => {
    mkdirSync(join(workspace, '.git'), { recursive: true })
    const text = injected(runHook(command())) ?? ''
    assert.match(text, /agentgit_status/)
    assert.equal(existsSync(join(workspace, '.agentgit')), false, 'initialising is the model\'s next step, not the hook\'s')
  })

  test('a message that merely mentions the command enables nothing', () => {
    claim()
    for (const promptText of ['can you run /agentgit here?', 'what does /agentgit do', '/agentgitx']) {
      const text = injected(runHook(command({ prompt: promptText })))
      // It may fall through to the ordinary workspace offer, or to silence - both are fine. What it
      // must never be is the enable block: that would be a conversation enabling itself, and
      // pinning itself, because it happened to discuss the plugin.
      assert.ok(
        text === null || !text.includes('enable this workspace'),
        `${promptText} must not enable the workspace`,
      )
    }
  })

  test('an already-pinned conversation is told not to pin again', () => {
    claim()
    seed({ pinnedThreads: { 'thread-a': '2026-01-01T00:00:00.000Z' } })
    const text = injected(runHook(command())) ?? ''
    assert.match(text, /already recorded as pinned/)
    assert.ok(text.includes('set_thread_pinned'), 'the tool is still named, so the block stays recognisable')
  })

  test('with no thread id it still asks for the pin, because it cannot check the record', () => {
    // `shouldPinOnEnable` answers false for an absent id - there is nothing to look up. Reading that
    // as "already pinned" would drop the pin step exactly when the host is least forthcoming, so the
    // hook asks for it instead and the model supplies the id it is running in.
    claim()
    // No id in the environment and none in the payload, which is the only way to reach this branch:
    // the host normally sends `session_id`, and that is a usable conversation id.
    const bare = { hook_event_name: 'UserPromptSubmit', cwd: workspace, prompt: '/agentgit' }
    const text = injected(runHook(bare, { CODEX_THREAD_ID: '' })) ?? ''
    assert.match(text, /Pin this conversation/)
    assert.match(text, /this conversation's own threadId/)
  })

  test('it answers before the workspace offer, so nobody is asked to do what they just asked for', () => {
    claim()
    const text = injected(runHook(command())) ?? ''
    assert.match(text, /enable this workspace/)
    assert.doesNotMatch(text, /offer a coordination task/)
  })

  test('the shipped text fits its own cap with room to spare', () => {
    claim()
    const text = injected(runHook(command())) ?? ''
    assert.ok(text.length <= 1500, `the enable block is ${text.length} chars, over the cap`)
    assert.ok(text.length > 800, 'a cap that never binds is not being tested; the text really is this long')
  })
})

describe('the hot path stays constant and self-contained', () => {
  test('names no ledger path, so nothing can creep onto the session-start path', () => {
    const source = readFileSync(DESKTOP, 'utf8')
    for (const forbidden of ['events.jsonl', 'readdirSync', 'readAllEvents', 'buildBoardView', 'hub.json']) {
      assert.equal(source.includes(forbidden), false, `the offer must not reach for ${forbidden}`)
    }
  })

  test('imports nothing outside node: or its own directory, because it runs with no node_modules', () => {
    // The constraint is "no node_modules, no build step, no path back to this repository". A
    // sibling file in the same installed directory satisfies all three; a bare specifier does not.
    const source = readFileSync(DESKTOP, 'utf8')
    const imports = [...source.matchAll(/^import .*?from '([^']+)'/gm)].map((match) => match[1])
    assert.ok(imports.length > 0, 'it has to import something, or this test proves nothing')
    for (const specifier of imports) {
      const local = specifier.startsWith('./') || specifier.startsWith('../')
      assert.ok(
        specifier.startsWith('node:') || local,
        `${specifier} would not resolve from an installed plugin`,
      )
      if (local) {
        assert.ok(
          existsSync(join(DESKTOP, '..', specifier)),
          `${specifier} is imported but not shipped in scripts/`,
        )
      }
    }
  })

  test('cannot create a task, because creating one is the user\'s call and not this script\'s', () => {
    // The script has no client for the host's tools and no way to reach one. What it can do is put
    // a question in front of a model, and that boundary is the point of the whole design.
    const source = readFileSync(DESKTOP, 'utf8')
    for (const forbidden of ['create_thread(', 'spawn', 'exec', 'http', 'fetch']) {
      assert.equal(source.includes(forbidden), false, `the offer hook must not be able to ${forbidden}`)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* The copies, driven against the library                                      */
/* -------------------------------------------------------------------------- */

/**
 * Compile one or more functions out of the shipped source, with free variables injected.
 *
 * The helpers are copied into `desktop.mjs` rather than imported, so a drift test has to run the
 * *shipped* text. `new Function` is used instead of importing the module because the module
 * executes its hook on load and calls `process.exit`, which would take the test runner with it.
 */
function extract<T>(source: string, names: readonly string[], scope: Record<string, unknown>): T {
  const bodies = names.map((name) => {
    const body = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?\\n\\}`, 'm'))?.[0]
    assert.ok(body, `desktop.mjs must still declare ${name}, which this test drives`)
    return body
  })
  const keys = Object.keys(scope)
  const last = names[names.length - 1]
  return new Function(...keys, `${bodies.join('\n')}\nreturn ${last}`)(...keys.map((key) => scope[key])) as T
}

/** The value a top-level `const` was assigned, so a copied constant can be compared. */
function constFromSource(source: string, name: string): string | number {
  const match = source.match(new RegExp(`^const ${name}\\s*=\\s*([^\\n]+)$`, 'm'))
  assert.ok(match, `desktop.mjs must still declare ${name}, which this test drives`)
  const raw = match[1].trim()
  if (raw.startsWith("'") || raw.startsWith('"')) return raw.slice(1, -1)
  // A numeric expression such as `7 * 24 * 60 * 60 * 1000`. Evaluated rather than re-derived here,
  // so the test compares the value the script actually ships rather than the test's own arithmetic.
  assert.match(raw, /^[0-9+\-*/(). ]+$/, `${name} must be a literal or a plain arithmetic expression`)
  return Number(new Function(`return ${raw}`)()) as number
}

describe("the offer hook's copies cannot drift from the library", () => {
  test('it decides the same thing the library decides, over one table', () => {
    const source = readFileSync(DESKTOP, 'utf8')
    const fromHook = extract<(state: unknown, now: Date) => boolean>(source, ['shouldOfferDesktop'], {
      DESKTOP_OFFER_COOLDOWN_MS: constFromSource(source, 'DESKTOP_OFFER_COOLDOWN_MS'),
    })

    const now = new Date('2026-02-01T12:00:00.000Z')
    const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
    const base: DesktopState = {
      version: DESKTOP_VERSION,
      workspace: resolve(workspace),
      threadId: null,
      automationId: null,
      offeredAt: null,
      declinedAt: null,
      lastRulingId: null,
      lastReportedAt: null,
      pinnedThreads: {},
      enabledAt: null,
    }

    const table: { readonly label: string; readonly state: DesktopState | null }[] = [
      { label: 'nothing decided', state: null },
      { label: 'fresh', state: base },
      { label: 'a task exists', state: { ...base, threadId: 't' } },
      { label: 'refused', state: { ...base, declinedAt: daysAgo(1) } },
      { label: 'offered today', state: { ...base, offeredAt: daysAgo(0) } },
      { label: 'offered six days ago', state: { ...base, offeredAt: daysAgo(6) } },
      { label: 'offered seven days ago', state: { ...base, offeredAt: daysAgo(7) } },
      { label: 'offered eight days ago', state: { ...base, offeredAt: daysAgo(8) } },
      { label: 'unreadable timestamp', state: { ...base, offeredAt: 'not a date' } },
      { label: 'task and refusal together', state: { ...base, threadId: 't', declinedAt: daysAgo(1) } },
    ]

    for (const row of table) {
      assert.equal(
        fromHook(row.state, now),
        shouldOfferDesktop(row.state, now),
        `the hook and the library disagree about "${row.label}"`,
      )
    }
  })

  test('it names the task the way the library does', () => {
    const source = readFileSync(DESKTOP, 'utf8')
    const fromHook = extract<(root: string) => string>(source, ['desktopTaskTitle'], { basename, resolve })

    for (const root of [
      workspace,
      '/home/someone/limiter',
      'C:\\work\\a-repo',
      resolve(workspace),
      join(workspace, 'nested'),
    ]) {
      assert.equal(fromHook(root), desktopTaskTitle(root), `the hook and the library disagree about ${root}`)
    }
  })

  test('it spells the state path the way the library does', () => {
    const source = readFileSync(DESKTOP, 'utf8')
    const fromHook = extract<(root: string) => string>(source, ['desktopStatePath'], {
      join,
      DESKTOP_FILE_NAME: constFromSource(source, 'DESKTOP_FILE_NAME'),
    })

    for (const root of [workspace, '/home/someone/limiter', 'C:\\work\\a-repo']) {
      assert.equal(fromHook(root), desktopStatePath(workspacePaths(root)))
    }
  })

  test('it reads the same version and cooldown the library writes', () => {
    const source = readFileSync(DESKTOP, 'utf8')
    assert.equal(constFromSource(source, 'DESKTOP_VERSION'), DESKTOP_VERSION)
    assert.equal(constFromSource(source, 'DESKTOP_OFFER_COOLDOWN_MS'), DESKTOP_OFFER_COOLDOWN_MS)
    assert.equal(constFromSource(source, 'INIT_OFFERS_VERSION'), INIT_OFFERS_VERSION)
    assert.equal(constFromSource(source, 'INIT_OFFERS_MAX'), INIT_OFFERS_MAX)
  })

  test('it decides the init offer the same way the library does, over one table', () => {
    const source = readFileSync(DESKTOP, 'utf8')
    const fromHook = extract<(state: InitOfferRecord | null, kind: WorkspaceKind, now: Date) => boolean>(
      source,
      ['shouldOfferInit'],
      { DESKTOP_OFFER_COOLDOWN_MS: constFromSource(source, 'DESKTOP_OFFER_COOLDOWN_MS') },
    )

    const now = new Date('2026-02-01T12:00:00.000Z')
    const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
    const base: InitOfferRecord = { offeredAt: null, declinedAt: null }
    const rows: { readonly label: string; readonly state: InitOfferRecord | null }[] = [
      { label: 'nothing remembered', state: null },
      { label: 'fresh', state: base },
      { label: 'refused', state: { ...base, declinedAt: daysAgo(1) } },
      { label: 'offered today', state: { ...base, offeredAt: daysAgo(0) } },
      { label: 'offered eight days ago', state: { ...base, offeredAt: daysAgo(8) } },
      { label: 'unreadable timestamp', state: { ...base, offeredAt: 'not a date' } },
    ]

    for (const kind of ['claimed', 'repo', 'folder', 'none'] as WorkspaceKind[]) {
      for (const row of rows) {
        assert.equal(
          fromHook(row.state, kind, now),
          shouldOfferInit(row.state, kind, now),
          `the hook and the library disagree about "${row.label}" in a ${kind} directory`,
        )
      }
    }
  })

  test('it recognises /agentgit the way the library does, over one table', () => {
    const source = readFileSync(DESKTOP, 'utf8')
    const fromHook = extract<(prompt: string | null | undefined) => boolean>(source, ['promptEnablesAgentGit'], {})

    for (const prompt of [
      '/agentgit',
      '/agentgit now please',
      '  /agentgit',
      '/AgentGit',
      'run /agentgit',
      '/agentgitx',
      '',
      null,
      undefined,
    ]) {
      assert.equal(fromHook(prompt), promptEnablesAgentGit(prompt), `the hook and the library disagree about ${JSON.stringify(prompt)}`)
    }
  })

  test('it decides whether to pin the way the library does, over one table', () => {
    const source = readFileSync(DESKTOP, 'utf8')
    const fromHook = extract<(state: DesktopState | null, threadId: string | null) => boolean>(
      source,
      ['shouldPinOnEnable'],
      {},
    )

    const base: DesktopState = {
      version: DESKTOP_VERSION,
      workspace: resolve(workspace),
      threadId: null,
      automationId: null,
      offeredAt: null,
      declinedAt: null,
      lastRulingId: null,
      lastReportedAt: null,
      pinnedThreads: {},
      enabledAt: null,
    }
    const rows: { readonly label: string; readonly state: DesktopState | null; readonly threadId: string | null }[] = [
      { label: 'nothing recorded', state: null, threadId: 'thread-a' },
      { label: 'a fresh record', state: base, threadId: 'thread-a' },
      { label: 'already pinned', state: { ...base, pinnedThreads: { 'thread-a': 'x' } }, threadId: 'thread-a' },
      { label: 'a different conversation pinned', state: { ...base, pinnedThreads: { 'thread-b': 'x' } }, threadId: 'thread-a' },
      { label: 'no thread id', state: base, threadId: null },
      { label: 'a blank thread id', state: base, threadId: '   ' },
    ]

    for (const row of rows) {
      assert.equal(
        fromHook(row.state, row.threadId),
        shouldPinOnEnable(row.state, row.threadId),
        `the hook and the library disagree about "${row.label}"`,
      )
    }
  })
})

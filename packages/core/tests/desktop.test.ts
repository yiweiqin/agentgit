/**
 * The desktop task's state file, and the two rules that decide what to do with it.
 *
 * The file is small and the rules are pure, and that is exactly why they need tests: this is the
 * record that decides whether a workspace gets asked about a task, and every field in it means
 * "do not ask again". A field that reads back wrong in the permissive direction turns the offer
 * into a repeating question, and one that reads back wrong in the other direction silently
 * removes the feature. Both are invisible in a UI.
 *
 * The rules are exported as pure functions rather than folded into the reader because
 * `plugins/agentgit/scripts/desktop.mjs` cannot import this library and therefore carries its own
 * copy. `packages/cli/tests/desktop-hook.test.ts` drives that copy against these over one table,
 * which is the arrangement `canonicalEntityPath`, the arm table and the endpoint file all use.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import {
  DESKTOP_OFFER_COOLDOWN_MS,
  DESKTOP_VERSION,
  INIT_OFFERS_MAX,
  INIT_OFFERS_VERSION,
  desktopStatePath,
  desktopTaskTitle,
  emptyDesktopState,
  initOfferFor,
  initOffersPath,
  markEnabled,
  promptEnablesAgentGit,
  readDesktopState,
  readInitOffers,
  recordPinnedThread,
  resetDesktopState,
  shouldOfferDesktop,
  shouldOfferInit,
  shouldPinOnEnable,
  shouldReportRuling,
  workspacePaths,
  writeDesktopState,
  writeInitOffer,
  type DesktopState,
  type InitOfferRecord,
  type WorkspaceKind,
} from '@agentgit/core'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentgit-desktop-'))
  mkdirSync(join(root, '.agentgit', 'state'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const paths = () => workspacePaths(root)

/** A state file with everything decided, so a test can flip one field and see what changes. */
function seeded(overrides: Partial<DesktopState> = {}): DesktopState {
  const base: DesktopState = {
    version: DESKTOP_VERSION,
    workspace: resolve(root),
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
  writeFileSync(desktopStatePath(paths()), `${JSON.stringify(base)}\n`, 'utf8')
  return base
}

describe('the state file lives with derived state', () => {
  test('sits under .agentgit/state, so it is never committed work', () => {
    // It records a task id belonging to one machine's Codex install. A team asked to merge that is
    // a team asked to merge somebody else's sidebar.
    assert.equal(desktopStatePath(paths()), join(root, '.agentgit', 'state', 'desktop.json'))
  })

  test('round-trips every field', () => {
    const written = writeDesktopState(paths(), {
      threadId: 'thread-1',
      automationId: 'auto-1',
      offeredAt: '2026-01-01T00:00:00.000Z',
      declinedAt: null,
      lastRulingId: 'hub-abc',
      lastReportedAt: '2026-01-02T00:00:00.000Z',
    })
    const read = readDesktopState(paths())

    assert.equal(read?.threadId, 'thread-1')
    assert.equal(read?.automationId, 'auto-1')
    assert.equal(read?.offeredAt, '2026-01-01T00:00:00.000Z')
    assert.equal(read?.lastRulingId, 'hub-abc')
    assert.equal(read?.lastReportedAt, '2026-01-02T00:00:00.000Z')
    assert.equal(read?.version, DESKTOP_VERSION)
    assert.equal(read?.workspace, resolve(root))
    assert.deepEqual(read, written)
  })

  test('a patch merges, so a heartbeat does not erase the task id', () => {
    // The heartbeat writes `lastRulingId` on every run. If that were a replace, the record of the
    // created task would vanish on the first tick and the workspace would be offered a second one.
    writeDesktopState(paths(), { threadId: 'thread-1', automationId: 'auto-1', offeredAt: '2026-01-01T00:00:00.000Z' })
    writeDesktopState(paths(), { lastRulingId: 'hub-abc', lastReportedAt: '2026-01-03T00:00:00.000Z' })

    const read = readDesktopState(paths())
    assert.equal(read?.threadId, 'thread-1')
    assert.equal(read?.automationId, 'auto-1')
    assert.equal(read?.offeredAt, '2026-01-01T00:00:00.000Z')
    assert.equal(read?.lastRulingId, 'hub-abc')
  })

  test('writing to a workspace with no state directory yet creates it', () => {
    const bare = mkdtempSync(join(tmpdir(), 'agentgit-desktop-bare-'))
    try {
      assert.equal(existsSync(join(bare, '.agentgit')), false)
      writeDesktopState(workspacePaths(bare), { offeredAt: '2026-01-01T00:00:00.000Z' })
      assert.equal(readDesktopState(workspacePaths(bare))?.offeredAt, '2026-01-01T00:00:00.000Z')
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  test('leaves no temporary file behind', () => {
    writeDesktopState(paths(), { offeredAt: '2026-01-01T00:00:00.000Z' })
    writeDesktopState(paths(), { threadId: 'thread-1' })
    const entries = readdirSync(join(root, '.agentgit', 'state'))
    assert.deepEqual(entries, ['desktop.json'], 'the write is atomic and cleans up after itself')
  })
})

describe('an unusable record reads as nothing decided', () => {
  test('a missing file is nothing decided', () => {
    assert.equal(readDesktopState(paths()), null)
  })

  test('a torn write is nothing decided', () => {
    writeFileSync(desktopStatePath(paths()), '{"version":1,"threadId":', 'utf8')
    assert.equal(readDesktopState(paths()), null)
  })

  test('a record from another version is nothing decided', () => {
    // Every field here means "do not ask again", so honouring one whose meaning has changed is the
    // only way this file can do harm. The cost of the other choice is one repeated offer.
    seeded({ version: DESKTOP_VERSION + 1, threadId: 'thread-1' })
    assert.equal(readDesktopState(paths()), null)
  })

  test('empty strings are read as absent rather than as values', () => {
    seeded({ threadId: '', declinedAt: '' })
    const read = readDesktopState(paths())
    assert.equal(read?.threadId, null)
    assert.equal(read?.declinedAt, null)
  })

  test('a fresh state is all nulls and the current root', () => {
    const state = emptyDesktopState(root)
    assert.equal(state.version, DESKTOP_VERSION)
    assert.equal(state.workspace, resolve(root))
    for (const key of [
      'threadId',
      'automationId',
      'offeredAt',
      'declinedAt',
      'lastRulingId',
      'lastReportedAt',
      'enabledAt',
    ] as const) {
      assert.equal(state[key], null, `${key} starts unset`)
    }
    assert.deepEqual(state.pinnedThreads, {}, 'nothing is pinned until a conversation asks to be')
  })

  test('a record missing the two new fields reads them as unset rather than refusing the file', () => {
    // A v2 record written before these fields existed, or by a copy that predates them, must still
    // be honoured: every other field in it means "do not ask again", and discarding the whole file
    // over a field it never claimed to have would resurrect an offer the user already answered.
    writeFileSync(
      desktopStatePath(paths()),
      `${JSON.stringify({
        version: DESKTOP_VERSION,
        workspace: resolve(root),
        threadId: 'thread-1',
        automationId: null,
        offeredAt: '2026-01-01T00:00:00.000Z',
        declinedAt: null,
        lastRulingId: null,
        lastReportedAt: null,
      })}\n`,
      'utf8',
    )

    const read = readDesktopState(paths())
    assert.equal(read?.threadId, 'thread-1')
    assert.deepEqual(read?.pinnedThreads, {})
    assert.equal(read?.enabledAt, null)
  })

  test('reset clears the record, and says whether it had one', () => {
    writeDesktopState(paths(), { declinedAt: '2026-01-01T00:00:00.000Z' })
    assert.equal(resetDesktopState(paths()), true)
    assert.equal(readDesktopState(paths()), null)
    // Idempotent: resetting a workspace with no record is not an error, it is a no-op.
    assert.equal(resetDesktopState(paths()), false)
  })
})

describe('what the task is called', () => {
  test('names the workspace, because every ruling is scoped to one', () => {
    // A ledger, a board and a ruling all belong to one workspace. Two repositories with work in
    // flight are two different answers, and one shared task would make them look like one.
    assert.equal(desktopTaskTitle('/home/someone/limiter'), 'AgenticGit — limiter')
    assert.equal(desktopTaskTitle(root), `AgenticGit — ${basename(root)}`)
  })

  test('falls back to the full path when a root has no last segment', () => {
    // `basename('/')` is empty, and a task titled "AgenticGit — " is worse than a long one.
    const title = desktopTaskTitle(root)
    assert.ok(title.startsWith('AgenticGit — '))
    assert.ok(title.length > 'AgenticGit — '.length)
  })
})

describe('whether to offer, which is the whole anti-nag rule', () => {
  const now = new Date('2026-02-01T12:00:00.000Z')
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()

  test('a workspace that has decided nothing is offered once', () => {
    assert.equal(shouldOfferDesktop(null, now), true)
    assert.equal(shouldOfferDesktop(emptyDesktopState(root), now), true)
  })

  test('a task that exists ends the question for good', () => {
    const state = seeded({ threadId: 'thread-1' })
    assert.equal(shouldOfferDesktop(state, now), false)
  })

  test('a refusal ends the question, and a task id is not needed to mean it', () => {
    // Checked before the cooldown, because a refusal is terminal: if the order were the other way
    // round, someone who said no would be asked again a week later, forever.
    const state = seeded({ declinedAt: daysAgo(1) })
    assert.equal(shouldOfferDesktop(state, now), false)
  })

  test('an unanswered offer is not repeated inside the cooldown', () => {
    for (const days of [0, 1, 6]) {
      const state = seeded({ offeredAt: daysAgo(days) })
      assert.equal(shouldOfferDesktop(state, now), false, `${days} day(s) ago is inside the cooldown`)
    }
  })

  test('an unanswered offer is made again once the cooldown expires', () => {
    const state = seeded({ offeredAt: daysAgo(8) })
    assert.equal(shouldOfferDesktop(state, now), true)
    // The boundary itself counts as expired, so the cooldown is exactly as long as it says.
    const boundary = seeded({ offeredAt: new Date(now.getTime() - DESKTOP_OFFER_COOLDOWN_MS).toISOString() })
    assert.equal(shouldOfferDesktop(boundary, now), true)
  })

  test('an unreadable timestamp costs one cooldown rather than an offer every session', () => {
    // The alternative - treating it as "never offered" - is the failure that turns this hook into a
    // question on every single session, which is the one outcome the whole rule exists to prevent.
    const state = seeded({ offeredAt: 'not a date' })
    assert.equal(shouldOfferDesktop(state, now), false)
  })

  test('a task that exists wins even if a refusal is also recorded', () => {
    // Both terminal answers at once is a corrupt record. Not asking is the safe reading, and it is
    // the same answer either field would give alone.
    const state = seeded({ threadId: 'thread-1', declinedAt: daysAgo(1) })
    assert.equal(shouldOfferDesktop(state, now), false)
  })
})

describe('whether the task has anything to say', () => {
  test('nothing to report when there is no ruling', () => {
    assert.equal(shouldReportRuling(null, null), false)
    assert.equal(shouldReportRuling(seeded(), null), false)
  })

  test('a ruling never reported before is worth saying', () => {
    assert.equal(shouldReportRuling(null, 'hub-abc'), true)
    assert.equal(shouldReportRuling(seeded(), 'hub-abc'), true)
  })

  test('the same ruling twice is not, which is what keeps the heartbeat quiet', () => {
    const state = seeded({ lastRulingId: 'hub-abc' })
    assert.equal(shouldReportRuling(state, 'hub-abc'), false)
    assert.equal(shouldReportRuling(state, 'hub-def'), true)
  })
})

describe('the /agentgit command, recognised only where it is the instruction', () => {
  test('the command itself enables, with or without surrounding whitespace', () => {
    for (const prompt of ['/agentgit', '/agentgit ', '  /agentgit\n', '/AgentGit', '/agentgit now please']) {
      assert.equal(promptEnablesAgentGit(prompt), true, `${JSON.stringify(prompt)} is the command`)
    }
  })

  test('a message that merely mentions it does not', () => {
    // Otherwise a conversation that discussed the plugin would silently enable itself and pin
    // itself, which is exactly the "plugin acting on the user" failure the whole design avoids.
    for (const prompt of [
      'can you run /agentgit',
      'what does /agentgit do?',
      '/agentgitx',
      'use /agentgit here',
      '',
      null,
      undefined,
    ]) {
      assert.equal(promptEnablesAgentGit(prompt), false, `${JSON.stringify(prompt)} is not the command`)
    }
  })
})

describe('whether to offer a repository that has not opted in', () => {
  const now = new Date('2026-02-01T12:00:00.000Z')
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
  const record = (overrides: Partial<InitOfferRecord> = {}): InitOfferRecord => ({
    offeredAt: null,
    declinedAt: null,
    ...overrides,
  })

  test('unclaimed repositories and ordinary folders are offered', () => {
    // A claimed workspace has its own offer, and `none` is not a repository. Driving these through
    // one function is what stops the hook and the library from disagreeing about which is which.
    const notRepositories: WorkspaceKind[] = ['claimed', 'none']
    for (const kind of notRepositories) {
      assert.equal(shouldOfferInit(record(), kind, now), false, `${kind} is not offered here`)
      assert.equal(shouldOfferInit(null, kind, now), false)
    }
    assert.equal(shouldOfferInit(null, 'repo', now), true)
    assert.equal(shouldOfferInit(record(), 'repo', now), true)
    assert.equal(shouldOfferInit(null, 'folder', now), true)
    assert.equal(shouldOfferInit(record({ declinedAt: daysAgo(1) }), 'folder', now), false)
  })

  test('a refusal is terminal, and a cooldown covers an unanswered question', () => {
    assert.equal(shouldOfferInit(record({ declinedAt: daysAgo(1) }), 'repo', now), false)
    assert.equal(shouldOfferInit(record({ offeredAt: daysAgo(1) }), 'repo', now), false)
    assert.equal(shouldOfferInit(record({ offeredAt: daysAgo(8) }), 'repo', now), true)
    assert.equal(
      shouldOfferInit(record({ offeredAt: new Date(now.getTime() - DESKTOP_OFFER_COOLDOWN_MS).toISOString() }), 'repo', now),
      true,
      'the boundary counts as expired',
    )
    assert.equal(
      shouldOfferInit(record({ offeredAt: 'not a date' }), 'repo', now),
      false,
      'a corrupt timestamp costs one cooldown, not a question on every prompt',
    )
  })
})

describe('pinning a conversation, once per conversation', () => {
  test('a conversation with no thread id is never pinned', () => {
    assert.equal(shouldPinOnEnable(seeded(), null), false)
    assert.equal(shouldPinOnEnable(seeded(), ''), false)
    assert.equal(shouldPinOnEnable(seeded(), '   '), false)
  })

  test('nothing recorded means it still needs pinning', () => {
    assert.equal(shouldPinOnEnable(null, 'thread-1'), true)
    assert.equal(shouldPinOnEnable(seeded(), 'thread-1'), true)
  })

  test('a conversation already pinned is not pinned again, but a new one is', () => {
    const state = seeded({ pinnedThreads: { 'thread-1': '2026-01-01T00:00:00.000Z' } })
    assert.equal(shouldPinOnEnable(state, 'thread-1'), false)
    assert.equal(shouldPinOnEnable(state, 'thread-2'), true)
  })

  test('recording a pin merges rather than replacing the others', () => {
    recordPinnedThread(paths(), 'thread-1', new Date('2026-01-01T00:00:00.000Z'))
    const state = recordPinnedThread(paths(), 'thread-2', new Date('2026-01-02T00:00:00.000Z'))
    assert.deepEqual(state.pinnedThreads, {
      'thread-1': '2026-01-01T00:00:00.000Z',
      'thread-2': '2026-01-02T00:00:00.000Z',
    })
    assert.deepEqual(readDesktopState(paths())?.pinnedThreads, state.pinnedThreads)
  })

  test('enabling records the first instant, and a second enable does not move it', () => {
    const first = markEnabled(paths(), new Date('2026-01-01T00:00:00.000Z'))
    assert.equal(first.enabledAt, '2026-01-01T00:00:00.000Z')
    const second = markEnabled(paths(), new Date('2026-06-01T00:00:00.000Z'))
    assert.equal(second.enabledAt, '2026-01-01T00:00:00.000Z', 'the field answers "since when"')
  })
})

describe('the machine-level record, which lives outside the repository', () => {
  let machine: string

  beforeEach(() => {
    machine = mkdtempSync(join(tmpdir(), 'agentgit-offers-'))
  })

  afterEach(() => {
    rmSync(machine, { recursive: true, force: true })
  })

  const env = () => ({ AGENTGIT_HOME: machine })

  test('the file sits under AGENTGIT_HOME, not in any repository', () => {
    // Creating `.agentgit` in a repository that has not opted in is the thing this whole store
    // exists to avoid, so where the file lands is part of the contract.
    assert.equal(initOffersPath(env()), join(machine, 'offers.json'))
    assert.equal(existsSync(machine), true)
  })

  test('a missing or torn file remembers nothing', () => {
    assert.deepEqual(readInitOffers(env()), { version: INIT_OFFERS_VERSION, workspaces: {} })
    writeFileSync(initOffersPath(env()), '{"version":1,"workspaces":', 'utf8')
    assert.deepEqual(readInitOffers(env()), { version: INIT_OFFERS_VERSION, workspaces: {} })
  })

  test('an offer is recorded and read back, and a refusal is terminal', () => {
    writeInitOffer(root, { offeredAt: '2026-01-01T00:00:00.000Z' }, env())
    assert.deepEqual(initOfferFor(root, env()), { offeredAt: '2026-01-01T00:00:00.000Z', declinedAt: null })

    writeInitOffer(root, { declinedAt: '2026-01-02T00:00:00.000Z' }, env())
    const state = readInitOffers(env())
    assert.equal(state.workspaces[resolve(root)]?.declinedAt, '2026-01-02T00:00:00.000Z')
    assert.equal(state.workspaces[resolve(root)]?.offeredAt, '2026-01-01T00:00:00.000Z', 'a patch merges')
    assert.equal(initOfferFor(join(machine, 'never-seen'), env()), null)
  })

  test('records for directories that no longer exist are dropped', () => {
    // The key is an absolute path and a machine opens many repositories, so the file is bounded by
    // forgetting what it can no longer act on.
    const gone = join(machine, 'gone-repo')
    mkdirSync(gone, { recursive: true })
    writeInitOffer(gone, { offeredAt: '2026-01-01T00:00:00.000Z' }, env())
    assert.ok(readInitOffers(env()).workspaces[resolve(gone)], 'recorded while it existed')
    rmSync(gone, { recursive: true, force: true })
    writeInitOffer(root, { offeredAt: '2026-01-02T00:00:00.000Z' }, env())

    const state = readInitOffers(env())
    assert.equal(state.workspaces[resolve(gone)], undefined, 'a deleted directory cannot be offered again')
    assert.ok(state.workspaces[resolve(root)])
    assert.ok(Object.keys(state.workspaces).length <= INIT_OFFERS_MAX)
  })
})

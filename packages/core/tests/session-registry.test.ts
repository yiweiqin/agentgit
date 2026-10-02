/**
 * Claiming a session, which is what stops two windows from becoming one agent.
 *
 * The failure this replaces is quiet and total: when the host does not hand down a session id,
 * the old fallback was "whichever session wrote last", which two live windows both satisfy.
 * They then resolve to one id, and a hub whose entire output is "who owns this" reports the
 * opposite of the truth.
 *
 * So the tests here are about *arbitration*, not about heuristics scoring well:
 *
 * 1. A session a live process holds is not handed out again.
 * 2. A session whose process is gone comes back into circulation, or a crashed window would
 *    consume an identity forever.
 * 3. Two claimers cannot both take one session, which is enforced by the filesystem rather than
 *    by timing.
 * 4. Working directory outranks recency, because it is evidence about *which* session this is
 *    and recency is only a race between two windows that both wrote a second ago.
 *
 * Process tables are injected rather than observed, so a test can describe two live windows
 * without owning two.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendEvent,
  buildEvent,
  claimSession,
  CLAIMS_DIRNAME,
  deriveSessions,
  ensureWorkspace,
  forgetClaimedSessions,
  loadClaims,
  readAllEvents,
  sessionFileName,
  workspacePaths,
  type SessionClaimFile,
} from '../src/index.ts'

let root: string
let now: Date

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentgit-session-'))
  ensureWorkspace(root)
  forgetClaimedSessions()
  now = new Date()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function paths() {
  return workspacePaths(root)
}

function minutesAgo(minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString()
}

/** One session doing one write, with the directory it reported. */
function session(sessionId: string, cwd: string | null, at: string): void {
  appendEvent(
    paths(),
    buildEvent({
      kind: 'file_write',
      timestampUtc: at,
      sessionId,
      taskId: sessionId,
      entities: [{ kind: 'file', identifier: 'src/a.ts', path: 'src/a.ts' }],
      hostEvent: 'test',
      detail: cwd === null ? {} : { cwd },
    }),
    new Date(at),
  )
}

/** Nobody is alive, so every existing claim is reclaimable. */
const nobodyAlive = () => false
/** Everybody is alive. */
const everybodyAlive = () => true

const claim = (overrides: Partial<Parameters<typeof claimSession>[1]> = {}) =>
  claimSession(paths(), {
    pid: 1001,
    startedAt: 5_000,
    now,
    cwd: null,
    pidIsAlive: nobodyAlive,
    ...overrides,
  })

function writeClaimFile(claimFile: SessionClaimFile): void {
  const dir = join(paths().state, CLAIMS_DIRNAME)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, sessionFileName(claimFile.sessionId)), `${JSON.stringify(claimFile)}\n`, 'utf8')
}

/** A claims directory that exists but holds nothing, so a fixture can write a torn file into it. */
function ensureClaimsDir(): void {
  mkdirSync(join(paths().state, CLAIMS_DIRNAME), { recursive: true })
}

/** The events the fixtures wrote, read through the library's own reader. */
function readEvents() {
  return readAllEvents(paths()).events
}

/* -------------------------------------------------------------------------- */

describe('deriving the sessions a workspace knows about', () => {
  test('keeps recent ones, drops old ones, and reports the directory each reported', () => {
    session('recent', 'C:/proj', minutesAgo(2))
    session('stale', 'C:/proj', minutesAgo(90))

    const found = deriveSessions(readEvents(), { now, windowMinutes: 30 })
    assert.deepEqual(found.map((entry) => entry.sessionId), ['recent'])
    assert.equal(found[0].cwd, 'C:/proj')
    assert.deepEqual(found[0].tasks, ['recent'])
  })

  test('never offers the hub\'s own session, which would attribute an agent\'s work to the hub', () => {
    session('real-session', 'C:/proj', minutesAgo(1))
    appendEvent(
      paths(),
      buildEvent({
        kind: 'advisory_injected',
        timestampUtc: minutesAgo(0.5),
        sessionId: 'hub:TEST-MACHINE',
        taskId: null,
        hostEvent: 'hub/publish',
      }),
      now,
    )

    const found = deriveSessions(readEvents(), { now, windowMinutes: 30 })
    assert.deepEqual(found.map((entry) => entry.sessionId), ['real-session'])
  })
})

describe('one session, one live owner', () => {
  test('claims a session the ledger knows about, and says which rung answered', () => {
    session('session-a', 'C:/proj', minutesAgo(3))
    const claimed = claim({ cwd: 'C:/proj' })

    assert.equal(claimed.sessionId, 'session-a')
    assert.equal(claimed.source, 'registry')
    assert.match(claimed.explanation, /ledger/)
  })

  test('is idempotent for the process that already holds it', () => {
    session('session-a', 'C:/proj', minutesAgo(3))
    const first = claim()
    const again = claim()

    assert.equal(again.sessionId, first.sessionId)
    assert.equal(again.source, 'existing')
    assert.equal(loadClaims(paths()).length, 1, 'the second call must not add a second claim')
  })

  test('does not hand out a session a live process is holding', () => {
    // The whole point: a second window must not be given the first window's identity.
    session('session-a', 'C:/proj', minutesAgo(3))
    claim({ pid: 1001, startedAt: 5_000, pidIsAlive: everybodyAlive })

    const second = claim({ pid: 2002, startedAt: 9_000, pidIsAlive: everybodyAlive })
    assert.notEqual(second.sessionId, 'session-a')
    assert.equal(second.source, 'fallback')
    assert.notEqual(second.sessionId, 'mcp-hub-1001')
  })

  test('takes back a session whose process is gone, instead of losing it forever', () => {
    session('session-a', 'C:/proj', minutesAgo(3))
    writeClaimFile({
      version: 1,
      sessionId: 'session-a',
      pid: 9999,
      startedAt: 1,
      claimedAt: minutesAgo(5),
      cwd: 'C:/proj',
    })

    const claimed = claim({ pid: 2002, startedAt: 9_000, pidIsAlive: nobodyAlive })
    assert.equal(claimed.sessionId, 'session-a')
    assert.equal(claimed.source, 'registry')
    assert.equal(loadClaims(paths()).length, 1, 'the dead claim must be replaced, not duplicated')
  })

  test('treats a reused pid as a different process, so a crash cannot wedge a session', () => {
    // Same pid, different start time: the process that wrote this claim is gone and its number
    // has been handed to somebody else. Without this check the session would be held forever.
    session('session-a', 'C:/proj', minutesAgo(3))
    writeClaimFile({
      version: 1,
      sessionId: 'session-a',
      pid: 2002,
      startedAt: 1_000,
      claimedAt: minutesAgo(5),
      cwd: 'C:/proj',
    })

    const claimed = claim({ pid: 2002, startedAt: 9_000, pidIsAlive: everybodyAlive })
    assert.equal(claimed.sessionId, 'session-a', 'a previous process that merely shared this pid')
  })

  test('two claimers cannot both take one session, and the loser moves on', () => {
    // Arbitration is the exclusive file create, not timing: the second claimer finds the file
    // already there and is offered its next choice rather than sharing an identity.
    session('newer', 'C:/proj', minutesAgo(1))
    session('older', 'C:/proj', minutesAgo(10))
    const first = claim({ pid: 1001, startedAt: 5_000, pidIsAlive: everybodyAlive })
    const second = claim({ pid: 2002, startedAt: 9_000, pidIsAlive: everybodyAlive })

    assert.equal(first.sessionId, 'newer')
    assert.equal(second.sessionId, 'older')
    assert.notEqual(first.sessionId, second.sessionId)
  })

  test('an empty workspace gets a per-process id rather than a per-machine one', () => {
    // The old placeholder was identical for every MCP server on the machine, so two windows with
    // no history were *guaranteed* to look like one agent. An unshareable id is worth more.
    const first = claim({ pid: 1001, startedAt: 5_000 })
    const second = claim({ pid: 2002, startedAt: 9_000 })

    assert.equal(first.source, 'fallback')
    assert.notEqual(first.sessionId, second.sessionId)
    // Uniqueness comes from the pid, which is the part two processes on one machine cannot share.
    assert.match(first.sessionId, /1001$/)
    assert.match(second.sessionId, /2002$/)
  })

  test('writes one claim file per session, and no more', () => {
    session('session-a', 'C:/proj', minutesAgo(3))
    session('session-b', 'C:/proj', minutesAgo(2))
    claim({ pid: 1001, startedAt: 5_000, pidIsAlive: everybodyAlive })
    claim({ pid: 2002, startedAt: 9_000, pidIsAlive: everybodyAlive })

    const files = readdirSync(join(paths().state, CLAIMS_DIRNAME))
    assert.equal(files.length, 2)
    for (const file of files) assert.match(file, /\.claim\.json$/)
  })
})

describe('which session this process is, when more than one fits', () => {
  test('the working directory outranks recency', () => {
    // Recency alone is a race between two windows that both wrote a second ago. The directory is
    // evidence about *which* session this is, and the MCP server inherits the session's directory.
    session('mine', 'C:/proj', minutesAgo(20))
    session('somebody-elses', 'C:/other', minutesAgo(1))

    assert.equal(claim({ cwd: 'C:/proj' }).sessionId, 'mine')
  })

  test('matches the working directory by identity, not by the spelling the session recorded', () => {
    // The Windows bug: a session started as `c:\users\me` and a server reporting `C:\Users\me`
    // are one directory, but a string comparison made them two and sent the session id to the
    // wrong window. Case is folded exactly where the filesystem folds it, so on Linux these are
    // two different directories and recency is allowed to win.
    session('mine', 'C:/proj', minutesAgo(20))
    session('somebody-elses', 'C:/other', minutesAgo(1))

    const claimed = claim({ cwd: 'c:/PROJ' })
    if (process.platform === 'win32' || process.platform === 'darwin') {
      assert.equal(claimed.sessionId, 'mine', 'one directory, one match')
      assert.match(claimed.explanation, /working directory matches/)
    } else {
      assert.equal(claimed.sessionId, 'somebody-elses', 'on Linux the casing names a real second directory')
    }
  })

  test('recency decides when no directory distinguishes them', () => {
    session('older', null, minutesAgo(20))
    session('newer', null, minutesAgo(1))

    assert.equal(claim({ cwd: null }).sessionId, 'newer')
  })

  test('falls back to recency rather than refusing, when the directory matches nothing', () => {
    session('older', 'C:/somewhere', minutesAgo(20))
    session('newer', 'C:/elsewhere', minutesAgo(1))

    const claimed = claim({ cwd: 'C:/proj' })
    assert.equal(claimed.sessionId, 'newer')
    assert.doesNotMatch(claimed.explanation, /working directory matches/)
  })

  test('reports a directory match in words, so a wrong attribution is diagnosable', () => {
    session('mine', 'C:/proj', minutesAgo(20))
    assert.match(claim({ cwd: 'C:/proj' }).explanation, /working directory matches this server/)
  })

  test('a session with no recorded directory still competes on recency', () => {
    session('no-cwd', null, minutesAgo(2))
    assert.equal(claim({ cwd: 'C:/proj' }).sessionId, 'no-cwd')
  })
})

describe('the claim directory survives being damaged', () => {
  test('a torn claim file is ignored rather than fatal', () => {
    ensureClaimsDir()
    session('session-a', 'C:/proj', minutesAgo(3))
    writeFileSync(join(paths().state, CLAIMS_DIRNAME, 'torn.claim.json'), '{"sessionId":', 'utf8')

    assert.equal(loadClaims(paths()).length, 0)
    assert.equal(claim({ pid: 1001, startedAt: 5_000 }).sessionId, 'session-a')
  })

  test('a claim file with no session id is ignored', () => {
    ensureClaimsDir()
    session('session-a', 'C:/proj', minutesAgo(3))
    writeFileSync(join(paths().state, CLAIMS_DIRNAME, 'empty.claim.json'), '{"pid":7}', 'utf8')

    assert.equal(loadClaims(paths()).length, 0)
  })

  test('claiming works with no claim directory at all', () => {
    session('session-a', 'C:/proj', minutesAgo(3))
    rmSync(join(paths().state, CLAIMS_DIRNAME), { recursive: true, force: true })

    assert.equal(claim().sessionId, 'session-a')
    assert.ok(existsSync(join(paths().state, CLAIMS_DIRNAME)))
  })
})

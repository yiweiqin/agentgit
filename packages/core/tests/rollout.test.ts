/**
 * Session adoption: the transcript as a second, independent record of the same work.
 *
 * Two things make this worth testing hard rather than once over lightly.
 *
 * **The format is not ours.** A rollout is an internal Codex file, parsed defensively, and
 * every misreading fails the same way: fewer events, no error. A field that moved does not
 * throw, it simply stops matching, and the coordinator goes back to knowing a file was
 * written without knowing why — which is the gap this module exists to close. The fixtures
 * here mirror shapes taken from real transcripts, and the shapes are asserted directly, so
 * a format change shows up as a failing test rather than as quietly thinner data.
 *
 * **Double-counting is worse than missing.** The hook and the transcript both see the same
 * write. If adoption does not recognise hook coverage, every collision count is inflated
 * by whatever fraction of writes were visible to both, and the numbers stop meaning
 * anything. So the dedupe rule is asserted in both directions: inside the window it
 * suppresses, outside it does not.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  adoptSession,
  adoptWorkspace,
  appendEvent,
  buildEvent,
  listRolloutFiles,
  parseRollout,
  readAllEvents,
  sessionIntent,
  sessionsForWorkspace,
  workspacePaths,
} from '@agentgit/core'

/** One session, one workspace, one file. */
const SESSION = '01a0c2fc-630e-7600-bd63-b94d3a1c235c'
const FILE = 'src/login.py'

let home: string
let workspace: string
let paths: ReturnType<typeof workspacePaths>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentgit-rollout-home-'))
  workspace = mkdtempSync(join(tmpdir(), 'agentgit-rollout-ws-'))
  paths = workspacePaths(workspace)
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

const at = (seconds: number): string => new Date(Date.UTC(2026, 8, 23, 10, 0, seconds)).toISOString()

/** A rollout record, wrapped the way Codex wraps every one of them. */
function record(type: string, payload: Record<string, unknown>, timestamp: string): string {
  return JSON.stringify({ ordinal: 1, type, timestamp, payload })
}

function sessionMeta(cwd: string, extras: Record<string, unknown> = {}): string {
  return record(
    'session_meta',
    {
      session_id: SESSION,
      id: SESSION,
      cwd,
      timestamp: at(0),
      context_window: { window_id: 'window-1' },
      runtime_workspace_roots: [cwd],
      ...extras,
    },
    at(0),
  )
}

function userMessage(text: string, timestamp: string): string {
  return record(
    'event_msg',
    {
      type: 'item_completed',
      item: { id: 'item-1', type: 'UserMessage', client_id: 'client', content: [{ type: 'text', text, text_elements: [] }] },
    },
    timestamp,
  )
}

/**
 * A command, in the shape a real transcript uses.
 *
 * `command` is an argv array, and `parsed_cmd` is present and always empty. Both details
 * were read out of real files after the first version of this parser dropped every
 * command in silence.
 */
function commandExecution(argv: readonly string[], timestamp: string): string {
  return record(
    'event_msg',
    {
      type: 'item_completed',
      item: { id: 'item-2', type: 'CommandExecution', command: [...argv], parsed_cmd: [], cwd: workspace, exit_code: 0 },
    },
    timestamp,
  )
}

function fileChange(absolutePath: string, timestamp: string, kind = 'update'): string {
  return record(
    'event_msg',
    {
      type: 'item_completed',
      item: {
        id: 'item-3',
        type: 'FileChange',
        status: 'completed',
        changes: { [absolutePath]: { type: kind, unified_diff: '@@', content: 'x' } },
      },
    },
    timestamp,
  )
}

function tokenCount(inputTokens: number, timestamp: string): string {
  return record(
    'event_msg',
    { type: 'token_count', info: { last_token_usage: { input_tokens: inputTokens }, model_context_window: 200_000 } },
    timestamp,
  )
}

/** Write a rollout into the day directory layout the lister walks. */
function writeRollout(lines: readonly string[], name = 'rollout-2026-09-23T10-00-00.jsonl'): string {
  const day = join(home, 'sessions', '2026', '09', '23')
  mkdirSync(day, { recursive: true })
  const file = join(day, name)
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
  return file
}

function fullSession(cwd = workspace): string {
  return writeRollout([
    sessionMeta(cwd),
    userMessage('add rate limiting to the login endpoint', at(1)),
    fileChange(join(cwd, FILE), at(30)),
    commandExecution(['pwsh', '-Command', 'npm test'], at(40)),
  ])
}

describe('reading a transcript', () => {
  test('takes the session id, the working directory and the context window from session_meta', () => {
    const file = fullSession()
    const session = parseRollout(file)
    assert.ok(session)
    assert.equal(session.sessionId, SESSION)
    assert.equal(session.cwd, workspace)
    assert.equal(session.contextWindowId, 'window-1')
    assert.deepEqual(session.workspaceRoots, [workspace])
    assert.equal(session.startedAt, at(0))
  })

  test('reads a command from its argv array, which is the shape every real record uses', () => {
    // The regression. The parser looked for a string, or an object's `command` field, and
    // a real record is neither: it is `["pwsh", "-Command", "..."]`. Every adopted command
    // was dropped, which is precisely the coverage this module is for, since a shell
    // command's file effects are invisible to the hook.
    const file = writeRollout([
      sessionMeta(workspace),
      commandExecution(['pwsh', '-Command', 'Get-ChildItem -Recurse'], at(5)),
    ])
    const session = parseRollout(file)
    assert.deepEqual(session?.commands.map((command) => command.command), ['pwsh -Command Get-ChildItem -Recurse'])
  })

  test('joins a user message from its content blocks', () => {
    const file = writeRollout([sessionMeta(workspace), userMessage('first   line\n second', at(3))])
    const session = parseRollout(file)
    assert.deepEqual(session?.userMessages, [{ at: at(3), text: 'first   line\n second' }])
    assert.equal(sessionIntent({ ...session!, }), 'first line second', 'the intent is flattened to one line')
  })

  test('reads a file change as an absolute path and keeps its kind', () => {
    const file = writeRollout([sessionMeta(workspace), fileChange(join(workspace, FILE), at(9), 'add')])
    const session = parseRollout(file)
    assert.deepEqual(
      session?.fileChanges.map((change) => [change.absolutePath, change.kind]),
      [[join(workspace, FILE), 'add']],
    )
  })

  test('the intent is the first thing the user asked for', () => {
    const file = writeRollout([
      sessionMeta(workspace),
      userMessage('first instruction', at(1)),
      userMessage('actually, do this instead', at(2)),
    ])
    const session = parseRollout(file)
    assert.equal(sessionIntent(session!), 'first instruction')
  })

  test('an unknown record type is skipped rather than fatal', () => {
    // The format belongs to someone else. A new record type must cost coverage, never the
    // ability to read the rest of the file.
    const file = writeRollout([
      sessionMeta(workspace),
      JSON.stringify({ ordinal: 2, type: 'something_new', timestamp: at(2), payload: { whatever: true } }),
      userMessage('still readable', at(3)),
    ])
    const session = parseRollout(file)
    assert.equal(sessionIntent(session!), 'still readable')
  })

  test('a file being written right now still reads up to its last complete line', () => {
    const file = fullSession()
    writeFileSync(file, `${sessionMeta(workspace)}\n${userMessage('mid-flight', at(1))}\n{"ordinal":3,"type":"event`, 'utf8')
    const session = parseRollout(file)
    assert.equal(sessionIntent(session!), 'mid-flight', 'a torn final line must not blank the session')
  })

  test('a file with nothing legible is null rather than an empty session', () => {
    const file = writeRollout([JSON.stringify({ nothing: 'useful' }), 'not json at all'])
    assert.equal(parseRollout(file), null)
    assert.equal(parseRollout(join(home, 'does-not-exist.jsonl')), null)
  })
})

describe('inferring a context reset', () => {
  test('a halving of request input, above the noise floor, is a compaction', () => {
    const file = writeRollout([
      sessionMeta(workspace),
      tokenCount(20_000, at(1)),
      tokenCount(45_000, at(2)),
      tokenCount(9_000, at(3)),
    ])
    assert.deepEqual(parseRollout(file)?.tokenDrops, [{ at: at(3), fromTokens: 45_000, toTokens: 9_000 }])
  })

  test('ordinary growth is not a compaction', () => {
    const file = writeRollout([
      sessionMeta(workspace),
      tokenCount(20_000, at(1)),
      tokenCount(30_000, at(2)),
      tokenCount(45_000, at(3)),
    ])
    assert.deepEqual(parseRollout(file)?.tokenDrops, [])
  })

  test('a dip inside the noise floor is not a compaction', () => {
    // Nothing here has ever been a real conversation, so there is no context to lose. The
    // floor is checked against the input that came *before* the dip as well as the high
    // water mark, which is what keeps a startup sequence from being read as a reset.
    const file = writeRollout([
      sessionMeta(workspace),
      tokenCount(7_000, at(1)),
      tokenCount(6_000, at(2)),
      tokenCount(3_000, at(3)),
    ])
    assert.deepEqual(parseRollout(file)?.tokenDrops, [])
  })

  test('is recorded as an inference, not as something Codex said', () => {
    writeRollout([sessionMeta(workspace), tokenCount(20_000, at(1)), tokenCount(40_000, at(2)), tokenCount(8_000, at(3))])
    const session = parseRollout(listRolloutFiles(home)[0]!)
    adoptSession(paths, session!)
    const compaction = readAllEvents(paths).events.find((event) => event.kind === 'context_compacted')
    assert.ok(compaction, 'the reset should be recorded')
    assert.match(String(compaction.reason), /inferred/)
    assert.equal((compaction.detail as { inferred?: boolean } | null)?.inferred, true)
  })
})

describe('binding sessions to a workspace', () => {
  test('a session started in a subdirectory belongs to the repository', () => {
    // String-prefix matching would miss this, and it is the common case: an agent is
    // usually started somewhere inside the project.
    const file = writeRollout([sessionMeta(join(workspace, 'src', 'auth'))])
    assert.deepEqual(sessionsForWorkspace(workspace, home).map((session) => session.path), [file])
  })

  test('a session in another repository is not adopted', () => {
    writeRollout([sessionMeta(join(tmpdir(), 'somewhere-else'))])
    assert.deepEqual(sessionsForWorkspace(workspace, home), [])
  })

  test('a session started above the workspace is adopted by it too', () => {
    // A monorepo: the session runs at the repository root and the board is watching one
    // package. The writes that landed here are the only ones the ledger can hold, so
    // adopting the session adds exactly those.
    const packageRoot = join(workspace, 'packages', 'api')
    mkdirSync(packageRoot, { recursive: true })
    writeRollout([sessionMeta(workspace), fileChange(join(packageRoot, 'server.py'), at(5))])

    const paths = workspacePaths(packageRoot)
    const adopted = adoptWorkspace(paths, { home, now: new Date(Date.UTC(2026, 8, 23, 10, 0, 30)) })
    assert.equal(adopted.sessions, 1)
    const written = readAllEvents(paths).events.flatMap((event) => (event.entities ?? []).map((entity) => entity.path))
    assert.deepEqual(written, ['server.py'], 'only what landed inside this workspace is recorded')
  })

  test('a sibling directory that shares a prefix is not the workspace', () => {
    // `/repo-other` starts with `/repo`, and a string-prefix rule would adopt it.
    const sibling = `${workspace}-other`
    mkdirSync(sibling, { recursive: true })
    writeRollout([sessionMeta(sibling)])
    try {
      assert.deepEqual(sessionsForWorkspace(workspace, home), [])
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })

  test('the lister finds the day directories and ignores anything else', () => {
    const file = fullSession()
    mkdirSync(join(home, 'sessions', '2026', '09', '23', 'nested'), { recursive: true })
    writeFileSync(join(home, 'sessions', '2026', '09', '23', 'notes.txt'), 'ignore me', 'utf8')
    assert.deepEqual(listRolloutFiles(home), [file])
    assert.deepEqual(listRolloutFiles(join(home, 'nowhere')), [])
  })
})

describe('adopting a session into the ledger', () => {
  test('attributes the work to the session, which is the task the hook opened', () => {
    // The alignment claim. The hook falls back to the session id as the task id, and the
    // transcript only ever knows the session id — so if adoption invented a different task
    // id, one agent's work would land in two tasks that never collide with each other.
    const session = parseRollout(fullSession())
    adoptSession(paths, session!)

    const { events } = readAllEvents(paths)
    // `session_started` deliberately carries no task: a session exists before anything is
    // known about its work, and the hook records it the same way. Every event that *is*
    // attributed must agree, or one agent's work lands in two tasks that then never
    // collide with each other.
    const attributed = new Set(events.filter((event) => event.taskId !== null).map((event) => event.taskId))
    assert.deepEqual([...attributed], [SESSION])
    assert.equal(
      events.find((event) => event.kind === 'session_started')?.taskId,
      null,
      'a session that has not written anything yet is not a task',
    )
    assert.ok(events.some((event) => event.kind === 'file_write'), 'the write should be recorded')
    assert.equal(
      events.find((event) => event.kind === 'task_registered')?.intentText,
      'add rate limiting to the login endpoint',
    )
  })

  test('a write the hook already recorded is not counted twice', () => {
    // Both records exist for the same write. Without this the collision counts are
    // inflated by every write both streams saw, and the numbers stop meaning anything.
    const hookAt = at(31)
    appendEvent(
      paths,
      buildEvent({
        kind: 'file_write',
        timestampUtc: hookAt,
        sessionId: SESSION,
        taskId: SESSION,
        entities: [{ kind: 'file', identifier: FILE, path: FILE }],
        hostEvent: 'codex/PreToolUse',
      }),
    )

    const result = adoptSession(paths, parseRollout(fullSession())!)
    assert.equal(result.skipped, 1, 'the transcript copy of a hook-visible write is skipped')
    const writes = readAllEvents(paths).events.filter((event) => event.kind === 'file_write')
    assert.equal(writes.length, 1, 'one write, one record')
    assert.equal(writes[0]?.hostEvent, 'codex/PreToolUse', 'and the hook record is the one that stays')
  })

  test('a hook record outside the window does not suppress it', () => {
    // A half hour apart is not the same write observed twice; it is two writes. Suppressing
    // it would hide real work.
    appendEvent(
      paths,
      buildEvent({
        kind: 'file_write',
        timestampUtc: at(1800),
        sessionId: SESSION,
        taskId: SESSION,
        entities: [{ kind: 'file', identifier: FILE, path: FILE }],
        hostEvent: 'codex/PreToolUse',
      }),
    )
    assert.equal(adoptSession(paths, parseRollout(fullSession())!).appended >= 1, true)
    assert.equal(readAllEvents(paths).events.filter((event) => event.kind === 'file_write').length, 2)
  })

  test('a file outside the workspace is not adopted', () => {
    const outside = join(tmpdir(), 'agentgit-not-this-repo', 'other.py')
    const file = writeRollout([sessionMeta(workspace), fileChange(outside, at(5))])
    adoptSession(paths, parseRollout(file)!)
    const paths_recorded = readAllEvents(paths).events.flatMap((event) => (event.entities ?? []).map((entity) => entity.path))
    assert.ok(!paths_recorded.includes(outside), 'an entity key outside the workspace can never be matched to work')
  })

  test('running it twice adds nothing the second time', () => {
    // It runs on every daemon tick, so this is the property that makes that safe.
    const first = adoptSession(paths, parseRollout(fullSession())!)
    const countAfterFirst = readAllEvents(paths).events.length
    const second = adoptSession(paths, parseRollout(fullSession())!)
    assert.ok(first.appended > 0)
    assert.equal(second.appended, 0, 'a re-read of the same transcript is not new work')
    assert.equal(readAllEvents(paths).events.length, countAfterFirst)
  })

  test('a later instruction is a restatement, not a second task', () => {
    const file = writeRollout([
      sessionMeta(workspace),
      userMessage('add rate limiting', at(1)),
      userMessage('start over, use a token bucket', at(2)),
    ])
    adoptSession(paths, parseRollout(file)!)
    const registrations = readAllEvents(paths).events.filter((event) => event.kind === 'task_registered')
    assert.equal(registrations.length, 2)
    assert.equal(new Set(registrations.map((event) => event.taskId)).size, 1, 'one session is one task')
    assert.equal((registrations[1]?.detail as { restated?: boolean } | null)?.restated, true)
  })

  test('adoptWorkspace skips a session that has not moved for days', () => {
    // Rollouts accumulate forever; adopting last week's sessions would put finished work
    // back on the board as though it were in flight.
    writeRollout([sessionMeta(workspace), userMessage('ancient history', at(1))])
    const result = adoptWorkspace(paths, { home, now: new Date(Date.UTC(2026, 8, 30, 10, 0, 0)) })
    assert.equal(result.sessions, 0)
    assert.equal(result.appended, 0)

    const recent = adoptWorkspace(paths, { home, now: new Date(Date.UTC(2026, 8, 23, 10, 0, 10)) })
    assert.equal(recent.sessions, 1)
    assert.ok(recent.appended > 0)
  })
})

/**
 * Naming a session, which is how a commit gets attributed to a conversation.
 *
 * The whole value of the feature rests on the fallback chain, so every rung is asserted
 * separately and in order. A chain that silently skipped a rung would still produce a
 * plausible-looking label — it would just name the wrong window, or name a window when it
 * should have admitted it did not know, and neither failure is visible in a screenshot.
 *
 * The other property worth pinning is that nothing here throws. This reads a Codex-internal
 * file that may be absent, truncated mid-line, or holding a shape this version does not
 * recognise, and every one of those has to degrade to a shorter chain rather than to a
 * failed board refresh.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  firstPromptsFromRollouts,
  loadThreadNames,
  resolveSessionLabels,
  sessionIndexPath,
  shortSessionId,
  shortenLabel,
} from '@agentgit/core'

import { removeScratch } from './helpers.ts'

const SESSION_A = '01a0cc22-20fb-75e2-a990-3a1641734f87'
const SESSION_B = '01a0ce89-ed91-73c1-9b10-4853c3d9e38c'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentgit-labels-'))
})

afterEach(() => {
  // Best-effort: this directory is a transcript fixture the parser read a moment ago, and a
  // handle can briefly outlive the read. A teardown failure on a disposable temp directory
  // must not be reported as the test failing.
  removeScratch(home)
})

function writeIndex(lines: readonly unknown[]): void {
  writeFileSync(sessionIndexPath(home), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
}

/** A rollout file at the path `listRolloutFiles` walks to, dated today so it is in range. */
function writeRollout(sessionId: string, prompts: readonly string[]): string {
  const now = new Date()
  const dir = join(
    home,
    'sessions',
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  )
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-${now.toISOString().replace(/[:.]/g, '-')}-${sessionId}.jsonl`)
  const rows = [
    JSON.stringify({
      type: 'session_meta',
      timestamp: now.toISOString(),
      payload: { session_id: sessionId, id: sessionId, cwd: home },
    }),
    ...prompts.map((text, index) =>
      JSON.stringify({
        type: 'event_msg',
        timestamp: new Date(now.getTime() + index + 1).toISOString(),
        payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } },
      }),
    ),
  ]
  writeFileSync(file, `${rows.join('\n')}\n`, 'utf8')
  return file
}

describe('the thread index', () => {
  test('reads id, name and time', () => {
    writeIndex([{ id: SESSION_A, thread_name: 'Review仓库痛点与创新点', updated_at: '2026-09-23T02:40:56Z' }])
    const names = loadThreadNames(home)
    assert.equal(names.size, 1)
    assert.equal(names.get(SESSION_A)?.name, 'Review仓库痛点与创新点')
    assert.equal(names.get(SESSION_A)?.updatedAt, '2026-09-23T02:40:56Z')
  })

  test('the last line wins, because a rename appends rather than edits', () => {
    writeIndex([
      { id: SESSION_A, thread_name: 'old name', updated_at: '2026-09-23T02:40:56Z' },
      { id: SESSION_A, thread_name: 'new name', updated_at: '2026-09-23T02:40:56Z' },
    ])
    assert.equal(loadThreadNames(home).get(SESSION_A)?.name, 'new name')
  })

  test('a missing file is an empty index, not an error', () => {
    assert.equal(loadThreadNames(home).size, 0)
  })

  test('a torn final line costs one name and keeps the rest', () => {
    const good = JSON.stringify({ id: SESSION_A, thread_name: 'kept', updated_at: null })
    writeFileSync(sessionIndexPath(home), `${good}\n{"id":"${SESSION_B}","thread_na`, 'utf8')
    const names = loadThreadNames(home)
    assert.equal(names.size, 1)
    assert.equal(names.get(SESSION_A)?.name, 'kept')
  })

  test('a line with no name is skipped rather than stored as empty', () => {
    writeIndex([
      { id: SESSION_A, thread_name: '   ', updated_at: null },
      { id: SESSION_B, thread_name: 'real', updated_at: null },
    ])
    const names = loadThreadNames(home)
    assert.equal(names.has(SESSION_A), false)
    assert.equal(names.get(SESSION_B)?.name, 'real')
  })
})

describe('the fallback chain', () => {
  test('a recorded name wins over everything else', () => {
    writeRollout(SESSION_A, ['prompt that would also do'])
    const labels = resolveSessionLabels([SESSION_A], {
      home,
      threadNames: new Map([[SESSION_A, { name: 'recorded', updatedAt: null }]]),
      firstPrompts: new Map([[SESSION_A, 'prompt that would also do']]),
      taskIdForSession: () => 'T-1',
    })
    assert.equal(labels.get(SESSION_A)?.label, 'recorded')
    assert.equal(labels.get(SESSION_A)?.source, 'index')
  })

  test('the first prompt is used when the index has no name', () => {
    const firstPrompts = new Map([[SESSION_A, '我希望制作出一个近10年二次元人气最高角色的动态变化图']])
    const labels = resolveSessionLabels([SESSION_A], { home, threadNames: new Map(), firstPrompts })
    assert.equal(labels.get(SESSION_A)?.label, '我希望制作出一个近10年二次元人气最高角色的动态变化图')
    assert.equal(labels.get(SESSION_A)?.source, 'first-prompt')
  })

  test('the task id is used when there is neither a name nor a prompt', () => {
    const labels = resolveSessionLabels([SESSION_A], {
      home,
      threadNames: new Map(),
      taskIdForSession: (sessionId) => (sessionId === SESSION_A ? 'T-9' : null),
    })
    assert.equal(labels.get(SESSION_A)?.label, 'T-9')
    assert.equal(labels.get(SESSION_A)?.source, 'task')
  })

  test('the session id is the last resort, so a graph is never unlabelled', () => {
    const labels = resolveSessionLabels([SESSION_A], { home, threadNames: new Map() })
    assert.equal(labels.get(SESSION_A)?.label, shortSessionId(SESSION_A))
    assert.equal(labels.get(SESSION_A)?.source, 'session-id')
  })

  test('reads the first prompt out of a real rollout file', () => {
    writeRollout(SESSION_A, ['first thing asked', 'second thing asked'])
    const prompts = firstPromptsFromRollouts(home)
    assert.equal(prompts.get(SESSION_A), 'first thing asked')
  })
})

describe('labels that fit on a row', () => {
  test('leaves a short name alone', () => {
    assert.equal(shortenLabel('评估项目审稿风险'), '评估项目审稿风险')
  })

  test('cuts at a word boundary and marks the cut', () => {
    const long = 'add rate limiting to the login endpoint so repeated failures back off'
    const short = shortenLabel(long, 40)
    assert.equal(short.length <= 41, true)
    assert.equal(short.endsWith('…'), true)
    assert.equal(short.includes('  '), false, 'whitespace is flattened first')
  })

  test('a single long token is still cut rather than left to overflow', () => {
    const short = shortenLabel('x'.repeat(120), 20)
    assert.equal(short, `${'x'.repeat(20)}…`)
  })
})

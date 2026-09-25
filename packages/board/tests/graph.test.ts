/**
 * The graph and an explanation, as text.
 *
 * These are the surfaces a reader sees when there is no panel: the CLI, a log line, an MCP
 * tool result inside a client that does not render MCP Apps. Two things therefore have to
 * hold, and neither is visible in a browser:
 *
 * 1. **The lane gutter comes from the lane the core computed.** If the text renderer
 *    re-derived a column the two would drift, and the terminal and the panel would disagree
 *    about which branch a commit is on.
 * 2. **The caveats are present and are not the last thing on the page.** A reader who stops
 *    after the first screen must already have seen that a label was guessed.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { explanationMarkdown, graphLine, graphMarkdown } from '../src/graph.ts'
import type { CommitExplanation, GraphView } from '@agentgit/core'

function node(overrides: Partial<GraphView['nodes'][number]> = {}): GraphView['nodes'][number] {
  return {
    oid: 'a'.repeat(40),
    short: 'aaaaaaaa',
    parents: [],
    subject: 'a subject',
    committedAt: '2026-09-24T10:00:00.000Z',
    lane: 0,
    refs: [],
    head: false,
    taskId: null,
    sessionIds: [],
    labels: [],
    label: 'some window',
    labelSource: 'index',
    authorName: 'A Human',
    files: ['src/a.ts'],
    filesChanged: 1,
    ...overrides,
  }
}

function view(overrides: Partial<GraphView> = {}): GraphView {
  return {
    workspace: '/tmp/ws',
    workspaceName: 'ws',
    repo: '/tmp/ws',
    branch: 'main',
    generatedAt: '2026-09-24T10:00:00.000Z',
    nodes: [node()],
    edges: [],
    lanes: 1,
    labels: [{ label: 'some window', sessionId: 's1', taskId: null, source: 'index', commits: 1 }],
    overlay: [],
    truncated: false,
    diagnostics: { commits: 1, maxCommits: 400, gitError: null },
    ...overrides,
  }
}

describe('the graph as text', () => {
  test('the header names the workspace, the branch and the window legend', () => {
    const text = graphMarkdown(view())
    assert.match(text, /AgenticGit for "ws"/)
    assert.match(text, /main/)
    assert.match(text, /some window \(1\)/)
  })

  test('a lane is drawn as indentation, so a fork reads as a fork', () => {
    const zero = graphLine(node({ lane: 0 }), 2)
    const one = graphLine(node({ lane: 1 }), 2)
    assert.equal(zero.startsWith('aaaaaaaa'), true)
    assert.equal(one.startsWith('  aaaaaaaa'), true, 'one lane is two spaces in')
  })

  test('a lane past the cap is clamped rather than pushing the row off screen', () => {
    const deep = graphLine(node({ lane: 40 }), 3)
    assert.equal(deep.startsWith(' '.repeat(4) + 'aaaaaaaa'), true)
  })

  test('HEAD and branch decorations come after the subject, not before it', () => {
    const line = graphLine(node({ refs: ['main', 'origin/main'], head: true }), 1)
    assert.match(line, /a subject \(HEAD, main, origin\/main\)$/)
  })

  test('an empty subject says so instead of leaving a gap', () => {
    assert.match(graphLine(node({ subject: '' }), 1), /\(no message\)/)
  })

  test('in-flight work is listed, and a clean workspace renders no such section', () => {
    const withOverlay = graphMarkdown(
      view({
        overlay: [
          {
            worktree: '/tmp/ws',
            branch: 'main',
            taskId: null,
            sessionIds: ['s1'],
            label: 'a window',
            labelSource: 'index',
            paths: ['a.ts', 'b.ts'],
            main: true,
          },
        ],
      }),
    )
    assert.match(withOverlay, /in flight:/)
    assert.match(withOverlay, /a window \(index\) — 2 uncommitted in the main checkout/)

    assert.equal(graphMarkdown(view()).includes('in flight:'), false)
  })

  test('an in-flight entry with no window says so rather than naming nothing', () => {
    const text = graphMarkdown(
      view({
        overlay: [
          {
            worktree: '/tmp/ws',
            branch: 'main',
            taskId: null,
            sessionIds: [],
            label: null,
            labelSource: null,
            paths: ['a.ts'],
            main: true,
          },
        ],
      }),
    )
    assert.match(text, /no window recorded/)
  })

  test('older commits are counted rather than silently dropped', () => {
    const many = view({
      nodes: Array.from({ length: 5 }, (unused, index) => node({ oid: `${index}`.repeat(40), short: `s${index}` })),
    })
    const text = graphMarkdown(many, { limit: 2 })
    assert.match(text, /3 older commit\(s\) not shown/)
  })

  test('a truncated read says so, because an absent commit must not look absent', () => {
    const text = graphMarkdown(view({ truncated: true }))
    assert.match(text, /more commits than the 400 this view reads/)
  })
})

describe('an explanation as text', () => {
  function explanation(overrides: Partial<CommitExplanation> = {}): CommitExplanation {
    return {
      found: true,
      oid: 'a'.repeat(40),
      short: 'aaaaaaaa',
      subject: 'add rate limiting',
      label: 'login work',
      labelSource: 'index',
      taskId: 'T-1',
      sessionIds: ['s1'],
      authorName: 'A Human',
      committedAt: '2026-09-24T10:00:00.000Z',
      refs: ['main'],
      files: ['src/login.py'],
      intents: ['add rate limiting to the login endpoint'],
      events: [],
      leases: [],
      contracts: [],
      notes: [],
      ...overrides,
    }
  }

  test('names the window, the task, the sessions and the files', () => {
    const text = explanationMarkdown(explanation())
    assert.match(text, /aaaaaaaa {2}add rate limiting/)
    assert.match(text, /window : login work {2}\(index\)/)
    assert.match(text, /task   : T-1/)
    assert.match(text, /session: s1/)
    assert.match(text, /src\/login\.py/)
  })

  test('quotes the intent in the agent\'s own words', () => {
    assert.match(explanationMarkdown(explanation()), /add rate limiting to the login endpoint/)
  })

  test('a miss explains itself rather than rendering an empty page', () => {
    const text = explanationMarkdown(
      explanation({ found: false, oid: null, short: null, notes: ["No commit in this graph matches 'zzz'."] }),
    )
    assert.equal(text, "No commit in this graph matches 'zzz'.")
  })

  test('an empty file list says it is empty, not nothing', () => {
    assert.match(explanationMarkdown(explanation({ files: [] })), /nothing — this commit is empty or a merge/)
  })

  test('a long file list is counted down rather than printed whole', () => {
    const files = Array.from({ length: 45 }, (unused, index) => `src/f${index}.ts`)
    assert.match(explanationMarkdown(explanation({ files })), /… 5 more/)
  })

  test('the ledger timeline and the leases are printed when they exist', () => {
    const text = explanationMarkdown(
      explanation({
        events: [{ kind: 'file_write', at: '2026-09-24T10:00:00.000Z', taskId: 'T-1', sessionId: 's1', summary: 'file_write · src/login.py' }],
        leases: ['file::src/login.py (held by T-1, expires 2026-09-24T10:20:00.000Z)'],
        contracts: ['auth.limit v2 (breaking)'],
      }),
    )
    assert.match(text, /ledger:/)
    assert.match(text, /file_write/)
    assert.match(text, /leases:/)
    assert.match(text, /auth\.limit v2 \(breaking\)/)
  })
})

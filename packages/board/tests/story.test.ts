/**
 * The story artifact, checked against the same sandbox contract as the panel.
 *
 * This file exists because the story is the one artifact a reader is most likely to open
 * and least likely to re-generate. A `<script>` in it would not fail loudly — the sandbox
 * drops it — so the toggle would simply stop responding and the screen would look
 * deliberately inert. Asserting the constraint is the only way that stays true.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { STORY_ROOT_ID, renderStory, storyDocument, writeStory, type StoryView } from '@agentgit/board'

function view(overrides: Partial<StoryView> = {}): StoryView {
  return {
    workspace: 'C:\\work\\demo',
    title: 'Two agents, one file, 45 minutes apart',
    subtitle: 'a real case found by examples/real/cases.mjs',
    generatedAt: '2026-07-20T08:42:13.301Z',
    provenance: [{ label: 'found by', value: 'examples/real/cases.mjs' }],
    before: {
      label: 'git',
      headline: 'merges cleanly, 0 conflicts',
      tone: 'clear',
      facts: [{ label: 'conflicts', value: '0', mono: true }],
      command: 'git merge-tree --write-tree main agentgit/task-b',
      raw: 'ff2ab1c9\n',
      observed: true,
    },
    after: {
      label: 'AgenticGit',
      headline: 'replan',
      tone: 'warn',
      facts: [{ label: 'verdict', value: 'replan', mono: true }],
      quote: { text: 'add the rebuild-vlm adapter', attribution: 'session a, 45m ago' },
      observed: true,
    },
    timeline: [{ at: '2026-07-20 07:57', who: 'session A', what: 'wrote src/cli.py', kind: 'write' }],
    honesty: ['one case is not a rate'],
    ...overrides,
  }
}

describe('the story fragment contract', () => {
  test('is a fragment, never a document', () => {
    const html = renderStory(view())
    for (const forbidden of ['<!doctype', '<html', '<head', '<body', '</html>', '</body>']) {
      assert.ok(!html.toLowerCase().includes(forbidden), `'${forbidden}' would be dropped by the host`)
    }
    assert.ok(html.trimStart().startsWith(`<div id="${STORY_ROOT_ID}">`), 'the root element is the first thing in the file')
  })

  test('calls nothing and loads nothing, because the sandbox blocks it in silence', () => {
    const html = renderStory(view())
    for (const forbidden of ['<script', 'fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'src="http', 'href="http']) {
      assert.ok(!html.includes(forbidden), `'${forbidden}' would fail silently under the sandbox policy`)
    }
  })

  test('does its one interaction with a checked radio and <details>, not with script', () => {
    const html = renderStory(view())
    assert.match(html, /<input class="ag-focus" type="radio"[^>]*checked/, 'the default state must be a checked radio')
    assert.match(html, /#ag-focus-before:checked ~ \.ag-columns \.ag-col-after \{ display: none; \}/, 'the toggle is CSS-only')
    assert.match(html, /<details class="ag-raw">/, 'raw output folds open natively')
  })

  test('scopes every rule to the story root, so it cannot restyle the host page', () => {
    const html = renderStory(view())
    for (const selector of html.matchAll(/^\s*(#[^\s{,]*)/gm)) {
      assert.equal(selector[1], `#${STORY_ROOT_ID}`, `${selector[1]} is not scoped to the story root`)
    }
  })

  test('repeats the honesty notes rather than trimming them when the view is small', () => {
    const html = renderStory(view({ honesty: ['not an effect size', 'the reconstruction is static'] }))
    assert.match(html, /not an effect size/)
    assert.match(html, /the reconstruction is static/)
  })
})

describe('the story document', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentgit-story-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('wraps the fragment in exactly one document with the theme', () => {
    const document = storyDocument(view())
    assert.equal(document.split('<!doctype html>').length - 1, 1)
    assert.match(document, /<style>\s*:root \{/)
    assert.ok(document.includes(`<div id="${STORY_ROOT_ID}">`))
  })

  test('escapes what it is given rather than trusting a rendered number', () => {
    const document = storyDocument(view({ title: '<script>alert(1)</script>' }))
    assert.ok(!document.includes('<script>alert(1)</script>'), 'a title must not be able to inject markup')
    assert.match(document, /&lt;script&gt;/)
  })

  test('writes a file and returns a reference that names it', () => {
    const artifact = writeStory(view(), dir)
    assert.equal(artifact.path, join(dir, 'agentgit-story.html'))
    assert.ok(artifact.bytes > 0)
    assert.ok(readFileSync(artifact.path, 'utf8').includes('ag-story'))
    assert.ok(artifact.reference.includes(JSON.stringify({ path: artifact.path })))
    assert.match(artifact.reference, /^\uE200visualize\uE202/)
    assert.match(artifact.reference, /\uE201$/)
  })
})

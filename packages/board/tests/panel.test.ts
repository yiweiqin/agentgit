/**
 * The panel fragment, checked against the host's contract rather than against my memory.
 *
 * The fragment is not a page. It is injected into a conversation sandbox that owns the
 * stylesheet, the tab runtime and the security policy, and every one of those imposes a
 * rule that fails *silently* when broken — a `<html>` wrapper is dropped, a `fetch` call
 * is blocked with no error, a hand-rolled pill simply looks wrong next to the host's own.
 * None of that shows up as a failing request, so it is asserted here instead.
 *
 * These tests are also the reason the fragment is generated from a real ledger rather
 * than from a hand-built object literal: the bug this file was written after was a panel
 * that reported "1 entity" for a task and never named the file, which no assertion on a
 * fixture would have caught, because the fixture was written by the same person who wrote
 * the panel.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendEvent, buildBoardView, buildEvent, workspacePaths } from '@agentgit/core'
import { renderPanel, PANEL_ROOT_ID } from '@agentgit/board'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'agentgit-panel-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

function write(taskId: string, path: string, intent: string): void {
  appendEvent(
    workspacePaths(workspace),
    buildEvent({
      kind: 'file_write',
      timestampUtc: new Date().toISOString(),
      sessionId: taskId,
      taskId,
      entities: [{ kind: 'file', identifier: path, path }],
      intentText: intent,
      hostEvent: 'test',
    }),
  )
}

function fragment(): string {
  return renderPanel(buildBoardView(workspacePaths(workspace)))
}

describe('the fragment contract', () => {
  test('is a fragment, never a document', () => {
    write('task-a', 'src/login.py', 'add rate limiting')
    const html = fragment()
    for (const forbidden of ['<!doctype', '<html', '<head', '<body', '</html>', '</body>']) {
      assert.ok(
        !html.toLowerCase().includes(forbidden),
        `'${forbidden}' would be dropped or ignored by the host, which injects this into a page`,
      )
    }
    assert.ok(html.trimStart().startsWith('<div id="'), 'the fragment root is the first thing in the file')
  })

  test('has exactly one root with the exported id', () => {
    write('task-a', 'src/login.py', 'add limits')
    const html = fragment()
    assert.equal(html.split(`id="${PANEL_ROOT_ID}"`).length - 1, 1)
    // Every rule the fragment adds is scoped to that root, so it cannot restyle the host.
    for (const selector of html.matchAll(/^\s*(#[^\s{]*)/gm)) {
      assert.equal(selector[1], `#${PANEL_ROOT_ID}`, `${selector[1]} is not scoped to the panel root`)
    }
  })

  test('calls nothing and loads nothing, because the sandbox would block it in silence', () => {
    write('task-a', 'src/login.py', 'add limits')
    const html = fragment()
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', '<script', 'src="http', 'href="http']) {
      assert.ok(!html.includes(forbidden), `'${forbidden}' would fail silently under the sandbox policy`)
    }
  })

  test('stays well under the one megabyte ceiling', () => {
    for (let index = 0; index < 200; index += 1) write(`task-${index}`, `src/file-${index}.py`, `intent ${index}`)
    const html = fragment()
    assert.ok(html.length < 1_000_000, `fragment is ${html.length} bytes, over the host's limit`)
  })

  test('uses the host utilities for pills and the debt track instead of its own', () => {
    write('task-a', 'src/login.py', 'add limits')
    const html = fragment()
    // The host supplies these; a local copy drifts from the host's theme and its rules.
    assert.match(html, /class="viz-badge"/, 'status pills should be the host utility')
    assert.match(html, /class="progress-bar"/, 'the debt track should be the host utility')
    assert.match(html, /class="nav nav-pills"/)
    for (const handRolled of ['ag-pill', 'ag-badge', 'ag-state-', 'ag-debt-bar', 'ag-debt-fill']) {
      assert.ok(!html.includes(handRolled), `'${handRolled}' duplicates a host utility`)
    }
  })

  test('follows the tab markup the host runtime drives', () => {
    write('task-a', 'src/login.py', 'add limits')
    const html = fragment()
    // The host implements tab switching for this exact markup, so the ids and the
    // aria attributes are load-bearing rather than decorative.
    assert.match(html, /<div class="nav nav-pills" role="tablist" aria-label="[^"]+">/)
    const tabs = [...html.matchAll(/<button class="nav-link[^"]*" id="([^"]+)" role="tab" aria-controls="([^"]+)" aria-selected="(true|false)" type="button">/g)]
    assert.ok(tabs.length >= 4, `expected the four board sections as tabs, found ${tabs.length}`)
    for (const [, id, controls] of tabs) {
      assert.ok(html.includes(`id="${controls}" role="tabpanel" aria-labelledby="${id}"`), `${controls} has no panel`)
    }
    assert.equal(tabs.filter(([, , , selected]) => selected === 'true').length, 1, 'exactly one tab starts selected')
  })
})

describe('what the panel says', () => {
  test('names the files a task is on, not just how many it touched', () => {
    // The regression. A count cannot be acted on: the reader's question is which file, and
    // in the ordinary single-agent case no other section names it, so the panel reported a
    // task and never mentioned the path.
    write('task-a', 'src/login.py', 'add rate limiting')
    const html = fragment()
    assert.match(html, /src\/login\.py/, 'the file a task holds should be named')
    assert.ok(!html.includes('>Entities<'), 'a bare count is not a working answer')
  })

  test('reports two tasks on one file as a collision, with both intents', () => {
    write('task-a', 'src/login.py', 'add rate limiting to the login endpoint')
    write('task-b', 'src/login.py', 'add rate limiting to login')
    const html = fragment()
    assert.match(html, /same work|different work/, 'the radar should say which kind of collision this is')
    assert.match(html, /task-a/)
    assert.match(html, /task-b/)
  })

  test('says so plainly when there is nothing to coordinate', () => {
    const html = fragment()
    assert.match(html, /No task has been recorded/)
    assert.match(html, /No entity is wanted by more than one task/)
  })
})

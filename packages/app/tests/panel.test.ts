/**
 * The panel document, which has to survive a sandbox that fails silently.
 *
 * The failures this guards against do not look like failures. A `<script src>` that the
 * sandbox refuses produces an empty panel rather than an error; a workspace name containing
 * a quote or `</script>` produces a document whose script tag ends early and whose panel is
 * blank; a resource URI that does not match what the tool advertises produces a host that
 * preloads nothing. Every one of these renders as "the plugin is broken" with no clue which
 * line did it, so each is asserted here instead.
 *
 * The tests are deliberately about the document as a *string*, not about a browser: the
 * properties that matter are the ones a string can be checked for, and there is no headless
 * browser in this repository's test path.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  APP_EXTENSION_ID,
  APP_MIME_TYPE,
  APP_RESOURCE_URI,
  renderAppPanel,
} from '../src/index.ts'

/** Every `<script src=`, `<link href=` and `@import` in the document, if any. */
function externalReferences(html: string): string[] {
  const matches = html.match(/<script[^>]+src=|<link[^>]+href=|@import[^;]+;/gi) ?? []
  return matches.filter((match) => !match.startsWith('@import'))
}

describe('the resource contract', () => {
  test('the URI and MIME type are the MCP Apps ones', () => {
    assert.equal(APP_MIME_TYPE, 'text/html;profile=mcp-app')
    assert.equal(APP_RESOURCE_URI.startsWith('ui://'), true)
    assert.equal(APP_EXTENSION_ID, 'io.modelcontextprotocol/ui')
  })

  test('the URI is versioned, because a host caches a document by its URI', () => {
    assert.match(APP_RESOURCE_URI, /v\d+\.html$/)
  })
})

describe('the document is self-contained', () => {
  test('it loads nothing from outside itself', () => {
    const html = renderAppPanel({ workspaceName: 'agentgit' })
    assert.deepEqual(externalReferences(html), [], 'a blocked external script renders as a blank panel')
    assert.equal(/https?:\/\//.test(html.replace(/http:\/\/localhost:7777/g, '')), false)
  })

  test('the stylesheet and the runtime are inlined, not linked', () => {
    const html = renderAppPanel({})
    assert.match(html, /<style>[\s\S]*--ag-row-h[\s\S]*<\/style>/)
    assert.match(html, /ui\/initialize/)
    assert.match(html, /agentgit_graph/)
    assert.match(html, /agentgit_explain/)
  })

  test('it declares the bridge methods it actually calls', () => {
    const html = renderAppPanel({})
    for (const method of ['ui/initialize', 'ui/notifications/initialized', 'tools/call', 'ui/message']) {
      assert.equal(html.includes(method), true, `${method} must be present`)
    }
  })

  test('it has the anchors the runtime writes into', () => {
    const html = renderAppPanel({})
    for (const id of ['ag-app', 'ag-title', 'ag-live', 'ag-legend', 'ag-graph', 'ag-detail-body', 'ag-overlay', 'ag-question', 'ag-answer']) {
      assert.equal(html.includes(`id="${id}"`), true, `#${id} must exist`)
    }
  })

  test('the ask box starts hidden, so an unselected panel has no dead input', () => {
    const html = renderAppPanel({})
    assert.match(html, /id="ag-ask"[^>]*hidden/)
  })
})

describe('a workspace name cannot break the document', () => {
  test('a quote in the name is escaped in the title and the attribute', () => {
    const html = renderAppPanel({ workspaceName: 'he said "hi"' })
    assert.equal(html.includes('he said "hi"'), false, 'the raw quote must not survive')
    assert.equal(html.includes('&quot;hi&quot;'), true)
  })

  test('a closing script tag in the name cannot end the document early', () => {
    const html = renderAppPanel({ workspaceName: '</script><script>alert(1)</script>' })
    assert.equal(html.includes('<script>alert(1)</script>'), false)
    assert.equal(html.includes('&lt;/script&gt;'), true)
    // One opening and one closing script tag, the runtime's own.
    assert.equal(html.split('<script>').length - 1, 1)
    assert.equal(html.split('</script>').length - 1, 1)
  })

  test('an angle bracket in the name cannot inject an element', () => {
    const html = renderAppPanel({ workspaceName: '<img src=x onerror=alert(1)>' })
    assert.equal(html.includes('<img src=x'), false)
    assert.equal(html.includes('&lt;img'), true)
  })
})

describe('options reach the runtime as data attributes', () => {
  test('the workspace id and interval are written where the script can read them', () => {
    const html = renderAppPanel({ workspaceId: 'agentgit', intervalMs: 2000 })
    assert.match(html, /data-workspace-id="agentgit"/)
    assert.match(html, /data-interval="2000"/)
  })

  test('an empty http base survives, because it means "this origin"', () => {
    const html = renderAppPanel({ transport: 'http', httpBase: '' })
    assert.match(html, /data-base=""/)
  })

  test('a base with a query-breaking character is escaped', () => {
    const html = renderAppPanel({ httpBase: 'http://x/?a="b"' })
    assert.equal(html.includes('a="b"'), false)
    assert.equal(html.includes('&quot;'), true)
  })

  test('the title names the workspace, and defaults when there is none', () => {
    assert.match(renderAppPanel({ workspaceName: 'agentgit' }), /AgenticGit for &quot;agentgit&quot;/)
    assert.match(renderAppPanel({}), /AgenticGit for &quot;this workspace&quot;/)
  })
})

/**
 * The panel document: a self-contained page an MCP host can render in an iframe.
 *
 * Why the markup and the runtime live in `assets/` rather than in this file
 * -------------------------------------------------------------------------
 * The document has to be one file. A sandbox that refuses `<script src>` fails silently and
 * shows an empty panel, so the CSS and the JavaScript must be inlined — which means they
 * are read from disk and embedded, not imported. Keeping them as real `.css` and `.js`
 * files rather than as template literals is what makes them editable: a 600-line string
 * literal has no syntax highlighting, no linting, and no way to see a stray backtick until
 * the panel renders blank.
 *
 * The resource URI is versioned on purpose. MCP hosts treat a resource URI as a cache key,
 * so a breaking change to the markup has to publish a new URI or a host may keep serving
 * the old document from its cache. `v1` is that key; bump it when the markup changes shape.
 *
 * @module @agentgit/app/panel
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** MIME type an MCP Apps host requires for a UI resource. */
export const APP_MIME_TYPE = 'text/html;profile=mcp-app'

/**
 * Where the panel is served from, and what a tool points at with `_meta.ui.resourceUri`.
 *
 * Versioned because the URI is a cache key: a host may keep serving a cached document for
 * the same URI, so anything that changes the markup's shape must publish a new one.
 */
export const APP_RESOURCE_URI = 'ui://agentgit/panel.v1.html'

/** The `ui/initialize` revision the panel's runtime negotiates. */
export const APP_PROTOCOL_VERSION = '2026-01-26'

/** The MCP Apps extension identifier, declared in the server's initialize capabilities. */
export const APP_EXTENSION_ID = 'io.modelcontextprotocol/ui'

export const APP_NAME = 'agentgit-panel'
export const APP_VERSION = '0.1.0'

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')

export const PANEL_CSS_FILENAME = 'panel.css'
export const PANEL_JS_FILENAME = 'panel.js'

/** Default filename when the panel is written to disk by `agentgit app`. */
export const APP_HTML_FILENAME = 'agentgit-app.html'

export interface AppPanelOptions {
  /** Directory name of the workspace, used for the title. */
  readonly workspaceName?: string | null
  /** Workspace id, so a daemon serving several can tell the panel which one it is showing. */
  readonly workspaceId?: string | null
  /** Force a transport instead of letting the runtime detect one. */
  readonly transport?: 'bridge' | 'http'
  /** Milliseconds between refreshes. */
  readonly intervalMs?: number
  /** Base URL for the HTTP transport. Defaults to the daemon on port 7777. */
  readonly httpBase?: string | null
}

/**
 * The panel document.
 *
 * Options are written as `data-` attributes rather than interpolated into the script,
 * because the script must not be generated: a workspace name containing a quote would end
 * the attribute, and one containing `</script>` would end the document. Escaping once, in
 * the attribute, is the only place it has to be right.
 */
export function renderAppPanel(options: AppPanelOptions = {}): string {
  const name = options.workspaceName?.trim() || 'this workspace'
  const title = `AgenticGit for "${name}"`
  const escapedTitle = escapeHtml(title)
  const rootAttributes = [
    // `!= null` rather than truthiness: an empty `data-base` means "this origin", which is
    // exactly what the daemon serving the panel into its own page needs to say.
    options.workspaceId != null ? `data-workspace-id="${escapeHtml(options.workspaceId)}"` : null,
    `data-workspace-name="${escapeHtml(name)}"`,
    options.transport != null ? `data-transport="${escapeHtml(options.transport)}"` : null,
    options.intervalMs != null ? `data-interval="${escapeHtml(String(options.intervalMs))}"` : null,
    options.httpBase != null ? `data-base="${escapeHtml(options.httpBase)}"` : null,
  ]
    .filter((value): value is string => value !== null)
    .join(' ')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapedTitle}</title>
<style>
${asset(PANEL_CSS_FILENAME)}
</style>
</head>
<body>
<div id="ag-app" ${rootAttributes}>
  <header class="ag-head">
    <h1 class="ag-title" id="ag-title">${escapedTitle}</h1>
    <div class="ag-meta">
      <span class="ag-dot" id="ag-live" data-live="0" role="img" aria-label="connection status"></span>
      <span id="ag-foot-left"></span>
    </div>
  </header>

  <div class="ag-actions">
    <button class="ag-btn" id="ag-refresh" type="button">Refresh</button>
    <button class="ag-btn" id="ag-fullscreen" type="button">Fullscreen</button>
    <button class="ag-btn" id="ag-board" type="button">Open live board</button>
  </div>

  <section class="ag-card">
    <h2>Windows</h2>
    <div class="ag-legend" id="ag-legend"></div>
  </section>

  <section class="ag-card">
    <div class="ag-graph-wrap">
      <div class="ag-graph-col">
        <h2>Commits</h2>
        <div class="ag-graph" id="ag-graph"></div>
      </div>
      <aside class="ag-detail">
        <div class="ag-card" id="ag-detail-body"></div>
        <div class="ag-card ag-ask" id="ag-ask" hidden>
          <h2>Ask about this commit</h2>
          <label class="ag-sr" for="ag-question">Question for the conversation</label>
          <textarea id="ag-question" spellcheck="false"></textarea>
          <div class="ag-ask-row">
            <button class="ag-btn" id="ag-send" data-primary="1" type="button">Ask in conversation</button>
            <button class="ag-btn" id="ag-quick" type="button">Quick answer</button>
          </div>
          <p class="ag-answer" id="ag-answer" hidden></p>
        </div>
      </aside>
    </div>
  </section>

  <section class="ag-card">
    <h2>In flight</h2>
    <div id="ag-overlay"></div>
  </section>

  <footer class="ag-foot">
    <span id="ag-foot-right">connecting…</span>
  </footer>
</div>
<script>
${asset(PANEL_JS_FILENAME)}
</script>
</body>
</html>
`
}

let assetCache: Map<string, string> | null = null

/** Read one asset, memoised for the life of the process. */
function asset(name: string): string {
  if (!assetCache) assetCache = new Map()
  const cached = assetCache.get(name)
  if (cached !== undefined) return cached
  const text = readFileSync(join(ASSETS_DIR, name), 'utf8')
  assetCache.set(name, text)
  return text
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

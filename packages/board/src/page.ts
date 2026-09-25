/**
 * The live board page served by the daemon.
 *
 * The whole page is a thin shell around the *same* fragment the inline panel uses.
 * That is deliberate: server-side rendering means the panel markup is written once,
 * so the panel and the board cannot disagree about what a collision looks like. The
 * only things this file adds are the things a standalone page needs and the
 * conversation sandbox forbids: a theme, a tab runtime, and an `EventSource`.
 *
 * Two capabilities are absent from the sandbox and present here, and this is exactly
 * why both surfaces exist:
 *
 * - `EventSource` works, so the board updates itself.
 * - The fragment is re-rendered from disk on every change, so the board reflects
 *   edits made by an editor, a `git checkout` or another agent - not just by the
 *   plugin.
 *
 * @module @agentgit/board/page
 */

import { escapeHtml } from './format.ts'

export interface BoardPageOptions {
  readonly workspace: string
  readonly workspaceId: string
  readonly workspaces: readonly { id: string; root: string; active: boolean }[]
  readonly initialHtml: string
  /** Milliseconds between forced refreshes, in case the ledger changed without an event. */
  readonly refreshMs?: number
}
/**
 * Fallback theme.
 *
 * The fragment is written against the conversation host's CSS variables, so a page
 * that does not define them renders unstyled rather than broken. Defining the same
 * names here - rather than a parallel set of class names - is what lets one fragment
 * serve both surfaces.
 *
 * Exported so the standalone panel file can use the same theme. A panel saved to disk
 * is opened in a browser that has no host styles, and without this it would render as
 * unstyled markup that reads as a bug in the plugin rather than as a missing stylesheet.
 */
export const THEME = `
  :root {
    color-scheme: light dark;
    --background: light-dark(#ffffff, #0b0f14);
    --foreground: light-dark(#111827, #e5e7eb);
    --card: light-dark(#f8fafc, #131a23);
    --card-foreground: var(--foreground);
    --muted: light-dark(#eef2f6, #1b232e);
    --muted-foreground: light-dark(#5b6675, #9aa4b1);
    --border: light-dark(#e2e8f0, #243040);
    --primary: light-dark(#0f766e, #2dd4bf);
    --primary-foreground: light-dark(#ffffff, #04211d);
    --destructive: light-dark(#b91c1c, #f87171);
    --blue: light-dark(#1d4ed8, #60a5fa);
    --green: light-dark(#15803d, #4ade80);
    --orange: light-dark(#b45309, #fbbf24);
    --red: light-dark(#b91c1c, #f87171);
    --font-size-base: 14px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 20px clamp(16px, 4vw, 40px) 56px;
    background: var(--background);
    color: var(--foreground);
    font: var(--font-size-base)/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .card {
    background: var(--card); color: var(--card-foreground);
    border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px;
  }
  .viz-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  .viz-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .viz-stat-value { font-size: 20px; }
  /*
   * The host's own definitions of the utilities the panel fragment uses. A saved panel
   * opened straight from disk has no host stylesheet, so without these the pills and the
   * debt track render as bare text and the file reads as broken. Copied rather than
   * improvised, so the standalone view and the in-conversation one look like one product.
   */
  .viz-badge { display: inline-block; padding: 3px 8px; border-radius: 999px; background: var(--muted); color: var(--muted-foreground); font-size: 12px; line-height: 18px; }
  .progress { display: flex; height: 8px; overflow: hidden; border-radius: 999px; background: var(--muted); }
  .progress-bar { height: 100%; flex-shrink: 0; background: var(--primary); }
  .text-destructive { color: var(--destructive); }
  .text-small { font-size: 12px; }
  .text-muted { color: var(--muted-foreground); }
  .tabular-nums { font-variant-numeric: tabular-nums; }
  .text-end { text-align: end; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  h2 { font-size: 20px; font-weight: 500; }
  h4 { font-size: 14px; font-weight: 500; color: var(--muted-foreground); }
  hr { border: 0; border-top: 1px solid var(--border); margin: 8px 0; }
  table.table { width: 100%; border-collapse: collapse; }
  table.table th, table.table td { padding: 7px 8px; border-bottom: 1px solid var(--border); text-align: start; vertical-align: top; }
  table.table th { font-weight: 500; color: var(--muted-foreground); font-size: 12px; }
  table.table-sm th, table.table-sm td { padding: 5px 8px; }
  .table-responsive { overflow-x: auto; }
  .nav-pills { display: flex; flex-wrap: wrap; gap: 6px; }
  .nav-pills .nav-link {
    appearance: none; border: 1px solid transparent; background: transparent; color: var(--muted-foreground);
    padding: 5px 11px; border-radius: 999px; font: inherit; font-size: 13px; cursor: pointer;
  }
  .nav-pills .nav-link:hover { background: var(--muted); color: var(--foreground); }
  .nav-pills .nav-link[aria-selected="true"] { background: var(--primary); color: var(--primary-foreground); }
  .btn { appearance: none; background: var(--muted); color: var(--foreground); border: 1px solid var(--border); border-radius: 8px; padding: 5px 11px; font: inherit; font-size: 13px; cursor: pointer; }
  .ag-chrome { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .ag-chrome h1 { font-size: 16px; font-weight: 500; margin: 0; }
  .ag-chrome a.btn { text-decoration: none; display: inline-block; }
  .ag-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--muted-foreground); margin-inline-end: 6px; }
  .ag-dot[data-live="1"] { background: var(--green); }
  .ag-dot[data-live="0"] { background: var(--red); }
`

/** The page shell. `initialHtml` is a panel fragment, produced server-side. */
export function renderBoardPage(options: BoardPageOptions): string {
  const refreshMs = options.refreshMs ?? 5000
  const switcher =
    options.workspaces.length > 1
      ? `<div class="viz-row">${options.workspaces
          .map(
            (workspace) =>
              `<a class="btn" href="/?w=${encodeURIComponent(workspace.id)}"${
                workspace.active ? ' style="border-color:var(--primary)"' : ''
              }>${escapeHtml(workspace.id)}</a>`,
          )
          .join('')}</div>`
      : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgenticGit - ${escapeHtml(options.workspaceId)}</title>
<style>${THEME}</style>
</head>
<body>
  <div class="ag-chrome">
    <div>
      <h1><span class="ag-dot" id="ag-live" data-live="0"></span>AgenticGit board</h1>
      <div class="text-small text-muted" id="ag-meta">connecting...</div>
    </div>
    <div class="viz-row">
      <a class="btn" href="/panel?w=${encodeURIComponent(options.workspaceId)}">Panel</a>
      <a class="btn" href="/api/graph?w=${encodeURIComponent(options.workspaceId)}">Graph JSON</a>
      ${switcher}
    </div>
  </div>

  <div id="ag-board">${options.initialHtml}</div>

  <script>
    (function () {
      var workspaceId = ${JSON.stringify(options.workspaceId)};
      var refreshMs = ${JSON.stringify(refreshMs)};
      var board = document.getElementById('ag-board');
      var meta = document.getElementById('ag-meta');
      var live = document.getElementById('ag-live');
      var activeTab = null;

      function applyTab() {
        var tabs = board.querySelectorAll('[role="tab"]');
        var panes = board.querySelectorAll('[role="tabpanel"]');
        if (tabs.length === 0) return;
        var chosen = null;
        for (var i = 0; i < tabs.length; i += 1) {
          if (activeTab && tabs[i].id === activeTab) chosen = tabs[i];
        }
        if (!chosen) chosen = tabs[0];
        activeTab = chosen.id;
        for (var k = 0; k < tabs.length; k += 1) {
          var on = tabs[k] === chosen;
          tabs[k].setAttribute('aria-selected', on ? 'true' : 'false');
          tabs[k].classList.toggle('active', on);
        }
        for (var j = 0; j < panes.length; j += 1) {
          panes[j].hidden = panes[j].getAttribute('aria-labelledby') !== chosen.id;
        }
      }

      board.addEventListener('click', function (event) {
        var button = event.target.closest('[role="tab"]');
        if (!button || !board.contains(button)) return;
        activeTab = button.id;
        applyTab();
      });

      function paint(html, stamp) {
        board.innerHTML = html;
        applyTab();
        meta.textContent = 'updated ' + stamp;
      }

      function connect() {
        var source = new EventSource('/events?w=' + encodeURIComponent(workspaceId));
        source.onopen = function () { live.setAttribute('data-live', '1'); };
        source.onerror = function () { live.setAttribute('data-live', '0'); };
        source.onmessage = function (event) {
          if (event.data[0] !== '{') return;
          var payload;
          try { payload = JSON.parse(event.data); } catch (error) { return; }
          paint(payload.html, new Date(payload.generatedAt).toLocaleTimeString());
        };
      }

      // A second, slow path. The SSE stream only fires on a ledger change, but state
      // can also change because a lease expired, which writes nothing. Without this
      // the board would keep showing a lease that lapsed two minutes ago.
      setInterval(function () {
        fetch('/api/panel?w=' + encodeURIComponent(workspaceId))
          .then(function (response) { return response.ok ? response.json() : null; })
          .then(function (payload) {
            if (!payload) return;
            paint(payload.html, new Date(payload.generatedAt).toLocaleTimeString());
          })
          .catch(function () {});
      }, refreshMs);

      applyTab();
      connect();
    })();
  </script>
</body>
</html>`
}

/** Page shown when the daemon knows about no workspace. */
export function renderEmptyPage(hint: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgenticGit</title>
<style>${THEME}</style>
</head>
<body>
  <div class="card">
    <h2>No workspace is being watched</h2>
    <p class="text-muted">${escapeHtml(hint)}</p>
    <p class="text-small text-muted">
      Start the daemon from a workspace (<code>agentgit up</code>), or pass explicit paths:
      <code>agentgit up --watch &lt;path&gt;</code>.
    </p>
  </div>
</body>
</html>`
}

/**
 * Writing the panel to disk.
 *
 * The conversation host renders the panel from a *file*, not from a returned string:
 * the content reference it understands carries a path. So the panel has to exist as a
 * real file before it can be referenced, and this module is the only place that
 * decides what that file is.
 *
 * Two files are written, not one, because the two consumers need opposite things:
 *
 * - `agentgit-panel.html` is a complete document with a theme. It is what the content
 *   reference points at, and it is what a user opens when the reference does not
 *   render. A bare fragment here would display as unstyled markup, which reads as a
 *   broken plugin rather than as a missing stylesheet.
 * - `agentgit-panel.fragment.html` is the unmodified fragment, with no doctype, no
 *   `<html>` and no `<head>`. This is the form a host page can inject directly, and
 *   the only form that is safe to embed.
 *
 * Writing both means neither consumer has to strip anything, and a wrapper tag can
 * never leak into the embedded case.
 *
 * @module @agentgit/board/panel-file
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { BoardView } from '@agentgit/core'

import { renderPanel } from './panel.ts'
import { THEME } from './page.ts'

/**
 * The control characters that bracket a content reference.
 *
 * These are Unicode private-use codepoints. They have no visible width, so the token
 * looks like the word `visualize` followed by JSON, and it is why the token cannot be
 * assembled by hand or found with a plain text search. `agentgit` is set as the kind
 * because the host dispatches on the kind, and only the built-in one renders.
 */
const REFERENCE_OPEN = '\uE200'
const REFERENCE_MIDDLE = '\uE202'
const REFERENCE_CLOSE = '\uE201'

export const PANEL_HTML_FILENAME = 'agentgit-panel.html'
export const PANEL_FRAGMENT_FILENAME = 'agentgit-panel.fragment.html'

/**
 * The token to place in a reply, verbatim, on its own line.
 *
 * Exported rather than inlined at the call site so the CLI, the MCP tool and the
 * skill all produce byte-identical tokens. A single wrong codepoint here produces a
 * token that renders as visible gibberish in the user's transcript.
 */
export function panelReference(absolutePath: string): string {
  return `${REFERENCE_OPEN}visualize${REFERENCE_MIDDLE}${JSON.stringify({ path: absolutePath })}${REFERENCE_CLOSE}`
}

export interface PanelArtifact {
  /** The standalone document, and the path the content reference points at. */
  readonly path: string
  /** The raw fragment, for embedding into a host page. */
  readonly fragmentPath: string
  /** The content-reference token, ready to print verbatim. */
  readonly reference: string
  readonly generatedAt: string
  readonly bytes: number
}

/** Wrap a fragment in the smallest document that will display correctly on its own. */
export function standaloneDocument(view: BoardView, fragment: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgenticGit — ${escapeTitle(view.workspace)}</title>
<style>${THEME}</style>
</head>
<body>
${fragment}
</body>
</html>
`
}

function escapeTitle(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Write both panel files and return the reference for the standalone one.
 *
 * `outDir` defaults to a directory under the workspace rather than the system temp
 * directory, so the artifact survives a reboot and stays next to the ledger it
 * describes. It lives under `.agentgit/state/`, which is gitignored and regenerable.
 */
export function writePanel(view: BoardView, outDir: string): PanelArtifact {
  const dir = resolve(outDir)
  mkdirSync(dir, { recursive: true })

  const fragment = renderPanel(view)
  const document = standaloneDocument(view, fragment)

  const fragmentPath = join(dir, PANEL_FRAGMENT_FILENAME)
  const path = join(dir, PANEL_HTML_FILENAME)
  writeFileSync(fragmentPath, fragment, 'utf8')
  writeFileSync(path, document, 'utf8')

  return {
    path,
    fragmentPath,
    reference: panelReference(path),
    generatedAt: view.generatedAt,
    bytes: Buffer.byteLength(document, 'utf8'),
  }
}

/** Where the panel files belong for a workspace, absent an explicit `--out`. */
export function defaultPanelDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.agentgit', 'state', 'panel')
}

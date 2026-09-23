/**
 * The real-case story: one screen of before and after.
 *
 * What this is for
 * ----------------
 * The four experiments in `docs/EXPERIMENTS.md` measure. This is what a reader who will
 * not read a measurement looks at first: on the left, what the tooling they already have
 * said; on the right, what AgenticGit said at the same moment; underneath, the timestamps
 * that make the difference checkable.
 *
 * It is a renderer and nothing else. Every string it shows arrives in the {@link StoryView},
 * because a renderer that derives a number can produce a number that no measurement
 * produced — and this artifact exists specifically to be auditable back to a case.
 *
 * Why the markup is shaped the way it is
 * -------------------------------------
 * The conversation sandbox blocks `<script>`, `fetch`, `XMLHttpRequest`, `WebSocket` and
 * `EventSource`, and it blocks them *silently*: the failure mode is a blank panel, not an
 * error. So the two things a reader wants — a focus toggle and the raw command output —
 * are built from native HTML and CSS only: a checked radio with sibling selectors for the
 * toggle, and `<details>` for the output. Both work with scripting fully disabled.
 *
 * @module @agentgit/board/story
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { escapeHtml, truncate } from './format.ts'
import { pageDocument, panelReference } from './panel-file.ts'

/** Scoped, because the fragment is injected into a page whose styles are not ours. */
export const STORY_ROOT_ID = 'ag-story'

export const STORY_HTML_FILENAME = 'agentgit-story.html'

export type StoryTone = 'clear' | 'warn' | 'danger'

export interface StoryFact {
  readonly label: string
  readonly value: string
  /** True when the value is a literal string from a command and must not be reworded. */
  readonly mono?: boolean
}

export interface StorySide {
  /** Who is talking: `git`, `AgenticGit`, `before`, `after`. */
  readonly label: string
  /** The one line that carries the point. */
  readonly headline: string
  readonly tone: StoryTone
  readonly facts: readonly StoryFact[]
  /** A verbatim quotation, with who said it. */
  readonly quote?: { readonly text: string; readonly attribution: string } | null
  /** The command whose output is being quoted. */
  readonly command?: string | null
  /** Verbatim output, folded away by default. */
  readonly raw?: string | null
  /** False when this side is a statement about the tooling rather than an observation. */
  readonly observed?: boolean
}

export interface StoryTimelineEntry {
  readonly at: string
  readonly who: string
  readonly what: string
  readonly kind: 'write' | 'verdict' | 'merge'
}

export interface StoryView {
  /** The repository or workspace the case came from. */
  readonly workspace: string
  readonly title: string
  readonly subtitle: string
  readonly generatedAt: string
  /** How the case was found, so a reader can re-run the search. */
  readonly provenance: readonly StoryFact[]
  readonly before: StorySide
  readonly after: StorySide
  readonly timeline: readonly StoryTimelineEntry[]
  /** Non-negotiable limits of what this screen shows. */
  readonly honesty: readonly string[]
}

const toneClass: Readonly<Record<StoryTone, string>> = {
  clear: 'ag-tone-clear',
  warn: 'ag-tone-warn',
  danger: 'ag-tone-danger',
}

function factsTable(facts: readonly StoryFact[]): string {
  if (facts.length === 0) return ''
  const rows = facts
    .map(
      (fact) =>
        `<div class="ag-fact"><dt>${escapeHtml(fact.label)}</dt><dd${fact.mono ? ' class="ag-mono"' : ''}>${escapeHtml(fact.value)}</dd></div>`,
    )
    .join('')
  return `<dl class="ag-facts">${rows}</dl>`
}

function sideCard(side: StorySide, position: 'before' | 'after'): string {
  const quote = side.quote
    ? `<blockquote class="ag-quote">${escapeHtml(side.quote.text)}<cite>${escapeHtml(side.quote.attribution)}</cite></blockquote>`
    : ''
  const command = side.command ? `<div class="ag-command"><code>${escapeHtml(side.command)}</code></div>` : ''
  const raw = side.raw
    ? `<details class="ag-raw"><summary>raw output</summary><pre>${escapeHtml(side.raw)}</pre></details>`
    : ''
  const observed = side.observed === false
    ? `<div class="ag-observed">statement about the tool, not an observation of this case</div>`
    : ''

  return `<section class="ag-col ag-col-${position} card ${toneClass[side.tone]}">
  <div class="ag-col-head">
    <span class="ag-col-label">${escapeHtml(side.label)}</span>
    <span class="viz-badge">${escapeHtml(position)}</span>
  </div>
  <p class="ag-headline">${escapeHtml(side.headline)}</p>
  ${factsTable(side.facts)}
  ${quote}
  ${command}
  ${observed}
  ${raw}
</section>`
}

function timelineStrip(entries: readonly StoryTimelineEntry[]): string {
  if (entries.length === 0) return ''
  const items = entries
    .map(
      (entry) => `<li class="ag-tl-item ag-tl-${entry.kind}">
    <span class="ag-tl-dot" aria-hidden="true"></span>
    <div class="ag-tl-body">
      <div class="ag-tl-head"><span class="ag-tl-who">${escapeHtml(entry.who)}</span><span class="ag-tl-at tabular-nums">${escapeHtml(entry.at)}</span></div>
      <div class="text-small text-muted">${escapeHtml(entry.what)}</div>
    </div>
  </li>`,
    )
    .join('\n')
  return `<ol class="ag-timeline">${items}</ol>`
}

/**
 * The fragment, ready to embed or to wrap.
 *
 * Starts with the root element, because the host injects this into a page it already owns
 * and a stray wrapper tag would be dropped rather than reported.
 */
export function renderStory(view: StoryView): string {
  const provenance = view.provenance.length > 0
    ? `<div class="ag-provenance text-small text-muted">${view.provenance
        .map((fact) => `<span>${escapeHtml(fact.label)}: ${escapeHtml(fact.value)}</span>`)
        .join('<span class="ag-sep">·</span>')}</div>`
    : ''

  const honesty = view.honesty.length > 0
    ? `<section class="ag-honesty card">
    <h3>What this screen does not show</h3>
    <ul>${view.honesty.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
  </section>`
    : ''

  return `<div id="${STORY_ROOT_ID}">
  <style>
    #${STORY_ROOT_ID} { display: flex; flex-direction: column; gap: 14px; color: var(--foreground); }
    #${STORY_ROOT_ID} .ag-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; justify-content: space-between; }
    #${STORY_ROOT_ID} h2 { margin: 0; }
    #${STORY_ROOT_ID} h3 { margin: 0 0 6px; }
    #${STORY_ROOT_ID} .ag-provenance { display: flex; flex-wrap: wrap; gap: 6px; }
    #${STORY_ROOT_ID} .ag-sep { opacity: 0.5; }
    /* The focus toggle is a checked radio plus sibling selectors — no runtime of any kind. */
    #${STORY_ROOT_ID} .ag-focus { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
    #${STORY_ROOT_ID} .ag-focus-bar { display: flex; flex-wrap: wrap; gap: 6px; }
    #${STORY_ROOT_ID} .ag-focus-bar label {
      border: 1px solid var(--border); border-radius: 999px; padding: 5px 11px;
      font-size: 13px; color: var(--muted-foreground); cursor: pointer; background: transparent;
    }
    #${STORY_ROOT_ID} #ag-focus-both:checked ~ .ag-focus-bar label[for="ag-focus-both"],
    #${STORY_ROOT_ID} #ag-focus-before:checked ~ .ag-focus-bar label[for="ag-focus-before"],
    #${STORY_ROOT_ID} #ag-focus-after:checked ~ .ag-focus-bar label[for="ag-focus-after"] {
      background: var(--primary); color: var(--primary-foreground); border-color: var(--primary);
    }
    #${STORY_ROOT_ID} #ag-focus-before:checked ~ .ag-columns .ag-col-after { display: none; }
    #${STORY_ROOT_ID} #ag-focus-after:checked ~ .ag-columns .ag-col-before { display: none; }
    #${STORY_ROOT_ID} .ag-columns { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); align-items: start; }
    /* One column when focused, so the reader is not left with a half-empty row. */
    #${STORY_ROOT_ID} #ag-focus-before:checked ~ .ag-columns,
    #${STORY_ROOT_ID} #ag-focus-after:checked ~ .ag-columns { grid-template-columns: minmax(0, 1fr); }
    #${STORY_ROOT_ID} .ag-col { display: flex; flex-direction: column; gap: 10px; border-top-width: 3px; border-top-style: solid; }
    #${STORY_ROOT_ID} .ag-col-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
    #${STORY_ROOT_ID} .ag-col-label { font-weight: 500; }
    #${STORY_ROOT_ID} .ag-headline { margin: 0; font-size: 17px; }
    #${STORY_ROOT_ID} .ag-facts { margin: 0; display: flex; flex-direction: column; gap: 4px; }
    #${STORY_ROOT_ID} .ag-fact { display: flex; gap: 10px; justify-content: space-between; align-items: baseline; }
    #${STORY_ROOT_ID} .ag-fact dt { color: var(--muted-foreground); font-size: 12px; }
    #${STORY_ROOT_ID} .ag-fact dd { margin: 0; text-align: end; font-size: 13px; }
    #${STORY_ROOT_ID} .ag-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    #${STORY_ROOT_ID} .ag-quote { margin: 0; padding: 8px 10px; border-inline-start: 3px solid var(--border); background: var(--muted); border-radius: 0 8px 8px 0; font-size: 13px; }
    #${STORY_ROOT_ID} .ag-quote cite { display: block; margin-top: 4px; color: var(--muted-foreground); font-style: normal; font-size: 12px; }
    #${STORY_ROOT_ID} .ag-command code { font-size: 12px; word-break: break-all; }
    #${STORY_ROOT_ID} .ag-observed { font-size: 12px; color: var(--muted-foreground); font-style: italic; }
    #${STORY_ROOT_ID} .ag-raw summary { cursor: pointer; font-size: 12px; color: var(--muted-foreground); }
    #${STORY_ROOT_ID} .ag-raw pre { margin: 6px 0 0; padding: 8px 10px; background: var(--muted); border-radius: 8px; overflow-x: auto; font-size: 12px; }
    #${STORY_ROOT_ID} .ag-tone-clear { border-top-color: var(--green); }
    #${STORY_ROOT_ID} .ag-tone-warn { border-top-color: var(--orange); }
    #${STORY_ROOT_ID} .ag-tone-danger { border-top-color: var(--red); }
    #${STORY_ROOT_ID} .ag-timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    #${STORY_ROOT_ID} .ag-tl-item { display: flex; gap: 10px; align-items: flex-start; }
    #${STORY_ROOT_ID} .ag-tl-dot { width: 9px; height: 9px; border-radius: 50%; margin-top: 5px; flex: 0 0 auto; background: var(--muted-foreground); }
    #${STORY_ROOT_ID} .ag-tl-write .ag-tl-dot { background: var(--blue); }
    #${STORY_ROOT_ID} .ag-tl-verdict .ag-tl-dot { background: var(--orange); }
    #${STORY_ROOT_ID} .ag-tl-merge .ag-tl-dot { background: var(--red); }
    #${STORY_ROOT_ID} .ag-tl-body { display: flex; flex-direction: column; gap: 2px; }
    #${STORY_ROOT_ID} .ag-tl-head { display: flex; gap: 10px; align-items: baseline; }
    #${STORY_ROOT_ID} .ag-tl-who { font-size: 13px; font-weight: 500; }
    #${STORY_ROOT_ID} .ag-tl-at { font-size: 12px; color: var(--muted-foreground); }
    #${STORY_ROOT_ID} .ag-honesty ul { margin: 0; padding-inline-start: 18px; display: flex; flex-direction: column; gap: 4px; }
    #${STORY_ROOT_ID} .ag-honesty li { font-size: 13px; }
  </style>

  <div class="ag-head">
    <div>
      <h2>${escapeHtml(view.title)}</h2>
      <div class="text-small text-muted">${escapeHtml(view.subtitle)}</div>
    </div>
    <div class="text-small text-muted ag-mono">${escapeHtml(view.workspace)}</div>
  </div>
  ${provenance}

  <input class="ag-focus" type="radio" name="ag-story-focus" id="ag-focus-both" checked>
  <input class="ag-focus" type="radio" name="ag-story-focus" id="ag-focus-before">
  <input class="ag-focus" type="radio" name="ag-story-focus" id="ag-focus-after">
  <div class="ag-focus-bar" role="group" aria-label="Which side to show">
    <label for="ag-focus-both">both</label>
    <label for="ag-focus-before">${escapeHtml(truncate(view.before.label, 24))} only</label>
    <label for="ag-focus-after">${escapeHtml(truncate(view.after.label, 24))} only</label>
  </div>

  <div class="ag-columns">
${sideCard(view.before, 'before')}
${sideCard(view.after, 'after')}
  </div>

  <section class="card">
    <h3>What happened, in order</h3>
    ${timelineStrip(view.timeline)}
  </section>

  ${honesty}

  <div class="text-small text-muted">rendered ${escapeHtml(view.generatedAt)}</div>
</div>`
}

/** The same fragment as a standalone document, for the content reference to point at. */
export function storyDocument(view: StoryView): string {
  return pageDocument(view.title, renderStory(view))
}

export interface StoryArtifact {
  readonly path: string
  readonly reference: string
  readonly generatedAt: string
  readonly bytes: number
}

/**
 * Write the story and return the content reference for it.
 *
 * Defaults under `.agentgit/state/`, which is gitignored and regenerable, so the artifact
 * survives a reboot and never looks like a source file somebody forgot to commit.
 */
export function writeStory(view: StoryView, outDir: string): StoryArtifact {
  const dir = resolve(outDir)
  mkdirSync(dir, { recursive: true })
  const document = storyDocument(view)
  const path = join(dir, STORY_HTML_FILENAME)
  writeFileSync(path, document, 'utf8')
  return {
    path,
    reference: panelReference(path),
    generatedAt: view.generatedAt,
    bytes: Buffer.byteLength(document, 'utf8'),
  }
}

/** Where the story belongs for a workspace, absent an explicit `--out`. */
export function defaultStoryDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.agentgit', 'state', 'story')
}

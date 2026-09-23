/**
 * The inline panel: a self-contained HTML fragment describing one workspace.
 *
 * Why a snapshot and not a live view
 * ----------------------------------
 * The conversation sandbox forbids `fetch`, XHR and WebSocket, and its CSP allows
 * only a short list of CDNs. A panel that tried to poll would fail silently and show
 * a permanently empty table, which is worse than showing nothing. So this module
 * emits every fact inline at generation time, and the live view lives on the local
 * board where no such restriction applies. The panel answers "what was true when I
 * asked"; the board answers "what is true now".
 *
 * The fragment contract is strict: no doctype, no `<html>`, `<head>` or `<body>`,
 * a unique root id, and literal markup. The renderer injects this into a host page,
 * so a stray wrapper tag would either be dropped or break the host's layout.
 *
 * @module @agentgit/board/panel
 */

import type { BoardView } from '@agentgit/core'

import { ago, baseName, escapeHtml, shortPath, truncate, until, VERDICT_ACTION } from './format.ts'

const ROOT_ID = 'agentgit-panel'

/**
 * Debt is rendered as a bar, not a gauge with a needle or a ring.
 *
 * A score of 0 must look empty and 100 must look full, which a bar does literally.
 * A gauge invites reading a value against a dial rather than against zero, and this
 * number has no meaningful midpoint.
 */
function debtTone(score: number): string {
  if (score >= 60) return 'var(--red)'
  if (score >= 30) return 'var(--orange)'
  return 'var(--green)'
}

function stat(label: string, value: string, note: string): string {
  return `<div class="card ag-stat">
      <div class="text-small text-muted">${escapeHtml(label)}</div>
      <div class="viz-stat-value tabular-nums">${escapeHtml(value)}</div>
      <div class="text-small text-muted">${escapeHtml(note)}</div>
    </div>`
}

function flightTable(view: BoardView): string {
  if (view.tasks.length === 0) {
    return `<p class="text-muted">No task has been recorded in this workspace yet. Start one with a normal agent turn: the hooks open a task as soon as an agent writes.</p>`
  }
  const rows = view.tasks
    .map((task) => {
      const stale = task.staleContracts.length > 0
        ? `<span class="ag-pill ag-pill-warn">${escapeHtml(task.staleContracts.join(', '))}</span>`
        : '<span class="text-muted">—</span>'
      const leases = task.leases.length > 0
        ? escapeHtml(task.leases.map(baseName).join(', '))
        : '<span class="text-muted">none</span>'
      const intent = task.intents[0] ? truncate(task.intents[0], 90) : ''
      return `<tr>
        <td>
          <code>${escapeHtml(truncate(task.taskId, 28))}</code>
          ${intent ? `<div class="text-small text-muted">${escapeHtml(intent)}</div>` : ''}
        </td>
        <td><span class="ag-pill ag-state-${escapeHtml(task.state)}">${escapeHtml(task.state)}</span></td>
        <td class="text-end tabular-nums">${task.writes}</td>
        <td class="text-end tabular-nums">${task.entities.length}</td>
        <td class="text-small">${leases}</td>
        <td class="text-small">${stale}</td>
      </tr>`
    })
    .join('\n')

  return `<div class="table-responsive">
    <table class="table table-sm">
      <thead>
        <tr>
          <th>Task</th><th>State</th><th class="text-end">Writes</th><th class="text-end">Entities</th><th>Holds</th><th>Stale</th>
        </tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>`
}

function radarList(view: BoardView): string {
  if (view.collisions.length === 0) {
    return `<p class="text-muted">No entity is wanted by more than one task. Nothing to coordinate.</p>`
  }
  const items = view.collisions
    .map((collision) => {
      const same = collision.sameWork
      const badge = same === null
        ? `<span class="ag-pill">unknown intent</span>`
        : same
          ? `<span class="ag-pill ag-pill-warn">same work</span>`
          : `<span class="ag-pill ag-pill-info">different work</span>`
      const live = collision.live ? `<span class="ag-pill ag-pill-live">live lease</span>` : ''
      const intents = collision.intents
        .slice(0, 3)
        .map((intent) => `<div class="text-small text-muted">“${escapeHtml(truncate(intent, 110))}”</div>`)
        .join('')
      return `<li class="ag-radar-item">
        <div class="ag-radar-head">
          <code>${escapeHtml(shortPath(collision.entityKey.replace(/^(file|symbol)::/, ''), 64))}</code>
          ${badge}${live}
        </div>
        <div class="text-small text-muted">
          ${collision.tasks.length} task(s) · ${collision.sessions.length} session(s) · ${collision.touches} touch(es)
        </div>
        ${intents}
      </li>`
    })
    .join('\n')
  return `<ul class="ag-list">${items}</ul>`
}

function contractsSection(view: BoardView): string {
  if (view.contracts.length === 0) {
    return `<p class="text-muted">No shared interface has been published. Publish one when a change alters a signature another task depends on, and the plugin can tell that task its assumption has expired.</p>`
  }
  const rows = view.contracts
    .map(
      (contract) => `<tr>
        <td><code>${escapeHtml(contract.name)}</code>${
          contract.symbol ? `<div class="text-small text-muted">${escapeHtml(contract.symbol)}</div>` : ''
        }</td>
        <td class="text-end tabular-nums">v${contract.version}</td>
        <td>${contract.breaking ? `<span class="ag-pill ag-pill-warn">breaking</span>` : '<span class="text-muted">additive</span>'}</td>
        <td class="text-small">${escapeHtml(contract.publishedBy)}</td>
        <td class="text-small text-muted">${escapeHtml(truncate(contract.summary, 90))}</td>
      </tr>`,
    )
    .join('\n')

  const stale = staleSection(view)

  return `<div class="table-responsive">
    <table class="table table-sm">
      <thead><tr><th>Interface</th><th class="text-end">Version</th><th>Change</th><th>Published by</th><th>Summary</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>
  <h4>Expired assumptions</h4>
  ${stale}`
}

function staleSection(view: BoardView): string {
  const breaking = view.debt.breakdown.staleAssumptions
  if (view.tasks.every((task) => task.staleContracts.length === 0)) {
    return `<p class="text-muted">Every task is coded against the current published version of every interface it declared.</p>`
  }
  const items = view.tasks
    .filter((task) => task.staleContracts.length > 0)
    .map(
      (task) => `<li class="ag-radar-item">
        <div class="ag-radar-head">
          <code>${escapeHtml(truncate(task.taskId, 30))}</code>
          <span class="ag-pill ag-pill-warn">coded against an older version</span>
        </div>
        <div class="text-small text-muted">${escapeHtml(task.staleContracts.join(', '))}</div>
      </li>`,
    )
    .join('\n')
  return `<ul class="ag-list">${items}</ul>${
    breaking > 0
      ? `<p class="text-small">${breaking} of these is a breaking change, so a clean merge is not evidence that the result works.</p>`
      : ''
  }`
}

function ledgerSection(view: BoardView): string {
  const { diagnostics, report } = view
  const leases = view.leases.length === 0
    ? `<p class="text-muted">No lease is held.</p>`
    : `<div class="table-responsive"><table class="table table-sm">
        <thead><tr><th>Entity</th><th>Task</th><th>Reason</th><th>Expires</th></tr></thead>
        <tbody>${view.leases
          .map(
            (lease) => `<tr>
              <td><code>${escapeHtml(shortPath(lease.entityKey.replace(/^(file|symbol|contract)::/, ''), 48))}</code></td>
              <td><code>${escapeHtml(truncate(lease.taskId, 22))}</code></td>
              <td class="text-small text-muted">${escapeHtml(truncate(lease.reason, 70))}</td>
              <td class="text-small">${escapeHtml(until(lease.expiresAt))}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table></div>`

  return `<div class="viz-grid">
      ${stat('events', String(diagnostics.events), `${diagnostics.shards} shard(s), ${(diagnostics.bytes / 1024).toFixed(1)} KiB`)}
      ${stat('tasks', String(report.counts.capsules), `${report.counts.openCapsules} open · ${report.counts.integratedCapsules} integrated`)}
      ${stat('reads unrecorded', diagnostics.malformedEvents > 0 ? String(diagnostics.malformedEvents) : '0', 'malformed or torn ledger lines')}
    </div>
    <h4>Live leases</h4>
    ${leases}
    <p class="text-small text-muted">
      Ledger shards: <code>.agentgit/events/${escapeHtml(view.machine)}-*.jsonl</code>.
      This panel is a snapshot taken ${escapeHtml(ago(view.generatedAt))}. Run the local board for a live view.
    </p>`
}

/** The complete fragment, ready to be written to an HTML file and referenced. */
export function renderPanel(view: BoardView): string {
  const open = view.tasks.filter((task) => task.state === 'proposed' || task.state === 'active' || task.state === 'validated')
  const debt = view.debt
  const pct = Math.max(0, Math.min(100, debt.score))

  const headline = [
    `${open.length} task(s) in flight`,
    `${view.collisions.length} collision(s)`,
    `${debt.breakdown.staleAssumptions} stale assumption(s)`,
    `${view.leases.length} live lease(s)`,
  ].join(' · ')

  const drivers = debt.drivers.length > 0
    ? `<div class="text-small text-muted">${escapeHtml(debt.drivers.join(' · '))}</div>`
    : `<div class="text-small text-muted">Nothing is waiting on anyone.</div>`

  // Tab ids are fixed rather than derived from the workspace path, because the
  // fragment may be regenerated into the same conversation and the host's tab
  // runtime keys on these ids.
  const tabs = [
    ['flight', 'In flight', flightTable(view)],
    ['radar', 'Collision radar', radarList(view)],
    ['contracts', 'Contracts', contractsSection(view)],
    ['ledger', 'Ledger', ledgerSection(view)],
  ] as const

  const tabButtons = tabs
    .map(
      ([id, label], index) =>
        `<button class="nav-link${index === 0 ? ' active' : ''}" id="ag-tab-${id}" role="tab" aria-controls="ag-pane-${id}" aria-selected="${index === 0}" type="button">${escapeHtml(label)}${
          id === 'radar' && view.collisions.length > 0 ? ` <span class="ag-badge">${view.collisions.length}</span>` : ''
        }</button>`,
    )
    .join('\n    ')

  const panels = tabs
    .map(
      ([id, , body], index) =>
        `<div id="ag-pane-${id}" role="tabpanel" aria-labelledby="ag-tab-${id}"${index === 0 ? '' : ' hidden'}>
  ${body}
</div>`,
    )
    .join('\n')

  return `<div id="${ROOT_ID}">
  <style>
    #${ROOT_ID} { display: flex; flex-direction: column; gap: 14px; color: var(--foreground); }
    #${ROOT_ID} .ag-head { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; justify-content: space-between; }
    #${ROOT_ID} h2 { margin: 0; }
    #${ROOT_ID} h4 { margin: 18px 0 6px; }
    #${ROOT_ID} .ag-debt { display: flex; flex-direction: column; gap: 4px; min-width: 220px; flex: 1 1 220px; }
    #${ROOT_ID} .ag-debt-bar { height: 8px; border-radius: 4px; background: var(--muted); overflow: hidden; }
    #${ROOT_ID} .ag-debt-fill { height: 100%; }
    #${ROOT_ID} .ag-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    #${ROOT_ID} .ag-radar-item { display: flex; flex-direction: column; gap: 3px; }
    #${ROOT_ID} .ag-radar-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    #${ROOT_ID} .ag-pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 12px; line-height: 18px; background: var(--muted); color: var(--muted-foreground); }
    #${ROOT_ID} .ag-pill-warn { background: var(--orange); color: var(--background); }
    #${ROOT_ID} .ag-pill-info { background: var(--blue); color: var(--background); }
    #${ROOT_ID} .ag-pill-live { background: var(--red); color: var(--background); }
    #${ROOT_ID} .ag-state-active, #${ROOT_ID} .ag-state-proposed { background: var(--green); color: var(--background); }
    #${ROOT_ID} .ag-state-validated { background: var(--blue); color: var(--background); }
    #${ROOT_ID} .ag-state-integrated { background: var(--muted); }
    #${ROOT_ID} .ag-state-stale, #${ROOT_ID} .ag-state-abandoned { background: var(--destructive); color: var(--background); }
    #${ROOT_ID} .ag-badge { display: inline-block; min-width: 16px; padding: 0 4px; border-radius: 999px; background: var(--orange); color: var(--background); font-size: 11px; line-height: 16px; text-align: center; }
    #${ROOT_ID} .ag-stat .viz-stat-value { font-size: 20px; }
    #${ROOT_ID} code { font-size: 12px; }
  </style>

  <div class="ag-head">
    <div>
      <h2>AgenticGit</h2>
      <div class="text-small text-muted">${escapeHtml(headline)}</div>
      ${drivers}
    </div>
    <div class="ag-debt">
      <div class="viz-row" style="justify-content: space-between">
        <span class="text-small text-muted">coordination debt</span>
        <span class="text-small tabular-nums">${debt.score}/100</span>
      </div>
      <div class="ag-debt-bar" role="progressbar" aria-label="Coordination debt" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
        <div class="ag-debt-fill" style="width:${pct}%;background:${debtTone(pct)}"></div>
      </div>
    </div>
  </div>

  <div class="nav nav-pills" role="tablist" aria-label="AgenticGit sections">
    ${tabButtons}
  </div>

  ${panels}

  <hr>
  <div class="text-small text-muted">
    ${escapeHtml(view.workspace)} · machine ${escapeHtml(view.machine)} · snapshot ${escapeHtml(ago(view.generatedAt))}
  </div>
</div>`
}

/**
 * A compact one-screen summary for callers that must not embed a full panel — the
 * MCP tool result, for instance, which needs the facts in the transcript too.
 */
export function panelMarkdown(view: BoardView): string {
  const lines: string[] = []
  lines.push(`**Coordination debt ${view.debt.score}/100** — ${view.tasks.length} task(s), ${view.collisions.length} collision(s), ${view.leases.length} live lease(s).`)
  if (view.debt.drivers.length > 0) lines.push(`Drivers: ${view.debt.drivers.join('; ')}.`)
  if (view.collisions.length > 0) {
    lines.push('')
    lines.push('| entity | tasks | same work? |')
    lines.push('|---|---|---|')
    for (const collision of view.collisions.slice(0, 8)) {
      const same = collision.sameWork === null ? 'unknown' : collision.sameWork ? 'yes' : 'no'
      lines.push(`| \`${collision.entityKey.replace(/\\/g, '/')}\` | ${collision.tasks.join(', ')} | ${same} |`)
    }
  }
  return lines.join('\n')
}

/** Exported for tests that assert the fragment contract. */
export const PANEL_ROOT_ID = ROOT_ID

/** Verdict wording is re-exported so the daemon and the CLI cannot drift from it. */
export { VERDICT_ACTION }

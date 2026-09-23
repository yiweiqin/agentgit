/**
 * Shared formatting helpers for every surface.
 *
 * The panel, the live board, the CLI and the MCP tool descriptions all quote the
 * same facts, so the words for those facts live here. A second copy would drift,
 * and the drift would show up as a board that calls a collision "live" while the
 * CLI calls it "contested", after which neither word is trusted.
 *
 * @module @agentgit/board/format
 */

import type { Verdict } from '@agentgit/core'

/** Human words for the six verdicts, matching the skill's table exactly. */
export const VERDICT_LABEL: Readonly<Record<Verdict, string>> = {
  allow: 'allow',
  reuse: 'reuse',
  refresh: 'refresh',
  replan: 'replan',
  wait: 'wait',
  review: 'review',
}

/**
 * One-line instruction per verdict.
 *
 * Written as an instruction rather than a description because the reader is an
 * agent deciding what to do next, and "an in-flight change overlaps yours" is a
 * fact it can already see.
 */
export const VERDICT_ACTION: Readonly<Record<Verdict, string>> = {
  allow: 'nothing else is on this ground',
  reuse: 'someone is already building this; consume their change',
  refresh: 'an interface you assumed has moved; re-read it first',
  replan: 'an in-flight plan wants the same ground for different reasons',
  wait: 'the interface you need is still landing; stub it or wait',
  review: 'breaking interface change; stop for a human decision',
}

export function shortPath(path: string, max = 52): string {
  const normalized = path.replace(/\\/g, '/')
  if (normalized.length <= max) return normalized
  const parts = normalized.split('/')
  if (parts.length <= 2) return `…${normalized.slice(-(max - 1))}`
  return `${parts[0]}/…/${parts.slice(-2).join('/')}`
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Relative time from an ISO instant, coarse on purpose: precision here is noise. */
export function ago(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '—'
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return '—'
  const seconds = Math.max(0, Math.round((now.getTime() - at) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Time until an ISO instant, for a lease that has not expired yet. */
export function until(iso: string, now: Date = new Date()): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return '—'
  const seconds = Math.round((at - now.getTime()) / 1000)
  if (seconds <= 0) return 'expired'
  if (seconds < 60) return `${seconds}s left`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m left`
  return `${Math.round(minutes / 60)}h left`
}

/** The last path segment, for a table cell where the directory is noise. */
export function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

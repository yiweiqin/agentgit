/**
 * Entity subjects: what a write is *about*, at two resolutions.
 *
 * A ledger key answers "which row is this", and one subject has two spellings:
 * `file::src/auth.py` names ground, `symbol::resolveIdentity` names behaviour. Two
 * agents can be about the same thing while spelling it differently — one names the file,
 * the other names the function inside it — and a detector that compares keys literally
 * cannot see that. That miss is what E2 measured and what this module exists to close.
 *
 * So a key is decoded into a *subject*: a file, a symbol, or both. Two subjects match at
 * one of two strengths, and the strength is what the policy acts on:
 *
 * | strength | meaning                       | how the policy reads it                    |
 * |----------|-------------------------------|--------------------------------------------|
 * | `symbol` | both name the same symbol     | the same work, on its own                  |
 * | `file`   | the same file, no shared symbol | ground overlap only; still needs intent evidence |
 *
 * The second row is the constraint this module protects. Sharing a file is not evidence of
 * doing the same thing — two tasks can edit one file for unrelated reasons — so a
 * file-level match never becomes a duplicate by itself. Sharing a symbol is stronger
 * evidence, because a symbol is a behaviour rather than a place.
 *
 * @module @agentgit/core/entity
 */

/** What a write is about. `null` where that resolution is unknown. */
export interface EntitySubject {
  readonly file: string | null
  readonly symbol: string | null
}

/** How strongly two subjects are the same subject. `null` means unrelated. */
export type MatchStrength = 'symbol' | 'file' | null

/** The parts a ledger entity carries, from which its subject is decoded. */
export interface EntityParts {
  readonly kind: string
  readonly identifier: string
  readonly path: string
}

/**
 * Decode an entity's parts into a subject.
 *
 * A symbol whose `path` is the symbol itself carries no file information, so the file
 * side stays `null` rather than echoing the symbol back as a path. Treating the two as
 * the same thing is how a symbol-level claim would silently become a file-level one.
 */
export function entitySubjectOf(parts: EntityParts): EntitySubject {
  const { kind, identifier, path } = parts
  if (kind === 'symbol') {
    const symbol = identifier || path
    return { symbol: symbol || null, file: path && path !== symbol ? path : null }
  }
  const file = path || identifier
  return { file: file || null, symbol: null }
}

/**
 * The subject of a proposal.
 *
 * `entityKey` is authoritative for *which* thing this is; `entityPath` is the human-facing
 * spelling and only fills in a resolution the key does not already carry. Reading the path
 * first would let a stale or defaulted path override the key, which is how two unrelated
 * entities get compared as one.
 *
 * A caller that names a symbol may also name the file it lives in, and both are kept: the
 * file is what lets a symbol-level claim meet a path-level claim from the other side.
 */
export function subjectOfProposal(proposal: {
  readonly entityKey: string
  readonly entityPath?: string | null
  readonly symbol?: string | null
}): EntitySubject {
  const key = proposal.entityKey
  const fileFromKey = key.startsWith('file::') ? key.slice('file::'.length) : null

  if (key.startsWith('symbol::')) {
    return { symbol: key.slice('symbol::'.length) || null, file: proposal.entityPath ?? null }
  }
  if (proposal.symbol) {
    return { symbol: proposal.symbol, file: proposal.entityPath ?? fileFromKey ?? null }
  }
  const file = fileFromKey || proposal.entityPath || null
  return { file, symbol: null }
}

/** How two subjects are the same subject, strongest first. */
export function matchStrength(a: EntitySubject, b: EntitySubject): MatchStrength {
  if (a.symbol !== null && b.symbol !== null && a.symbol === b.symbol) return 'symbol'
  if (a.file !== null && b.file !== null && a.file === b.file) return 'file'
  return null
}

/** The stronger of two strengths. Used to fold a list of matches into one. */
export function strongestStrength(a: MatchStrength, b: MatchStrength): MatchStrength {
  if (a === 'symbol' || b === 'symbol') return 'symbol'
  if (a === 'file' || b === 'file') return 'file'
  return null
}

/**
 * Whether a match at this strength is enough, on its own, to call two writes the same work.
 *
 * Only `symbol` qualifies. This is a named function rather than an inline comparison
 * because the rule that file overlap is never sufficient should have exactly one home, so
 * a later change cannot quietly loosen it at one call site.
 */
export function isStructuralDuplicate(strength: MatchStrength): boolean {
  return strength === 'symbol'
}

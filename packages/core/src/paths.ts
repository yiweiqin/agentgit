/**
 * One directory, one identity.
 *
 * The problem this solves
 * -----------------------
 * Three places in this product keyed a directory by the string the caller happened to hold:
 * the machine-level offer record (`desktop.ts`), the session registry's working-directory
 * match, and the rollout containment check. On Windows — and, for case, on macOS — `C:\Users\me`
 * and `c:\users\ME` are the *same* directory but different strings, so the same repository got
 * two records, or a session was matched against the wrong root. The symptom is a second prompt
 * to opt in, or a match that silently fails, never a crash — which is why it survived.
 *
 * Two functions, because there are two questions
 * ---------------------------------------------
 * - {@link normalizeRoot} answers "what is the canonical path?", for storing and displaying. It
 *   resolves to an absolute path and, when the directory exists, asks the OS for its real
 *   casing (`realpathSync.native`). A path that does not exist is left as resolved rather than
 *   guessed at.
 * - {@link rootKey} answers "is this the same directory as that one?", for keying and comparing.
 *   It folds case on the platforms where the filesystem does, so two spellings collapse to one
 *   key there and stay distinct on Linux, where they are genuinely two directories.
 *
 * Both are pure given the filesystem. Neither throws: a coordination lookup that fails because
 * a path could not be canonicalised would be worse than one that treats the path as spelled.
 *
 * @module @agentgit/core/paths
 */

import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/**
 * Whether this platform's filesystem treats two casings of one name as one file.
 *
 * Windows does. macOS does by default. Linux does not, and folding case there would merge two
 * directories that really are separate — the opposite of the bug being fixed.
 */
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

/** Absolute, with the casing the filesystem itself uses when the directory exists. */
export function normalizeRoot(input: string): string {
  const absolute = resolve(input)
  try {
    return realpathSync.native(absolute)
  } catch {
    // The path does not exist, or cannot be read. `resolve` already made it absolute and
    // normalised its separators, which is as much as can be known without the OS.
    return absolute
  }
}

/**
 * The identity key for a directory: canonical, and case-folded where the filesystem is.
 *
 * Use this for `Map` keys and `===` comparisons between roots. Use {@link normalizeRoot} for
 * anything a human will read, so a stored path keeps its real casing.
 */
export function rootKey(input: string): string {
  const canonical = normalizeRoot(input)
  return CASE_INSENSITIVE ? canonical.toLowerCase() : canonical
}

/** True when two spellings name the same directory on this platform. */
export function sameRoot(a: string, b: string): boolean {
  return rootKey(a) === rootKey(b)
}

/**
 * True when `candidate` is `root` itself or inside it, compared on path boundaries.
 *
 * The boundary matters: `/repo-other` starts with `/repo`, and a raw prefix test would call it
 * a child. Case is folded exactly where {@link rootKey} folds it, for the same reason.
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  const parent = rootKey(root)
  const child = rootKey(candidate)
  if (parent === child) return true
  // `rootKey` keeps the platform separator, so the boundary is the OS's own.
  const boundary = parent.endsWith(sep) ? parent : `${parent}${sep}`
  return child.startsWith(boundary)
}

/**
 * Read the patch bodies Codex writes into a rollout.
 *
 * Why this is not part of codex-rollout.ts
 * ----------------------------------------
 * `codex-rollout.ts` answers "which files did this session touch", which is all the
 * ledger needs. This module answers a different and much harder question: *what did the
 * session actually write.* That distinction is the whole point of the real-data study —
 * a ledger entry proving two sessions touched one file cannot tell duplicate work from
 * two people editing one file for unrelated reasons, and the experiment is not allowed
 * to answer that by opinion.
 *
 * The rollout records it. An `apply_patch` call is stored verbatim as
 * `response_item / custom_tool_call` with `input` holding the whole patch, so the added
 * and removed lines are facts on disk rather than a judgement call.
 *
 * Two deliberate choices
 * ----------------------
 * **Parse defensively, and never throw.** The record layout is Codex's internal format,
 * not a contract. A shape this module does not recognise yields fewer parsed patches and
 * a reason, never an exception out of a hook or a daemon tick.
 *
 * **Keep the hunks, do not just count them.** `addedLines` is enough for a summary and
 * useless for the thing the study needs: applying the patch to a base revision to see
 * whether two real sessions' work merges cleanly. The hunks are kept so
 * {@link applyFileOps} can do exactly that, and a patch that cannot be applied is
 * reported as such instead of being counted as a change.
 *
 * @module @agentgit/core/rollout-patches
 */

import { readFileSync } from 'node:fs'

import { extractIdentifiers } from './policy.ts'

/**
 * One contiguous run of changes inside a file.
 *
 * `old` and `next` are the hunk's two sides in *file order*, with context interleaved
 * exactly where the patch wrote it. They are the only fields {@link applyFileOps}
 * needs; `added` and `removed` are kept alongside because a count and a display both
 * want them without having to re-derive which side a context line sits on.
 */
export interface PatchHunk {
  /** The `@@` line as written, when there was one. Kept for the report. */
  readonly header: string | null
  /** Context and removed lines, in file order. */
  readonly old: readonly string[]
  /** Context and added lines, in file order. */
  readonly next: readonly string[]
  readonly context: readonly string[]
  readonly removed: readonly string[]
  readonly added: readonly string[]
}

export interface PatchFileOp {
  readonly kind: 'add' | 'update' | 'delete'
  /** The path as the patch wrote it. Absolute on Windows, relative in a repo-relative patch. */
  readonly path: string
  /** A `*** Move to:` target, when the patch renames the file. */
  readonly moveTo: string | null
  readonly hunks: readonly PatchHunk[]
  readonly addedLines: number
  readonly removedLines: number
  /**
   * Signatures the patch adds or removes, normalised to `kind name`.
   *
   * This is the mechanical evidence for the hidden-dependency failure: an interface whose
   * signature changed under a session that had already coded against it. It is derived
   * from the patch text, so it is a fact about what was written rather than a claim about
   * what it meant.
   */
  readonly addedSignatures: readonly string[]
  readonly removedSignatures: readonly string[]
  /** Identifier-like tokens on added and removed lines, for lexical overlap. */
  readonly addedIdentifiers: readonly string[]
  readonly removedIdentifiers: readonly string[]
}

export interface RolloutPatchCall {
  readonly at: string
  readonly callId: string | null
  /**
   * Where the patch text was found.
   *
   * `body` is an `apply_patch` call whose input is the patch itself. `embedded` is a
   * script tool call that builds the patch as a string literal and runs it — the shape
   * one of the two real sessions writes, and 27 of its 6,548 tool calls carry a body
   * while hundreds carry an embedded literal. Treating `embedded` as absent would have
   * discarded that session's work entirely and left the study with half a case.
   */
  readonly source: 'body' | 'embedded'
  readonly files: readonly PatchFileOp[]
}

export interface RolloutPatches {
  readonly sessionId: string | null
  readonly path: string
  readonly calls: readonly RolloutPatchCall[]
  /** Every op across every call, flattened in order. The convenient form for a scan. */
  readonly files: readonly PatchFileOp[]
  /** Calls whose body contained patch markers but produced no file op. */
  readonly unparsedCalls: number
}

/* -------------------------------------------------------------------------- */
/* Signatures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The signature forms worth recognising, one per language family the pool contains.
 *
 * Deliberately a list of regexes rather than a parser per language: the question is "did
 * a callable's name move", and a regex answers it on any file the pool actually holds
 * without pretending to understand the language.
 */
const SIGNATURE_PATTERNS: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
  { kind: 'def', pattern: /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  { kind: 'class', pattern: /^class\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  { kind: 'function', pattern: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: 'func', pattern: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/ },
  { kind: 'fn', pattern: /^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  { kind: 'interface', pattern: /^(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: 'type', pattern: /^(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  // A JS/TS binding that looks like a callable.
  { kind: 'const', pattern: /^(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/ },
]

/** `def foo`, `function bar`, `class Baz` — or null when the line declares nothing. */
export function signatureOf(rawLine: string): string | null {
  const line = rawLine.trim()
  if (line.length === 0) return null
  for (const { kind, pattern } of SIGNATURE_PATTERNS) {
    const match = pattern.exec(line)
    if (match?.[1]) return `${kind} ${match[1]}`
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                      */
/* -------------------------------------------------------------------------- */

const BEGIN_PATCH = '*** Begin Patch'
const END_PATCH = '*** End Patch'
const ADD_FILE = '*** Add File: '
const UPDATE_FILE = '*** Update File: '
const DELETE_FILE = '*** Delete File: '
const MOVE_TO = '*** Move to: '

/** A patch, and how it was written. */
export interface LocatedPatch {
  readonly body: string
  readonly source: 'body' | 'embedded'
}

/**
 * Find the patch a tool call carries, whether it *is* the call or is built by it.
 *
 * Session B in the real pool writes `const patch = "*** Begin Patch\n..."` inside a
 * script and then runs it, so the patch is a JavaScript string literal. Reading only the
 * literal-as-call shape would have thrown away every one of those edits, and the case
 * would have looked like a session that touched a file without ever writing it.
 *
 * Returns null when the text merely mentions the marker (prose, a diff quoted in an
 * error message), because a false positive here becomes a file op the session never made.
 */
export function locatePatch(source: string): LocatedPatch | null {
  const trimmed = source.trimStart()
  if (trimmed.startsWith(BEGIN_PATCH)) return { body: trimmed, source: 'body' }
  const embedded = extractEmbeddedPatch(source)
  return embedded ? { body: embedded, source: 'embedded' } : null
}

/** The string literal that contains the marker, unescaped — or null. */
export function extractEmbeddedPatch(source: string): string | null {
  const at = source.indexOf(BEGIN_PATCH)
  if (at < 0) return null

  /*
   * A character scan rather than a regex, because a regex cannot know whether a quote
   * opens a literal or sits inside one. Only being *inside* a literal counts: a bare
   * marker in a comment or a message is not a patch anybody ran.
   */
  let quote: string | null = null
  let stringStart = -1
  let escaped = false
  for (let index = 0; index < at; index += 1) {
    const char = source[index]
    if (quote === null) {
      if (char === '"' || char === "'" || char === '`') {
        quote = char
        stringStart = index
        escaped = false
      }
    } else if (escaped) {
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else if (char === quote) {
      quote = null
      stringStart = -1
    }
  }
  if (quote === null || stringStart < 0) return null

  let end = -1
  escaped = false
  for (let index = at; index < source.length; index += 1) {
    const char = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === quote) {
      end = index
      break
    }
  }
  if (end < 0) return null

  const literal = source.slice(stringStart + 1, end)
  const body = unescapeStringLiteral(literal)
  return body.includes(BEGIN_PATCH) ? body : null
}

/** Undo the escapes a JavaScript string literal uses. Unknown escapes keep their character. */
export function unescapeStringLiteral(literal: string): string {
  let out = ''
  for (let index = 0; index < literal.length; index += 1) {
    const char = literal[index]!
    if (char !== '\\') {
      out += char
      continue
    }
    index += 1
    const next = literal[index]
    if (next === undefined) break
    switch (next) {
      case 'n': out += '\n'; break
      case 'r': out += '\r'; break
      case 't': out += '\t'; break
      case 'b': out += '\b'; break
      case 'f': out += '\f'; break
      case 'v': out += '\v'; break
      case '0': out += '\0'; break
      case '\n': break
      case 'x': {
        out += String.fromCharCode(Number.parseInt(literal.slice(index + 1, index + 3), 16) || 0)
        index += 2
        break
      }
      case 'u': {
        if (literal[index + 1] === '{') {
          const close = literal.indexOf('}', index + 2)
          const hex = close < 0 ? '' : literal.slice(index + 2, close)
          out += String.fromCodePoint(Number.parseInt(hex, 16) || 0)
          index = close < 0 ? index : close
        } else {
          out += String.fromCharCode(Number.parseInt(literal.slice(index + 1, index + 5), 16) || 0)
          index += 4
        }
        break
      }
      default:
        // `\\`, `\"`, `\'`, `` \` ``, `\/`, `\$` and anything else: the character itself.
        out += next
    }
  }
  return out
}

interface MutableOp {
  kind: 'add' | 'update' | 'delete'
  path: string
  moveTo: string | null
  hunks: PatchHunk[]
}

/**
 * Parse one `apply_patch` body into file ops.
 *
 * Tolerant by construction: a body that stops mid-hunk yields the ops it did parse. The
 * caller is expected to treat an empty result as "nothing legible here" and to report it,
 * because a silently empty parse is how a study ends up with a denominator that shrank
 * without anyone noticing.
 */
export function parsePatchBody(body: string): PatchFileOp[] {
  const ops: PatchFileOp[] = []

  let current: MutableOp | null = null
  let hunkHeader: string | null = null
  let old: string[] = []
  let next: string[] = []
  let context: string[] = []
  let removed: string[] = []
  let added: string[] = []

  const flushHunk = (): void => {
    if (!current) return
    if (old.length === 0 && next.length === 0) return
    current.hunks.push({ header: hunkHeader, old, next, context, removed, added })
    hunkHeader = null
    old = []
    next = []
    context = []
    removed = []
    added = []
  }

  const flushOp = (): void => {
    flushHunk()
    if (!current) return
    const hunks = current.hunks
    const addedLines = hunks.reduce((total, hunk) => total + hunk.added.length, 0)
    const removedLines = hunks.reduce((total, hunk) => total + hunk.removed.length, 0)
    ops.push({
      kind: current.kind,
      path: current.path,
      moveTo: current.moveTo,
      hunks,
      addedLines,
      removedLines,
      addedSignatures: collectSignatures(hunks.flatMap((hunk) => hunk.added)),
      removedSignatures: collectSignatures(hunks.flatMap((hunk) => hunk.removed)),
      addedIdentifiers: uniqueIdentifiers(hunks.flatMap((hunk) => hunk.added)),
      removedIdentifiers: uniqueIdentifiers(hunks.flatMap((hunk) => hunk.removed)),
    })
    current = null
  }

  for (const line of body.split('\n')) {
    // A Windows checkout writes CRLF into the patch body; left in place it would make
    // every context line fail to match its own file.
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line

    if (clean.startsWith(BEGIN_PATCH)) continue
    if (clean.startsWith(END_PATCH)) {
      flushOp()
      break
    }
    if (clean.startsWith(ADD_FILE) || clean.startsWith(UPDATE_FILE) || clean.startsWith(DELETE_FILE)) {
      flushOp()
      const kind = clean.startsWith(ADD_FILE) ? 'add' : clean.startsWith(UPDATE_FILE) ? 'update' : 'delete'
      const prefix = kind === 'add' ? ADD_FILE : kind === 'update' ? UPDATE_FILE : DELETE_FILE
      current = { kind, path: clean.slice(prefix.length).trim(), moveTo: null, hunks: [] }
      continue
    }
    if (clean.startsWith(MOVE_TO)) {
      if (current) current.moveTo = clean.slice(MOVE_TO.length).trim()
      continue
    }
    if (clean.startsWith('@@')) {
      flushHunk()
      hunkHeader = clean.slice(2).trim() || null
      continue
    }
    if (!current) continue

    // The `+`/`-`/space prefix is the patch's own encoding, so it is stripped here and
    // nowhere else. Anything else (`*** End of File`, prose) is not a hunk line.
    if (clean.startsWith('+')) {
      const value = clean.slice(1)
      added.push(value)
      next.push(value)
    } else if (clean.startsWith('-')) {
      const value = clean.slice(1)
      removed.push(value)
      old.push(value)
    } else if (clean.startsWith(' ')) {
      const value = clean.slice(1)
      context.push(value)
      old.push(value)
      next.push(value)
    }
  }
  flushOp()

  return ops
}

function collectSignatures(lines: readonly string[]): string[] {
  const out = new Set<string>()
  for (const line of lines) {
    const signature = signatureOf(line)
    if (signature) out.add(signature)
  }
  return [...out].sort()
}

function uniqueIdentifiers(lines: readonly string[]): string[] {
  const out = new Set<string>()
  for (const line of lines) {
    for (const identifier of extractIdentifiers(line)) out.add(identifier)
  }
  return [...out].sort()
}

/** The patch calls in one rollout's text, in file order. */
export function parsePatchRecords(text: string, path = '<memory>'): RolloutPatches {
  const calls: RolloutPatchCall[] = []
  const files: PatchFileOp[] = []
  let sessionId: string | null = null
  let unparsedCalls = 0

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const type = typeof record.type === 'string' ? record.type : null
    const payload = record.payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue
    const body = payload as Record<string, unknown>

    if (type === 'session_meta') {
      const id = body.session_id ?? body.id
      if (typeof id === 'string' && id.length > 0) sessionId = id
      continue
    }
    if (type !== 'response_item' || body.type !== 'custom_tool_call') continue

    /*
     * `input` is the patch. Some builds wrap it under `arguments` instead, so both are
     * read rather than assuming one: a rollout that keeps working after a format change
     * is the entire reason this parser is defensive.
     *
     * The body must *start* with the marker, or the patch must be a string literal inside
     * a script the call runs. Checking only for containment counted 1,471 extra "calls" in
     * one workspace, every one of them a script that happened to embed a patch literal,
     * whose lines then parsed into file ops belonging to no real edit. Demanding that the
     * literal actually be a literal is what separates those two cases.
     */
    const raw = body.input ?? body.arguments
    if (typeof raw !== 'string') continue
    const located = locatePatch(raw)
    if (!located) continue
    const ops = parsePatchBody(located.body)
    if (ops.length === 0) {
      unparsedCalls += 1
      continue
    }
    const at = typeof record.timestamp === 'string' ? record.timestamp : new Date(0).toISOString()
    const callId = typeof body.call_id === 'string' ? body.call_id : null
    calls.push({ at, callId, source: located.source, files: ops })
    for (const op of ops) files.push(op)
  }

  return { sessionId, path, calls, files, unparsedCalls }
}

/** Read and parse one rollout file. Unreadable files yield an empty result, never a throw. */
export function rolloutPatches(file: string): RolloutPatches {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { sessionId: null, path: file, calls: [], files: [], unparsedCalls: 0 }
  }
  return parsePatchRecords(text, file)
}

/* -------------------------------------------------------------------------- */
/* Applying                                                                     */
/* -------------------------------------------------------------------------- */

export interface ApplyFileResult {
  readonly ok: boolean
  readonly lines: readonly string[]
  /** Why it failed, in the report's words. Empty when it succeeded. */
  readonly reason: string
  /** Hunk index that could not be located, when the failure was a locate failure. */
  readonly failedHunk: number | null
}

/**
 * Apply one file's ops to a base revision, returning the new lines.
 *
 * A real applier rather than a diff-sized guess, because the demo's whole honesty claim is
 * that the two branches contain what the two sessions actually wrote. A patch that cannot
 * be applied is reported as a failure and the candidate is dropped; it is never
 * approximated, because an approximate reconstruction would make the clean merge a
 * property of the approximation rather than of the work.
 *
 * Locating is deliberately three-tiered, mirroring what the host itself does:
 *
 * 1. exact, searching forward from where the previous hunk ended so a repeated block
 *    resolves to the place the original tool meant;
 * 2. trailing-whitespace-insensitive, because a CRLF checkout differs only there;
 * 3. trim-insensitive, for indentation the patch normalised.
 *
 * Only the *location* is fuzzy. The replacement is always the patch's own bytes.
 */
export function applyFileOps(base: string, ops: readonly PatchFileOp[]): ApplyFileResult {
  let lines = base.length === 0 ? [] : base.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines = lines.slice(0, -1)

  for (const op of ops) {
    if (op.kind === 'delete') {
      lines = []
      continue
    }
    if (op.kind === 'add') {
      // An Add File against a file that already has content is a conflict the patch format
      // does not define, so it fails instead of being reinterpreted as an append.
      if (lines.length > 0) {
        return { ok: false, lines, reason: `Add File on a file that already has content: ${op.path}`, failedHunk: null }
      }
      lines = op.hunks.flatMap((hunk) => hunk.next)
      continue
    }

    let cursor = 0
    for (const [index, hunk] of op.hunks.entries()) {
      if (hunk.old.length === 0) {
        // A pure insertion with no quoted region cannot be located. Appending is the only
        // reading that is not a guess, and it is a real interpretation of "add these
        // lines" rather than an invention.
        lines = [...lines, ...hunk.next]
        cursor = lines.length
        continue
      }
      const found = locate(lines, hunk.old, cursor)
      if (!found) {
        return {
          ok: false,
          lines,
          reason: `hunk ${index + 1} of ${op.path} does not match the base revision`,
          failedHunk: index,
        }
      }
      lines = [...lines.slice(0, found.start), ...hunk.next, ...lines.slice(found.start + found.length)]
      cursor = found.start + hunk.next.length
    }
  }

  return { ok: true, lines, reason: '', failedHunk: null }
}

/**
 * Remove a change from a revision that already contains it.
 *
 * This exists because of what the repository the demo draws from actually looks like. Both
 * sessions wrote against a *working tree*, not against commits — the developer committed in
 * batches hours or days later — so no commit accepts either patch as a base, and the demo
 * cannot be built by adding each patch to a shared revision. What the batch commit does
 * contain is the *result*.
 *
 * So the one-sided versions are recovered the other way round: take the revision that holds
 * both changes, and remove the *other* session's change from it. Each side's file is then
 * the landed file minus the other side's edits, which is what that session's own version
 * looked like to everyone else.
 *
 * The applier is the same one, and only which side of each hunk it searches for changes.
 * The replacement written back is still the patch's own bytes, and an unlocatable hunk is
 * still a failure rather than a nudge — so a reconstruction that comes out clean does so
 * because the two edits are disjoint, not because the removal landed somewhere convenient.
 */
export function reverseFileOps(base: string, ops: readonly PatchFileOp[]): ApplyFileResult {
  return applyFileOps(base, ops.map(reverseOp))
}

/** One op with its two sides swapped, including the kind and every count derived from it. */
export function reverseOp(op: PatchFileOp): PatchFileOp {
  return {
    ...op,
    // Removing an added file deletes it, and removing a deleted file puts it back. A kind
    // left alone would make `applyFileOps` reject the reversal of an `Add File`, which is a
    // real shape here: one of the two sessions adds files.
    kind: op.kind === 'add' ? 'delete' : op.kind === 'delete' ? 'add' : 'update',
    hunks: op.hunks.map((hunk) => ({
      ...hunk,
      old: hunk.next,
      next: hunk.old,
      removed: hunk.added,
      added: hunk.removed,
    })),
    addedLines: op.removedLines,
    removedLines: op.addedLines,
    addedSignatures: op.removedSignatures,
    removedSignatures: op.addedSignatures,
    addedIdentifiers: op.removedIdentifiers,
    removedIdentifiers: op.addedIdentifiers,
  }
}

function locate(
  lines: readonly string[],
  block: readonly string[],
  from: number,
): { start: number; length: number } | null {
  const passes: readonly ((line: string) => string)[] = [
    (line) => line,
    (line) => line.replace(/\s+$/, ''),
    (line) => line.trim(),
  ]
  for (const normalize of passes) {
    const wanted = block.map(normalize)
    // Forward from the cursor first, so the second of two identical blocks lands after the
    // first rather than on top of it. Then the whole file, for a hunk that moved backwards.
    for (const begin of from > 0 ? [from, 0] : [0]) {
      for (let start = begin; start + wanted.length <= lines.length; start += 1) {
        let hit = true
        for (let offset = 0; offset < wanted.length; offset += 1) {
          if (normalize(lines[start + offset] ?? '') !== wanted[offset]) {
            hit = false
            break
          }
        }
        if (hit) return { start, length: wanted.length }
      }
    }
  }
  return null
}

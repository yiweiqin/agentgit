/** Bounded rename-insensitive source evidence. This raises a question, never a merge decision. */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { isWithinRoot } from './paths.ts'
import type { Capsule } from './types.ts'

const words = new Set('export default async await function return const let var if else for while do switch case break continue throw try catch finally new class extends import from as typeof instanceof void null undefined true false this super number string boolean interface type public private protected static readonly'.split(' '))

/** Keep operators, literals, API member names and identifier relationships; ignore spelling. */
export function codeFingerprint(source: string): string | null {
  // Templates and regex literals require a parser to normalize safely; abstain for now.
  if (source.includes('`')) return null
  const tokens = source.match(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*|(?:\d+(?:\.\d+)?)|===|!==|=>|==|!=|<=|>=|\+\+|--|&&|\|\||\?\?|\?\.|[^\s]/g) ?? []
  const clean = tokens.filter(token => !token.startsWith('//') && !token.startsWith('/*'))
  if (clean.includes('/')) return null
  if (clean.length < 40 || clean.length > 20000) return null
  const names = new Map<string, number>()
  const normalized = clean.map((token, index) => {
    if (!/^[A-Za-z_$][\w$]*$/.test(token) || words.has(token) || ['.', '?.'].includes(clean[index - 1]) ||
      (clean[index + 1] === ':' && !words.has(clean[index + 2]))) return token
    if (!names.has(token)) names.set(token, names.size)
    return `identifier:${names.get(token)}`
  })
  if (names.size < 3) return null
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

export interface CodeDuplicate {
  tasks: [string, string]
  sessions: [string[], string[]]
  paths: [string, string]
  fingerprint: string
}

/** Only recent open tasks and files they recorded; never traverse an entire repository. */
export function findCodeDuplicates(root: string, capsules: Map<string, Capsule>, now: Date): CodeDuplicate[] {
  const groups = new Map<string, { task: string; sessions: string[]; path: string }[]>()
  let budget = 2_000_000
  const active = [...capsules.values()].filter(c => ['proposed', 'active', 'validated'].includes(c.state) &&
    c.lastEventAtUtc && now.getTime() - Date.parse(c.lastEventAtUtc) < 60 * 60_000).sort((a, b) => a.taskId.localeCompare(b.taskId)).slice(0, 60)
  const seen = new Map<string, string | null>()
  for (const capsule of active) {
    const files = [...new Set([...capsule.entities.values()].map(e => e.path))].sort().slice(0, 8)
    for (const path of files) {
      const absolute = resolve(root, path)
      if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extname(path)) || !isWithinRoot(root, absolute)) continue
      let fingerprint = seen.get(absolute)
      if (fingerprint === undefined) {
        try {
          const stat = statSync(absolute)
          if (!stat.isFile() || stat.size > 128_000 || stat.size > budget) continue
          budget -= stat.size
          fingerprint = codeFingerprint(readFileSync(absolute, 'utf8'))
          seen.set(absolute, fingerprint)
        } catch { continue }
      }
      if (!fingerprint) continue
      const entries = groups.get(fingerprint) ?? []
      entries.push({ task: capsule.taskId, sessions: [...capsule.sessions].sort(), path })
      groups.set(fingerprint, entries)
    }
  }
  const result: CodeDuplicate[] = []
  for (const [fingerprint, entries] of groups) {
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j]
      if (a.task === b.task || resolve(root, a.path) === resolve(root, b.path)) continue
      result.push({ tasks: [a.task, b.task], sessions: [a.sessions, b.sessions], paths: [a.path, b.path], fingerprint })
      if (result.length === 5) return result
    }
  }
  return result
}

// Prints the exact codepoints of the panel content-reference marker in the skill file.
// The marker is surrounded by private-use characters, so it cannot be read by eye and
// cannot be typed reliably into source: this is how the generator gets the real bytes.
import { readFileSync } from 'node:fs'

const file = process.argv[2] ?? 'plugins/agentgit/skills/agentgit/SKILL.md'
const text = readFileSync(file, 'utf8')
const line = text.split(/\r?\n/).find((candidate) => candidate.includes('"path"'))

if (!line) {
  console.error('no reference line found')
  process.exit(1)
}

console.log('line json :', JSON.stringify(line))
console.log('codepoints:', [...line].slice(0, 12).map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase()}`).join(' '))
console.log('char codes:', [...line].slice(0, 4).map((c) => c.codePointAt(0).toString(10)).join(' '))

const start = line.indexOf('\uE200')
const end = line.indexOf('\uE201')
if (start >= 0 && end > start) {
  const inner = line.slice(start + 1, end)
  console.log('kind token:', JSON.stringify(inner.slice(0, inner.indexOf('\uE202'))))
  console.log('payload   :', JSON.stringify(inner.slice(inner.indexOf('\uE202') + 1)))
  console.log('escape    :', JSON.stringify(line.slice(start, end + 1)).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`))
}

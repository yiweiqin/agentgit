#!/usr/bin/env node
/**
 * Strip UTF-8 BOMs and normalise line endings across the repository.
 *
 * Why this exists as a script rather than a rule people remember
 *
 * A BOM is invisible and it breaks three things silently:
 *
 * - `json.loads` in the plugin validator fails, so a plugin that looks perfectly
 *   correct is rejected with "must be valid JSON".
 * - `contents.startswith("---")` in the same validator fails, so skill frontmatter
 *   that is present is treated as missing.
 * - Codex reads `.mcp.json` and `hooks.json` as JSON. A BOM there means the server
 *   never starts and no hook ever fires, with nothing on screen to say why.
 *
 * Windows editors add one by default, so "remember not to" is not a control. This
 * script is idempotent and `npm run lint:encoding` runs it in check mode, which is
 * what makes the property enforced rather than hoped for.
 *
 * Usage:
 *   node scripts/strip-bom.mjs           # rewrite files that need it
 *   node scripts/strip-bom.mjs --check   # exit 1 if anything would change
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const BOM = '\uFEFF'
const CHECK = process.argv.includes('--check')
const ROOT = resolve(process.argv.find((arg) => arg.startsWith('--root='))?.slice('--root='.length) ?? '.')

/** Text formats this repository owns. Binary assets are never touched. */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.md', '.py', '.css', '.html', '.sh', '.cmd', '.txt',
  // `.template` matters more than the rest of this list put together: the two files
  // with it are the hooks and MCP config Codex reads as JSON, and a BOM in either one
  // means no hook fires and no tool appears, with nothing on screen to explain it.
  // Both were skipped by the first version of this script, which is exactly how the
  // BOM in them survived a cleanup that was supposed to have covered the repository.
  '.template', '.toml', '.yml', '.yaml',
])

/** Extensionless files that are still text, checked by exact name. */
const TEXT_NAMES = new Set(['.gitignore', '.gitattributes', '.editorconfig', '.npmrc'])

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'worktrees', 'playground'])

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      walk(join(dir, entry.name), out)
      continue
    }
    if (!entry.isFile()) continue
    if (TEXT_NAMES.has(entry.name)) {
      out.push(join(dir, entry.name))
      continue
    }
    const dot = entry.name.lastIndexOf('.')
    if (dot < 0) continue
    if (!TEXT_EXTENSIONS.has(entry.name.slice(dot).toLowerCase())) continue
    out.push(join(dir, entry.name))
  }
  return out
}

const offenders = []
let fixed = 0

for (const file of walk(ROOT)) {
  let bytes
  try {
    bytes = readFileSync(file)
  } catch {
    continue
  }
  // Only these five bytes can begin a UTF-8 BOM, so the check is two comparisons.
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  if (!hasBom) continue

  const label = relative(ROOT, file)
  offenders.push(label)
  if (CHECK) continue

  const text = bytes.subarray(3).toString('utf8')
  // Line endings are normalised in the same pass because a checkout that mixes
  // CRLF and LF makes a committed ledger diff on every line.
  writeFileSync(file, text.replace(/\r\n/g, '\n'), { encoding: 'utf8' })
  fixed += 1
}

if (CHECK) {
  if (offenders.length > 0) {
    process.stderr.write(`encoding: ${offenders.length} file(s) start with a UTF-8 BOM:\n`)
    for (const name of offenders) process.stderr.write(`  ${name}\n`)
    process.stderr.write('Run `node scripts/strip-bom.mjs` to fix.\n')
    process.exit(1)
  }
  process.stdout.write('encoding: clean\n')
} else {
  process.stdout.write(`encoding: rewrote ${fixed} file(s)${fixed === 0 ? ' (already clean)' : ''}\n`)
}

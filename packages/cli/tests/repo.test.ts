/**
 * Checks about the repository itself, rather than about any one package.
 *
 * Both of these guard failures that cost hours and leave no trace in a test run that
 * only exercises behaviour.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dirname, '..', '..', '..')

const SKIP = new Set(['node_modules', '.git', 'worktrees', 'playground', '.agentgit'])
const TEXT_EXTENSIONS = new Set([
  '.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.md', '.py', '.css', '.html', '.sh', '.cmd', '.txt',
  '.template', '.toml', '.yml', '.yaml',
])
const TEXT_NAMES = new Set(['.gitignore', '.gitattributes', '.editorconfig', '.npmrc'])

function textFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue
      textFiles(join(dir, entry.name), out)
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
  // Deterministic order, so a failure names the same file every run.
  return out.sort()
}

function relative(file: string): string {
  return file.slice(REPO.length + 1).replace(/\\/g, '/')
}

describe('file encoding', () => {
  test('no text file starts with a UTF-8 BOM', () => {
    // A BOM is invisible in an editor and fatal to three separate parsers: the plugin
    // validator, `JSON.parse` on `hooks.json`, and `JSON.parse` on `.mcp.json`. Windows
    // editors add one by default, so this cannot be left to discipline. It has already
    // shipped twice: once in the plugin manifest, and once in the two `.template` files
    // that a previous cleanup pass skipped because of their extension.
    const offenders: string[] = []
    for (const file of textFiles(REPO)) {
      const bytes = readFileSync(file)
      if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        offenders.push(relative(file))
      }
    }
    assert.deepEqual(offenders, [], 'run `node scripts/strip-bom.mjs`')
  })

  test('no text file has CRLF line endings', () => {
    const offenders: string[] = []
    for (const file of textFiles(REPO)) {
      if (readFileSync(file, 'utf8').includes('\r\n')) offenders.push(relative(file))
    }
    assert.deepEqual(offenders, [], 'run `node scripts/strip-bom.mjs`')
  })
})

describe('the plugin manifest', () => {
  test('declares only keys the validator accepts, and is strict semver', () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO, 'plugins', 'agentgit', '.codex-plugin', 'plugin.json'), 'utf8'),
    ) as Record<string, unknown>
    const allowed = new Set([
      'id', 'name', 'version', 'description', 'skills', 'apps', 'mcpServers', 'interface', 'author', 'homepage',
      'repository', 'license', 'keywords',
    ])

    for (const key of Object.keys(manifest)) {
      assert.ok(allowed.has(key), `plugin.json key '${key}' is rejected by validate_plugin.py, which fails the install`)
    }
    assert.ok(!('hooks' in manifest), 'hooks are discovered from hooks.json, not declared here')
    assert.equal(typeof manifest.author, 'object')

    // The committed manifest may or may not carry a cachebuster: installing from a
    // checkout stamps the file, because the installed plugin *is* the checkout. What
    // must hold in both states is that the base version is strict semver and that the
    // suffix never stacks — a version drifting to `+codex.a+codex.b` reads as a typo in
    // the user's config, and one that stops changing silently disables the cachebuster.
    const version = String(manifest.version)
    assert.match(version, /^\d+\.\d+\.\d+(\+codex\.[A-Za-z0-9.-]+)?$/)
    assert.equal(version.split('+').length, version.includes('+') ? 2 : 1, 'the cachebuster is replaced, never appended')

    const iface = manifest.interface as Record<string, unknown>
    for (const key of [
      'displayName',
      'shortDescription',
      'longDescription',
      'developerName',
      'category',
      'capabilities',
      'defaultPrompt',
    ]) {
      assert.ok(iface?.[key] !== undefined, `interface.${key} is required by the validator`)
    }
  })

  test('does not ship a generated hooks.json or .mcp.json', () => {
    // Both name this machine's absolute paths. They are gitignored, so a tracked copy
    // would be overwritten on every install, and the repository would carry one
    // developer's directory layout to everyone else.
    const gitignore = readFileSync(join(REPO, '.gitignore'), 'utf8')
    assert.match(gitignore, /^plugins\/agentgit\/hooks\.json$/m)
    assert.match(gitignore, /^plugins\/agentgit\/\.mcp\.json$/m)
  })
})

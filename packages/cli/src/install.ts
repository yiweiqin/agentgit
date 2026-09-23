/**
 * Install AgenticGit as a Codex plugin, and undo it.
 *
 * There is no `codex` binary on PATH on a stock Windows install, so this command
 * cannot delegate. It therefore has to do the four things the plugin-creator
 * helpers do, and it does them in the order that fails safely:
 *
 * 1. **Place the plugin.** A directory junction (Windows) or symlink (POSIX) from
 *    `~/plugins/agentgit` to this checkout, so the marketplace entry resolves and
 *    edits to the checkout are live. Falls back to a copy when links are not
 *    permitted, and says so, because a silent copy turns "my fix did nothing" into
 *    a debugging session.
 * 2. **Generate the two machine-specific config files.** `hooks.json` and
 *    `.mcp.json` need absolute paths: Codex does no command substitution, does not
 *    resolve a POSIX relative path on Windows, and loads plugins from a cache
 *    directory whose location is chosen at install time. Both files are gitignored
 *    and both are regenerated on every install.
 * 3. **Write the marketplace entry.** The personal marketplace lives at
 *    `~/.agents/plugins/marketplace.json` and its `./plugins/<name>` path is
 *    relative to `~/.agents/plugins/`, which is why step 1 targets `~/plugins/`.
 * 4. **Bump the cachebuster.** Codex caches a plugin by its version, so an edit
 *    with an unchanged version is invisible. The token is replaced, never appended.
 *
 * Nothing here edits `config.toml`. Enabling a plugin there is a user preference,
 * and a tool that rewrites the user's editor config during an install is a tool
 * people stop running.
 *
 * @module @agentgit/cli/install
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { DoctorCheck } from './output.ts'

/** `<repo>/plugins/agentgit`, located from this file rather than from the cwd. */
export function pluginSourceDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // packages/cli/src -> packages/cli -> packages -> repo
  return resolve(here, '..', '..', '..', 'plugins', 'agentgit')
}

export function repoRootDir(): string {
  return resolve(pluginSourceDir(), '..', '..')
}

export interface InstallPaths {
  readonly repo: string
  readonly source: string
  readonly home: string
  readonly pluginsRoot: string
  readonly target: string
  readonly marketplace: string
  readonly marketplaceName: string
}

/** Resolve every path the install touches, honouring `AGENTGIT_HOME` for tests. */
export function installPaths(overrides: { home?: string; marketplaceName?: string } = {}): InstallPaths {
  const home = overrides.home ?? homedir()
  const source = pluginSourceDir()
  return {
    repo: repoRootDir(),
    source,
    home,
    pluginsRoot: join(home, 'plugins'),
    target: join(home, 'plugins', 'agentgit'),
    marketplace: join(home, '.agents', 'plugins', 'marketplace.json'),
    marketplaceName: overrides.marketplaceName ?? 'personal',
  }
}

/**
 * Node's TypeScript support changed defaults at major 23.
 *
 * Below 23 the flag is required and the MCP server never starts without it, which
 * would look like "the plugin installed but has no tools". Reading the running
 * version rather than a constant means the same file works on both.
 */
export function nodeFlags(): string[] {
  const major = Number(process.versions.node.split('.')[0])
  return Number.isFinite(major) && major >= 23 ? [] : ['--experimental-strip-types']
}

export interface LinkResult {
  readonly kind: 'junction' | 'symlink' | 'copy' | 'existing-link' | 'existing-dir'
  readonly detail: string
}

/** Point `~/plugins/agentgit` at the checkout, without ever deleting real work. */
export function linkPlugin(paths: InstallPaths, options: { copy?: boolean } = {}): LinkResult {
  mkdirSync(paths.pluginsRoot, { recursive: true })

  if (existsSync(paths.target)) {
    let stat
    try {
      stat = lstatSync(paths.target)
    } catch {
      stat = null
    }
    if (stat?.isSymbolicLink()) {
      const current = safeReadlink(paths.target)
      if (current && resolve(current) === resolve(paths.source)) {
        return { kind: 'existing-link', detail: `already linked to ${paths.source}` }
      }
      // A link to somewhere else is not ours to delete silently, but leaving it
      // would install nothing while reporting success.
      rmSync(paths.target, { force: true })
    } else if (stat?.isDirectory()) {
      if (!options.copy) {
        throw new Error(
          `${paths.target} is a real directory, not a link. Move it aside, or run with --copy to replace it ` +
            'with a copy of this checkout.',
        )
      }
      rmSync(paths.target, { recursive: true, force: true })
    } else {
      rmSync(paths.target, { force: true })
    }
  }

  if (options.copy) {
    cpSync(paths.source, paths.target, { recursive: true })
    return { kind: 'copy', detail: `copied to ${paths.target} (re-run install after every edit)` }
  }

  const onWindows = process.platform === 'win32'
  try {
    symlinkSync(paths.source, paths.target, onWindows ? 'junction' : 'dir')
    return {
      kind: onWindows ? 'junction' : 'symlink',
      detail: `${paths.target} -> ${paths.source}`,
    }
  } catch (error) {
    cpSync(paths.source, paths.target, { recursive: true })
    return {
      kind: 'copy',
      detail:
        `links are not permitted here (${(error as Error).message}), so the plugin was copied. ` +
        'Re-run install after editing this checkout.',
    }
  }
}

function safeReadlink(path: string): string | null {
  try {
    return readlinkSync(path)
  } catch {
    return null
  }
}

/**
 * Substitute placeholders into a JSON template.
 *
 * Values are JSON-escaped by default, and that default is load-bearing on Windows: a
 * placeholder substituted raw into a quoted string turns `C:\Users\...` into `\U`,
 * which is an invalid escape and makes the whole file unreadable. The first version of
 * this shipped exactly that bug, and the symptom was a hook file that no parser would
 * open and a plugin that silently recorded nothing.
 *
 * A name listed in `raw` is inserted verbatim, for placeholders that stand for JSON
 * fragments rather than string contents - an argument list, for instance.
 */
function renderTemplate(
  template: string,
  values: Record<string, string>,
  raw: readonly string[] = [],
): string {
  let out = template
  for (const [key, value] of Object.entries(values)) {
    const replacement = raw.includes(key) ? value : escapeForJsonString(value)
    out = out.split(`{{${key}}}`).join(replacement)
  }
  return out
}

/** The body of a JSON string literal, without the surrounding quotes. */
function escapeForJsonString(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

/**
 * Read a template as text a JSON parser will accept.
 *
 * A byte-order mark is invisible and fatal: `JSON.parse` rejects it, and the resulting
 * error names a character the user cannot see in their editor. Templates in this
 * repository have been written with a BOM more than once by Windows tooling, and the
 * generated file inherits whatever the template had, so the strip happens here as well
 * as in `scripts/strip-bom.mjs`. Line endings are normalised for the same reason: a
 * diff of a generated file should show the replaced paths and nothing else.
 */
function readTemplate(file: string): string {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

export interface GeneratedFiles {
  readonly hooks: string
  readonly mcp: string
  readonly node: string
  readonly flags: readonly string[]
}

/**
 * Write `hooks.json` and `.mcp.json` with this machine's absolute paths.
 *
 * `process.execPath` is used instead of the string `node` because the hook needs to
 * run under a Node new enough to strip TypeScript types, and `node` on PATH may well
 * be an older one on a machine with several installed.
 */
export function writeGeneratedFiles(paths: InstallPaths, target = paths.target): GeneratedFiles {
  const node = process.execPath
  const flags = nodeFlags()
  const track = join(target, 'scripts', 'track.mjs')
  const mcp = join(paths.repo, 'packages', 'mcp', 'src', 'main.ts')

  const hooksTemplate = readTemplate(join(target, 'hooks.json.template'))
  const mcpTemplate = readTemplate(join(target, 'mcp.json.template'))

  const hooks = renderTemplate(hooksTemplate, { NODE: node, TRACK: track })
  const mcpFile = renderTemplate(
    mcpTemplate,
    {
      NODE: node,
      NODE_FLAGS: flags.length > 0 ? `${flags.map((flag) => `"${flag}"`).join(', ')}, ` : '',
      MCP: mcp,
      REPO: paths.repo,
    },
    // The flag list is spliced into an array, not into a string, so escaping it would
    // turn `["--experimental-strip-types"]` into a quoted literal and break the server.
    ['NODE_FLAGS'],
  )

  writeFileSync(join(target, 'hooks.json'), `${hooks.trimEnd()}\n`, 'utf8')
  writeFileSync(join(target, '.mcp.json'), `${mcpFile.trimEnd()}\n`, 'utf8')
  return { hooks: join(target, 'hooks.json'), mcp: join(target, '.mcp.json'), node, flags }
}

interface MarketplaceEntry {
  name: string
  source: { source: string; path: string }
  policy: { installation: string; authentication: string }
  category: string
}

interface Marketplace {
  name: string
  interface?: { displayName?: string }
  plugins: MarketplaceEntry[]
}

export function buildMarketplaceEntry(): MarketplaceEntry {
  return {
    name: 'agentgit',
    source: { source: 'local', path: './plugins/agentgit' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Developer Tools',
  }
}

/**
 * Add or refresh the marketplace entry, preserving every other entry.
 *
 * An existing marketplace keeps its own name: it may already be referenced from
 * `config.toml`, and a rename would orphan that reference.
 */
export function upsertMarketplace(paths: InstallPaths): { file: string; name: string; created: boolean } {
  const created = !existsSync(paths.marketplace)
  let payload: Marketplace

  if (created) {
    payload = {
      name: paths.marketplaceName,
      interface: { displayName: 'Personal' },
      plugins: [],
    }
  } else {
    payload = JSON.parse(readTemplate(paths.marketplace)) as Marketplace
    if (typeof payload.name !== 'string' || payload.name.trim() === '') {
      throw new Error(`${paths.marketplace} has no marketplace name; refusing to guess one for a file this command did not create`)
    }
    if (!Array.isArray(payload.plugins)) payload.plugins = []
  }

  const entry = buildMarketplaceEntry()
  const index = payload.plugins.findIndex((existing) => existing?.name === 'agentgit')
  if (index >= 0) payload.plugins[index] = entry
  else payload.plugins.push(entry)

  mkdirSync(dirname(paths.marketplace), { recursive: true })
  writeFileSync(paths.marketplace, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return { file: paths.marketplace, name: payload.name, created }
}

/**
 * Replace the cachebuster suffix, never append one.
 *
 * The base version is everything before `+`, so repeated installs cannot stack
 * `+codex.a+codex.b` and push the semver further from anything a human wrote.
 *
 * The stamp is built digit by digit rather than sliced out of an ISO string. Slicing
 * an ISO instant at a fixed width leaves punctuation behind - the first version of this
 * produced `0.1.0+codex.local-20260923064735.`, with a trailing dot that no semver
 * parser accepts and that reads as a typo in the user's config.
 */
export function bumpCachebuster(target: string, stamp?: string): { from: string; to: string } {
  const manifestPath = join(target, '.codex-plugin', 'plugin.json')
  const manifest = JSON.parse(readTemplate(manifestPath)) as { version?: string }
  const from = manifest.version ?? '0.1.0'
  const base = from.split('+')[0]
  const to = `${base}+codex.${stamp ?? localStamp()}`
  manifest.version = to
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { from, to }
}

/** `local-20260923T064735Z`, digit-only, no punctuation a version parser can reject. */
function localStamp(now: Date = new Date()): string {
  const digits = now.toISOString().replace(/[^0-9]/g, '').slice(0, 14)
  return `local-${digits}`
}

/** The version Codex will see, for reporting. */
export function manifestVersion(target: string): string {
  try {
    const manifest = JSON.parse(readTemplate(join(target, '.codex-plugin', 'plugin.json'))) as { version?: string }
    return manifest.version ?? '(none)'
  } catch {
    return '(unreadable)'
  }
}

export interface InstallReport {
  readonly paths: InstallPaths
  readonly link: LinkResult
  readonly files: GeneratedFiles
  readonly marketplace: { file: string; name: string; created: boolean }
  readonly version: { from: string; to: string }
  readonly enableLine: string
  readonly installCommand: string
  readonly warnings: readonly string[]
}

export function install(options: { home?: string; copy?: boolean; stamp?: string } = {}): InstallReport {
  const paths = installPaths({ home: options.home })
  const warnings: string[] = []

  if (!existsSync(paths.source)) {
    throw new Error(`plugin source not found at ${paths.source}; run install from a checkout of this repository`)
  }

  const link = linkPlugin(paths, { copy: options.copy })
  const files = writeGeneratedFiles(paths)
  const marketplace = upsertMarketplace(paths)
  const version = bumpCachebuster(paths.target, options.stamp)

  if (link.kind === 'copy') warnings.push(link.detail)
  if (files.flags.length > 0) {
    warnings.push(
      `Node ${process.versions.node} needs ${files.flags.join(' ')} to read TypeScript; it is already in .mcp.json. ` +
        'Upgrading to Node 23 or newer removes the need for it.',
    )
  }

  return {
    paths,
    link,
    files,
    marketplace,
    version,
    enableLine: `[plugins."agentgit@${marketplace.name}"]\nenabled = true`,
    installCommand: `codex plugin add agentgit@${marketplace.name}`,
    warnings,
  }
}

export interface UninstallReport {
  readonly removed: readonly string[]
  readonly kept: readonly string[]
  readonly marketplace: string
  readonly enableLine: string
}

/**
 * Remove what install created.
 *
 * Deliberately does not touch the checkout itself, and does not remove a
 * `~/plugins/agentgit` that turned out to be a real directory this command did not
 * create. Two files are removed from the plugin directory because install generated
 * them; everything else there belongs to the plugin source.
 */
export function uninstall(options: { home?: string; marketplaceName?: string } = {}): UninstallReport {
  const paths = installPaths({ home: options.home })
  const removed: string[] = []
  const kept: string[] = []

  for (const file of [join(paths.target, 'hooks.json'), join(paths.target, '.mcp.json')]) {
    if (!existsSync(file)) continue
    rmSync(file, { force: true })
    removed.push(file)
  }

  if (existsSync(paths.marketplace)) {
    const payload = JSON.parse(readTemplate(paths.marketplace)) as Marketplace
    const before = Array.isArray(payload.plugins) ? payload.plugins.length : 0
    payload.plugins = (payload.plugins ?? []).filter((entry) => entry?.name !== 'agentgit')
    if (payload.plugins.length !== before) {
      writeFileSync(paths.marketplace, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      removed.push(`${paths.marketplace} entry`)
    } else {
      kept.push('marketplace entry (was not present)')
    }
  }

  if (existsSync(paths.target)) {
    let link = false
    try {
      link = lstatSync(paths.target).isSymbolicLink()
    } catch {
      link = false
    }
    if (link) {
      try {
        // `unlinkSync` on a Windows junction removes the link, not the target. Using
        // `rmSync(recursive)` here would delete the checkout it points at.
        unlinkSync(paths.target)
        removed.push(paths.target)
      } catch {
        kept.push(`${paths.target} (could not remove the link)`)
      }
    } else {
      kept.push(`${paths.target} (a real directory, not a link - left alone)`)
    }
  }

  return {
    removed,
    kept,
    marketplace: paths.marketplace,
    enableLine: `[plugins."agentgit@${paths.marketplaceName}"]`,
  }
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[]
  readonly version: string
}

/**
 * Check the things that actually have to be true for the plugin to work.
 *
 * Every check here corresponds to a failure that is invisible in the UI: a hook
 * that never fires looks like an agent that simply did not write anything, and an
 * MCP server that never starts looks like a plugin with no tools.
 */
export function runDoctor(options: { home?: string } = {}): DoctorReport {
  const paths = installPaths({ home: options.home })
  const checks: DoctorCheck[] = []

  const major = Number(process.versions.node.split('.')[0])
  checks.push({
    name: 'node version',
    ok: major >= 22,
    detail: `v${process.versions.node}${major >= 23 ? ' (TypeScript types need no flag)' : ' (needs --experimental-strip-types)'}`,
    fix: 'Install Node 22.19 or newer; 23 or newer needs no extra flag.',
  })

  checks.push({
    name: 'plugin source',
    ok: existsSync(paths.source),
    detail: existsSync(paths.source) ? paths.source : `missing: ${paths.source}`,
    fix: 'Run install from a checkout of this repository.',
  })

  const linked = existsSync(paths.target)
  checks.push({
    name: 'plugin installed',
    ok: linked,
    detail: linked ? paths.target : `not present: ${paths.target}`,
    fix: 'agentgit install',
  })

  for (const [name, file] of [
    ['hooks.json', join(paths.target, 'hooks.json')],
    ['.mcp.json', join(paths.target, '.mcp.json')],
  ] as const) {
    const present = existsSync(file)
    let valid = false
    let detail = present ? file : `missing: ${file}`
    if (present) {
      try {
        const parsed = JSON.parse(readTemplate(file)) as { hooks?: unknown; mcpServers?: unknown }
        valid = name === 'hooks.json' ? parsed.hooks !== undefined : parsed.mcpServers !== undefined
        detail = valid ? file : `${file} has no ${name === 'hooks.json' ? 'hooks' : 'mcpServers'} section`
      } catch (error) {
        detail = `${file} is not valid JSON: ${(error as Error).message}`
      }
    }
    checks.push({ name, ok: present && valid, detail, fix: 'agentgit install' })
  }

  const track = join(paths.target, 'scripts', 'track.mjs')
  checks.push({
    name: 'hook script',
    ok: existsSync(track),
    detail: existsSync(track) ? track : `missing: ${track}`,
    fix: 'agentgit install',
  })

  const mcpEntry = join(paths.repo, 'packages', 'mcp', 'src', 'main.ts')
  checks.push({
    name: 'mcp server entry',
    ok: existsSync(mcpEntry),
    detail: existsSync(mcpEntry) ? mcpEntry : `missing: ${mcpEntry}`,
    fix: 'You are running a partial checkout; the MCP tools will not be available.',
  })

  let marketplaceOk = false
  let marketplaceDetail = existsSync(paths.marketplace) ? paths.marketplace : `missing: ${paths.marketplace}`
  if (existsSync(paths.marketplace)) {
    try {
      const payload = JSON.parse(readTemplate(paths.marketplace)) as Marketplace
      const entry = (payload.plugins ?? []).find((candidate) => candidate?.name === 'agentgit')
      marketplaceOk = entry?.source?.path === './plugins/agentgit'
      marketplaceDetail = entry ? `${paths.marketplace} -> ${entry.source.path}` : `${paths.marketplace} has no agentgit entry`
    } catch (error) {
      marketplaceDetail = `${paths.marketplace} is not valid JSON: ${(error as Error).message}`
    }
  }
  checks.push({
    name: 'marketplace entry',
    ok: marketplaceOk,
    detail: marketplaceDetail,
    fix: 'agentgit install',
  })

  const agentgitDir = join(paths.repo, '.agentgit')
  const hooksFile = join(paths.target, 'hooks.json')
  let hookCommandOk = false
  let hookCommandDetail = 'hooks.json not readable'
  if (existsSync(hooksFile)) {
    try {
      const parsed = JSON.parse(readTemplate(hooksFile)) as {
        hooks?: Record<string, { hooks?: { command?: string }[] }[]>
      }
      const command = parsed.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command ?? ''
      const scriptPath = command.match(/"([^"]*track\.mjs)"/)?.[1]
      hookCommandOk = Boolean(scriptPath && existsSync(scriptPath))
      hookCommandDetail = scriptPath ? scriptPath : 'PreToolUse command has no script path'
    } catch {
      hookCommandOk = false
    }
  }
  checks.push({
    name: 'hook path resolves',
    ok: hookCommandOk,
    detail: hookCommandDetail,
    fix: 'agentgit install',
  })

  checks.push({
    name: 'workspace ledger',
    ok: true,
    detail: existsSync(agentgitDir)
      ? agentgitDir
      : 'no .agentgit yet in this checkout; the hooks create it on the first write',
  })

  return { checks, version: manifestVersion(paths.target) }
}

/** Machine-readable form of the install report. */
export function installReportJson(report: InstallReport): Record<string, unknown> {
  return {
    repo: report.paths.repo,
    source: report.paths.source,
    target: report.paths.target,
    link: report.link,
    files: report.files,
    marketplace: report.marketplace,
    version: report.version,
    enableLine: report.enableLine,
    installCommand: report.installCommand,
    warnings: report.warnings,
  }
}

/* -------------------------------------------------------------------------- */
/* config.toml                                                                 */
/* -------------------------------------------------------------------------- */

export interface ConfigEdit {
  readonly file: string
  readonly changed: boolean
  readonly detail: string
}

/**
 * Turn the plugin on or off inside `config.toml`, touching no other byte.
 *
 * This is a text edit and not a parse-and-re-serialise, and that is the whole point:
 * `config.toml` is a file people keep comments and hand-tuned settings in, and a TOML
 * round-trip through a data model would silently delete every comment in it. So the
 * edit finds the one table header it owns and changes only what is under it.
 *
 * Refuses rather than guesses when `config.toml` holds `plugins` as an inline table.
 * Appending a `[plugins."x"]` section to a file that already assigned `plugins` is
 * invalid TOML, and the failure would surface as Codex refusing to start - with the
 * cause several lines away from the symptom. A refusal here costs one sentence.
 */
export function setPluginEnabled(
  text: string,
  qualified: string,
  enabled: boolean,
  label = 'config.toml',
): { text: string; changed: boolean; found: boolean } {
  const header = `[plugins."${qualified}"]`
  const lines = text.replace(/\r\n/g, '\n').split('\n')

  const headerRe = new RegExp(`^\\s*\\[plugins\\.\\s*"${escapeRegExpChar(qualified)}"\\s*\\]\\s*$`)
  const inlinePluginsRe = /^\s*plugins\s*=\s*\{/

  const start = lines.findIndex((line) => headerRe.test(line))
  if (start < 0 && lines.some((line) => inlinePluginsRe.test(line))) {
    throw new Error(
      `${label} sets \`plugins\` as an inline table, which cannot be extended by a section. ` +
        `Add \`"${qualified}" = { enabled = ${enabled} }\` to it by hand, or move it to its own [plugins."${qualified}"] section.`,
    )
  }

  if (start < 0) {
    const body = lines.join('\n').replace(/\s*$/, '')
    const suffix = body === '' ? '' : '\n\n'
    return { text: `${body}${suffix}${header}\nenabled = ${enabled}\n`, changed: true, found: false }
  }

  // The end of the table is the next header of any kind, since TOML tables run until
  // the next one starts.
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      end = index
      break
    }
  }

  const enabledRe = /^(\s*enabled\s*=\s*)(true|false)\s*$/
  for (let index = start + 1; index < end; index += 1) {
    const match = enabledRe.exec(lines[index])
    if (!match) continue
    if (match[2] === String(enabled)) return { text: lines.join('\n'), changed: false, found: true }
    lines[index] = `${match[1]}${enabled}`
    return { text: lines.join('\n'), changed: true, found: true }
  }

  lines.splice(start + 1, 0, `enabled = ${enabled}`)
  return { text: lines.join('\n'), changed: true, found: true }
}

function escapeRegExpChar(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `~/.codex/config.toml`, honouring `AGENTGIT_CODEX_HOME` for tests. */
export function codexConfigFile(home: string): string {
  const fromEnv = (process.env.AGENTGIT_CODEX_HOME ?? '').trim()
  if (fromEnv) return join(resolve(fromEnv), 'config.toml')
  return join(home, '.codex', 'config.toml')
}

/**
 * Apply {@link setPluginEnabled} to the real file.
 *
 * `enabled = false` is written rather than the block being deleted: a disabled block
 * is how the user can see that something is installed and off, and a tool that
 * removes lines it once added is indistinguishable from one that lost them.
 */
export function writePluginEnabled(options: { home?: string; marketplaceName?: string; enabled: boolean }): ConfigEdit {
  const paths = installPaths(options)
  const file = codexConfigFile(paths.home)
  const qualified = `agentgit@${paths.marketplaceName}`

  let existing = ''
  try {
    existing = readFileSync(file, 'utf8')
  } catch {
    existing = ''
  }

  const result = setPluginEnabled(existing, qualified, options.enabled, file)
  if (!result.changed) {
    return {
      file,
      changed: false,
      detail: `[plugins."${qualified}"] enabled = ${options.enabled} is already set`,
    }
  }

  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, result.text, 'utf8')
  return {
    file,
    changed: true,
    detail: result.found
      ? `set enabled = ${options.enabled} in [plugins."${qualified}"]`
      : `added [plugins."${qualified}"] with enabled = ${options.enabled}`,
  }
}

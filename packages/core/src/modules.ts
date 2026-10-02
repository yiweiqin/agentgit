/**
 * Module boundaries and the coupling graph between them, derived mechanically.
 *
 * Why this exists
 * ---------------
 * The directional impact layer can only reason about a relationship somebody *declared*:
 * `agentgit_impact_state` asks an agent to list its dependencies, contract assumptions and
 * artifacts. An agent that declares nothing is invisible to it, and the failure mode is
 * silent — a change that breaks a consumer nobody wrote down reads as `background_only`.
 *
 * An `import` is the same dependency, and nobody has to write it down. This module walks the
 * workspace, reads the import graph the code already contains, groups files into modules, and
 * answers three questions with no model call and no hand annotation:
 *
 * - which module does this file belong to ({@link moduleIdOf});
 * - which modules depend on which ({@link buildModuleGraph});
 * - which modules are near this one ({@link moduleNeighborhood}), so a search can be routed
 *   through the graph instead of comparing every session with every change.
 *
 * Two rules this module exists to protect
 * ---------------------------------------
 * 1. **Sharing a module is never, on its own, evidence of shared work.** That rule lives in
 *    {@link isModuleCoupledOnItsOwn}, the sibling of `entity.ts`'s `isStructuralDuplicate`:
 *    one home, so a later change cannot loosen it at a call site. A module is a coarse place,
 *    and two tasks can touch one place for unrelated reasons, so the impact layer only treats
 *    module coupling as *recall plus a weaker, deferred signal* — never as a conflict.
 * 2. **Nothing here is guessed.** The boundary rule is a pure function of the path, the edges
 *    are parsed out of real `import`/`require`/`from` statements and real git history, and a
 *    specifier that does not resolve to a scanned file is counted as unresolved rather than
 *    assumed. A heuristic that silently invents an edge would make every downstream number
 *    uninterpretable.
 *
 * The graph is a cache, not a source of truth: it is keyed by a fingerprint of the files it
 * was built from, and everything derived from it (routing, coupling evidence, the read-only
 * report) can be deleted and rebuilt. It is written to `.agentgit/state/modules.json` and is
 * never committed, for the same reason the hub projection is not.
 *
 * @module @agentgit/core/modules
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'

import { runGit } from './git.ts'
import type { WorkspacePaths } from './workspace.ts'

/** Bumped when the on-disk shape changes, so a stale cache is rebuilt rather than misread. */
export const MODULE_GRAPH_VERSION = 1

/** How a file's module was named. Recorded so a report can say which rule answered. */
export type ModuleRule =
  /** `<packages|apps|plugins|...>/<name>/...` — the directory that holds a package manifest. */
  | 'workspace-package'
  /** `<...>/src/<group>/...` — the first directory under `src`, which is the unit people work in. */
  | 'src-group'
  /** `src/...` with no group, or the top-level directory. */
  | 'top-level'
  /** A file at the repository root, which belongs to no directory. */
  | 'root'

/**
 * How far the candidate search may travel from a changed module.
 *
 * `off` is the control: every session is compared with every change, which is the pairwise
 * baseline the module layer is measured against.
 */
export const MODULE_ROUTINGS = ['off', 'one-hop', 'transitive'] as const
export type ModuleRouting = (typeof MODULE_ROUTINGS)[number]

export interface ModuleBoundary {
  readonly id: string
  readonly rule: ModuleRule
}

/** Directories that never hold the source this graph is about. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'vendor',
])

/** Directories whose second level names a package, in the layouts this product is used in. */
const WORKSPACE_CONTAINERS = new Set(['packages', 'apps', 'libs', 'services', 'modules', 'plugins', 'workspaces'])

/** Extensions this graph parses. A file that is not one of these is not a module member. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyi'] as const

/** Extensions a bare import may resolve to, in priority order. */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyi'] as const

/**
 * A NodeNext-style import ends in `.js` while the file on disk is `.ts`.
 *
 * Maps the written extension to the extension it was compiled from, so `import './entity.js'`
 * finds `entity.ts`. Without this the repo's own convention — `.ts` extensions in source —
 * would resolve, but the far more common `.js` convention would not, and the graph would be
 * quietly empty for most TypeScript projects.
 */
const COMPILED_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx', '.mts', '.cts'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
  '.jsx': ['.tsx', '.jsx'],
}

export const DEFAULT_MAX_FILES = 4000
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024
export const DEFAULT_COCHANGE_COMMITS = 200

export interface ModuleGraphOptions {
  /** Cap on files scanned; the scan stops deterministically once reached. */
  readonly maxFiles?: number
  /** Files larger than this are counted, not parsed. Generated bundles are not evidence. */
  readonly maxFileBytes?: number
  /** Whether git history is consulted for `co-change` edges. Defaults to true. */
  readonly coChange?: boolean
  /** Cap on commits walked for co-change edges. */
  readonly coChangeCommits?: number
}

export interface ModuleNode {
  readonly id: string
  readonly rule: ModuleRule
  readonly fileCount: number
  /** Distinct modules that import this one. */
  readonly fanIn: number
  /** Distinct modules this one imports. */
  readonly fanOut: number
  /** `fanIn + fanOut`: how many other modules this one is wired to. The "core module" score. */
  readonly hubScore: number
}

export type ModuleEdgeKind = 'import' | 'co-change'

export interface ModuleEdge {
  readonly from: string
  readonly to: string
  readonly kind: ModuleEdgeKind
  /** Import references, or commits in which both modules changed together. */
  readonly weight: number
}

export interface ModuleGraph {
  readonly version: number
  readonly root: string
  /** Changes whenever the files or git revision the graph was built from change. */
  readonly fingerprint: string
  readonly modules: readonly ModuleNode[]
  readonly edges: readonly ModuleEdge[]
  /** Workspace-relative POSIX path -> module id. Every parsed file appears here. */
  readonly byPath: Readonly<Record<string, string>>
  /** Specifiers that did not resolve to a scanned file: external packages, aliases, gaps. */
  readonly unresolved: number
  /** Files over {@link ModuleGraphOptions.maxFileBytes} that were counted but not parsed. */
  readonly unparsed: number
  /** True when the file cap was reached, so the graph describes a prefix of the workspace. */
  readonly truncated: boolean
}

/**
 * The module a workspace-relative path belongs to.
 *
 * Pure, and deliberately so: the same path must get the same module from the CLI, the MCP
 * server, the daemon and the hook. A boundary rule that consulted the filesystem would let two
 * callers disagree, and the disagreement would look like a missing edge rather than an error.
 *
 * The rules are ordered, and the first one that matches wins:
 * 1. `packages/<name>/...` (and the sibling containers) — the directory that holds a manifest.
 *    The full relative path is the id, not the bare name, because two `core` packages in one
 *    repository are two modules and a bare name would merge them.
 * 2. the first directory under `src`, because that is the unit a person works in.
 * 3. otherwise the top-level directory, or the root itself.
 */
export function moduleIdOf(path: string): ModuleBoundary {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  const segments = normalized.split('/').filter(Boolean)
  if (segments.length <= 1) return { id: '(root)', rule: 'root' }
  const dirs = segments.slice(0, -1)

  if (dirs.length >= 2 && WORKSPACE_CONTAINERS.has(dirs[0])) {
    return { id: `${dirs[0]}/${dirs[1]}`, rule: 'workspace-package' }
  }

  const srcAt = dirs.indexOf('src')
  if (srcAt >= 0) {
    const grouped = srcAt + 1 < dirs.length
    const id = dirs.slice(0, srcAt + 1).join('/') + (grouped ? `/${dirs[srcAt + 1]}` : '')
    return { id, rule: 'src-group' }
  }

  return { id: dirs[0], rule: 'top-level' }
}

/**
 * Whether a module-to-module edge is strong enough to count as a structural relationship.
 *
 * Only a real `import` qualifies. `co-change` is deliberately excluded: two modules that a
 * person happened to edit in one commit have no declared dependency between them, and treating
 * that as coupling is how the old file-overlap false positive would come back wearing a new
 * name. This is the positive form of `entity.ts`'s `isStructuralDuplicate`, and it is the one
 * place the rule lives so a call site cannot loosen it.
 */
export function isStructuralModuleCoupling(kind: ModuleEdgeKind): boolean {
  return kind === 'import'
}

/** True for a file this graph parses: a source extension, and not a `.d.ts` declaration. */
export function isSourceFile(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower.endsWith('.d.ts')) return false
  return SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** Shared hashing helper so the cache fingerprint and the impact digest cannot drift. */
function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 24)
}

interface ScannedFile {
  readonly rel: string
  readonly size: number
  readonly mtimeMs: number
}

interface Scan {
  readonly files: ScannedFile[]
  /** `package.json` / `pyproject.toml` files, used to resolve package-alias imports. */
  readonly manifests: ScannedFile[]
  readonly truncated: boolean
}

/**
 * Every source file under `root`, deterministically ordered.
 *
 * Stat only: no file is read here, so a cache hit costs one directory walk and nothing else.
 * The cap is applied during a deterministic traversal and the result is sorted, so "the first
 * N files" means the same thing on every machine — a truncation that depended on directory
 * iteration order would make the fingerprint, and therefore the cache, flap.
 */
function scanFiles(root: string, options: ModuleGraphOptions): Scan {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const files: ScannedFile[] = []
  const manifests: ScannedFile[] = []
  const stack: string[] = ['']
  let truncated = false

  while (stack.length > 0) {
    const relDir = stack.pop() as string
    const absDir = relDir ? join(root, relDir) : root
    let entries
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
    } catch {
      continue
    }

    const subdirs: string[] = []
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        // A dotted entry is either tooling this graph does not describe or a symlink through
        // `isDirectory()` returning false; skipping both keeps the walk cycle-free.
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
        subdirs.push(rel)
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name === 'package.json' || entry.name === 'pyproject.toml') {
        try {
          const stat = statSync(join(root, rel))
          manifests.push({ rel, size: stat.size, mtimeMs: stat.mtimeMs })
        } catch {
          // A manifest that vanished mid-walk contributes nothing.
        }
        continue
      }
      if (!isSourceFile(entry.name)) continue
      let stat
      try {
        stat = statSync(join(root, rel))
      } catch {
        continue
      }
      files.push({ rel, size: stat.size, mtimeMs: stat.mtimeMs })
      if (files.length >= maxFiles) {
        truncated = true
        break
      }
    }
    if (truncated) break
    // Push in reverse so `pop` yields ascending order; the traversal is part of the fingerprint.
    subdirs.sort()
    for (let index = subdirs.length - 1; index >= 0; index -= 1) stack.push(subdirs[index])
  }

  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  manifests.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return { files, manifests, truncated }
}

/**
 * The import specifiers a source file contains.
 *
 * Four forms are matched, and only these four: a specifier is only evidence when it was
 * actually written as an import. A looser "any quoted string that looks like a path" scan
 * would invent edges out of doc comments and string literals, and an invented edge is worse
 * than a missing one because it looks like a finding.
 */
export function moduleSpecifiers(relPath: string, source: string): string[] {
  const found = new Set<string>()

  if (/\.(py|pyi)$/i.test(relPath)) {
    for (const match of source.matchAll(/^[ \t]*from[ \t]+([.\w]+)[ \t]+import\b/gm)) found.add(match[1])
    for (const match of source.matchAll(/^[ \t]*import[ \t]+([.\w]+(?:[ \t]*,[ \t]*[.\w]+)*)/gm)) {
      for (const part of match[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim()
        if (name) found.add(name)
      }
    }
    return [...found]
  }

  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\n)[ \t]*import\s+['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1])
  }
  return [...found]
}

/** The paths a base could name, in the order they are tried. */
function candidatePaths(base: string): string[] {
  const candidates = [base]
  const written = /\.[a-z]+$/i.exec(base)
  if (written && COMPILED_EXTENSIONS[written[0].toLowerCase()]) {
    const stem = base.slice(0, -written[0].length)
    for (const ext of COMPILED_EXTENSIONS[written[0].toLowerCase()]) candidates.push(stem + ext)
  }
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(base + ext)
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(`${base}/index${ext}`)
  candidates.push(`${base}/__init__.py`)
  return candidates
}

/**
 * Resolve one specifier against the set of files that were actually scanned.
 *
 * Only a hit against a real scanned file counts, which is what keeps the graph honest: a
 * package name, a path alias, or a stdlib import resolves to nothing and is counted as
 * unresolved rather than mapped onto a plausible-looking module.
 */
export function resolveModuleSpecifier(fromRel: string, spec: string, files: ReadonlySet<string>): string | null {
  const trimmed = spec.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('.')) {
    const base = posix.normalize(posix.join(posix.dirname(fromRel), trimmed))
    return firstExisting(base, files)
  }

  // A Python `a.b.c` is an absolute module path inside the project; a JS bare specifier is
  // almost always an installed package. Trying the workspace first is safe in both cases
  // because a hit requires a real file, and a miss changes nothing.
  if (/\.(py|pyi)$/i.test(fromRel) && /^[A-Za-z_][\w.]*$/.test(trimmed)) {
    return firstExisting(trimmed.replace(/\./g, '/'), files)
  }
  return firstExisting(trimmed, files)
}

function firstExisting(base: string, files: ReadonlySet<string>): string | null {
  for (const candidate of candidatePaths(base)) {
    if (files.has(candidate)) return candidate
  }
  return null
}

/**
 * Whether the workspace root itself carries a git directory (a directory, or the file a linked
 * worktree uses).
 *
 * Checked before every git call, and the reason is not only speed. `git` inherits its working
 * directory, and on Windows a directory cannot be removed while it is a live process's cwd — so
 * spawning git inside a directory that is not a repository, which is exactly what a test's
 * scratch workspace is, turns that workspace's cleanup into a flake. Deriving co-change is worth
 * a git call in a repository and never worth one outside it.
 *
 * The cost is that a workspace whose root is a *subdirectory* of a repository derives no
 * co-change edges. That is the right way to lose it: `findWorkspaceRoot` returns the repository
 * root for every ordinary case, and import edges — the structural signal — are unaffected.
 */
function hasLocalGit(root: string): boolean {
  return existsSync(join(root, '.git'))
}

/**
 * The fingerprint the cache is keyed by: which files were scanned, and whether co-change was on.
 *
 * The git revision is deliberately *not* part of this. Keying on HEAD would mean a `git` process
 * on every call — including every daemon tick that publishes the impact projection — to detect a
 * change that only moves co-change edges, which are a two-hundred-commit signal that shifts
 * slowly. Leaving it out means git is spawned only when a source file changes, and the cost is
 * that a fresh commit is not reflected until the next file edit. That is the right trade: co-change
 * is a secondary signal, and it is never allowed to decide anything (see `coChangeEdges`).
 */
function fingerprintOf(scan: Scan, options: ModuleGraphOptions): string {
  const parts = [`v${MODULE_GRAPH_VERSION}`, `coChange:${options.coChange === false ? 'off' : 'on'}`]
  for (const file of scan.files) parts.push(`${file.rel}\u0000${file.size}\u0000${file.mtimeMs}`)
  for (const manifest of scan.manifests) parts.push(`${manifest.rel}\u0000${manifest.size}\u0000${manifest.mtimeMs}`)
  return digestOf(parts.join('\n'))
}

/**
 * Workspace package name -> module, read from the manifests that already exist.
 *
 * This is what makes the graph work on the repositories this product is actually used in.
 * A monorepo imports its own packages by name (`@agentgit/core`), not by relative path, so a
 * purely path-based resolver sees no edges at all — the graph would report "one module, no
 * coupling" on exactly the layout where module routing matters most. The names are still
 * derived mechanically: nothing is annotated, the manifest is read and its `name` is used.
 *
 * A manifest at the workspace root maps to the root module, which is how a single-package
 * repository's own name resolves to itself — and a self-edge is dropped like any other.
 */
function discoverPackageModules(root: string, manifests: readonly ScannedFile[]): Map<string, string> {
  const byName = new Map<string, string>()
  for (const manifest of manifests) {
    let text: string
    try {
      text = readFileSync(join(root, manifest.rel), 'utf8')
    } catch {
      continue
    }
    let name: string | null = null
    if (manifest.rel.endsWith('package.json')) {
      try {
        const parsed = JSON.parse(text) as { name?: unknown }
        if (typeof parsed.name === 'string' && parsed.name.trim()) name = parsed.name.trim()
      } catch {
        name = null
      }
    } else {
      const match = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text)
      if (match) name = match[1].trim()
    }
    if (!name) continue

    const dir = manifest.rel.slice(0, Math.max(0, manifest.rel.lastIndexOf('/')))
    const module = moduleIdOf(dir ? `${dir}/index` : 'index').id
    // First writer wins so a name cannot be reassigned by a later manifest; the walk is
    // deterministic, so "first" is stable across machines.
    if (!byName.has(name)) byName.set(name, module)
  }
  return byName
}

/**
 * The module a bare specifier names, when it is a workspace package rather than a dependency.
 *
 * Handles both an exact name (`@agentgit/core`) and a subpath (`@agentgit/core/entity`), and
 * prefers the longest package name so `@agentgit/core` cannot shadow a package actually named
 * `@agentgit/core-extra`.
 */
function resolvePackageSpecifier(spec: string, packages: ReadonlyMap<string, string>): string | null {
  if (packages.has(spec)) return packages.get(spec) ?? null
  let bestName: string | null = null
  let bestModule: string | null = null
  for (const [name, module] of packages) {
    if (!spec.startsWith(`${name}/`)) continue
    if (bestName === null || name.length > bestName.length) {
      bestName = name
      bestModule = module
    }
  }
  return bestModule
}

function readSource(root: string, file: ScannedFile, maxBytes: number): string | null {
  if (file.size > maxBytes) return null
  try {
    return readFileSync(join(root, file.rel), 'utf8')
  } catch {
    return null
  }
}

/**
 * Co-change edges: modules that changed together in one commit.
 *
 * A weaker signal than an import, and deliberately a *different* kind, because it must never be
 * able to decide anything. It exists because an import graph cannot see the dependencies that
 * are not imports — a migration and the model it migrates, a schema and the client generated
 * from it — and those are exactly the couplings a person would have drawn by hand and resented
 * maintaining.
 *
 * It is also the signal most likely to be noise, so it is fenced in four ways: a commit must
 * touch a small number of modules (a sweep across the monorepo pairs everything with everything
 * and means nothing), a pair must co-change at least {@link MIN_COCHANGE_WEIGHT} times to be
 * reported, only modules that still exist are counted (a path from deleted history describes a
 * coupling that is gone), and — most importantly — co-change edges are excluded from module
 * degree and from routing in `buildFromScan` and `moduleNeighborhood`. Two modules edited in one
 * commit have no declared dependency, and treating that as coupling is how the old file-overlap
 * false positive would return wearing a new name.
 */
function coChangeEdges(
  root: string,
  byPath: Readonly<Record<string, string>>,
  knownModules: ReadonlySet<string>,
  maxCommits: number,
): ModuleEdge[] {
  if (!hasLocalGit(root)) return []
  // `core.quotepath=false` keeps a non-ASCII path as itself instead of a quoted octal escape,
  // which would otherwise be read as a directory name like `"research/04_/345/...`.
  const result = runGit(
    ['-c', 'core.quotepath=false', 'log', '--no-merges', '--name-only', '--pretty=format:__AGENTGIT_COMMIT__', '-n', String(maxCommits)],
    root,
  )
  if (!result.ok) return []

  const perCommit: Array<Set<string>> = []
  let current = new Set<string>()
  const flush = (): void => {
    if (current.size >= 2 && current.size <= 6) perCommit.push(current)
    current = new Set<string>()
  }
  for (const raw of result.stdout.split('\n')) {
    const line = raw.trim()
    if (line === '__AGENTGIT_COMMIT__') {
      flush()
      continue
    }
    if (!line) continue
    const rel = line.replace(/\\/g, '/').replace(/^\.\//, '')
    // A path this graph would never describe — a tooling directory, a file outside the tree, or
    // an agentgit state file — contributes no module and must not invent one.
    const firstSegment = rel.split('/')[0]
    if (rel.includes('..') || firstSegment.startsWith('.') || SKIP_DIRS.has(firstSegment)) continue
    const module = byPath[rel] ?? moduleIdOf(rel).id
    // Only modules that still exist may appear. A path from an old commit whose module was moved
    // or deleted describes a coupling that no longer exists, and reporting it would put phantom
    // modules in the graph that a reader cannot find anywhere in the tree.
    if (module && knownModules.has(module)) current.add(module)
  }
  flush()

  const weights = new Map<string, ModuleEdge>()
  for (const modules of perCommit) {
    const ids = [...modules].sort()
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        // Undirected in origin, but stored as two directed edges so a reader can ask "who
        // changed with me" without special-casing the kind.
        for (const [from, to] of [
          [ids[i], ids[j]],
          [ids[j], ids[i]],
        ] as const) {
          const key = `${from}\u0000${to}`
          const previous = weights.get(key)
          weights.set(key, { from, to, kind: 'co-change', weight: (previous?.weight ?? 0) + 1 })
        }
      }
    }
  }
  return [...weights.values()].filter((edge) => edge.weight >= MIN_COCHANGE_WEIGHT)
}

/** How many commits a pair must co-change in before it is worth reporting. */
export const MIN_COCHANGE_WEIGHT = 2

function buildFromScan(
  root: string,
  options: ModuleGraphOptions,
  scan: Scan,
  fingerprint: string,
): ModuleGraph {
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const files = scan.files
  const fileSet = new Set(files.map((file) => file.rel))
  // Package names are read before the import pass because a bare `@org/pkg` specifier cannot be
  // resolved to a file without knowing which directory that package owns.
  const packages = discoverPackageModules(root, scan.manifests)

  const byPath: Record<string, string> = {}
  const rules = new Map<string, ModuleRule>()
  for (const file of files) {
    const boundary = moduleIdOf(file.rel)
    byPath[file.rel] = boundary.id
    if (!rules.has(boundary.id)) rules.set(boundary.id, boundary.rule)
  }

  const importWeights = new Map<string, number>()
  let unresolved = 0
  let unparsed = 0
  for (const file of files) {
    const source = readSource(root, file, maxBytes)
    if (source === null) {
      unparsed += 1
      continue
    }
    const from = byPath[file.rel]
    for (const spec of moduleSpecifiers(file.rel, source)) {
      // A specifier resolves either to a real scanned file (a relative import, a Python module,
      // a path alias that happens to match) or to a workspace package by name. Anything else is
      // an external dependency or a gap, and is counted rather than guessed at.
      const resolvedFile = resolveModuleSpecifier(file.rel, spec, fileSet)
      const to = resolvedFile
        ? byPath[resolvedFile] ?? moduleIdOf(resolvedFile).id
        : resolvePackageSpecifier(spec, packages)
      if (!to) {
        unresolved += 1
        continue
      }
      // A file's import of its own module is not coupling; counting it would make every
      // large module look like a hub.
      if (to === from) continue
      const key = `${from}\u0000${to}`
      importWeights.set(key, (importWeights.get(key) ?? 0) + 1)
    }
  }

  const edges: ModuleEdge[] = [...importWeights.entries()].map(([key, weight]) => {
    const [from, to] = key.split('\u0000')
    return { from, to, kind: 'import' as const, weight }
  })
  if (options.coChange !== false) {
    edges.push(
      ...coChangeEdges(root, byPath, new Set(Object.values(byPath)), options.coChangeCommits ?? DEFAULT_COCHANGE_COMMITS),
    )
  }

  // A co-change path can name a module with no scanned source (config, migrations, docs). It
  // becomes a node so an edge is never dangling, but it carries no files.
  const modules = new Map<string, ModuleNode>()
  const ensure = (id: string): void => {
    if (!modules.has(id)) {
      modules.set(id, { id, rule: rules.get(id) ?? moduleIdOf(`${id}/file`).rule, fileCount: 0, fanIn: 0, fanOut: 0, hubScore: 0 })
    }
  }
  for (const id of rules.keys()) ensure(id)
  const fileCounts = new Map<string, number>()
  for (const id of Object.values(byPath)) fileCounts.set(id, (fileCounts.get(id) ?? 0) + 1)

  const fanIn = new Map<string, Set<string>>()
  const fanOut = new Map<string, Set<string>>()
  // Every edge names its endpoints as modules, so a co-change-only module still exists as a node.
  for (const edge of edges) {
    ensure(edge.from)
    ensure(edge.to)
  }
  /*
   * Degree counts *structural* coupling only. A co-change edge is real evidence that two modules
   * move together, but it is not a dependency, and letting it inflate the hub score would make
   * "core module" mean "edited in the same commits" — which, in a monorepo developed as one
   * thing, is every module, and the ranking would stop distinguishing anything.
   */
  for (const edge of edges.filter((candidate) => candidate.kind === 'import')) {
    if (!fanOut.has(edge.from)) fanOut.set(edge.from, new Set())
    if (!fanIn.has(edge.to)) fanIn.set(edge.to, new Set())
    fanOut.get(edge.from)!.add(edge.to)
    fanIn.get(edge.to)!.add(edge.from)
  }

  const nodes = [...modules.keys()].sort().map((id) => {
    const inbound = fanIn.get(id)?.size ?? 0
    const outbound = fanOut.get(id)?.size ?? 0
    return {
      id,
      rule: modules.get(id)!.rule,
      fileCount: fileCounts.get(id) ?? 0,
      fanIn: inbound,
      fanOut: outbound,
      hubScore: inbound + outbound,
    }
  })

  const sortedEdges = edges.sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
  )

  return {
    version: MODULE_GRAPH_VERSION,
    root,
    fingerprint,
    modules: nodes,
    edges: sortedEdges,
    byPath,
    unresolved,
    unparsed,
    truncated: scan.truncated,
  }
}

/** Build the graph from scratch. {@link moduleGraphFor} adds the cache in front of this. */
export function buildModuleGraph(root: string, options: ModuleGraphOptions = {}): ModuleGraph {
  const scan = scanFiles(root, options)
  return buildFromScan(root, options, scan, fingerprintOf(scan, options))
}

function cachePath(paths: WorkspacePaths): string {
  return join(paths.state, 'modules.json')
}

/** The cached graph, or null when it is absent, unreadable or a shape this build cannot read. */
export function readModuleGraph(paths: WorkspacePaths): ModuleGraph | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(paths), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const graph = parsed as Partial<ModuleGraph>
    if (graph.version !== MODULE_GRAPH_VERSION) return null
    if (typeof graph.fingerprint !== 'string' || !Array.isArray(graph.modules) || !Array.isArray(graph.edges)) return null
    if (!graph.byPath || typeof graph.byPath !== 'object') return null
    return {
      version: graph.version,
      root: typeof graph.root === 'string' ? graph.root : paths.root,
      fingerprint: graph.fingerprint,
      modules: graph.modules,
      edges: graph.edges,
      byPath: graph.byPath,
      unresolved: typeof graph.unresolved === 'number' ? graph.unresolved : 0,
      unparsed: typeof graph.unparsed === 'number' ? graph.unparsed : 0,
      truncated: graph.truncated === true,
    }
  } catch {
    return null
  }
}

function writeModuleGraph(paths: WorkspacePaths, graph: ModuleGraph): void {
  const file = cachePath(paths)
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(graph)}\n`, 'utf8')
  renameSync(temp, file)
}

/**
 * The graph for a workspace, rebuilt only when the files it describes have changed.
 *
 * The cache is keyed by a fingerprint of path, size and mtime for every scanned file, plus the
 * git revision when co-change is enabled — because a new commit changes the graph without
 * touching a single file. A build that fails is not written, so a transient error cannot
 * poison the cache with an empty graph that then looks like "this repository has one module".
 */
export function moduleGraphFor(paths: WorkspacePaths, options: ModuleGraphOptions = {}): ModuleGraph {
  let scan: Scan
  try {
    scan = scanFiles(paths.root, options)
  } catch {
    scan = { files: [], manifests: [], truncated: false }
  }
  const fingerprint = fingerprintOf(scan, options)

  const cached = readModuleGraph(paths)
  if (cached && cached.fingerprint === fingerprint && cached.root === paths.root) return cached

  const graph = buildFromScan(paths.root, options, scan, fingerprint)
  try {
    mkdirSync(dirname(cachePath(paths)), { recursive: true })
    writeModuleGraph(paths, graph)
  } catch {
    // A cache that cannot be written costs a rebuild, not correctness. Never fatal: the graph
    // is consulted by hooks on the hot path, where throwing would be far worse than recomputing.
  }
  return graph
}

/** The graph's module for a workspace-relative file, or null when it is outside the scan. */
export function moduleOfFile(graph: ModuleGraph, file: string): string | null {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '')
  return graph.byPath[normalized] ?? null
}

/**
 * A direct *structural* edge between two modules: an import, and nothing else.
 *
 * Co-change edges are excluded on purpose. This is the helper the impact layer calls to decide
 * whether two modules are wired together, and if a pair of modules that merely changed in one
 * commit could satisfy it, the module layer would be the file-overlap false positive again with
 * a new name. See {@link isStructuralModuleCoupling}.
 */
export function directModuleEdge(graph: ModuleGraph, from: string, to: string): ModuleEdge | null {
  return graph.edges.find((edge) => edge.kind === 'import' && edge.from === from && edge.to === to) ?? null
}

interface Adjacency {
  readonly all: ReadonlyMap<string, readonly string[]>
}

const adjacencyCache = new WeakMap<ModuleGraph, Adjacency>()

function adjacencyOf(graph: ModuleGraph): Adjacency {
  const cached = adjacencyCache.get(graph)
  if (cached) return cached
  const all = new Map<string, string[]>()
  // Import edges only: routing may not travel along a co-change, because widening recall with a
  // signal that is explicitly not a dependency would flood the pool with unrelated sessions.
  for (const edge of graph.edges.filter((candidate) => candidate.kind === 'import')) {
    for (const [key, value] of [
      [edge.from, edge.to],
      [edge.to, edge.from],
    ] as const) {
      if (!all.has(key)) all.set(key, [])
      all.get(key)!.push(value)
    }
  }
  for (const list of all.values()) list.sort()
  const value = { all }
  adjacencyCache.set(graph, value)
  return value
}

/**
 * The modules within reach of `id` under a routing mode.
 *
 * Undirected, because coupling runs both ways: a change in `core` affects `cli` which imports
 * it, and a change in `cli` may be an adaptation forced by `core`. Which direction carries
 * which meaning is decided by the impact layer, not here.
 *
 * `hops` bounds the walk and is only consulted under `transitive`; `one-hop` is always exactly
 * one edge regardless of it. The bound exists because reachability in a connected monorepo is
 * nearly the whole repository, so an unbounded `transitive` would recall everything and narrow
 * nothing — a knob that silently disables itself. Callers that genuinely want the whole
 * reachable set pass a depth that exceeds the graph, as {@link moduleDetail} does.
 */
export function moduleNeighborhood(
  graph: ModuleGraph,
  id: string,
  routing: ModuleRouting,
  hops = 1,
): ReadonlySet<string> {
  if (routing === 'off') return new Set([id])
  const adjacency = adjacencyOf(graph)
  const depth = routing === 'one-hop' ? 1 : Math.max(1, Math.floor(hops))

  const seen = new Set<string>([id])
  let frontier: string[] = [id]
  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const next: string[] = []
    for (const current of frontier) {
      for (const neighbor of adjacency.all.get(current) ?? []) {
        if (seen.has(neighbor)) continue
        seen.add(neighbor)
        next.push(neighbor)
      }
    }
    frontier = next
  }
  return seen
}

/**
 * The modules with the highest coupling, worst first.
 *
 * These are the "core modules" a reader would want to keep extensible, and the list a report
 * can print without any judgement about which direction matters — {@link ModuleNode.hubScore}
 * is just degree, and degree is a fact about the graph, not an opinion.
 */
export function coreModules(graph: ModuleGraph, limit = 5): ModuleNode[] {
  return [...graph.modules]
    .filter((module) => module.hubScore > 0)
    .sort((a, b) => b.hubScore - a.hubScore || b.fanIn - a.fanIn || (a.id < b.id ? -1 : 1))
    .slice(0, Math.max(0, limit))
}

/** Every module, plus the graph, as a stable object for `--json` and for MCP clients. */
export function moduleGraphView(graph: ModuleGraph, options: { readonly limit?: number } = {}): {
  readonly version: number
  readonly root: string
  readonly fingerprint: string
  readonly moduleCount: number
  readonly edgeCount: number
  readonly importEdges: number
  readonly coChangeEdges: number
  readonly unresolved: number
  readonly unparsed: number
  readonly truncated: boolean
  readonly core: readonly ModuleNode[]
  readonly modules: readonly ModuleNode[]
  readonly edges: readonly ModuleEdge[]
} {
  const importEdges = graph.edges.filter((edge) => edge.kind === 'import').length
  return {
    version: graph.version,
    root: graph.root,
    fingerprint: graph.fingerprint,
    moduleCount: graph.modules.length,
    edgeCount: graph.edges.length,
    importEdges,
    coChangeEdges: graph.edges.length - importEdges,
    unresolved: graph.unresolved,
    unparsed: graph.unparsed,
    truncated: graph.truncated,
    core: coreModules(graph, options.limit ?? 5),
    modules: graph.modules,
    edges: graph.edges,
  }
}

/** Dependents (`fanIn`) and dependencies (`fanOut`) of one module, for a read-only report. */
export function moduleDetail(graph: ModuleGraph, id: string): {
  readonly module: ModuleNode | null
  readonly dependsOn: readonly string[]
  readonly dependedOnBy: readonly string[]
  /** Modules that changed in the same commits, kept apart from the import graph on purpose. */
  readonly coChangedWith: readonly string[]
  readonly reaches: readonly string[]
} | null {
  if (!graph.modules.some((module) => module.id === id)) return null
  const imports = graph.edges.filter((edge) => edge.kind === 'import')
  const dependsOn = imports.filter((edge) => edge.from === id).map((edge) => edge.to)
  const dependedOnBy = imports.filter((edge) => edge.to === id).map((edge) => edge.from)
  const coChangedWith = graph.edges.filter((edge) => edge.kind === 'co-change' && edge.from === id).map((edge) => edge.to)
  // Depth exceeds any path in the graph, so this is the whole reachable set by construction.
  const reaches = new Set(moduleNeighborhood(graph, id, 'transitive', graph.modules.length + 1))
  reaches.delete(id)
  return {
    module: graph.modules.find((module) => module.id === id) ?? null,
    dependsOn: [...new Set(dependsOn)].sort(),
    dependedOnBy: [...new Set(dependedOnBy)].sort(),
    coChangedWith: [...new Set(coChangedWith)].sort(),
    reaches: [...reaches].sort(),
  }
}
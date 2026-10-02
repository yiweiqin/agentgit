import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  buildModuleGraph,
  coreModules,
  directModuleEdge,
  isSourceFile,
  isStructuralModuleCoupling,
  moduleDetail,
  moduleGraphFor,
  moduleIdOf,
  moduleNeighborhood,
  moduleSpecifiers,
  resolveModuleSpecifier,
  type ModuleGraph,
} from '../src/modules.ts'
import { parseTunable } from '../src/tunables.ts'
import { moduleContention } from '../src/ledger.ts'
import {
  DEFAULT_CONFIG,
  MAX_MODULE_HOPS,
  ensureWorkspace,
  resolveModuleHops,
  resolveModuleRouting,
} from '../src/workspace.ts'
import type { ContentionRecord } from '../src/types.ts'

let root: string
function write(rel: string, contents: string): void {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents, 'utf8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentgit-modules-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('module boundaries are a pure function of the path', () => {
  assert.deepEqual(moduleIdOf('packages/core/src/entity.ts'), { id: 'packages/core', rule: 'workspace-package' })
  assert.deepEqual(moduleIdOf('plugins/agentgit/scripts/hub.mjs'), { id: 'plugins/agentgit', rule: 'workspace-package' })
  assert.deepEqual(moduleIdOf('src/login/handler.ts'), { id: 'src/login', rule: 'src-group' })
  assert.deepEqual(moduleIdOf('src/a.ts'), { id: 'src', rule: 'src-group' })
  assert.deepEqual(moduleIdOf('frontend/src/components/Button.tsx'), { id: 'frontend/src/components', rule: 'src-group' })
  assert.deepEqual(moduleIdOf('db/schema.sql'), { id: 'db', rule: 'top-level' })
  assert.deepEqual(moduleIdOf('README.md'), { id: '(root)', rule: 'root' })

  // A Windows path and a POSIX path are the same ground, so they must be the same module.
  assert.deepEqual(moduleIdOf('packages\\core\\src\\entity.ts'), moduleIdOf('packages/core/src/entity.ts'))
  assert.deepEqual(moduleIdOf('./src/a.ts'), moduleIdOf('src/a.ts'))
})

test('only real source files are members of a module', () => {
  assert.equal(isSourceFile('a.ts'), true)
  assert.equal(isSourceFile('a.tsx'), true)
  assert.equal(isSourceFile('a.py'), true)
  assert.equal(isSourceFile('a.mjs'), true)
  // A declaration file describes types but is not work anyone is doing.
  assert.equal(isSourceFile('a.d.ts'), false)
  assert.equal(isSourceFile('a.md'), false)
  assert.equal(isSourceFile('a.json'), false)
})

test('import specifiers are parsed from the four forms, and Python separately', () => {
  const ts = moduleSpecifiers(
    'a.ts',
    [
      "import { x } from './b.ts'",
      "export { y } from '../c/index.ts'",
      "const z = require('@agentgit/core')",
      "const p = await import('./lazy.js')",
      "import './side-effect.css'",
    ].join('\n'),
  )
  assert.deepEqual(
    ts.sort(),
    ['./b.ts', '../c/index.ts', '@agentgit/core', './lazy.js', './side-effect.css'].sort(),
  )

  const py = moduleSpecifiers('a.py', ['from pkg.sub import thing', 'import os, sys', 'import x as y'].join('\n'))
  assert.deepEqual(py.sort(), ['pkg.sub', 'os', 'sys', 'x'].sort())
})

test('a specifier resolves only to a real scanned file, and a compiled .js finds its .ts', () => {
  const files = new Set(['src/a.ts', 'src/b.ts', 'src/c/index.ts', 'pkg/b.py', 'pkg/__init__.py'])
  assert.equal(resolveModuleSpecifier('src/a.ts', './b.ts', files), 'src/b.ts')
  // A NodeNext import writes `.js` while the file on disk is `.ts`; that is the common case.
  assert.equal(resolveModuleSpecifier('src/a.ts', './b.js', files), 'src/b.ts')
  assert.equal(resolveModuleSpecifier('src/a.ts', './c', files), 'src/c/index.ts')
  assert.equal(resolveModuleSpecifier('pkg/a.py', 'pkg.b', files), 'pkg/b.py')
  assert.equal(resolveModuleSpecifier('src/a.ts', 'lodash', files), null)
})

test('the graph is derived from imports, skips self-edges, and resolves package aliases', () => {
  write('packages/core/package.json', JSON.stringify({ name: '@app/core' }))
  write('packages/core/src/entity.ts', 'export const x = 1\n')
  // An import inside one module is not coupling; counting it would make every large module a hub.
  write('packages/core/src/other.ts', "import { x } from './entity.ts'\n")
  write('packages/cli/package.json', JSON.stringify({ name: '@app/cli' }))
  write(
    'packages/cli/src/main.ts',
    ["import { x } from '@app/core'", "import { y } from '@app/core/src/entity.ts'", "import 'lodash'", "import { z } from './local.ts'"].join('\n'),
  )
  write('packages/cli/src/local.ts', 'export const z = 1\n')

  const graph = buildModuleGraph(root, { coChange: false })
  assert.deepEqual(
    graph.modules.map((module) => module.id).sort(),
    ['packages/cli', 'packages/core'],
  )
  // `lodash` is external and counts as unresolved rather than being mapped onto a guess.
  assert.equal(graph.unresolved, 1)

  const edge = directModuleEdge(graph, 'packages/cli', 'packages/core')
  assert.ok(edge)
  assert.equal(edge.kind, 'import')
  assert.equal(edge.weight, 2)
  assert.equal(directModuleEdge(graph, 'packages/core', 'packages/cli'), null)
  assert.equal(graph.edges.filter((candidate) => candidate.from === 'packages/core').length, 0)
})

test('the scan skips node_modules and dotted directories', () => {
  write('src/a.ts', 'export const a = 1\n')
  write('node_modules/pkg/i.ts', "import '../src/a.ts'\n")
  write('.cache/j.ts', 'export const j = 1\n')
  const graph = buildModuleGraph(root, { coChange: false })
  assert.deepEqual(
    graph.modules.map((module) => module.id),
    ['src'],
  )
})

test('two builds of one unchanged tree are identical, which is what makes the cache trustworthy', () => {
  write('src/a.ts', "import { b } from './b.ts'\n")
  write('src/b.ts', 'export const b = 1\n')
  assert.deepEqual(buildModuleGraph(root, { coChange: false }), buildModuleGraph(root, { coChange: false }))
})

test('core modules are ranked by import degree', () => {
  write('core/a.ts', 'export const a = 1\n')
  write('one/b.ts', "import { a } from '../core/a.ts'\n")
  write('two/b.ts', "import { a } from '../core/a.ts'\n")
  const graph = buildModuleGraph(root, { coChange: false })
  const core = graph.modules.find((module) => module.id === 'core')
  assert.equal(core?.fanIn, 2)
  assert.equal(core?.fanOut, 0)
  assert.equal(coreModules(graph, 3)[0].id, 'core')

  const detail = moduleDetail(graph, 'core')
  assert.deepEqual(detail?.dependedOnBy, ['one', 'two'])
  assert.deepEqual(detail?.dependsOn, [])
  assert.equal(moduleDetail(graph, 'nope'), null)
})

test('routing travels import edges only, and a co-change edge never widens it', () => {
  write('a/one.ts', 'export const one = 1\n')
  write('b/two.ts', "import { one } from '../a/one.ts'\n")
  write('c/three.ts', 'export const three = 1\n')
  const graph = buildModuleGraph(root, { coChange: false })
  assert.deepEqual([...moduleNeighborhood(graph, 'a', 'off')], ['a'])
  assert.deepEqual([...moduleNeighborhood(graph, 'a', 'one-hop')].sort(), ['a', 'b'])
  assert.deepEqual([...moduleNeighborhood(graph, 'a', 'transitive')].sort(), ['a', 'b'])
  assert.equal(moduleNeighborhood(graph, 'a', 'one-hop').has('c'), false)

  // A co-change edge is not a dependency, so it is neither structural coupling nor a route.
  const fabricated: ModuleGraph = {
    version: 1,
    root: '/r',
    fingerprint: 'f',
    modules: [],
    edges: [{ from: 'a', to: 'b', kind: 'co-change', weight: 9 }],
    byPath: {},
    unresolved: 0,
    unparsed: 0,
    truncated: false,
  }
  assert.equal(directModuleEdge(fabricated, 'a', 'b'), null)
  assert.equal(isStructuralModuleCoupling('co-change'), false)
  assert.equal(isStructuralModuleCoupling('import'), true)
  assert.deepEqual([...moduleNeighborhood(fabricated, 'a', 'transitive')], ['a'])
})

test('transitive routing is bounded by moduleHops, and one-hop ignores the bound', () => {
  write('a/one.ts', 'export const one = 1\n')
  write('b/two.ts', "import { one } from '../a/one.ts'\n")
  write('c/three.ts', "import { two } from '../b/two.ts'\n")
  const graph = buildModuleGraph(root, { coChange: false })

  assert.deepEqual([...moduleNeighborhood(graph, 'a', 'one-hop')].sort(), ['a', 'b'])
  // `one-hop` is fixed at one edge whatever the hop bound says; the bound only widens transitive.
  assert.deepEqual([...moduleNeighborhood(graph, 'a', 'one-hop', 5)].sort(), ['a', 'b'])
  assert.deepEqual([...moduleNeighborhood(graph, 'a', 'transitive', 1)].sort(), ['a', 'b'])
  assert.deepEqual([...moduleNeighborhood(graph, 'a', 'transitive', 2)].sort(), ['a', 'b', 'c'])
  // A depth past the graph is the whole reachable set, which is what `moduleDetail` reports.
  assert.deepEqual([...moduleNeighborhood(graph, 'a', 'transitive', 99)].sort(), ['a', 'b', 'c'])
})

test('moduleHops is a validated whole number and the CLI refuses what the reader refuses', () => {
  assert.equal(DEFAULT_CONFIG.moduleHops, 2)
  assert.equal(resolveModuleHops(undefined), 2)
  assert.equal(resolveModuleHops(3), 3)
  assert.equal(resolveModuleHops('4'), 4)
  assert.throws(() => resolveModuleHops(0), /moduleHops/)
  assert.throws(() => resolveModuleHops(1.5), /moduleHops/)
  assert.throws(() => resolveModuleHops(MAX_MODULE_HOPS + 1), /moduleHops/)
  assert.deepEqual(parseTunable('moduleHops', '3'), { key: 'moduleHops', value: 3 })
  assert.throws(() => parseTunable('moduleHops', '2.5'), /moduleHops/)
})

test('module contention groups contested entities by module, and decides nothing', () => {
  const record = (path: string, tasks: string[], sessions: string[], touches = 1): ContentionRecord => ({
    entityKey: `file::${path}`,
    kind: 'file',
    identifier: path,
    path,
    tasks,
    sessions,
    intents: [],
    touches,
  })
  const view = moduleContention([
    record('packages/core/src/entity.ts', ['t1', 't2'], ['s1', 's2'], 3),
    record('packages/core/src/ledger.ts', ['t1', 't2'], ['s1', 's2'], 1),
    record('packages/cli/src/main.ts', ['t3'], ['s3', 's4'], 2),
  ])
  assert.deepEqual(view.map((entry) => entry.module), ['packages/core', 'packages/cli'])
  assert.equal(view[0].entities, 2)
  assert.equal(view[0].touches, 4)
  assert.deepEqual(view[0].tasks, ['t1', 't2'])
  // A module with contention is a place, not a verdict: the view carries counts only, and the
  // "shared module is never on its own evidence" rule stays in `isStructuralModuleCoupling`.
  assert.equal('conflict' in view[0], false)
})

test('moduleGraphFor caches by fingerprint and rebuilds when a file changes', () => {
  write('src/a.ts', 'export const a = 1\n')
  const paths = ensureWorkspace(root)
  const first = moduleGraphFor(paths, { coChange: false })
  assert.ok(existsSync(join(paths.state, 'modules.json')))

  const second = moduleGraphFor(paths, { coChange: false })
  assert.equal(second.fingerprint, first.fingerprint)

  // Different size guarantees a different fingerprint even on a filesystem with coarse mtimes.
  write('src/a.ts', 'export const aaaa = 1\n')
  const third = moduleGraphFor(paths, { coChange: false })
  assert.notEqual(third.fingerprint, first.fingerprint)
  assert.equal(third.modules.find((module) => module.id === 'src')?.fileCount, 1)
})

test('moduleRouting is a validated setting that defaults to one-hop', () => {
  assert.equal(DEFAULT_CONFIG.moduleRouting, 'one-hop')
  assert.equal(resolveModuleRouting('off'), 'off')
  assert.equal(resolveModuleRouting('transitive'), 'transitive')
  assert.throws(() => resolveModuleRouting('nope'), /moduleRouting/)
  assert.deepEqual(parseTunable('moduleRouting', 'transitive'), { key: 'moduleRouting', value: 'transitive' })
  assert.throws(() => parseTunable('moduleRouting', 'nope'), /moduleRouting must be one of/)
})

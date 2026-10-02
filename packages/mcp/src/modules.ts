/**
 * `agentgit_modules` — the coupling graph the code declares, for a window that wants to know
 * what its change can reach before it writes.
 *
 * Read-only, and derived rather than declared: it answers "who imports this module", "what does
 * it import", and "which modules are within reach" from the imports already in the tree, so a
 * window does not have to write its dependencies down for this to work. That is the whole point
 * of having it as a tool: the declared path (`agentgit_impact_state`) only sees an agent that
 * filled it in, and the module graph sees everyone else.
 *
 * @module @agentgit/mcp/modules
 */

import { moduleDetail, moduleGraphFor, moduleGraphView, moduleIdOf } from '@agentgit/core'
import type { ToolDefinition } from './tools.ts'

function str(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function listOrNone(values: readonly string[]): string {
  return values.length === 0 ? '(none)' : values.join(', ')
}

export const MODULE_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'agentgit_modules',
    title: 'Module coupling graph for this workspace',
    description:
      'Read the module dependency graph derived mechanically from the imports in this workspace. Without arguments it ' +
      'returns every module with its fan-in, fan-out and the core modules, which is the fastest way to see what a change ' +
      'is likely to reach. Pass `module` (or `path`) to get one module\'s dependencies, dependents and transitive reach. ' +
      'Safe to call at any time; it writes nothing and decides nothing — a shared module is never by itself evidence of ' +
      'shared work.',
    inputSchema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'A module id, as reported by a previous call, to inspect on its own.' },
        path: {
          type: 'string',
          description: 'A workspace-relative file whose module to inspect; resolves through the same boundary rule as the graph.',
        },
        limit: { type: 'number', description: 'How many core (highest-coupling) modules to report. Defaults to 5.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler(args, context) {
      const graph = moduleGraphFor(context.identity.paths)
      const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : 5
      const path = str(args, 'path')
      const target = str(args, 'module') ?? (path ? moduleIdOf(path).id : null)

      if (target) {
        const detail = moduleDetail(graph, target)
        if (!detail) {
          return {
            text: `No module '${target}'. Known modules: ${graph.modules.map((module) => module.id).join(', ')}`,
            isError: true,
          }
        }
        const text = [
          `module ${target}`,
          `files         : ${detail.module?.fileCount ?? 0}`,
          `depends on    : ${listOrNone(detail.dependsOn)}`,
          `depended on by: ${listOrNone(detail.dependedOnBy)}`,
          `reaches       : ${listOrNone(detail.reaches)}`,
          `changed with  : ${listOrNone(detail.coChangedWith)}`,
          '',
          'A change here can reach every module above. A routed search visits that set; an import edge in either',
          'direction is what puts a module in it. "Changed with" is git history and is never counted as coupling.',
        ].join('\n')
        return { text, structured: detail }
      }

      const view = moduleGraphView(graph, { limit })
      const lines = [
        `module coupling: ${view.moduleCount} module(s), ${view.importEdges} import edge(s), ` +
          `${view.coChangeEdges} co-change edge(s), ${view.unresolved} unresolved specifier(s)` +
          `${view.truncated ? ', scan hit its file cap' : ''}`,
        'core modules, highest coupling first (imports only)',
      ]
      if (view.core.length === 0) {
        lines.push('  none: no module imports another, so there is nothing to route a change through')
      } else {
        for (const module of view.core) {
          lines.push(`  ${module.id}  (hub ${module.hubScore}); imported by ${module.fanIn}, imports ${module.fanOut}`)
        }
      }
      lines.push('')
      lines.push('Ask about one with module="<id>" or path="<workspace-relative file>".')
      lines.push('A shared module is not a shared task: coupling is evidence only when a real import points one way')
      lines.push('and a contract or an interface actually moves.')
      return { text: lines.join('\n'), structured: view }
    },
  },
]

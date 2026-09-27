import { readFileSync } from 'node:fs'
import { checksFile, checkPrompt, configureChecks, editChecks, readChecks, reserveCheck, syncChecks, updateCheck, type WorkspacePaths } from '@agentgit/core'
import type { ParsedArgs } from './args.ts'
import { beginSetup, endSetup } from '@agentgit/core'

/** JSON output is deliberately the same for a person, an MCP caller and the coordinating chat. */
export function cmdChecks(args: ParsedArgs, paths: WorkspacePaths): number {
  const required = (name: string): string => { const value = args.value(name); if (!value) throw new Error(`Missing --${name}`); return value }
  let result: unknown
  switch (args.subcommand ?? 'status') {
    case 'begin-setup': result = beginSetup(paths, required('thread')); break
    case 'end-setup': endSetup(paths, required('thread')); result = { released: true }; break
    case 'enable': result = configureChecks(paths, required('coordinator'), required('codex')); break
    case 'disable': result = editChecks(paths, state => { if (state.config) state.config.enabled = false; return state }); break
    case 'scan': result = syncChecks(paths); break
    case 'reserve': {
      const job = reserveCheck(paths, required('id'), required('thread'))
      result = { ...job, prompt: checkPrompt(job, paths.root) }; break
    }
    case 'sent': result = updateCheck(paths, required('id'), required('token'), required('thread'), 'sent'); break
    case 'reply':
    case 'fail': {
      // File input avoids shell quoting bugs in multi-line agent responses.
      const body = args.value('result-file') ? readFileSync(required('result-file'), 'utf8') : required('result')
      result = updateCheck(paths, required('id'), required('token'), required('thread'), args.subcommand === 'reply' ? 'replied' : 'failed', body); break
    }
    case 'status': result = readChecks(paths); break
    default: throw new Error('checks: expected begin-setup, end-setup, enable, disable, scan, status, reserve, sent, reply or fail')
  }
  process.stdout.write(`${JSON.stringify({ file: checksFile(paths), result }, null, 2)}\n`)
  return 0
}

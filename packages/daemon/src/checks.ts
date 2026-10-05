import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { checksFile, editChecks, needsWake, readChecks, recordWake, syncChecks, type WorkspacePaths } from '@agentgit/core'

export type WakeSender = (executable: string, thread: string, message: string, cwd: string) => Promise<void>

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

function mtimeOf(file: string): number {
  try { return statSync(file).mtimeMs } catch { return 0 }
}

/**
 * The Codex executable a wake is delivered through.
 *
 * `checks enable` records one absolute path once, and the Codex desktop installs each update
 * into a new hashed `bin/<hash>/` directory. The recorded path therefore goes stale on an
 * update, and a wake sent through a path that no longer exists fails every time — which looks
 * exactly like a workspace with nothing to coordinate. So the recorded value is preferred
 * while it is still there, and when it is gone the nearest fresh executable is found instead:
 * a sibling build directory first, then the canonical per-user install, then `PATH`.
 *
 * Options exist so a test can drive this over a fixed tree and a fixed environment.
 */
export function resolveCodexExecutable(
  recorded: string,
  options: {
    readonly env?: NodeJS.ProcessEnv
    readonly platform?: NodeJS.Platform
    readonly exists?: (file: string) => boolean
  } = {},
): string | null {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  const names = platform === 'win32' ? ['codex.exe'] : ['codex']

  if (recorded && exists(recorded)) return recorded

  const roots: string[] = []
  // Sibling builds of the recorded path: `<...>/Codex/bin/<hash>/codex.exe`.
  if (recorded) {
    const binRoot = dirname(dirname(recorded))
    if (binRoot && binRoot !== '.' && binRoot !== dirname(binRoot)) roots.push(binRoot)
  }
  // The canonical install location on Windows, whether or not anything was recorded.
  const localAppData = env.LOCALAPPDATA
  if (localAppData) roots.push(join(localAppData, 'OpenAI', 'Codex', 'bin'))

  const candidates: string[] = []
  for (const root of roots) {
    for (const entry of safeReaddir(root)) {
      for (const name of names) candidates.push(join(root, entry, name))
    }
  }
  // A `PATH` install, which is the POSIX shape and the fallback when no bin directory is known.
  for (const dir of (env.PATH ?? '').split(platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    for (const name of names) candidates.push(join(dir, name))
  }

  const found = candidates.filter((file) => exists(file))
  if (found.length === 0) return null
  // Newest first: a Codex update leaves the older build directories on disk.
  found.sort((a, b) => mtimeOf(b) - mtimeOf(a))
  return found[0]
}
export const queueChat: WakeSender = (executable, thread, message, cwd) => new Promise((done, reject) => {
  execFile(executable, ['queue', '--thread', thread, '--message', message, '--cd', cwd],
    { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 256_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}: ${stderr.slice(0, 1000)}`))
      else if (!stdout.includes('Queued message')) reject(new Error(`Queue acknowledgement missing: ${stdout.slice(0, 1000)}`))
      else done()
    })
})

/** One publisher owns a workspace. Failed sends retry at most three times, with a one-minute backoff. */
export function createChecksDispatcher(send: WakeSender = queueChat): { tick(paths: WorkspacePaths): Promise<void> } {
  const busy = new Set<string>()
  return {
    async tick(paths) {
      if (busy.has(paths.root) || !existsSync(checksFile(paths))) return
      busy.add(paths.root)
      try {
        if (!readChecks(paths).config?.enabled) return
        const state = syncChecks(paths)
        const key = needsWake(state)
        if (!key || !state.config) return
        // A recorded path that a Codex update has moved would make every wake fail silently,
        // so it is resolved first and the fresh path is written back for the next tick.
        const executable = resolveCodexExecutable(state.config.codex)
        if (!executable) {
          recordWake(paths, key, `No Codex executable found at ${state.config.codex}; run \`agentgit checks enable --codex <path>\``)
          return
        }
        if (executable !== state.config.codex) {
          editChecks(paths, next => { if (next.config) next.config.codex = executable })
        }
        const cli = resolve(import.meta.dirname, '../../cli/bin/agentgit.mjs')
        const guide = resolve(import.meta.dirname, '../../../plugins/agentgit/skills/agentgit/references/coordinate.md')
        const message = `AgenticGit 自动协调唤醒 ${key}。用户已授权本聊天协调工作区 ${paths.root}。\n` +
          `请读取 ${guide} 并按其流程处理。用 Node ${process.execPath} 运行 CLI ${cli} 的 checks scan --workspace 参数，工作区为 ${paths.root}。\n` +
          '读取持久化队列，核对相关聊天属于该工作区，预留未发送的检查后通知它们，等待并记录真实回复。' +
          '已经发送的检查不要重复发送。对于无法映射的聊天、发送失败或超时，报告真实状态。' +
          '没有新情况则保持安静。此消息仅授权协调检查，不授权自动修改业务代码或合并。'
        try { await send(executable, state.config.coordinator, message, paths.root); recordWake(paths, key, null) }
        catch (error) { recordWake(paths, key, String(error).slice(0, 2000)) }
      } finally { busy.delete(paths.root) }
    },
  }
}

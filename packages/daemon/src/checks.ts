import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { checksFile, needsWake, readChecks, recordWake, syncChecks, type WorkspacePaths } from '@agentgit/core'

export type WakeSender = (executable: string, thread: string, message: string, cwd: string) => Promise<void>
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
        const cli = resolve(import.meta.dirname, '../../cli/bin/agentgit.mjs')
        const guide = resolve(import.meta.dirname, '../../../plugins/agentgit/skills/agentgit/references/coordinate.md')
        const message = `AgenticGit 自动协调唤醒 ${key}。用户已授权本聊天协调工作区 ${paths.root}。\n` +
          `请读取 ${guide} 并按其流程处理。用 Node ${process.execPath} 运行 CLI ${cli} 的 checks scan --workspace 参数，工作区为 ${paths.root}。\n` +
          '读取持久化队列，核对相关聊天属于该工作区，预留未发送的检查后通知它们，等待并记录真实回复。' +
          '已经发送的检查不要重复发送。对于无法映射的聊天、发送失败或超时，报告真实状态。' +
          '没有新情况则保持安静。此消息仅授权协调检查，不授权自动修改业务代码或合并。'
        try { await send(state.config.codex, state.config.coordinator, message, paths.root); recordWake(paths, key, null) }
        catch (error) { recordWake(paths, key, String(error).slice(0, 2000)) }
      } finally { busy.delete(paths.root) }
    },
  }
}

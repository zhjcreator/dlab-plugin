/**
 * RunnerPort implementation that spawns detached processes and tees
 * stdout/stderr into the run log directory. In host mode the caller should
 * prefer a SubprocessPort wrapper around ctx.subprocess; this plain version
 * is what CLI mode uses and what integration tests exercise.
 */

import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { mkdirSync, createWriteStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tailFile } from './log-tee.js'
import type { RunnerPort } from '@dlab/core'

interface LiveProcess {
  child: ChildProcess
  logDir: string
}

export class LocalRunner implements RunnerPort {
  private readonly live = new Map<string, LiveProcess>()

  async spawn(opts: {
    cwd: string
    argv: string[]
    env: Record<string, string>
    logDir: string
  }): Promise<{ pid: number; pgid?: number }> {
    mkdirSync(opts.logDir, { recursive: true })
    const out = createWriteStream(join(opts.logDir, 'stdout.log'), { flags: 'a' })
    const err = createWriteStream(join(opts.logDir, 'stderr.log'), { flags: 'a' })
    if (opts.argv.length === 0) throw new Error('spawn failed: argv is empty')
    const child = spawn(opts.argv[0]!, opts.argv.slice(1), {
      cwd: opts.cwd || undefined,
      env: { ...process.env, ...opts.env },
      detached: true,
      stdio: ['ignore', out, err] as StdioOptions,
    }) as ChildProcess
    const pid = child.pid
    if (pid === undefined) throw new Error('spawn failed: no pid')
    const pgid = pid // detached child becomes its own process-group leader on POSIX

    child.on('exit', () => {
      out.end()
      err.end()
    })

    this.live.set(opts.cwd ?? '', { child, logDir: opts.logDir })
    return { pid, pgid }
  }

  /** Track runs by a stable key passed through opts (skeleton: caller passes run dir as cwd). */
  private keyFor(runId: string): string | undefined {
    for (const [k, v] of this.live) {
      if (k.includes(runId)) return k
    }
    return undefined
  }

  async stop(runId: string): Promise<void> {
    const key = this.keyFor(runId)
    const entry = key ? this.live.get(key) : undefined
    if (!entry || !key) return
    try {
      process.kill(-entry.child.pid!, 'SIGTERM')
    } catch {
      entry.child.kill('SIGTERM')
    }
    this.live.delete(key)
  }

  async isAlive(runId: string): Promise<boolean> {
    const key = this.keyFor(runId)
    const entry = key ? this.live.get(key) : undefined
    if (!entry) return false
    try {
      process.kill(entry.child.pid!, 0)
      return true
    } catch {
      return false
    }
  }

  async tail(runId: string, maxLines: number): Promise<string> {
    const key = this.keyFor(runId)
    const entry = key ? this.live.get(key) : undefined
    const logDir = entry?.logDir
    if (!logDir || !existsSync(join(logDir, 'stdout.log'))) return ''
    return tailFile(join(logDir, 'stdout.log'), maxLines)
  }
}

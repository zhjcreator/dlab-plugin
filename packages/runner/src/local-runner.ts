/**
 * RunnerPort implementation that spawns detached processes and tees
 * stdout/stderr into the run log directory. Tracks live processes by a
 * stable key (the run id) so stop/isAlive/tail address the right process
 * even when several runs share a working directory.
 *
 * In host mode the caller may prefer a SubprocessPort wrapper around
 * ctx.subprocess; this plain version is what CLI mode uses and what
 * integration tests exercise.
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, openSync, closeSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tailFile } from './log-tee.js'
import { isPidAlive } from './reconcile.js'
import type { RunnerPort } from '@dsh-lab/core'

const execFileAsync = promisify(execFile)

interface LiveProcess {
  child: ChildProcess
  logDir: string
}

export class LocalRunner implements RunnerPort {
  private readonly live = new Map<string, LiveProcess>()

  async spawn(opts: {
    key?: string
    cwd: string
    argv: string[]
    env: Record<string, string>
    logDir: string
    onExit?: (code: number | null) => void
  }): Promise<{ pid: number; pgid?: number }> {
    if (opts.argv.length === 0) throw new Error('spawn failed: argv is empty')
    mkdirSync(opts.logDir, { recursive: true })
    // fs streams are rejected as stdio; pass append-mode file descriptors
    const outFd = openSync(join(opts.logDir, 'stdout.log'), 'a')
    const errFd = openSync(join(opts.logDir, 'stderr.log'), 'a')
    let child: ChildProcess
    try {
      child = spawn(opts.argv[0]!, opts.argv.slice(1), {
        cwd: opts.cwd || undefined,
        env: { ...process.env, ...opts.env },
        detached: true,
        stdio: ['ignore', outFd, errFd],
      }) as ChildProcess
    } catch (error) {
      closeSync(outFd)
      closeSync(errFd)
      throw error
    }
    const pid = child.pid
    if (pid === undefined) {
      closeSync(outFd)
      closeSync(errFd)
      throw new Error('spawn failed: no pid')
    }
    const pgid = pid // detached child becomes its own process-group leader on POSIX
    // the child dups the fds; close the parent copies
    closeSync(outFd)
    closeSync(errFd)

    child.on('exit', (code) => {
      const key = opts.key ?? opts.cwd
      if (this.live.get(key)?.child === child) this.live.delete(key)
      opts.onExit?.(code)
    })

    this.live.set(opts.key ?? opts.cwd, { child, logDir: opts.logDir })
    return { pid, pgid }
  }

  async stop(runId: string): Promise<void> {
    const entry = this.live.get(runId)
    if (!entry) return
    try {
      // signal the whole detached process group first
      process.kill(-entry.child.pid!, 'SIGTERM')
    } catch {
      try {
        entry.child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }

  async isAlive(runId: string): Promise<boolean> {
    const entry = this.live.get(runId)
    if (!entry) return false
    return isPidAlive(entry.child.pid!)
  }

  isPidAlive(pid: number): boolean {
    return isPidAlive(pid)
  }

  async tail(runId: string, maxLines: number): Promise<string> {
    const entry = this.live.get(runId)
    const logDir = entry?.logDir
    if (!logDir || !existsSync(join(logDir, 'stdout.log'))) return ''
    return tailFile(join(logDir, 'stdout.log'), maxLines)
  }

  /**
   * Probe the shared .venv for the environment fingerprint: python version
   * and pip freeze. Falls back to the system python when no venv exists.
   */
  async probeEnvironment(projectRoot: string): Promise<{
    fingerprint: string
    pythonVersion?: string
    requirements?: string
  }> {
    const venvPython = join(projectRoot, '.venv', 'bin', 'python')
    const python = existsSync(venvPython) ? venvPython : 'python3'
    let pythonVersion: string | undefined
    let requirements: string | undefined
    try {
      const { stdout } = await execFileAsync(python, ['--version'])
      pythonVersion = stdout.trim().replace(/^Python\s+/i, '')
    } catch {
      /* no python available — fingerprint degrades to python-less */
    }
    try {
      const { stdout } = await execFileAsync(python, ['-m', 'pip', 'freeze'])
      requirements = stdout.trim()
    } catch {
      /* pip unavailable */
    }
    const hash = createHash('sha256')
    hash.update(pythonVersion ?? 'no-python')
    hash.update('\0')
    hash.update(requirements ?? 'no-requirements')
    return { fingerprint: `env:${hash.digest('hex').slice(0, 12)}`, pythonVersion, requirements }
  }
}

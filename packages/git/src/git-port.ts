/**
 * GitPort implementation using the `git` CLI (execFile, never shell).
 *
 * This is the ONLY module in the whole plugin that may spawn `git`.
 * Business code must go through GitPort defined in @dlab/core.
 *
 * Phase-1 skeleton: signatures + one safe exec helper. The worktree and
 * merge internals are filled in next.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import type { GitPort } from '@dlab/core'
import type { GitStatus } from '@dlab/shared'

const execFileAsync = promisify(execFile)

export interface LocalGitOptions {
  gitDir: string // absolute path to .dsh-lab/repo.git (bare)
  worktreeRoot: string // absolute path to solutions/ dir
}

type RunResult = { stdout: string; stderr: string }

export class LocalGitPort implements GitPort {
  readonly gitDir: string
  readonly worktreeRoot: string

  constructor(opts: LocalGitOptions) {
    this.gitDir = opts.gitDir
    this.worktreeRoot = opts.worktreeRoot
  }

  /** Run git inside the bare repo with an optional work-tree override. */
  private async run(args: string[], opts: { cwd?: string } = {}): Promise<RunResult> {
    const full = [
      ...(opts.cwd ? [] : ['--git-dir', this.gitDir]),
      ...(opts.cwd ? ['-C', opts.cwd] : []),
      ...args,
    ]
    try {
      const { stdout, stderr } = await execFileAsync('git', full, { maxBuffer: 64 * 1024 * 1024 })
      return { stdout: stdout.toString(), stderr: stderr.toString() }
    } catch (error) {
      const e = error as { stdout?: Buffer | string; stderr?: Buffer | string; code?: number }
      const out = (e.stdout?.toString?.() ?? '').trim()
      const errText = (e.stderr?.toString?.() ?? '').trim()
      const detail = errText || out || String(error)
      const wrapped = new Error(`git ${args.join(' ')} failed: ${detail}`) as Error & {
        stdout?: string
        stderr?: string
      }
      wrapped.stdout = out
      wrapped.stderr = errText
      throw wrapped
    }
  }

  async initBare(): Promise<void> {
    await this.run(['init', '--bare', this.gitDir])
  }

  async importFrom(sourceRepo: string): Promise<void> {
    await this.run(['clone', '--bare', sourceRepo, this.gitDir])
  }

  async branchExists(branch: string): Promise<boolean> {
    const { stdout } = await this.run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
      .then(() => ({ stdout: 'yes' }))
      .catch(() => ({ stdout: '' }))
    return stdout === 'yes'
  }

  async createBranch(branch: string, startPoint: string): Promise<void> {
    await this.run(['branch', branch, startPoint])
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.run(['branch', '-D', branch]).catch(() => undefined)
  }

  async branchHead(branch: string): Promise<string> {
    const { stdout } = await this.run(['rev-parse', `refs/heads/${branch}`])
    return stdout.trim()
  }

  async listWorktrees(): Promise<{ path: string; branch: string | null; detached: boolean; head: string }[]> {
    const { stdout } = await this.run(['worktree', 'list', '--porcelain'])
    const out: { path: string; branch: string | null; detached: boolean; head: string }[] = []
    let cur: { path: string; branch: string | null; detached: boolean; head: string } | null = null
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (cur) out.push(cur)
        cur = { path: line.slice('worktree '.length).trim(), branch: null, detached: false, head: '' }
      } else if (cur && line.startsWith('branch ')) {
        cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
      } else if (cur && line.startsWith('detached')) {
        cur.detached = true
      } else if (cur && line.startsWith('HEAD ')) {
        cur.head = line.slice('HEAD '.length).trim()
      }
    }
    if (cur) out.push(cur)
    return out
  }

  async addWorktree(path: string, branchOrCommit: string, opts: { detach?: boolean } = {}): Promise<void> {
    const dir = resolve(this.worktreeRoot, path)
    const args = opts.detach
      ? ['worktree', 'add', '--detach', dir, branchOrCommit]
      : ['worktree', 'add', dir, branchOrCommit]
    await this.run(args, { cwd: this.gitDir })
  }

  async removeWorktree(path: string, opts: { force?: boolean } = {}): Promise<void> {
    const dir = resolve(this.worktreeRoot, path)
    await this.run(opts.force ? ['worktree', 'remove', '--force', dir] : ['worktree', 'remove', dir], {
      cwd: this.gitDir,
    }).catch(() => {
      // worktree already gone is fine
      return undefined
    })
  }

  async getStatus(path: string): Promise<GitStatus> {
    const dir = resolve(this.worktreeRoot, path)
    const { stdout: headOut } = await this.run(['rev-parse', 'HEAD'], { cwd: dir })
    const headCommit = headOut.trim()
    const { stdout: porcelain } = await this.run(['status', '--porcelain=v1', '-uno'], { cwd: dir })
    const { stdout: untracked } = await this.run(['ls-files', '--others', '--exclude-standard'], { cwd: dir })
    const modified: string[] = []
    const staged: string[] = []
    for (const line of porcelain.split('\n')) {
      if (!line) continue
      const xy = line.slice(0, 2)
      const file = line.slice(3)
      if (xy[0] !== ' ' && xy[0] !== '?') staged.push(file)
      if (xy[1] === 'M' || xy[1] === 'D' || xy[0] === 'M' || xy[0] === 'D') modified.push(file)
    }
    const untrackedList = untracked.split('\n').filter(Boolean)
    return { clean: modified.length === 0 && staged.length === 0 && untrackedList.length === 0, modified, untracked: untrackedList, staged, headCommit }
  }

  async commitAll(path: string, message: string): Promise<string> {
    const dir = resolve(this.worktreeRoot, path)
    await this.run(['add', '-A'], { cwd: dir })
    const commitOut = await this.run(['commit', '-m', message], { cwd: dir }).catch((error: unknown) => {
      const e = error as { message?: string; stdout?: string; stderr?: string }
      const text = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n')
      // 'nothing to commit' is a legitimate no-op (clean checkpoint)
      if (text.includes('nothing to commit') || text.includes('nothing added to commit')) return { stdout: '', stderr: '' }
      throw error
    })
    void commitOut
    const { stdout } = await this.run(['rev-parse', 'HEAD'], { cwd: dir })
    return stdout.trim()
  }

  async commitTreeSnapshot(path: string, refName: string, message: string): Promise<string> {
    // Snapshot implementation uses a temporary GIT_INDEX_FILE; skeleton for Phase 1.
    throw new Error('commitTreeSnapshot(): not implemented yet')
  }

  async updateRef(refName: string, commit: string): Promise<void> {
    await this.run(['update-ref', refName, commit])
  }

  async mergeBase(a: string, b: string): Promise<string> {
    const { stdout } = await this.run(['merge-base', a, b])
    return stdout.trim()
  }

  async mergePreflight(
    targetBranch: string,
    sourceBranch: string,
  ): Promise<{ conflictFiles: string[]; clean: boolean }> {
    // `git merge-tree --write-tree <target> <source>` reports conflicts on
    // stderr / exit code without touching any worktree.
    try {
      const { stdout } = await this.run(['merge-tree', '--write-tree', targetBranch, sourceBranch])
      // On success stdout carries the resulting tree oid; no conflicts.
      return { conflictFiles: [], clean: true }
    } catch (error) {
      const msg = String((error as { message?: string })?.message ?? error)
      const conflictFiles = parseMergeTreeConflicts(msg)
      return { conflictFiles, clean: false }
    }
  }

  async mergeInWorktree(path: string, targetBranch: string, sourceBranch: string): Promise<string> {
    const dir = resolve(this.worktreeRoot, path)
    await this.run(['merge', '--no-ff', sourceBranch, '-m', `[dsh-lab] merge ${sourceBranch} into ${targetBranch}`], {
      cwd: dir,
    })
    const { stdout } = await this.run(['rev-parse', 'HEAD'], { cwd: dir })
    return stdout.trim()
  }

  async squashMergeInWorktree(
    path: string,
    targetBranch: string,
    sourceBranch: string,
    message: string,
  ): Promise<string> {
    const dir = resolve(this.worktreeRoot, path)
    await this.run(['merge', '--squash', sourceBranch], { cwd: dir })
    await this.run(['commit', '-m', message], { cwd: dir })
    const { stdout } = await this.run(['rev-parse', 'HEAD'], { cwd: dir })
    return stdout.trim()
  }

  async diff(
    baseRef: string | undefined,
    a: string,
    b: string,
  ): Promise<{ changedFiles: { status: 'A' | 'M' | 'D'; path: string }[]; patch?: string }> {
    const range = baseRef ? `${baseRef}...${b}` : `${a}...${b}`
    const { stdout: nameStatus } = await this.run(['diff', '--name-status', range])
    const changedFiles = nameStatus
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, path] = line.split('\t')
        return { status: (status === 'A' ? 'A' : status === 'D' ? 'D' : 'M') as 'A' | 'M' | 'D', path: path ?? '' }
      })
    const { stdout: patch } = await this.run(['diff', '--no-color', range])
    return { changedFiles, patch }
  }

  async changedFilesBetween(a: string, b: string): Promise<{ status: 'A' | 'M' | 'D'; path: string }[]> {
    return (await this.diff(undefined, a, b)).changedFiles
  }
}

/** Heuristic parse of `git merge-tree --write-tree` conflict stderr lines. */
function parseMergeTreeConflicts(message: string): string[] {
  const files = new Set<string>()
  for (const line of message.split('\n')) {
    // modern git emits: CONFLICT (content): Merge conflict in <path>
    const m = /CONFLICT \(.*?\): Merge conflict in (.+)$/.exec(line.trim())
    if (m?.[1]) files.add(m[1])
  }
  // fallback: lines that name a file with "<<<<<<<" markers
  if (files.size === 0) {
    for (const line of message.split('\n')) {
      if (line.includes('<<<<<<<') || line.includes('=======') || line.includes('>>>>>>>')) {
        const nearby = line.trim()
        if (nearby) files.add(nearby.slice(0, 80))
      }
    }
  }
  return [...files]
}

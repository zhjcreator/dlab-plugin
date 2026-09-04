/**
 * GitPort implementation using the `git` CLI (execFile, never shell).
 *
 * This is the ONLY module in the whole plugin that may spawn `git`.
 * Business code must go through GitPort defined in @dlab/core.
 *
 * Phase-1 skeleton: signatures + one safe exec helper. The worktree and
 * merge internals are filled in next.
 */

import { execFile, spawn } from 'node:child_process'
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
  private async run(
    args: string[],
    opts: { cwd?: string; input?: string } = {},
  ): Promise<RunResult> {
    const full = [
      ...(opts.cwd ? [] : ['--git-dir', this.gitDir]),
      ...(opts.cwd ? ['-C', opts.cwd] : []),
      ...args,
    ]
    try {
      const { stdout, stderr } = await execFileAsync('git', full, {
        maxBuffer: 64 * 1024 * 1024,
        ...(opts.input !== undefined ? { input: opts.input } : {}),
      })
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

  async currentHeadBranch(): Promise<string | undefined> {
    try {
      const { stdout } = await this.run(['symbolic-ref', '--short', 'HEAD'])
      const name = stdout.trim()
      return name || undefined
    } catch {
      return undefined // empty repository: HEAD points at an unborn branch
    }
  }

  /**
   * Run git with content on stdin. execFile's `input` option is silently
   * ignored (stdin stays an open pipe), so this uses spawn directly.
   */
  private runWithStdin(args: string[], input: string): Promise<RunResult> {
    const full = ['--git-dir', this.gitDir, ...args]
    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn('git', full, { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      child.on('error', (err: Error) => reject(err))
      child.on('close', (code: number | null) => {
        if (code === 0) resolve({ stdout, stderr })
        else reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim() || stdout.trim()}`))
      })
      child.stdin.write(input)
      child.stdin.end()
    })
  }

  async bootstrapBranchWithEmptyCommit(
    branch: string,
    message: string,
    files: Record<string, string> = {},
  ): Promise<string> {
    // build a root tree from the given files via plumbing
    let tree: string
    const entries: string[] = []
    for (const [path, content] of Object.entries(files)) {
      const blob = await this.runWithStdin(['hash-object', '-w', '--stdin'], content)
      entries.push(`100644 blob ${blob.stdout.trim()}\t${path}`)
    }
    if (entries.length > 0) {
      const mktree = await this.runWithStdin(['mktree'], entries.join('\n'))
      tree = mktree.stdout.trim()
    } else {
      // git's well-known empty tree object
      tree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
    }
    const { stdout: commitOut } = await this.run(['commit-tree', tree, '-m', message])
    const commit = commitOut.trim()
    await this.run(['update-ref', `refs/heads/${branch}`, commit])
    // point HEAD at the new branch so later worktree adds resolve it
    await this.run(['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
    return commit
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
    // Modern form (git >= 2.38): `merge-tree --write-tree <target> <source>`
    // exits non-zero with conflict info on failure, zero on a clean merge.
    try {
      await this.run(['merge-tree', '--write-tree', targetBranch, sourceBranch])
      return { conflictFiles: [], clean: true }
    } catch (error) {
      const e = error as { message?: string; stdout?: string; stderr?: string }
      const text = [e.message, e.stdout, e.stderr].filter(Boolean).join('\n')
      // Unknown option / bad revision → old git without --write-tree support:
      // fall through to the legacy 3-arg form below. Anything else that looks
      // like a real conflict report is returned directly.
      if (!text.includes('unknown') && !text.includes('usage:') && !text.includes('Not a valid object')) {
        const conflictFiles = parseMergeTreeConflicts(text)
        return { conflictFiles, clean: conflictFiles.length === 0 }
      }
    }

    // Legacy form (git < 2.38): `merge-tree <base> <branch1> <branch2>` prints
    // the hypothetical merge; conflicts appear as 'changed in both' /
    // 'added in both' sections containing +<<<<<<< markers.
    const base = await this.mergeBase(targetBranch, sourceBranch)
    const { stdout } = await this.run(['merge-tree', base, targetBranch, sourceBranch])
    const conflictFiles = parseLegacyMergeTree(stdout)
    return { conflictFiles, clean: conflictFiles.length === 0 }
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
  return [...files]
}

/**
 * Parse the legacy 3-arg `git merge-tree <base> <b1> <b2>` output. A conflict
 * appears as a section header like `changed in both` / `added in both` /
 * `removed in both`, followed by `our`/`their` blob lines naming the file.
 * Only sections that actually contain a conflict marker are real conflicts;
 * clean both-sides changes produce no `+<<<<<<<` line.
 */
function parseLegacyMergeTree(stdout: string): string[] {
  const files = new Set<string>()
  const lines = stdout.split('\n')
  let sectionConflict = false
  let sectionPaths: string[] = []
  const flush = () => {
    if (sectionConflict) for (const p of sectionPaths) files.add(p)
    sectionConflict = false
    sectionPaths = []
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^(changed|added|removed) in (both|remote|local)/.test(line)) {
      flush()
      continue
    }
    // blob lines: "  our    100644 <sha> <path>"
    const m = /^  (?:our|their|result)\s+\d+ [0-9a-f]+ (.+)$/.exec(line)
    if (m?.[1]) {
      sectionPaths.push(m[1])
      continue
    }
    // section starts after the blob lines with the diff; a conflict marker
    // inside the diff body marks this section as a conflict
    if (line.startsWith('+<<<<<<<')) {
      sectionConflict = true
      continue
    }
    // a new file section begins at the next "added in"/"merged" header
    if (/^(merged|added in (remote|local))/.test(line)) {
      flush()
    }
  }
  flush()
  return [...files]
}

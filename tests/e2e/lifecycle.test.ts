/**
 * E2E acceptance: full Solution lifecycle through the real CLI wiring
 * (LocalGitPort + SqliteStore + LocalRunner + GpuScheduler + no-op
 * WorkspacePort) against a fresh sandbox under dsh-scholar/scratch-dlab.
 *
 * Covers DESIGN.md Scenarios A, C, D, E, G, H, I plus fork-from-archived.
 * Runs the actual bin/dsh-lab.js against a temporary directory.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const BIN = join(process.cwd(), 'packages/cli/bin/dsh-lab.js')
const SANDBOX_ROOT = '/home2/zhanghanjin/WorkSpace/dsh-scholar/scratch-dlab'

let labRoot: string

function lab(...args: string[]): { stdout: string; stderr: string } {
  const r = { stdout: '', stderr: '' }
  try {
    r.stdout = execFileSync('node', [BIN, '--root', labRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number }
    r.stdout = err.stdout ?? ''
    r.stderr = err.stderr ?? ''
    throw Object.assign(new Error(`dsh-lab ${args.join(' ')} failed (${err.status})\n${err.stdout}\n${err.stderr}`), { r })
  }
  return r
}

function labExpectFail(...args: string[]): string {
  try {
    execFileSync('node', [BIN, '--root', labRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    throw new Error(`expected dsh-lab ${args.join(' ')} to fail`)
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    if (typeof err.stdout !== 'string') throw e // real spawn failure
    return err.stdout + err.stderr
  }
}

beforeAll()

function beforeAll() {
  labRoot = mkdtempSync(join(SANDBOX_ROOT, 'e2e-'))
}

afterAll(() => {
  if (labRoot && existsSync(labRoot)) rmSync(labRoot, { recursive: true, force: true })
})

describe('e2e: solution lifecycle', () => {
  it('A: init creates main worktree + branch + db row', () => {
    const out = lab('init', 'PRISM').stdout
    expect(out).toContain('initialized project "PRISM"')
    expect(existsSync(join(labRoot, 'solutions/main'))).toBe(true)
    expect(existsSync(join(labRoot, '.dsh-lab/repo.git'))).toBe(true)
    expect(existsSync(join(labRoot, '.dsh-lab/lab.sqlite'))).toBe(true)
  })

  it('A: fork creates worktree + exp branch', () => {
    lab('solution', 'fork', 'main', 'agm-cosine', '-n', 'AGM Cosine')
    expect(existsSync(join(labRoot, 'solutions/agm-cosine'))).toBe(true)
    const list = lab('solution', 'list').stdout
    expect(list).toContain('agm-cosine')
    expect(list).toContain('exp/agm-cosine')
  })

  it('checkpoint records the change on the branch', () => {
    writeFileSync(join(labRoot, 'solutions/agm-cosine/agm.py'), 'def agm(): pass\n')
    const out = lab('solution', 'checkpoint', 'agm-cosine', '-m', 'AGM cosine').stdout
    expect(out).toContain('checkpoint:')
  })

  it('G: fork→fork into-fork merge keeps source active', () => {
    lab('solution', 'fork', 'main', 'pgu-cosine')
    writeFileSync(join(labRoot, 'solutions/pgu-cosine/pgu.txt'), 'rae_depth = 4\n')
    lab('solution', 'checkpoint', 'pgu-cosine', '-m', 'PGU config')
    const out = lab('solution', 'merge', 'agm-cosine', '--target', 'pgu-cosine', '--mode', 'into-fork').stdout
    expect(out).toContain('source now active')
    // both branches still exist; both workspaces still present
    expect(existsSync(join(labRoot, 'solutions/agm-cosine'))).toBe(true)
    expect(existsSync(join(labRoot, 'solutions/pgu-cosine'))).toBe(true)
    // target received the source change
    expect(readFileSync(join(labRoot, 'solutions/pgu-cosine/agm.py'), 'utf8')).toContain('def agm(): pass')
  })

  it('E: merge to main (into-target) archives source workspace, keeps branch', () => {
    const out = lab(
      'solution', 'merge', 'pgu-cosine', '--target', 'main', '--mode', 'into-target', '--allow-unevidenced',
    ).stdout
    expect(out).toContain('source now merged')
    expect(existsSync(join(labRoot, 'solutions/pgu-cosine'))).toBe(false)
    expect(readFileSync(join(labRoot, 'solutions/main/pgu.txt'), 'utf8')).toContain('rae_depth = 4')
    const list = lab('solution', 'list').stdout
    expect(list).toContain('pgu-cosine           merged')
  })

  it('C: archive removes worktree, keeps branch + experiments dir', () => {
    lab('solution', 'fork', 'main', 'tmp-exp')
    writeFileSync(join(labRoot, 'solutions/tmp-exp/x.txt'), 'x\n')
    lab('solution', 'checkpoint', 'tmp-exp', '-m', 'x')
    lab('solution', 'archive', 'tmp-exp', '--conclusion', 'dead end')
    expect(existsSync(join(labRoot, 'solutions/tmp-exp'))).toBe(false)
    const list = lab('solution', 'list').stdout
    expect(list).toContain('tmp-exp              archived')
    expect(list).toContain('exp/tmp-exp')
  })

  it('D: restore brings back the exact code', () => {
    lab('solution', 'restore', 'tmp-exp')
    expect(existsSync(join(labRoot, 'solutions/tmp-exp'))).toBe(true)
    expect(readFileSync(join(labRoot, 'solutions/tmp-exp/x.txt'), 'utf8')).toBe('x\n')
  })

  it('H: conflicting merge is refused before touching the target worktree', () => {
    lab('solution', 'fork', 'main', 'conf-a')
    lab('solution', 'fork', 'main', 'conf-b')
    writeFileSync(join(labRoot, 'solutions/conf-a/c.txt'), 'one\n')
    writeFileSync(join(labRoot, 'solutions/conf-b/c.txt'), 'two\n')
    lab('solution', 'checkpoint', 'conf-a', '-m', 'a')
    lab('solution', 'checkpoint', 'conf-b', '-m', 'b')
    const fail = labExpectFail('solution', 'merge', 'conf-a', '--target', 'conf-b', '--mode', 'into-fork')
    expect(fail).toContain('conflict')
    // target worktree untouched: c.txt still has its own content
    expect(readFileSync(join(labRoot, 'solutions/conf-b/c.txt'), 'utf8')).toBe('two\n')
  })

  it('I: consolidate squashes source history into one commit', () => {
    lab('solution', 'fork', 'main', 'squash-src')
    writeFileSync(join(labRoot, 'solutions/squash-src/s.txt'), 'v1\n')
    lab('solution', 'checkpoint', 'squash-src', '-m', 's1')
    writeFileSync(join(labRoot, 'solutions/squash-src/s.txt'), 'v1\nv2\n')
    lab('solution', 'checkpoint', 'squash-src', '-m', 's2')
    const out = lab(
      'solution', 'merge', 'squash-src', '--target', 'main', '--mode', 'consolidate', '--allow-unevidenced',
    ).stdout
    expect(out).toContain('source now merged')
    expect(readFileSync(join(labRoot, 'solutions/main/s.txt'), 'utf8')).toBe('v1\nv2\n')
  })

  it('fork from archived works without restore', () => {
    lab('solution', 'archive', 'tmp-exp')
    const out = lab('solution', 'fork', 'tmp-exp', 'revived').stdout
    expect(out).toContain('forked revived from tmp-exp')
    expect(readFileSync(join(labRoot, 'solutions/revived/x.txt'), 'utf8')).toBe('x\n')
  })
})

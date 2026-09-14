/**
 * Docs partitioning tests (DESIGN §26): shared documents live once, at the
 * project root, and every solution worktree reaches them through the link
 * `local/docs`.
 *
 * The properties asserted here are the ones the whole design rests on:
 *   1. the link exists in `main` and in every forked experiment, with the
 *      SAME relative target — so one git tree cannot mean two things;
 *   2. writing through the link writes the single root copy;
 *   3. `git add -A` inside a worktree never duplicates shared docs into the
 *      solution branch (git does not follow the symlink);
 *   4. archiving promotes local notes into docs/local/<slug>/ and leaves an
 *      immutable snapshot that survives the worktree's removal.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeDeps } from '../../packages/cli/lib/cli.js'
import { SolutionService, DocsService } from '../../packages/core/lib/index.js'
import type { LabDeps } from '../../packages/core/lib/index.js'

const SANDBOX_ROOT = '/home2/zhanghanjin/WorkSpace/dsh-scholar/scratch-dlab'

let labRoot: string
let deps: LabDeps
let docs: DocsService
let solutions: SolutionService

beforeAll(async () => {
  mkdirSync(SANDBOX_ROOT, { recursive: true })
  labRoot = mkdtempSync(join(SANDBOX_ROOT, 'docs-'))
  deps = makeDeps(labRoot, 'DocsTest')
  docs = new DocsService(deps)
  solutions = new SolutionService(deps, docs)
  await solutions.init(labRoot, 'DocsTest')
})

afterAll(() => {
  ;(deps.store as unknown as { close(): void }).close()
  if (labRoot) rmSync(labRoot, { recursive: true, force: true })
})

const mainLink = () => join(labRoot, 'solutions/main/local/docs')
const forkLink = (slug: string) => join(labRoot, 'solutions', slug, 'local/docs')

describe('shared documents (DESIGN §26)', () => {
  it('init seeds the layout: root docs/, generated .dlab area, index, link in main', () => {
    expect(existsSync(join(labRoot, 'docs/README.md'))).toBe(true)
    expect(lstatSync(join(labRoot, 'docs/.dlab')).isDirectory()).toBe(true)
    expect(existsSync(join(labRoot, 'docs/.dlab/.gitignore'))).toBe(true)
    // the project row records the docs directory
    expect(docs.state()).toBeTruthy()
    // main reaches it through the link
    expect(lstatSync(mainLink()).isSymbolicLink()).toBe(true)
    expect(readlinkSync(mainLink())).toBe(join('..', '..', '..', 'docs'))
  })

  it('a fork carries the same link, pointing at the same single copy', async () => {
    await solutions.fork({ sourceSolutionId: 'main', slug: 'doc-exp', name: 'Doc Exp' })
    expect(lstatSync(forkLink('doc-exp')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(forkLink('doc-exp'))).toBe(join('..', '..', '..', 'docs'))

    // writing through the FORK link lands in the single root copy
    writeFileSync(join(forkLink('doc-exp'), 'roadmap.md'), '# roadmap v2\n')
    expect(readFileSync(join(labRoot, 'docs/roadmap.md'), 'utf8')).toBe('# roadmap v2\n')
    // ...and is visible through main's link, because it is the same file
    expect(readFileSync(join(mainLink(), 'roadmap.md'), 'utf8')).toBe('# roadmap v2\n')
    // exactly one physical copy exists
    expect(existsSync(join(labRoot, 'solutions/doc-exp/docs/roadmap.md'))).toBe(false)
  })

  it('a checkpoint never commits shared docs into the solution branch', async () => {
    writeFileSync(join(labRoot, 'solutions/doc-exp/model.py'), 'x = 1\n')
    await solutions.checkpoint('doc-exp', 'doc-exp: local change only')
    const tracked = (await deps.git.changedPathsBetween('main', 'exp/doc-exp')).filter((p) => p.startsWith('docs/'))
    expect(tracked).toEqual([])
  })

  it('the generated area is excluded from listings', () => {
    const paths = docs.list().map((d) => d.path)
    expect(paths).toContain('README.md')
    expect(paths).toContain('roadmap.md')
    expect(paths.some((p) => p.startsWith('.dlab'))).toBe(false)
  })

  it('a document path cannot escape the docs directory', () => {
    expect(() => docs.read('../../etc/passwd')).toThrow(/escapes the docs directory/)
    expect(() => docs.write('../evil.md', 'x')).toThrow(/escapes the docs directory/)
  })

  it('archive promotes local notes into the shared docs and snapshots them', async () => {
    // a per-experiment note that must outlive the worktree
    const localDir = join(labRoot, 'solutions/doc-exp/docs')
    mkdirSync(localDir, { recursive: true })
    writeFileSync(join(localDir, 'finding.md'), 'LR=0.01 beats 0.001 by 0.3 AUC\n')

    const archived = await solutions.archive('doc-exp', 'seed 1024 is the stable one')
    expect(archived.status).toBe('archived')
    expect(existsSync(join(labRoot, 'solutions/doc-exp'))).toBe(false)

    // promoted copies + the recorded conclusion survive in the shared docs
    expect(readFileSync(join(labRoot, 'docs/local/doc-exp/docs/finding.md'), 'utf8')).toContain('beats 0.001')
    expect(readFileSync(join(labRoot, 'docs/local/doc-exp/conclusion.md'), 'utf8')).toContain('seed 1024')
    const snapshotDir = join(labRoot, 'docs/.dlab/snapshots')
    const snapshots = readdirSync(snapshotDir)
    expect(snapshots.some((f) => f.includes('doc-exp'))).toBe(true)
  })

  it('promotion can copy a chosen document to a shared path', async () => {
    await solutions.fork({ sourceSolutionId: 'main', slug: 'doc-promote', name: 'Doc Promote' })
    // local note chosen for promotion to the shared root
    mkdirSync(join(labRoot, 'solutions/doc-promote/docs'), { recursive: true })
    writeFileSync(join(labRoot, 'solutions/doc-promote/docs/lessons.md'), 'shared lesson\n')
    const result = await docs.promoteSolution({ solutionId: 'doc-promote', promote: ['lessons.md'] })
    expect(result.sharedWrites).toContain('lessons.md')
    expect(readFileSync(join(labRoot, 'docs/lessons.md'), 'utf8')).toBe('shared lesson\n')
  })

  it('versions the shared docs under refs/dsh/docs, excluding the generated area', async () => {
    // init created the first version; a write chains the next one
    const first = await docs.history(10)
    expect(first.length).toBeGreaterThan(0)
    expect(first[0]!.message).toContain('[dsh-lab] docs:')

    writeFileSync(join(labRoot, 'docs/roadmap.md'), '# roadmap v3\n')
    const sha = await docs.commitVersion('[dsh-lab] docs: update roadmap.md')
    expect(sha).toBeTruthy()

    const history = await docs.history(10)
    expect(history[0]!.commit).toBe(sha)
    expect(history[0]!.message).toContain('update roadmap.md')
    expect(history.length).toBeGreaterThanOrEqual(2)

    // the versioned tree carries the documents, but no snapshot/state JSON —
    // that area is derived data
    const versioned = execFileSync(
      'git',
      ['--git-dir', join(labRoot, '.dsh-lab/repo.git'), 'ls-tree', '-r', 'refs/dsh/docs', '--name-only'],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
    expect(versioned).toContain('docs/roadmap.md')
    expect(versioned.some((p) => p.startsWith('docs/.dlab/snapshots'))).toBe(false)
    expect(versioned.some((p) => p === 'docs/.dlab/state.json')).toBe(false)
  })

  it('repairLinks re-materializes a link that was replaced by a real directory', async () => {
    // simulate a hand-made copy standing where the link belongs
    const link = forkLink('doc-promote')
    rmSync(link, { recursive: true, force: true })
    mkdirSync(link, { recursive: true })
    writeFileSync(join(link, 'stale.md'), 'stale copy\n')
    const repaired = await docs.repairLinks()
    expect(repaired).toContain('doc-promote')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    // the stale copy is gone (it was shadowing the shared docs)
    expect(existsSync(join(labRoot, 'docs/stale.md'))).toBe(false)
  })
})

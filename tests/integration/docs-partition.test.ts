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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeDeps } from '../../packages/cli/lib/cli.js'
import { SolutionService, DocsService } from '../../packages/core/lib/index.js'
import type { LabDeps } from '../../packages/core/lib/index.js'

// Local integration sandbox. Override with DLAB_SANDBOX_ROOT=<dir> to keep
// scratch dirs across runs; otherwise vitest uses the OS temp dir.
const SANDBOX_ROOT = process.env.DLAB_SANDBOX_ROOT ?? join(tmpdir(), 'dlab-sandbox')

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

const mainLink = () => join(labRoot, 'solutions/main/docs')
const forkLink = (slug: string) => join(labRoot, 'solutions', slug, 'docs')

describe('shared documents (DESIGN §26)', () => {
  it('init seeds the layout: root docs/, generated .dlab area, index, link in main', () => {
    expect(existsSync(join(labRoot, 'docs/README.md'))).toBe(true)
    expect(lstatSync(join(labRoot, 'docs/.dlab')).isDirectory()).toBe(true)
    expect(existsSync(join(labRoot, 'docs/.dlab/.gitignore'))).toBe(true)
    // the project row records the docs directory
    expect(docs.state()).toBeTruthy()
    // main reaches it through the link
    expect(lstatSync(mainLink()).isSymbolicLink()).toBe(true)
    expect(readlinkSync(mainLink())).toBe(join('..', '..', 'docs'))
  })

  it('a fork carries the same link, pointing at the same single copy', async () => {
    await solutions.fork({ sourceSolutionId: 'main', slug: 'doc-exp', name: 'Doc Exp' })
    expect(lstatSync(forkLink('doc-exp')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(forkLink('doc-exp'))).toBe(join('..', '..', 'docs'))

    // writing through the FORK link lands in the single root copy
    writeFileSync(join(forkLink('doc-exp'), 'roadmap.md'), '# roadmap v2\n')
    expect(readFileSync(join(labRoot, 'docs/roadmap.md'), 'utf8')).toBe('# roadmap v2\n')
    // ...and is visible through main's link, because it is the same file
    expect(readFileSync(join(mainLink(), 'roadmap.md'), 'utf8')).toBe('# roadmap v2\n')
    // exactly one physical copy exists: the worktree path IS the link
    expect(lstatSync(join(labRoot, 'solutions/doc-exp/docs')).isSymbolicLink()).toBe(true)
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
    // a per-experiment note that must outlive the worktree (private notes
    // live in notes/ — docs/ is the shared link)
    const localDir = join(labRoot, 'solutions/doc-exp/notes')
    mkdirSync(localDir, { recursive: true })
    writeFileSync(join(localDir, 'finding.md'), 'LR=0.01 beats 0.001 by 0.3 AUC\n')

    const archived = await solutions.archive('doc-exp', 'seed 1024 is the stable one')
    expect(archived.status).toBe('archived')
    expect(existsSync(join(labRoot, 'solutions/doc-exp'))).toBe(false)

    // promoted copies + the recorded conclusion survive in the shared docs
    expect(readFileSync(join(labRoot, 'docs/local/doc-exp/notes/finding.md'), 'utf8')).toContain('beats 0.001')
    expect(readFileSync(join(labRoot, 'docs/local/doc-exp/conclusion.md'), 'utf8')).toContain('seed 1024')
    const snapshotDir = join(labRoot, 'docs/.dlab/snapshots')
    const snapshots = readdirSync(snapshotDir)
    expect(snapshots.some((f) => f.includes('doc-exp'))).toBe(true)
  })

  it('promotion can copy a chosen document to a shared path', async () => {
    await solutions.fork({ sourceSolutionId: 'main', slug: 'doc-promote', name: 'Doc Promote' })
    // local note chosen for promotion to the shared root
    mkdirSync(join(labRoot, 'solutions/doc-promote/notes'), { recursive: true })
    writeFileSync(join(labRoot, 'solutions/doc-promote/notes/lessons.md'), 'shared lesson\n')
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

  it('migrates in-solution documents into the shared docs (plan → apply)', async () => {
    await solutions.fork({ sourceSolutionId: 'main', slug: 'doc-migrate', name: 'Doc Migrate' })
    const localNotes = join(labRoot, 'solutions/doc-migrate/notes')
    mkdirSync(localNotes, { recursive: true })
    writeFileSync(join(localNotes, 'legacy-report.md'), '# legacy report\n')

    // the plan changes nothing
    const plan = await docs.planMigration({ solutionId: 'doc-migrate' })
    expect(plan.files).toContain('legacy-report.md')
    expect(plan.prefix).toBe('')
    expect(docs.exists('legacy-report.md')).toBe(false)

    const applied = await docs.applyMigration({ solutionId: 'doc-migrate', move: true })
    expect(applied.copied).toContain('legacy-report.md')
    expect(applied.version).toBeTruthy()
    // it landed at the shared ROOT (not docs/docs/) and is versioned
    expect(readFileSync(join(labRoot, 'docs/legacy-report.md'), 'utf8')).toContain('legacy report')
    expect(existsSync(join(localNotes, 'legacy-report.md'))).toBe(false)

    // a second migration has nothing left to do
    const second = await docs.planMigration({ solutionId: 'doc-migrate' })
    expect(second.files).toEqual([])
  })

  it('unifySolutionDocs turns an in-solution docs directory into the link', async () => {
    await solutions.fork({ sourceSolutionId: 'main', slug: 'doc-unify', name: 'Doc Unify' })
    const worktreeDocs = join(labRoot, 'solutions/doc-unify/docs')
    // simulate the pre-partition layout: a REAL directory of documents
    rmSync(worktreeDocs, { recursive: true, force: true })
    mkdirSync(worktreeDocs, { recursive: true })
    writeFileSync(join(worktreeDocs, 'charter.md'), '# charter from the solution\n')

    const result = await docs.unifySolutionDocs('doc-unify')
    expect(result.linked).toBe(true)
    expect(result.copied).toContain('charter.md')
    // the document moved to the single shared copy and the path still reads
    expect(readFileSync(join(labRoot, 'docs/charter.md'), 'utf8')).toContain('charter from the solution')
    expect(lstatSync(worktreeDocs).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(worktreeDocs, 'charter.md'), 'utf8')).toContain('charter from the solution')

    // idempotent: a second unify is a no-op
    const again = await docs.unifySolutionDocs('doc-unify')
    expect(again.copied).toEqual([])

    // and the shared documents cannot be deleted through the link, even when
    // a caller explicitly asks for path=docs with move
    await expect(
      docs.applyMigration({ solutionId: 'doc-unify', path: 'docs', move: true }),
    ).rejects.toThrow(/refusing to move "docs"/)
    expect(existsSync(join(labRoot, 'docs/charter.md'))).toBe(true)
  })

  it('a relative link inside a shared document resolves from any worktree', async () => {
    // the real projects' docs reference each other as [x](sibling.md); those
    // must keep working when read through a solution's docs/ link
    writeFileSync(join(labRoot, 'docs/index.md'), '[charter](charter.md)\n')
    writeFileSync(join(labRoot, 'docs/charter.md'), '# charter\n')
    await solutions.fork({ sourceSolutionId: 'main', slug: 'doc-links', name: 'Doc Links' })
    const fromWorktree = readFileSync(join(labRoot, 'solutions/doc-links/docs/index.md'), 'utf8')
    expect(fromWorktree).toContain('(charter.md)')
    // the sibling is readable next to it, so the relative link resolves
    expect(readFileSync(join(labRoot, 'solutions/doc-links/docs/charter.md'), 'utf8')).toContain('# charter')
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

  it('reads a solution’s own note inside its worktree, and refuses to escape it', async () => {
    await solutions.fork({ sourceSolutionId: 'main', slug: 'doc-read', name: 'Doc Read' })
    const solution = await solutions.get('doc-read')
    mkdirSync(join(labRoot, 'solutions/doc-read/notes'), { recursive: true })
    writeFileSync(join(labRoot, 'solutions/doc-read/notes/plan.md'), '# plan\nstep one\n')

    // the panel previews a solution note through this read
    const note = docs.readSolutionFile(solution, 'notes/plan.md')
    expect(note.text).toContain('step one')
    expect(note.truncated).toBe(false)
    expect(note.size).toBeGreaterThan(0)

    // a path through the docs link reaches the shared copy
    expect(docs.readSolutionFile(solution, 'docs/charter.md').text).toContain('# charter')

    // traversal out of the worktree is refused
    expect(() => docs.readSolutionFile(solution, '../../main/notes/plan.md')).toThrow(/escapes/)
    expect(() => docs.readSolutionFile(solution, '')).toThrow(/required/)
  })
})

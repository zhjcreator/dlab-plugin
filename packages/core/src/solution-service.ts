/**
 * Solution lifecycle use cases: init / fork / checkpoint / archive / restore /
 * diff / merge. Pure orchestration over LabDeps; no DSH imports.
 */

import {
  ConflictError,
  DirtyError,
  InvalidStateError,
  NotFoundError,
  assertSlug,
  resolveInside,
} from '@dsh-lab/shared'
import type {
  DiffView,
  ForkSolutionInput,
  GitStatus,
  MergeMode,
  MergeResult,
  MergeSolutionInput,
  Solution,
  SolutionStatus,
} from '@dsh-lab/shared'
import { solutionId } from '@dsh-lab/shared'
import type { GitPort, LabDeps, StorePort, WorkspacePort } from './ports.js'

export class SolutionService {
  constructor(private readonly deps: LabDeps) {}

  private get store(): StorePort {
    return this.deps.store
  }

  private get git(): GitPort {
    return this.deps.git
  }

  private get workspace(): WorkspacePort {
    return this.deps.workspace
  }

  /** Absolute path of a solution worktree dir given its slug. */
  solutionDir(slug: string): string {
    return resolveInside(this.deps.config.projectRoot, `${this.deps.config.solutionsDir}/${slug}`)
  }

  async requireSolution(idOrSlug: string): Promise<Solution> {
    const byId = await this.store.getSolution(idOrSlug)
    if (byId) return byId
    const bySlug = await this.store.getSolutionBySlug(idOrSlug)
    if (bySlug) return bySlug
    throw new NotFoundError('solution', idOrSlug)
  }

  async requireMain(): Promise<Solution> {
    const project = await this.store.getProject()
    if (!project?.mainSolutionId) throw new InvalidStateError('project is not initialized')
    const main = await this.store.getSolution(project.mainSolutionId)
    if (!main) throw new NotFoundError('solution', project.mainSolutionId)
    return main
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * First-time init of a project root: bare repo under labStateDir, main
   * branch + main worktree under solutions/, DB rows, DSH workspace.
   *
   * When the root already contains a plain `.git` repository, it is imported
   * by cloning --bare into the lab repo; the original is never deleted. When
   * the imported repo's default branch is not `main`, a `main` branch is
   * created at the imported HEAD.
   */
  async init(root: string, name: string): Promise<Solution> {
    const existing = await this.store.getProject()
    if (existing) throw new InvalidStateError(`project already initialized at ${existing.rootPath}`)

    const { existsSync } = await import('node:fs')
    const gitDirAbs = resolveInside(root, this.deps.config.gitDir)

    if (!existsSync(gitDirAbs)) {
      const legacyGit = resolveInside(root, '.git')
      if (existsSync(legacyGit)) {
        // import an existing working repo without touching it
        await this.git.importFrom(legacyGit)
      } else {
        await this.git.initBare()
      }
    }

    const mainBranch = this.deps.config.mainBranch
    if (!(await this.git.branchExists(mainBranch))) {
      const headBranch = await this.git.currentHeadBranch().catch(() => undefined)
      // unborn HEAD (fresh `git init --bare`, no commits) → truly empty repo
      const headHasCommits = headBranch !== undefined && (await this.git.branchExists(headBranch))
      if (headBranch && headHasCommits && headBranch !== mainBranch) {
        // imported repo defaulting to e.g. `master`: alias main at the same commit
        await this.git.createBranch(mainBranch, headBranch)
      } else {
        // empty repo: bootstrap an initial commit via plumbing so the
        // worktree has something to check out
        await this.git.bootstrapBranchWithEmptyCommit(mainBranch, `[dsh-lab] init: ${name}`, {
          'README.md': `# ${name}\n`,
        })
      }
    }

    const project = await this.store.createProject({ name, rootPath: root })
    return this.finishInit(project.id)
  }

  private async finishInit(projectId: string): Promise<Solution> {
    const mainBranch = this.deps.config.mainBranch
    const head = await this.git.branchHead(mainBranch)
    const mainDirRel = `${this.deps.config.solutionsDir}/main`
    const worktrees = await this.git.listWorktrees()
    if (!worktrees.some((w) => w.branch === mainBranch)) {
      await this.git.addWorktree(this.solutionDir('main'), mainBranch)
    }
    const now = Date.now()
    const main: Solution = {
      id: solutionId(),
      projectId,
      slug: 'main',
      name: 'Main',
      role: 'main',
      status: 'active',
      branch: mainBranch,
      worktreePath: mainDirRel,
      headCommit: head,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.upsertSolution(main)
    await this.store.setMainSolution(projectId, main.id)
    const workspaceId = await this.workspace.createWorkspace(this.solutionDir('main'), 'Main')
    if (workspaceId) {
      main.workspaceId = workspaceId
      await this.store.upsertSolution(main)
    }
    await this.store.appendEvent({ type: 'SolutionForked', entityType: 'solution', entityId: main.id, payload: { init: true } })
    return main
  }

  async list(): Promise<Solution[]> {
    const list = await this.store.listSolutions()
    // projection: refresh dirty/head from git lazily; keep DB authoritative for now
    return list
  }

  async get(idOrSlug: string): Promise<Solution> {
    return this.requireSolution(idOrSlug)
  }

  /** Fork a new experiment solution from a source (branch + worktree + DB + DSH workspace). */
  async fork(input: ForkSolutionInput): Promise<Solution> {
    const source = await this.requireSolution(input.sourceSolutionId)
    assertSlug(input.slug)
    const branch = `${this.deps.config.experimentBranchPrefix}${input.slug}`
    if (source.status !== 'active' && source.status !== 'archived' && source.status !== 'merged') {
      throw new InvalidStateError(`cannot fork from solution "${source.slug}" in status ${source.status}`)
    }
    const existing = await this.store.getSolutionBySlug(input.slug)
    if (existing) throw new InvalidStateError(`slug "${input.slug}" already exists`)
    if (await this.git.branchExists(branch)) throw new InvalidStateError(`branch "${branch}" already exists`)

    let head: string
    if (source.status === 'active') {
      // dirty source → auto-checkpoint first (unless caller opted out)
      const status = await this.git.getStatus(this.solutionDir(source.slug))
      head = status.headCommit
      if (!status.clean && input.checkpointSource !== false) {
        head = await this.git.commitAll(
          this.solutionDir(source.slug),
          `[dsh-lab] checkpoint before fork ${input.slug}`,
        )
        await this.store.upsertSolution({ ...source, headCommit: head, updatedAt: Date.now() })
      }
    } else {
      // fork from archived/merged: no worktree, branch HEAD is the source of truth
      head = await this.git.branchHead(source.branch)
    }

    await this.git.createBranch(branch, head)
    await this.git.addWorktree(this.solutionDir(input.slug), branch)
    const now = Date.now()
    const solution: Solution = {
      id: solutionId(),
      projectId: source.projectId,
      slug: input.slug,
      name: input.name,
      description: input.description,
      hypothesis: input.hypothesis,
      role: 'experiment',
      status: 'active',
      branch,
      worktreePath: `${this.deps.config.solutionsDir}/${input.slug}`,
      parentSolutionId: source.id,
      forkCommit: head,
      headCommit: head,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.upsertSolution(solution)
    const workspaceId = await this.workspace.createWorkspace(this.solutionDir(input.slug), input.name)
    if (workspaceId) solution.workspaceId = workspaceId
    await this.store.upsertSolution(solution)
    await this.store.appendEvent({
      type: 'SolutionForked',
      entityType: 'solution',
      entityId: solution.id,
      payload: { sourceId: source.id, branch },
    })
    return solution
  }

  /** Normal git commit on the solution branch (checkpoint). */
  async checkpoint(idOrSlug: string, message?: string): Promise<{ commit: string }> {
    const solution = await this.requireSolution(idOrSlug)
    if (solution.status !== 'active') throw new InvalidStateError(`solution "${solution.slug}" is ${solution.status}, cannot checkpoint`)
    const dir = this.solutionDir(solution.slug)
    const commit = await this.git.commitAll(dir, message ?? `[dsh-lab] checkpoint: ${solution.name}`)
    await this.store.upsertSolution({ ...solution, headCommit: commit, updatedAt: Date.now() })
    return { commit }
  }

  /** Archive: dirty → auto-checkpoint, remove worktree, delete DSH workspace, mark archived. */
  async archive(idOrSlug: string, conclusion?: string): Promise<Solution> {
    const solution = await this.requireSolution(idOrSlug)
    if (solution.role === 'main') throw new InvalidStateError('cannot archive the main solution')
    if (solution.status !== 'active') {
      throw new InvalidStateError(`solution "${solution.slug}" is ${solution.status}, cannot archive`)
    }
    const dir = this.solutionDir(solution.slug)

    // dirty → auto-checkpoint so nothing is lost
    const status = await this.git.getStatus(dir)
    let head = solution.headCommit
    if (!status.clean) {
      head = await this.git.commitAll(dir, `[dsh-lab] archive: ${solution.name}`)
    }

    await this.git.removeWorktree(this.solutionDir(solution.slug))
    if (solution.workspaceId) {
      await this.workspace.deleteWorkspace(solution.workspaceId)
    }

    const now = Date.now()
    const archived: Solution = {
      ...solution,
      status: 'archived',
      conclusion: conclusion ?? solution.conclusion,
      headCommit: head,
      worktreePath: undefined,
      workspaceId: undefined,
      archivedAt: now,
      updatedAt: now,
    }
    await this.store.upsertSolution(archived)
    await this.store.appendEvent({
      type: 'SolutionArchived',
      entityType: 'solution',
      entityId: archived.id,
      payload: { branch: archived.branch, head },
    })
    return archived
  }

  /** Restore: re-add worktree at archived/merged branch HEAD, re-register DSH workspace. */
  async restore(idOrSlug: string): Promise<Solution> {
    const solution = await this.requireSolution(idOrSlug)
    if (solution.status === 'active') return solution
    if (solution.status === 'broken') {
      throw new InvalidStateError(`solution "${solution.slug}" is broken; repair first`)
    }
    if (!(await this.git.branchExists(solution.branch))) {
      throw new InvalidStateError(`branch "${solution.branch}" no longer exists; cannot restore`)
    }
    await this.git.addWorktree(this.solutionDir(solution.slug), solution.branch)
    const head = await this.git.branchHead(solution.branch)
    const workspaceId = await this.workspace.createWorkspace(
      this.solutionDir(solution.slug),
      solution.name,
    )
    const now = Date.now()
    const restored: Solution = {
      ...solution,
      status: 'active',
      headCommit: head,
      worktreePath: `${this.deps.config.solutionsDir}/${solution.slug}`,
      workspaceId: workspaceId ?? undefined,
      archivedAt: undefined,
      updatedAt: now,
    }
    await this.store.upsertSolution(restored)
    await this.store.appendEvent({
      type: 'SolutionRestored',
      entityType: 'solution',
      entityId: restored.id,
      payload: { branch: restored.branch },
    })
    return restored
  }

  // ── diff ─────────────────────────────────────────────────────────────────

  async diff(aId: string, bId: string): Promise<DiffView> {
    const a = await this.requireSolution(aId)
    const b = await this.requireSolution(bId)
    const forkBase = a.parentSolutionId ? (await this.store.getSolution(a.parentSolutionId))?.slug : a.slug
    const { changedFiles, patch } = await this.git.diff(forkBase ?? undefined, a.branch, b.branch)
    return {
      forkBase: forkBase ?? undefined,
      headA: a.branch,
      headB: b.branch,
      changedFiles,
      patch,
    }
  }

  // ── merge ────────────────────────────────────────────────────────────────

  /**
   * Unified merge entry: target may be main (merge-to-main) or any other
   * solution (fork → fork). Modes:
   *   into-target   — source merged; default archives source workspace
   *   into-fork     — source stays active (recommended default)
   *   consolidate   — squash into target; source merged; default archives
   */
  async merge(input: MergeSolutionInput): Promise<MergeResult> {
    const source = await this.requireSolution(input.sourceSolutionId)
    const target = await this.requireSolution(input.targetSolutionId)
    if (source.id === target.id) throw new InvalidStateError('cannot merge a solution into itself')
    if (source.status === 'broken' || target.status === 'broken') {
      throw new InvalidStateError('cannot merge a broken solution; repair first')
    }
    const mode: MergeMode = input.mode ?? 'into-fork'

    // preflight first (refuses on conflicts before touching anything)
    const preflight = await this.git.mergePreflight(target.branch, source.branch)
    if (!preflight.clean || preflight.conflictFiles.length > 0) {
      throw new ConflictError(
        preflight.conflictFiles,
        preflight.conflictFiles.length > 0
          ? undefined
          : `merge preflight for "${source.slug}" → "${target.slug}" reported a conflict but no files could be parsed`,
      )
    }

    if (mode === 'into-target' || mode === 'into-fork') {
      if (target.status !== 'active') throw new InvalidStateError(`target "${target.slug}" is ${target.status}; restore it first`)
      const targetDir = this.solutionDir(target.slug)
      const targetStatus = await this.git.getStatus(targetDir)
      if (!targetStatus.clean) throw new DirtyError(`target workspace "${target.slug}" has uncommitted changes; checkpoint or revert before merging`)
      if (source.status === 'active') {
        const sourceStatus = await this.git.getStatus(this.solutionDir(source.slug))
        if (!sourceStatus.clean) await this.checkpoint(source.id)
      }
      const mergeCommit = await this.git.mergeInWorktree(targetDir, target.branch, source.branch)
      const now = Date.now()
      await this.store.upsertSolution({ ...target, headCommit: mergeCommit, updatedAt: now })
      if (mode === 'into-target') {
        const after: Solution = { ...source, status: 'merged', mergedIntoSolutionId: target.id, mergeCommit, mergedAt: now, updatedAt: now }
        await this.store.upsertSolution(after)
        if (input.archiveSource !== false) {
          await this.git.removeWorktree(this.solutionDir(source.slug))
          if (source.workspaceId) await this.workspace.deleteWorkspace(source.workspaceId)
        }
        return {
          sourceSolutionId: source.id,
          targetSolutionId: target.id,
          mergeCommit,
          mode,
          sourceStatusAfter: 'merged',
          conflictFiles: [],
        }
      }
      // into-fork: source untouched
      return {
        sourceSolutionId: source.id,
        targetSolutionId: target.id,
        mergeCommit,
        mode,
        sourceStatusAfter: source.status as SolutionStatus,
        conflictFiles: [],
      }
    }

    // consolidate
    if (target.status !== 'active') throw new InvalidStateError(`target "${target.slug}" is ${target.status}; restore it first`)
    const targetDir = this.solutionDir(target.slug)
    const targetStatus = await this.git.getStatus(targetDir)
    if (!targetStatus.clean) throw new DirtyError(`target workspace "${target.slug}" has uncommitted changes; checkpoint or revert before merging`)
    const mergeCommit = await this.git.squashMergeInWorktree(
      targetDir,
      target.branch,
      source.branch,
      input.message ?? `[dsh-lab] consolidate ${source.slug} into ${target.slug}`,
    )
    const now = Date.now()
    await this.store.upsertSolution({ ...target, headCommit: mergeCommit, updatedAt: now })
    const after: Solution = { ...source, status: 'merged', mergedIntoSolutionId: target.id, mergeCommit, mergedAt: now, updatedAt: now }
    await this.store.upsertSolution(after)
    if (input.archiveSource !== false) {
      await this.git.removeWorktree(this.solutionDir(source.slug))
      if (source.workspaceId) await this.workspace.deleteWorkspace(source.workspaceId)
    }
    return {
      sourceSolutionId: source.id,
      targetSolutionId: target.id,
      mergeCommit,
      mode,
      sourceStatusAfter: 'merged',
      conflictFiles: [],
    }
  }
}

export type { GitStatus }

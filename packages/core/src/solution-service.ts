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
} from '@dlab/shared'
import type {
  DiffView,
  ForkSolutionInput,
  GitStatus,
  MergeMode,
  MergeResult,
  MergeSolutionInput,
  Solution,
  SolutionStatus,
} from '@dlab/shared'
import { solutionId } from '@dlab/shared'
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

  /** First-time init of a project root (bare repo + main worktree + DB row). */
  async init(root: string, name: string): Promise<Solution> {
    // not yet implemented in skeleton phase
    throw new Error('init(): not implemented yet')
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
    // Phase 1 implementation fills this in
    const source = await this.requireSolution(input.sourceSolutionId)
    assertSlug(input.slug)
    const branch = `${this.deps.config.experimentBranchPrefix}${input.slug}`
    if (source.status !== 'active' && source.status !== 'archived') {
      throw new InvalidStateError(`cannot fork from solution "${source.slug}" in status ${source.status}`)
    }
    if (source.role === 'experiment') {
      throw new InvalidStateError('fork source must be main (or an experiment explicitly allowed)')
    }
    const existing = await this.store.getSolutionBySlug(input.slug)
    if (existing) throw new InvalidStateError(`slug "${input.slug}" already exists`)
    if (await this.git.branchExists(branch)) throw new InvalidStateError(`branch "${branch}" already exists`)

    const status = await this.git.getStatus(this.solutionDir(source.slug))
    let head = status.headCommit
    if (!status.clean && input.checkpointSource !== false) {
      head = await this.git.commitAll(
        this.solutionDir(source.slug),
        `[dsh-lab] checkpoint before fork ${input.slug}`,
      )
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
  async archive(idOrSlug: string, conclusion?: string): Promise<void> {
    const solution = await this.requireSolution(idOrSlug)
    if (solution.role === 'main') throw new InvalidStateError('cannot archive the main solution')
    if (solution.status !== 'active') throw new InvalidStateError(`solution "${solution.slug}" is ${solution.status}, cannot archive`)
    // Phase 1 fills in: status check + dirty auto-checkpoint + worktree remove + workspace delete
    throw new Error('archive(): not implemented yet')
  }

  /** Restore: re-add worktree at archived/merged branch HEAD, re-register DSH workspace. */
  async restore(idOrSlug: string): Promise<Solution> {
    const solution = await this.requireSolution(idOrSlug)
    if (solution.status === 'active') return solution
    if (solution.status === 'broken') throw new InvalidStateError(`solution "${solution.slug}" is broken; repair first`)
    // Phase 1 fills in
    throw new Error('restore(): not implemented yet')
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
    if (preflight.conflictFiles.length > 0) {
      throw new ConflictError(preflight.conflictFiles)
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

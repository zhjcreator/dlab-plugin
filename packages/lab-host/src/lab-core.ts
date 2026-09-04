/**
 * LabCore: the host-side composition root. Builds the pure ports
 * (LocalGitPort / SqliteStore / LocalRunner / GpuScheduler), takes a
 * WorkspacePort from the caller (DSH bridge in-process, no-op in tests),
 * and exposes view-shaped operations used by LabService, tools, and RPC.
 *
 * No DSH imports here — only @dlab/* packages.
 */

import { mkdirSync, existsSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'
import { LocalGitPort } from '@dlab/git'
import { SqliteStore } from '@dlab/store'
import { LocalRunner } from '@dlab/runner'
import { GpuScheduler } from '@dlab/scheduler'
import {
  SolutionService,
  RunService,
  ReconcileService,
  type LabConfig,
  type LabDeps,
  type WorkspacePort,
} from '@dlab/core'
import type {
  EnvironmentView,
  ExperimentRun,
  ResourceView,
  RunView,
  Solution,
  SolutionView,
} from '@dlab/shared'

export interface LabCoreOptions {
  solutionRoot: string
  projectName: string
  workspace: WorkspacePort
}

export class LabCore {
  readonly config: LabConfig
  readonly deps: LabDeps
  readonly solutions: SolutionService
  readonly runs: RunService
  readonly reconcile: ReconcileService
  private readonly store: SqliteStore

  constructor(opts: LabCoreOptions) {
    const projectRoot = isAbsolute(opts.solutionRoot) ? opts.solutionRoot : resolve(process.cwd(), opts.solutionRoot)
    this.config = {
      projectName: opts.projectName,
      projectRoot,
      solutionsDir: 'solutions',
      experimentsDir: 'experiments',
      labStateDir: '.dsh-lab',
      venvDir: '.venv',
      gitDir: '.dsh-lab/repo.git',
      runWorktreesDir: '.dsh-lab/run-worktrees',
      runRefPrefix: 'refs/dsh/runs/',
      experimentBranchPrefix: 'exp/',
      mainBranch: 'main',
    }
    mkdirSync(resolve(projectRoot, this.config.labStateDir), { recursive: true })
    const git = new LocalGitPort({
      gitDir: resolve(projectRoot, this.config.gitDir),
      worktreeRoot: projectRoot,
    })
    this.store = new SqliteStore({ path: resolve(projectRoot, this.config.labStateDir, 'lab.sqlite') })
    this.deps = {
      config: this.config,
      git,
      store: this.store,
      runner: new LocalRunner(),
      scheduler: new GpuScheduler(),
      workspace: opts.workspace,
    }
    this.solutions = new SolutionService(this.deps)
    this.runs = new RunService(this.deps)
    this.reconcile = new ReconcileService(this.deps)
  }

  get root(): string {
    return this.config.projectRoot
  }

  get projectName(): string {
    return this.config.projectName
  }

  close(): void {
    this.store.close()
  }

  get isInitialized(): boolean {
    return existsSync(resolve(this.config.projectRoot, this.config.labStateDir, 'lab.sqlite'))
  }

  // ── view projections ─────────────────────────────────────────────────────

  async solutionView(solution: Solution): Promise<SolutionView> {
    const all = await this.deps.store.listRuns({ solutionId: solution.id })
    const parent = solution.parentSolutionId
      ? await this.deps.store.getSolution(solution.parentSolutionId)
      : undefined
    const mergedInto = solution.mergedIntoSolutionId
      ? await this.deps.store.getSolution(solution.mergedIntoSolutionId)
      : undefined
    let dirty: boolean | undefined
    if (solution.status === 'active' && solution.worktreePath) {
      try {
        dirty = !(await this.deps.git.getStatus(solution.worktreePath)).clean
      } catch {
        dirty = undefined
      }
    }
    return {
      id: solution.id,
      slug: solution.slug,
      name: solution.name,
      status: solution.status,
      role: solution.role,
      branch: solution.branch,
      worktreePath: solution.worktreePath,
      headCommit: solution.headCommit,
      dirty,
      parentSlug: parent?.slug,
      mergedIntoSlug: mergedInto?.slug,
      runCount: all.length,
      lastRunAt: all[0]?.createdAt,
    }
  }

  async runView(run: ExperimentRun): Promise<RunView> {
    const solution = await this.deps.store.getSolution(run.solutionId)
    const metrics = await this.deps.store.listRunMetrics(run.id)
    const summaryMetrics: Record<string, number> = {}
    for (const m of metrics) summaryMetrics[m.name] = m.value
    const resources = run.resources as { gpuIds?: number[] } | undefined
    return {
      id: run.id,
      solutionId: run.solutionId,
      solutionSlug: solution?.slug ?? run.solutionId,
      snapshotCommit: run.snapshotCommit,
      status: run.status,
      command: run.command,
      gpuIds: resources?.gpuIds,
      exitCode: run.exitCode,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs:
        run.startedAt !== undefined && run.finishedAt !== undefined ? run.finishedAt - run.startedAt : undefined,
      summaryMetrics,
      tags: run.tags ?? [],
    }
  }

  async environmentView(): Promise<EnvironmentView> {
    const venv = resolve(this.config.projectRoot, this.config.venvDir)
    const warnings: string[] = []
    if (!existsSync(venv)) {
      warnings.push(`shared environment not found at ${this.config.venvDir}`)
    }
    return {
      path: venv,
      fingerprint: 'env:not-computed-yet',
      warnings,
    }
  }

  async resourceView(): Promise<ResourceView> {
    return this.deps.scheduler.snapshot()
  }
}

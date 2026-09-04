/**
 * Ports (hexagonal seams) that the core use-cases depend on.
 *
 * Each port is a minimal interface owned by @dlab/core. Concrete DSH-aware
 * or CLI-aware adapters implement them in git/, store/, runner/, scheduler/,
 * and the host layer. Core NEVER imports DSH; the adapters do.
 */

import type {
  EnvironmentView,
  GitStatus,
  MergeMode,
  MergeResult,
  RunResourceRequest,
  RunStatus,
} from '@dlab/shared'

/** Git operations the core needs. Implemented by @dlab/git (git-port.ts). */
export interface GitPort {
  gitDir: string
  worktreeRoot: string

  initBare(): Promise<void>
  /** Import an existing non-bare repo by cloning it into gitDir (does not delete the source). */
  importFrom(sourceRepo: string): Promise<void>
  /** Symbolic HEAD branch of the bare repo, or undefined for an empty repo. */
  currentHeadBranch(): Promise<string | undefined>
  /** Create branch with one commit over the given files (bootstrap for empty repos). */
  bootstrapBranchWithEmptyCommit(branch: string, message: string, files?: Record<string, string>): Promise<string>

  branchExists(branch: string): Promise<boolean>
  createBranch(branch: string, startPoint: string): Promise<void>
  deleteBranch(branch: string): Promise<void> // used only by rollback
  branchHead(branch: string): Promise<string>

  listWorktrees(): Promise<{ path: string; branch: string | null; detached: boolean; head: string }[]>
  addWorktree(path: string, branchOrCommit: string, opts?: { detach?: boolean }): Promise<void>
  removeWorktree(path: string, opts?: { force?: boolean }): Promise<void>

  getStatus(path: string): Promise<GitStatus>
  commitAll(path: string, message: string): Promise<string> // adds tracked+untracked under path
  commitTreeSnapshot(path: string, refName: string, message: string): Promise<string>
  updateRef(refName: string, commit: string): Promise<void>

  mergeBase(a: string, b: string): Promise<string>
  /** Dry-run preflight: returns changed files and whether conflicts are expected. */
  mergePreflight(targetBranch: string, sourceBranch: string): Promise<{ conflictFiles: string[]; clean: boolean }>
  /** Real merge executed in the target worktree path. */
  mergeInWorktree(path: string, targetBranch: string, sourceBranch: string): Promise<string>
  squashMergeInWorktree(path: string, targetBranch: string, sourceBranch: string, message: string): Promise<string>

  diff(baseRef: string | undefined, a: string, b: string): Promise<{ changedFiles: { status: 'A' | 'M' | 'D'; path: string }[]; patch?: string }>
  changedFilesBetween(a: string, b: string): Promise<{ status: 'A' | 'M' | 'D'; path: string }[]>
}

/** Durable store the core uses. Implemented by @dlab/store (sqlite-store.ts). */
export interface StorePort {
  getProject(): Promise<import('@dlab/shared').Project | undefined>
  createProject(input: { name: string; rootPath: string }): Promise<import('@dlab/shared').Project>

  listSolutions(): Promise<import('@dlab/shared').Solution[]>
  getSolution(id: string): Promise<import('@dlab/shared').Solution | undefined>
  getSolutionBySlug(slug: string): Promise<import('@dlab/shared').Solution | undefined>
  upsertSolution(solution: import('@dlab/shared').Solution): Promise<void>
  /** Record which solution is the project's main (set once at init). */
  setMainSolution(projectId: string, solutionId: string): Promise<void>

  listRuns(filter?: { solutionId?: string; status?: RunStatus }): Promise<import('@dlab/shared').ExperimentRun[]>
  getRun(id: string): Promise<import('@dlab/shared').ExperimentRun | undefined>
  upsertRun(run: import('@dlab/shared').ExperimentRun): Promise<void>

  upsertRunMetric(metric: import('@dlab/shared').RunMetric): Promise<void>
  listRunMetrics(runId: string): Promise<import('@dlab/shared').RunMetric[]>

  nextRunCounter(): Promise<number>

  listReservations(): Promise<import('@dlab/shared').GpuReservation[]>
  reserveGpu(gpuId: number, runId: string): Promise<void>
  releaseGpu(gpuId: number): Promise<void>

  appendEvent(event: { type: import('@dlab/shared').LabEventType; entityType?: 'solution' | 'run'; entityId?: string; payload?: Record<string, unknown> }): Promise<void>

  transaction<T>(fn: () => Promise<T>): Promise<T>
}

/** Spawns/observes the Run process. Implemented by @dlab/runner (local-runner.ts). */
export interface RunnerPort {
  spawn(opts: {
    /** Stable tracking key (the run id); defaults to cwd when omitted. */
    key?: string
    cwd: string
    argv: string[]
    env: Record<string, string>
    logDir: string
    /** Invoked with the exit code when the spawned process tree ends. */
    onExit?: (code: number | null) => void
  }): Promise<{ pid: number; pgid?: number }>
  stop(runId: string): Promise<void>
  isAlive(runId: string): Promise<boolean>
  /** Raw PID liveness (adoption check after a host restart). */
  isPidAlive(pid: number): boolean
  /** Read the last N lines of a run's stdout log (tail). */
  tail(runId: string, maxLines: number): Promise<string>
  /** Probe the shared environment for the fingerprint snapshot. */
  probeEnvironment(projectRoot: string): Promise<{
    fingerprint: string
    pythonVersion?: string
    requirements?: string
  }>
}

/** GPU discovery + reservation. Implemented by @dlab/scheduler. */
export interface SchedulerPort {
  discover(): Promise<import('@dlab/shared').GpuState[]>
  /** Atomically allocate GPUs; rejects with details when insufficient. */
  allocate(request: RunResourceRequest): Promise<number[]>
  release(gpuIds: number[]): Promise<void>
  snapshot(): Promise<import('@dlab/shared').ResourceView>
}

/** DSH Workspace registry bridge; null-impl in CLI mode. */
export interface WorkspacePort {
  /** Register a solution directory as a DSH workspace; returns its id or undefined when unavailable. */
  createWorkspace(path: string, title: string): Promise<string | undefined>
  deleteWorkspace(workspaceId: string): Promise<void>
  /** Look up a registered workspace by canonical path. */
  resolveByPath(path: string): Promise<{ id: string } | undefined>
}

/** Config the core needs from whichever adapter is hosting it. */
export interface LabConfig {
  projectName: string
  projectRoot: string // absolute solution root
  solutionsDir: string // relative: 'solutions'
  experimentsDir: string // relative: 'experiments'
  labStateDir: string // relative: '.dsh-lab'
  venvDir: string // relative: '.venv'
  gitDir: string // relative: '.dsh-lab/repo.git'
  runWorktreesDir: string // relative: '.dsh-lab/run-worktrees'
  runRefPrefix: string // 'refs/dsh/runs/'
  experimentBranchPrefix: string // 'exp/'
  mainBranch: string // 'main'
}

/** Shared facade carrying every port + config. */
export interface LabDeps {
  config: LabConfig
  git: GitPort
  store: StorePort
  runner: RunnerPort
  scheduler: SchedulerPort
  workspace: WorkspacePort
}

export type { EnvironmentView, MergeMode, MergeResult }

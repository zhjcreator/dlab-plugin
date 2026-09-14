/**
 * Ports (hexagonal seams) that the core use-cases depend on.
 *
 * Each port is a minimal interface owned by @dsh-lab/core. Concrete DSH-aware
 * or CLI-aware adapters implement them in git/, store/, runner/, scheduler/,
 * and the host layer. Core NEVER imports DSH; the adapters do.
 */

import type {
  EnvironmentView,
  GitStatus,
  LabEvent,
  MergeMode,
  MergeResult,
  RunResourceRequest,
  RunStatus,
} from '@dsh-lab/shared'

/** Git operations the core needs. Implemented by @dsh-lab/git (git-port.ts). */
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
  /**
   * Snapshot ONE project-root-relative path (e.g. the shared docs directory)
   * onto `refName`, without a worktree of its own: the path lives in the
   * project root, which is not a worktree, so plumbing + a temporary index is
   * the only way to version it. `parentRef` chains the snapshots into a
   * history. Returns the commit sha.
   */
  commitPathSnapshot(input: {
    workTree: string
    path: string
    refName: string
    message: string
    parentRef?: string
    /** Generated subtree to leave out (relative to `path`). */
    exclude?: string
  }): Promise<string>
  /** Commits reachable from a ref, newest first (empty when the ref is absent). */
  logRef(refName: string, limit: number): Promise<{ commit: string; message: string; at: number }[]>
  updateRef(refName: string, commit: string): Promise<void>

  mergeBase(a: string, b: string): Promise<string>
  /** Dry-run preflight: returns changed files and whether conflicts are expected. */
  mergePreflight(targetBranch: string, sourceBranch: string): Promise<{ conflictFiles: string[]; clean: boolean }>
  /** Real merge executed in the target worktree path (shared docs keep the target's side). */
  mergeInWorktree(path: string, targetBranch: string, sourceBranch: string): Promise<string>
  /** Paths changed between two branches relative to their merge base (three-dot). */
  changedPathsBetween(branchA: string, branchB: string): Promise<string[]>
  squashMergeInWorktree(path: string, targetBranch: string, sourceBranch: string, message: string): Promise<string>

  diff(baseRef: string | undefined, a: string, b: string): Promise<{ changedFiles: { status: 'A' | 'M' | 'D'; path: string }[]; patch?: string }>
  changedFilesBetween(a: string, b: string): Promise<{ status: 'A' | 'M' | 'D'; path: string }[]>
}

/** Durable store the core uses. Implemented by @dsh-lab/store (sqlite-store.ts). */
export interface StorePort {
  getProject(): Promise<import('@dsh-lab/shared').Project | undefined>
  createProject(input: { name: string; rootPath: string }): Promise<import('@dsh-lab/shared').Project>

  listSolutions(): Promise<import('@dsh-lab/shared').Solution[]>
  getSolution(id: string): Promise<import('@dsh-lab/shared').Solution | undefined>
  getSolutionBySlug(slug: string): Promise<import('@dsh-lab/shared').Solution | undefined>
  upsertSolution(solution: import('@dsh-lab/shared').Solution): Promise<void>
  /** Record which solution is the project's main (set once at init). */
  setMainSolution(projectId: string, solutionId: string): Promise<void>
  /** Record the project-wide document directory (DESIGN §26). */
  setProjectDocs(projectId: string, docs: string): Promise<void>

  listRuns(filter?: { solutionId?: string; status?: RunStatus }): Promise<import('@dsh-lab/shared').ExperimentRun[]>
  getRun(id: string): Promise<import('@dsh-lab/shared').ExperimentRun | undefined>
  upsertRun(run: import('@dsh-lab/shared').ExperimentRun): Promise<void>

  upsertRunMetric(metric: import('@dsh-lab/shared').RunMetric): Promise<void>
  listRunMetrics(runId: string): Promise<import('@dsh-lab/shared').RunMetric[]>

  /**
   * Atomically allocate the next run id and insert its starting-row
   * skeleton — concurrent starters get distinct ids, and GPU reservations
   * always reference a run row that exists.
   */
  allocateRunId(input: { projectId: string; solutionId: string; experimentsDir: string }): Promise<{ id: string; runDir: string }>

  listReservations(): Promise<import('@dsh-lab/shared').GpuReservation[]>
  /** All-or-nothing GPU reservation for one run; false when any card is taken. */
  tryReserveGpus(gpuIds: number[], runId: string): Promise<boolean>
  /** Release every reservation held by one run (owner-correct by run_id). */
  releaseGpus(runId: string): Promise<void>

  listEvents(limit?: number): Promise<import('@dsh-lab/shared').LabEvent[]>
  appendEvent(event: { type: import('@dsh-lab/shared').LabEventType; entityType?: 'solution' | 'run'; entityId?: string; payload?: Record<string, unknown> }): Promise<void>

  transaction<T>(fn: () => Promise<T>): Promise<T>
}

/** Spawns/observes the Run process. Implemented by @dsh-lab/runner (local-runner.ts). */
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

/** GPU discovery + picking. Implemented by @dsh-lab/scheduler. */
export interface SchedulerPort {
  discover(): Promise<import('@dsh-lab/shared').GpuState[]>
  /**
   * Pick GPUs for a request. `excludedGpuIds` are the cards held by live-run
   * reservations — the store is the reservation authority, the caller passes
   * the live set, and the store's atomic tryReserveGpus serializes the final
   * claim (DESIGN §19). Rejects when the request cannot be met.
   */
  allocate(request: RunResourceRequest, opts?: { excludedGpuIds?: number[] }): Promise<number[]>
  snapshot(): Promise<import('@dsh-lab/shared').ResourceView>
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
  /**
   * Project-wide document directory, project-root relative — the shared
   * source of truth every solution worktree carries a link to (DESIGN §26).
   * Shared documents (charter, roadmap, baseline references, cross-cutting
   * lessons) live ONLY there; per-experiment notes stay in the solution.
   */
  docsDir: string // 'docs'
  /** Generated, machine-written area *inside* {@link docsDir}: mirrors + snapshots. */
  trackDir: string // '.dlab'
  /**
   * Relative path (inside a solution worktree) of the doc link. It is the
   * shared directory's own name, so `docs/` always means the project-wide
   * documents whether you stand in the project root or in any solution;
   * private experiment notes live in `notes/`.
   */
  docLinkPath: string // 'docs'
  /** Ref holding the shared-docs history (root docs/ is not in a worktree). */
  docsVersionRef: string // 'refs/dsh/docs'
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

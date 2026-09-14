/**
 * Pure domain types for the Deep Learning Lab.
 *
 * This module is imported by core, git, store, runner, scheduler, cli, and
 * lab-host. It must NOT import Cordis, DSH, or any UI dependency — it is the
 * wire/model contract shared across every surface.
 */

/** Human-visible state of one Solution. */
export type SolutionStatus =
  | 'active' // branch + worktree + DSH workspace present
  | 'archived' // branch kept; worktree removed; no DSH workspace
  | 'merged' // merged into another solution; branch kept; worktree usually removed
  | 'broken' // DB disagrees with Git/FS/registry; repair required

export type SolutionRole = 'main' | 'experiment'

export interface Solution {
  id: string // solution_<ulid>
  projectId: string
  slug: string // immutable: solutions/<slug>, exp/<slug>
  name: string
  description?: string
  hypothesis?: string
  conclusion?: string

  role: SolutionRole
  status: SolutionStatus

  branch: string // main | exp/<slug>
  worktreePath?: string // solutions/<slug> relative to project root, active only
  workspaceId?: string // ctx.workspaceRegistry id, active only

  parentSolutionId?: string
  forkCommit?: string

  headCommit: string

  mergedIntoSolutionId?: string
  mergeCommit?: string

  createdAt: number
  updatedAt: number
  archivedAt?: number
  mergedAt?: number
}

export interface Project {
  id: string
  name: string
  rootPath: string
  mainSolutionId?: string
  /**
   * Project-wide document directory (project-root relative) — the shared
   * source of truth for charter / roadmap / baseline references / lessons.
   * Every solution worktree carries a link to it, so there is exactly one
   * copy and `main` becomes the canonical carrier (DESIGN §26).
   */
  docs?: string
  createdAt: number
  updatedAt: number
}

export type RunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'lost'

export interface ExperimentRun {
  id: string // run_<ulid>
  projectId: string
  solutionId: string

  snapshotCommit: string // refs/dsh/runs/<run-id>
  sourceHeadCommit: string // solutions/<slug> HEAD at launch

  status: RunStatus
  title?: string
  description?: string
  tags: string[]

  command: string[]
  shellCommand?: string // only for explicit Shell profiles
  runProfileId?: string

  resources: RunResourceRequest

  runDir: string // experiments/run-NNNNNN relative to project root
  worktreePath?: string // .dsh-lab/run-worktrees/<run-id> relative, active only

  pid?: number
  pgid?: number
  exitCode?: number

  environmentFingerprint: string // env:<hash>

  createdAt: number
  startedAt?: number
  finishedAt?: number
}

export interface RunResourceRequest {
  mode: 'explicit' | 'auto'
  gpuIds?: number[]
  gpuCount?: number
  minFreeVramMB?: number
  env?: Record<string, string>
}

export interface RunMetric {
  runId: string
  name: string
  value: number
  dataset?: string
  split?: string
}

export interface RunProfile {
  id: string
  name: string
  command: string[]
  defaultResources?: RunResourceRequest
}

export interface EnvironmentSnapshot {
  fingerprint: string // env:<hash>
  pythonVersion?: string
  torchVersion?: string
  cudaVersion?: string
  pipFreeze?: string
  systemJson?: string
  createdAt: number
}

export interface GpuReservation {
  gpuId: number
  runId: string
  reservedAt: number
}

/** Core event log rows (persisted in the events table). */
export type LabEventType =
  | 'SolutionForked'
  | 'SolutionArchived'
  | 'SolutionRestored'
  | 'SolutionMerged'
  | 'RunCreated'
  | 'RunQueued'
  | 'RunPromoted'
  | 'RunStarted'
  | 'RunCompleted'
  | 'RunFailed'
  | 'RunCanceled'

export interface LabEvent {
  id: number
  type: LabEventType
  entityType?: 'solution' | 'run'
  entityId?: string
  payloadJson?: string
  createdAt: number
}

/** Merge directions supported by `mergeSolutions`. */
export type MergeMode = 'into-target' | 'into-fork' | 'consolidate'

export interface MergeSolutionInput {
  sourceSolutionId: string
  targetSolutionId: string
  mode?: MergeMode
  message?: string
  archiveSource?: boolean
  /**
   * Explicitly promote a line whose runs produced no successful evidence (all
   * failed/canceled, or none at all). Default false: merging into the mainline
   * requires at least one succeeded run on the source — experiment first,
   * promote only what worked.
   */
  allowUnevidenced?: boolean
}

/** One source run's contribution to the promotion gate (see SolutionService.merge). */
export interface MergeEvidence {
  /** Runs recorded for the source solution. */
  runs: number
  /** Runs that ended `succeeded` — the evidence a promotion needs. */
  succeeded: number
  /** Runs that ended failed/canceled/lost. */
  failed: number
  /** Runs still queued/running/starting. */
  live: number
  /** Whether the source line was forked from another solution. */
  forked: boolean
}

export interface MergeResult {
  sourceSolutionId: string
  targetSolutionId: string
  mergeCommit: string
  mode: MergeMode
  sourceStatusAfter: SolutionStatus
  conflictFiles: string[] // non-empty => preflight refused; nothing written
}

export interface ForkSolutionInput {
  sourceSolutionId: string
  slug: string
  name: string
  description?: string
  hypothesis?: string
  checkpointSource?: boolean // default true: auto-checkpoint dirty source first
}

export interface GitStatus {
  clean: boolean
  modified: string[]
  untracked: string[]
  staged: string[]
  headCommit: string
}

export interface DiffView {
  forkBase?: string
  headA: string
  headB: string
  changedFiles: { status: 'A' | 'M' | 'D'; path: string }[]
  patch?: string
}

/** Views returned by LabService to UI / RPC (projection of domain objects). */
export interface SolutionView {
  id: string
  slug: string
  name: string
  description?: string
  status: SolutionStatus
  role: SolutionRole
  branch: string
  worktreePath?: string
  headCommit: string
  dirty?: boolean
  parentSlug?: string
  mergedIntoSlug?: string
  hypothesis?: string
  conclusion?: string
  runCount: number
  bestSummary?: Record<string, number>
  lastRunAt?: number
}

export interface RunView {
  id: string
  solutionId: string
  solutionSlug: string
  snapshotCommit: string
  /** Branch HEAD at launch — runs sharing this value ran from the same code state. */
  sourceHeadCommit?: string
  status: RunStatus
  command: string[]
  /** Human-readable title chosen at launch (undefined when untitled). */
  title?: string
  /** Run directory relative to the project root (experiments/run-NNNNNN). */
  runDir?: string
  gpuIds?: number[]
  exitCode?: number
  createdAt: number
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  summaryMetrics?: Record<string, number>
  tags: string[]
}

export interface GpuState {
  id: number
  model: string
  freeVramMB: number
  totalVramMB: number
  runningRunIds: string[]
}

export interface ResourceView {
  gpus: GpuState[]
  queued: { runId: string; need: RunResourceRequest }[]
  polledAt: number
}

export interface EnvironmentView {
  path: string
  pythonVersion?: string
  torchVersion?: string
  cudaVersion?: string
  fingerprint: string
  lastChangedAt?: number
  warnings: string[]
}

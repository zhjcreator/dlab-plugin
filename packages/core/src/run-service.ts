/**
 * Run use cases: snapshot the solution working tree immutably, materialize a
 * detached run worktree, launch the process through RunnerPort, observe
 * status, and reconcile after restarts. No DSH imports.
 */

import { InvalidStateError, NotFoundError, resolveInside, runId } from '@dlab/shared'
import type {
  ExperimentRun,
  ForkSolutionInput,
  RunMetric,
  RunResourceRequest,
  RunStatus,
  Solution,
} from '@dlab/shared'
import type { LabDeps } from './ports.js'

export interface StartRunInput {
  solutionId: string
  profileId?: string
  command?: string[]
  resources?: RunResourceRequest
  title?: string
  tags?: string[]
}

export class RunService {
  constructor(private readonly deps: LabDeps) {}

  private get config() {
    return this.deps.config
  }

  runDir(runIdValue: string): string {
    return resolveInside(this.config.projectRoot, `experiments/${this.dirNameFor(runIdValue)}`)
  }

  private dirNameFor(runIdValue: string): string {
    // run_<ulid> → run-<counter>. The store keeps a global counter; skeleton
    // maps by looking up the run's recorded runDir (Phase 1).
    return runIdValue // placeholder — replaced when schema is in
  }

  /** Create DB row + manifest, snapshot git, add run worktree, launch. */
  async start(input: StartRunInput): Promise<ExperimentRun> {
    // Phase 1 implementation fills this in
    throw new Error('start(): not implemented yet')
  }

  async list(filter?: { solutionId?: string; status?: RunStatus }): Promise<ExperimentRun[]> {
    return this.deps.store.listRuns(filter)
  }

  async get(runIdValue: string): Promise<ExperimentRun> {
    const run = await this.deps.store.getRun(runIdValue)
    if (!run) throw new NotFoundError('run', runIdValue)
    return run
  }

  async stop(runIdValue: string): Promise<void> {
    const run = await this.get(runIdValue)
    if (run.status !== 'running' && run.status !== 'starting' && run.status !== 'queued') return
    await this.deps.runner.stop(runIdValue)
    await this.deps.store.upsertRun({ ...run, status: 'canceled', finishedAt: Date.now() })
  }

  async recordMetric(metric: RunMetric): Promise<void> {
    await this.deps.store.upsertRunMetric(metric)
  }

  /** After host restart: mark runs whose process is gone as 'lost'. */
  async reconcile(): Promise<void> {
    const running = await this.deps.store.listRuns({ status: 'running' })
    for (const run of running) {
      const alive = await this.deps.runner.isAlive(run.id)
      if (!alive) {
        await this.deps.store.upsertRun({ ...run, status: 'lost' })
      }
    }
  }
}

export type { ForkSolutionInput }

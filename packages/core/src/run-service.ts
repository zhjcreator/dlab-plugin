/**
 * Run use cases: snapshot the solution working tree immutably, materialize a
 * detached run worktree, launch the process through RunnerPort, observe
 * status, and reconcile after restarts. No DSH imports.
 *
 * Scenario B contract: the run executes the snapshot taken at launch —
 * later edits to the solution workspace never affect a running run.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { InvalidStateError, NotFoundError, resolveInside } from '@dsh-lab/shared'
import type {
  ExperimentRun,
  ResourceView,
  RunMetric,
  RunResourceRequest,
  RunStatus,
  Solution,
} from '@dsh-lab/shared'
import type { LabDeps } from './ports.js'

function isTerminal(status: RunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled' || status === 'lost'
}

/**
 * Wrapper executed instead of the raw command: records the exit code into the
 * run directory so ANY later reader (host restart, CLI invocation) can
 * finalize the run even when the spawning process is long gone.
 */
const RUN_WRAPPER = [
  'bash',
  '-c',
  [
    'trap \'printf %s "$?" > "$DSH_LAB_RUN_DIR/.exit_code"\' TERM INT',
    '"$@"',
    'ec=$?',
    'printf %s "$ec" > "$DSH_LAB_RUN_DIR/.exit_code"',
    'exit "$ec"',
  ].join('\n'),
  'dlab-run',
]

export interface StartRunInput {
  solutionId: string
  command: string[]
  resources?: RunResourceRequest
  title?: string
  tags?: string[]
}

/**
 * Grace window during which a persisted-but-not-yet-spawned 'starting' run
 * is immune to lazy finalization: a concurrent reader must not mark a
 * launching run lost (and sweep its GPU reservation) while its launcher is
 * still working. After the window a crashed launch self-heals to 'lost'.
 */
const STARTING_GRACE_MS = 120_000

/**
 * Observer of an in-process run process exit. Fired AFTER the run record is
 * finalized (terminal status persisted), so the listener can read the
 * authoritative final state via {@link RunService.get}. Adopted runs (spawned
 * by a previous host process) never fire this — their exit is unobserved.
 */
export type RunExitListener = (runId: string, code: number | null) => void

export class RunService {
  constructor(private readonly deps: LabDeps) {}

  private readonly exitListeners = new Set<RunExitListener>()

  private get config() {
    return this.deps.config
  }

  /**
   * Subscribe to in-process run process exits. The listener fires after the
   * run record reached its terminal status, so reading the run inside the
   * listener yields the final state. Errors thrown by a listener are
   * contained. Returns an unsubscriber.
   */
  onRunExit(listener: RunExitListener): () => void {
    this.exitListeners.add(listener)
    return () => {
      this.exitListeners.delete(listener)
    }
  }

  /** Contained fan-out to the exit listeners (listener errors never throw). */
  private notifyExit(runId: string, code: number | null): void {
    for (const listener of [...this.exitListeners]) {
      try {
        listener(runId, code)
      } catch {
        /* a broken observer must not break finalize bookkeeping */
      }
    }
  }

  /** Absolute run directory (experiments/run-NNNNNN). */
  runDirAbs(run: ExperimentRun): string {
    return resolve(this.config.projectRoot, run.runDir)
  }

  /** Absolute run worktree (.dsh-lab/run-worktrees/run-NNNNNN). */
  runWorktreeAbs(run: ExperimentRun): string {
    return resolve(this.config.projectRoot, this.config.runWorktreesDir, run.id)
  }

  private solutionWorktreeRel(solution: Solution): string {
    return `${this.config.solutionsDir}/${solution.slug}`
  }

  // ── start ─────────────────────────────────────────────────────────────────

  /**
   * Launch one experiment run:
   *   1. run identity: atomic counter + starting-row skeleton
   *   2. immutable snapshot of the solution working tree (temp index)
   *   3. detached run worktree at the snapshot commit
   *   4. run directory with manifest + logs, starting record persisted
   *   5. GPU allocation: binding, atomic store reservation (DESIGN §19)
   *   6. process spawn with DSH_LAB_* env
   *   7. exit observation → succeeded/failed + worktree cleanup + metrics
   */
  async start(input: StartRunInput): Promise<ExperimentRun> {
    if (input.command.length === 0) throw new InvalidStateError('run command must not be empty')

    const solution = await this.deps.store
      .getSolution(input.solutionId)
      .then((s) => s ?? this.deps.store.getSolutionBySlug(input.solutionId))
    if (!solution) throw new NotFoundError('solution', input.solutionId)
    if (solution.status !== 'active') {
      throw new InvalidStateError(`solution "${solution.slug}" is ${solution.status}; restore it before running`)
    }
    const solutionDir = this.solutionWorktreeRel(solution)

    // 1. run identity. The skeleton row exists before anything else, so
    //    (a) concurrent starters can never collide on an id, and (b) GPU
    //    reservations always reference a run row that exists.
    const { id, runDir: runDirRel } = await this.deps.store.allocateRunId({
      projectId: solution.projectId,
      solutionId: solution.id,
      experimentsDir: this.config.experimentsDir,
    })
    const refName = `${this.config.runRefPrefix}${id}`

    // 2. immutable snapshot (captures uncommitted work; never touches the branch)
    const snapshotCommit = await this.deps.git.commitTreeSnapshot(
      solutionDir,
      refName,
      `[dsh-lab] run snapshot ${id} (${solution.slug})`,
    )
    const sourceHead = await this.deps.git.branchHead(solution.branch)

    // 3. detached run worktree at the snapshot
    const worktreeRel = `${this.config.runWorktreesDir}/${id}`
    await this.deps.git.addWorktree(worktreeRel, snapshotCommit, { detach: true })
    const worktreeAbs = resolveInside(this.config.projectRoot, worktreeRel)

    // 4. run directory skeleton
    const runDirAbs = resolveInside(this.config.projectRoot, runDirRel)
    for (const sub of ['logs', 'environment', 'metrics', 'artifacts', 'configs']) {
      mkdirSync(resolve(runDirAbs, sub), { recursive: true })
    }

    // 5. environment fingerprint
    const envProbe = await this.deps.runner.probeEnvironment(this.config.projectRoot)

    // 6. persist the starting record BEFORE any GPU claim
    const resources: RunResourceRequest = { mode: 'explicit', ...(input.resources ?? {}) }
    const run: ExperimentRun = {
      id,
      projectId: solution.projectId,
      solutionId: solution.id,
      snapshotCommit,
      sourceHeadCommit: sourceHead,
      status: 'starting',
      title: input.title,
      tags: input.tags ?? [],
      command: input.command,
      resources,
      runDir: runDirRel,
      worktreePath: worktreeRel,
      environmentFingerprint: envProbe.fingerprint,
      createdAt: Date.now(),
    }
    await this.persistRun(run)
    writeFileSync(
      resolve(runDirAbs, 'manifest.json'),
      JSON.stringify({ ...run, runDirAbsolute: runDirAbs, worktreeAbsolute: worktreeAbs }, null, 2),
    )
    writeFileSync(resolve(runDirAbs, 'command.json'), JSON.stringify({ argv: input.command }, null, 2))
    if (envProbe.pythonVersion || envProbe.requirements) {
      const envDir = resolve(runDirAbs, 'environment')
      writeFileSync(
        resolve(envDir, 'python.json'),
        JSON.stringify({ python: envProbe.pythonVersion, fingerprint: envProbe.fingerprint }, null, 2),
      )
      if (envProbe.requirements) {
        writeFileSync(resolve(envDir, 'requirements.txt'), envProbe.requirements + '\n')
      }
    }

    // 7. GPU allocation — binding reservation (DESIGN §19). An explicit
    //    request fails loudly (never a silent CPU run); a run that asked for
    //    nothing proceeds unreserved when no card is free.
    try {
      resources.gpuIds = await this.allocateGpus(id, input.resources)
    } catch (error) {
      if (input.resources !== undefined) {
        await this.abortStart(run).catch(() => undefined)
        throw error
      }
      // unrequested: no GPUs available / no nvidia-smi → run on CPU
    }
    // the row carries its reservation (or the CPU fallback) from here on
    await this.persistRun(run)

    // 8. process environment
    const procEnv: Record<string, string> = {
      DSH_LAB_PROJECT_ROOT: this.config.projectRoot,
      DSH_LAB_SOLUTION_ID: solution.id,
      DSH_LAB_SOLUTION_NAME: solution.slug,
      DSH_LAB_RUN_ID: id,
      DSH_LAB_RUN_DIR: runDirAbs,
      DSH_LAB_SNAPSHOT_COMMIT: snapshotCommit,
      ...(resources.gpuIds ? { CUDA_VISIBLE_DEVICES: resources.gpuIds.join(',') } : {}),
    }
    const venvBin = resolve(this.config.projectRoot, this.config.venvDir, 'bin')
    if (existsSync(venvBin)) {
      procEnv.VIRTUAL_ENV = resolve(this.config.projectRoot, this.config.venvDir)
      procEnv.PATH = `${venvBin}:${process.env.PATH ?? ''}`
    }

    // 9. launch
    try {
      const spawned = await this.deps.runner.spawn({
        key: id,
        cwd: worktreeAbs,
        argv: [...RUN_WRAPPER, ...input.command],
        env: procEnv,
        logDir: resolve(runDirAbs, 'logs'),
        onExit: (code) => {
          void this.finalize(id, code)
            .catch(() => {
              /* finalize failures are logged by the host adapter */
            })
            .then(() => this.notifyExit(id, code))
        },
      })

      const started: ExperimentRun = {
        ...run,
        status: 'running',
        pid: spawned.pid,
        pgid: spawned.pgid,
        startedAt: Date.now(),
      }
      await this.persistRun(started)
      return started
    } catch (error) {
      await this.abortStart(run).catch(() => undefined)
      throw error
    }
  }

  // ── GPU allocation (DESIGN §19) ───────────────────────────────────────────

  /**
   * Reservation-aware allocation: candidates come from the scheduler
   * (hardware state minus cards held by live runs); the store's
   * tryReserveGpus is the atomic claim. Losing a race to a concurrent
   * starter just recomputes candidates and retries.
   */
  private async allocateGpus(runId: string, request?: RunResourceRequest): Promise<number[]> {
    for (let attempt = 0; ; attempt++) {
      const live = await this.liveReservations()
      const gpuIds = await this.deps.scheduler.allocate(request ?? { mode: 'explicit' }, {
        excludedGpuIds: [...live.keys()],
      })
      if (await this.deps.store.tryReserveGpus(gpuIds, runId)) return gpuIds
      if (attempt >= 2) throw new Error('GPU reservation lost to concurrent starters')
    }
  }

  /**
   * Live-run reservations (gpuId → runId). Rows whose run is missing or
   * terminal are stale — a crashed launch or a lost finalizer — and are
   * swept here: self-healing without a background job.
   */
  private async liveReservations(): Promise<Map<number, string>> {
    const live = new Map<number, string>()
    for (const r of await this.deps.store.listReservations()) {
      const run = await this.deps.store.getRun(r.runId)
      if (!run || isTerminal(run.status)) {
        await this.deps.store.releaseGpus(r.runId)
        continue
      }
      live.set(r.gpuId, r.runId)
    }
    return live
  }

  /**
   * A start that failed after the run record exists: record the failure,
   * release any reservation, remove the worktree. The row stays — the id
   * counter must never reuse an identity — and explains why nothing ran.
   */
  private async abortStart(run: ExperimentRun): Promise<void> {
    await this.deps.store.releaseGpus(run.id)
    await this.persistRun({ ...run, status: 'failed', finishedAt: Date.now() })
    if (run.worktreePath) {
      await this.deps.git.removeWorktree(run.worktreePath, { force: true }).catch(() => undefined)
    }
  }

  /** Persist + mirror into the manifest. */
  private async persistRun(run: ExperimentRun): Promise<void> {
    await this.deps.store.upsertRun(run)
    const manifest = resolve(this.runDirAbs(run), 'manifest.json')
    try {
      writeFileSync(manifest, JSON.stringify(run, null, 2))
    } catch {
      /* run dir may not exist yet during early writes */
    }
  }

  /** Exit path: final status, metrics ingest, worktree cleanup, GPU release. */
  private async finalize(runIdValue: string, code: number | null): Promise<void> {
    const run = await this.deps.store.getRun(runIdValue)
    if (!run || isTerminal(run.status)) return
    const status: RunStatus = code === null ? 'lost' : code === 0 ? 'succeeded' : 'failed'
    await this.persistRun({ ...run, status, exitCode: code ?? undefined, finishedAt: Date.now() })

    // ingest summary metrics when the project wrote them
    await this.ingestSummaryMetrics(run)

    // release this run's GPU reservations (by owner — never another run's)
    await this.deps.store.releaseGpus(run.id)

    // remove the run worktree; the snapshot ref stays forever
    if (run.worktreePath) {
      await this.deps.git.removeWorktree(run.worktreePath, { force: true })
    }
  }

  /** Read metrics/summary.json ({name: value} or {name: {value, dataset, split}}). */
  private async ingestSummaryMetrics(run: ExperimentRun): Promise<void> {
    const summaryPath = resolve(this.runDirAbs(run), 'metrics', 'summary.json')
    if (!existsSync(summaryPath)) return
    try {
      const parsed = JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<
        string,
        number | { value: number; dataset?: string; split?: string }
      >
      for (const [name, raw] of Object.entries(parsed)) {
        const metric: RunMetric =
          typeof raw === 'number'
            ? { runId: run.id, name, value: raw }
            : { runId: run.id, name, value: raw.value, dataset: raw.dataset, split: raw.split }
        await this.deps.store.upsertRunMetric(metric)
      }
    } catch {
      /* malformed summary — the run result stands without metrics */
    }
  }

  // ── reads (lazily finalize runs whose process died) ──────────────────────

  async list(filter?: { solutionId?: string; status?: RunStatus }): Promise<ExperimentRun[]> {
    const all = await this.deps.store.listRuns(filter)
    const out: ExperimentRun[] = []
    for (const r of all) out.push(await this.syncRunStatus(r))
    return out
  }

  async get(runIdValue: string): Promise<ExperimentRun> {
    const run = await this.deps.store.getRun(runIdValue)
    if (!run) throw new NotFoundError('run', runIdValue)
    return this.syncRunStatus(run)
  }

  /**
   * Hardware snapshot merged with live-run reservations: a reserved card
   * counts as running even before CUDA allocates its memory — what
   * lab_get_resources and the panel show, and what keeps concurrent
   * submissions from piling onto one card.
   */
  async resourceSnapshot(): Promise<ResourceView> {
    const snap = await this.deps.scheduler.snapshot()
    const byGpu = new Map<number, string[]>()
    for (const [gpuId, runId] of await this.liveReservations()) {
      const list = byGpu.get(gpuId) ?? []
      list.push(runId)
      byGpu.set(gpuId, list)
    }
    return {
      ...snap,
      gpus: snap.gpus.map((g) => ({ ...g, runningRunIds: byGpu.get(g.id) ?? g.runningRunIds })),
    }
  }

  /**
   * Cross-process finalization: a run the DB calls running whose pid is dead
   * is finalized from the wrapper's on-disk exit code (succeeded/failed), or
   * marked lost when no code was recorded (hard crash). Live pids are
   * returned unchanged (adopted after a host restart).
   */
  private async syncRunStatus(run: ExperimentRun): Promise<ExperimentRun> {
    if (isTerminal(run.status)) return run
    // a launching run (skeleton persisted, not yet spawned) must not be
    // finalized as lost by a concurrent reader — give the launcher its window
    if (
      run.status === 'starting' &&
      run.pid === undefined &&
      Date.now() - run.createdAt < STARTING_GRACE_MS
    ) {
      return run
    }
    if (run.pid !== undefined) {
      if (await this.deps.runner.isAlive(run.id)) return run // tracked in-process
      if (this.deps.runner.isPidAlive(run.pid)) return run // adopted, still running
    }
    const exitCode = this.readExitCode(run)
    if (exitCode !== null) {
      await this.finalize(run.id, exitCode)
      return (await this.deps.store.getRun(run.id))!
    }
    // no recorded code: the wrapper never ran to completion — hard kill
    await this.finalize(run.id, null)
    const lost = await this.deps.store.getRun(run.id)
    return lost ?? run
  }

  /** Read the wrapper-recorded exit code, null when absent/unparsable. */
  private readExitCode(run: ExperimentRun): number | null {
    try {
      const file = resolve(this.runDirAbs(run), '.exit_code')
      if (!existsSync(file)) return null
      const raw = readFileSync(file, 'utf8').trim()
      const code = Number.parseInt(raw, 10)
      return Number.isNaN(code) ? null : code
    } catch {
      return null
    }
  }

  // ── stop ──────────────────────────────────────────────────────────────────

  async stop(runIdValue: string): Promise<ExperimentRun> {
    const run = await this.get(runIdValue)
    if (run.status !== 'running' && run.status !== 'starting' && run.status !== 'queued') return run
    await this.deps.runner.stop(run.id)
    const canceled: ExperimentRun = { ...run, status: 'canceled', finishedAt: Date.now() }
    await this.persistRun(canceled)
    // release this run's reservations (by owner) + clean the worktree eagerly;
    // the exit callback may race
    await this.deps.store.releaseGpus(run.id)
    if (run.worktreePath) {
      await this.deps.git.removeWorktree(run.worktreePath, { force: true }).catch(() => undefined)
    }
    return canceled
  }

  // ── reconcile ─────────────────────────────────────────────────────────────

  /**
   * After a host restart the runner's live map is empty. Runs whose PID is
   * still alive are adopted (stay running, exit unobserved); everything else
   * that the DB calls running becomes 'lost'.
   */
  async reconcile(): Promise<{ adopted: string[]; lost: string[]; finalized: string[] }> {
    const adopted: string[] = []
    const lost: string[] = []
    const finalized: string[] = []
    const running = await this.deps.store.listRuns({ status: 'running' })
    for (const run of running) {
      const before = run.status
      const synced = await this.syncRunStatus(run)
      if (synced.status === before) adopted.push(run.id)
      else if (synced.status === 'lost') lost.push(run.id)
      else finalized.push(run.id)
    }
    return { adopted, lost, finalized }
  }
}

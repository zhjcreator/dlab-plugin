/**
 * Run → DSH background-job bridge (support module of the './tools' row).
 *
 * TWO job shapes per calling agent, so a batch of runs wakes the session
 * ONCE instead of once per run:
 *
 *   - one UNOWNED job per run (kind `lab-run`): `job_output` streams that
 *     run's stdout, `job_kill` stops it — but settlement delivers nothing,
 *     because dsh-tool-jobs routes completion notices by owner
 *     (`owner === undefined` ⇒ no notice, no wake);
 *   - one OWNED umbrella job (kind `lab-batch`) that stays live while ANY
 *     of the agent's lab runs is live and settles only when the last one
 *     settled — the idle owner is woken (followup) exactly once, with a
 *     summary of every run in the batch; its readOutput interleaves all
 *     live runs' logs (each line prefixed with its run id), and its cancel
 *     synchronously stops every tracked run (agent disposal stops all the
 *     session's training, same as background bash).
 *
 * The bridge is best-effort by design: when the deployment mounts no job
 * registry (or registration is refused, e.g. no job controller serves the
 * owner) the run still executes and its unowned streaming job still works —
 * only the wake-up is unavailable. Registry records are process-local like
 * the runner's live map; runs adopted after a host restart are unobserved
 * and finish through the store's cross-process finalize.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { JobHooks, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { RunView } from '@dsh-lab/shared'
import type { LabSurface } from './index.js'

/**
 * The registry treats producer kinds as an opaque id namespace and issues
 * `<kind>-<n>` ids, so any string is accepted; dsh-jobs 0.1.5 does not
 * export the module its JobKindMap augmentation lives behind.
 */
const KIND = 'lab-run'
const BATCH_KIND = 'lab-batch'

/** Byte cap for model-facing notices and streamed output reads. */
const OUTPUT_LIMIT_BYTES = 12 * 1024

/** Per-read cap for the streamed stdout cursor (the registry re-caps too). */
const READ_CAP_BYTES = 64 * 1024

/** Job ids lab_start_run's result carries: the streaming job + the wake umbrella. */
export interface RunJobIds {
  /** The per-run streaming job (job_output / job_kill handle). */
  dshJobId?: string
  /** The session's batch umbrella — the single wake when every run settled. */
  batchJobId?: string
}

/** One tracked live run inside an agent's batch. */
interface TrackedRun {
  surface: LabSurface
  /** Run directory relative to the project root (undefined pre-0.1.x records). */
  runDir?: string
}

/** One agent's umbrella-batch bookkeeping. */
interface BatchState {
  /** live runs: runId → where it runs (surface + run dir for the log reader) */
  runs: Map<string, TrackedRun>
  /** terminal records of settled runs, for the final summary */
  finished: { runId: string; status: string }[]
  /** set when the umbrella was canceled: the outcome reports killed */
  killRequested: boolean
  /** the umbrella drained — a later run starts a fresh umbrella */
  settled: boolean
  /** registry-issued id of the umbrella job */
  batchJobId?: string
  /** set while the umbrella is live; settles it when the live set drains */
  drain?: () => void
}

/**
 * Per-session job coordinator: one instance per tools row. Creates or joins
 * the calling agent's umbrella batch and registers the per-run streaming
 * jobs. All registration calls are synchronous, so check-and-create of the
 * umbrella cannot interleave.
 */
export class RunJobCoordinator {
  private readonly batches = new WeakMap<object, BatchState>()

  constructor(private readonly ctx: Context) {}

  /**
   * Register one started run: an unowned per-run streaming job plus the
   * agent's umbrella batch (created on the first run, joined while live,
   * recreated after it drained). Returns the job ids for the tool result;
   * `{}` when no jobs service is mounted.
   */
  register(surface: LabSurface, exec: { agent?: unknown; signal?: AbortSignal }, run: RunView): RunJobIds {
    const jobs = this.ctx.get('jobs') as JobRegistry | undefined
    if (!jobs) return {}

    // per-run job: always unowned — settlement must not wake anyone
    let runJobId: string | undefined
    try {
      runJobId = jobs.start({
        kind: KIND,
        label: jobLabel(run),
        outputLimitBytes: OUTPUT_LIMIT_BYTES,
        run: () => makeRunJobHooks(surface, run),
      })
    } catch {
      runJobId = undefined
    }

    if (!exec.agent) return { dshJobId: runJobId }
    let batch = this.batches.get(exec.agent)
    if (batch?.settled) batch = undefined
    if (!batch) {
      const fresh: BatchState = { runs: new Map(), finished: [], killRequested: false, settled: false }
      try {
        fresh.batchJobId = jobs.start({
          kind: BATCH_KIND,
          label: `lab batch · ${run.title ?? run.id}`,
          outputLimitBytes: OUTPUT_LIMIT_BYTES,
          owner: exec.agent,
          run: () => makeBatchHooks(fresh),
        })
        this.batches.set(exec.agent, fresh)
        batch = fresh
      } catch {
        // registration refused (e.g. no job controller serves this owner):
        // the run still executes and streams — only the wake-up is lost
        batch = undefined
      }
    }
    if (batch) this.track(batch, surface, run)
    return { dshJobId: runJobId, batchJobId: batch?.batchJobId }
  }

  /** Track one run in its agent's batch: on exit, record it and maybe drain. */
  private track(batch: BatchState, surface: LabSurface, run: RunView): void {
    batch.runs.set(run.id, { surface, runDir: run.runDir })
    const off = surface.runs.onRunExit((runId) => {
      if (runId !== run.id || batch.settled) return
      off()
      void surface.runs
        .get(run.id)
        .then(
          (final) => {
            batch.finished.push({ runId: final.id, status: final.status })
          },
          () => {
            batch.finished.push({ runId: run.id, status: 'lost' })
          },
        )
        .then(() => {
          batch.runs.delete(run.id)
          if (batch.runs.size === 0) batch.drain?.()
        })
    })
  }
}

/** One-line model-facing label: run id, title, then the command. */
function jobLabel(run: RunView): string {
  const parts = [run.id]
  if (run.title) parts.push(run.title)
  if (run.command.length > 0) parts.push(run.command.join(' '))
  return parts.join(' · ')
}

/**
 * Job hooks wired to the live run: `done` resolves when the run's process
 * exit has been finalized (the exit listener fires after the terminal
 * status is persisted, so the outcome reflects the authoritative record).
 */
function makeRunJobHooks(surface: LabSurface, run: RunView): JobHooks {
  let killRequested = false
  let settled = false
  let settle!: (outcome: JobOutcome) => void
  const done = new Promise<JobOutcome>((res) => {
    settle = res
  })

  const off = surface.runs.onRunExit((runId) => {
    if (runId !== run.id || settled) return
    settled = true
    off()
    void surface.runs
      .get(run.id)
      .then((final) => settle(outcomeOf(final, killRequested)))
      .catch(() => settle({ status: 'failed', detail: 'run record unavailable after exit' }))
  })

  return {
    cancel: () => {
      if (settled) return
      killRequested = true
      // synchronous signal first (the jobs contract requires a synchronous
      // cancel — the runner's stop sends SIGTERM before its first await),
      // then the regular stop path performs the bookkeeping
      void surface.runs.killProcess(run.id).catch(() => {})
      void surface.runs.stop(run.id).catch(() => {})
    },
    done,
    readOutput: makeRunLogReader(surface, run.runDir),
  }
}

/** Map the finalized run record to the registry's terminal outcome. */
function outcomeOf(final: RunView, killRequested: boolean): JobOutcome {
  const detail = final.exitCode !== undefined ? `exit code: ${final.exitCode}` : undefined
  if (killRequested) return { status: 'killed', detail: detail ?? 'killed' }
  if (final.status === 'canceled') return { status: 'killed', detail: detail ?? 'canceled' }
  if (final.status === 'succeeded') return { status: 'completed', detail: detail ?? 'exit code: 0' }
  return { status: 'failed', detail: detail ?? `run ${final.status}` }
}

/**
 * Umbrella hooks: live while any tracked run is live. `done` settles — the
 * single wake — when the live set drains; `cancel` stops every tracked run
 * (agent disposal lands here); `readOutput` interleaves all live logs.
 */
function makeBatchHooks(batch: BatchState): JobHooks {
  let settle!: (outcome: JobOutcome) => void
  const done = new Promise<JobOutcome>((res) => {
    settle = res
  })
  batch.drain = () => {
    if (batch.settled) return
    batch.settled = true
    settle({
      status: batch.killRequested ? 'killed' : 'completed',
      detail: summarizeBatch(batch),
    })
  }
  return {
    cancel: () => {
      batch.killRequested = true
      // synchronous signal first (the jobs contract requires a synchronous
      // cancel), then the regular stop path performs the bookkeeping; each
      // stopped run's exit listener drains the batch
      for (const [runId, tracked] of batch.runs) {
        void tracked.surface.runs.killProcess(runId).catch(() => {})
        void tracked.surface.runs.stop(runId).catch(() => {})
      }
      if (batch.runs.size === 0) batch.drain?.()
    },
    done,
    readOutput: makeBatchReader(batch),
  }
}

/** The one-line batch summary rendered into the single wake notice. */
function summarizeBatch(batch: BatchState): string {
  const counts = new Map<string, number>()
  for (const f of batch.finished) counts.set(f.status, (counts.get(f.status) ?? 0) + 1)
  const parts = [...counts.entries()].map(([status, n]) => `${n} ${status}`)
  const ids = batch.finished.map((f) => f.runId).join(', ')
  return `all ${batch.finished.length} lab run(s) settled: ${parts.join(', ')} (${ids})`
}

/**
 * Combined tail across every live tracked run, each line prefixed with its
 * run id — one `job_output` cursor for the whole batch. Settled runs drop
 * out (their full stream stays available on the per-run job).
 */
function makeBatchReader(batch: BatchState): () => string {
  const readers = new Map<string, () => string>()
  return () => {
    let out = ''
    for (const [runId, tracked] of batch.runs) {
      let read = readers.get(runId)
      if (!read) {
        read = makeRunLogReader(tracked.surface, tracked.runDir)
        readers.set(runId, read)
      }
      const chunk = read()
      if (chunk) out += prefixLines(runId, chunk)
    }
    for (const runId of readers.keys()) {
      if (!batch.runs.has(runId)) readers.delete(runId)
    }
    return out
  }
}

/** Prefix every non-empty line with its run id. */
function prefixLines(runId: string, chunk: string): string {
  return chunk
    .split('\n')
    .map((line) => (line ? `[${runId}] ${line}` : line))
    .join('\n')
}

/**
 * Streamed read of one run's stdout.log: each call returns the bytes
 * appended since the previous call (one consuming cursor, like the bash
 * producer's stream). Missing or unreadable logs read as empty.
 */
function makeRunLogReader(surface: LabSurface, runDir?: string): () => string {
  if (!runDir) return () => ''
  const file = resolve(surface.root, runDir, 'logs', 'stdout.log')
  let offset = 0
  return () => {
    try {
      const size = statSync(file).size
      if (size <= offset) return ''
      const length = Math.min(size - offset, READ_CAP_BYTES)
      const buffer = Buffer.alloc(length)
      const fd = openSync(file, 'r')
      try {
        readSync(fd, buffer, 0, length, offset)
      } finally {
        closeSync(fd)
      }
      offset += length
      return buffer.toString('utf8')
    } catch {
      return ''
    }
  }
}

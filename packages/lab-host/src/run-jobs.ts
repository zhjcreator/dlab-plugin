/**
 * Run → DSH background-job bridge (support module of the './tools' row).
 *
 * lab_start_run registers every run it launches as a first-class job in the
 * generic job registry (ctx.jobs, the same registry the bash tool's
 * `run_in_background` uses):
 *
 *   - kind `lab-run`, so job ids read `lab-run-N` and list alongside bash /
 *     subagent jobs;
 *   - owned by the CALLING AGENT, so the mounted job controller's completion
 *     listener delivers an in-session notice when the run settles — the
 *     agent is woken (followup) instead of having to poll lab_list_runs;
 *   - `readOutput` streams the run's stdout.log with a byte cursor, so
 *     job_output works on lab runs exactly like on bash jobs;
 *   - `cancel` sends SIGTERM to the run's detached process group
 *     synchronously, then lets the regular stop path do the bookkeeping
 *     (canceled record, GPU release, worktree cleanup);
 *   - agent disposal cancels the job — disposing the owning session stops
 *     its runs, mirroring background bash semantics.
 *
 * The bridge is best-effort by design: when the deployment mounts no job
 * registry (or no controller serves the owner) the run still executes with
 * today's behavior — only the completion wake-up is unavailable. Registry
 * records are process-local like the runner's live map; runs adopted after a
 * host restart are unobserved and simply finish through the store's
 * cross-process finalize.
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

/** Byte cap for model-facing notices and streamed output reads. */
const OUTPUT_LIMIT_BYTES = 12 * 1024

/** Per-read cap for the streamed stdout cursor (the registry re-caps too). */
const READ_CAP_BYTES = 64 * 1024

/**
 * Register a started run as a background job owned by the calling agent.
 * Returns the registry-issued job id (e.g. `lab-run-3`), or undefined when
 * no jobs service is mounted, the call has no owning agent, or the registry
 * refuses the registration (e.g. no job controller serves the owner).
 */
export function registerRunJob(
  ctx: Context,
  surface: LabSurface,
  exec: { agent?: unknown; signal?: AbortSignal },
  run: RunView,
): string | undefined {
  if (!exec.agent) return undefined
  const jobs = ctx.get('jobs') as JobRegistry | undefined
  if (!jobs) return undefined
  try {
    return jobs.start({
      kind: KIND,
      label: jobLabel(run),
      outputLimitBytes: OUTPUT_LIMIT_BYTES,
      owner: exec.agent,
      run: () => makeRunJobHooks(surface, run),
    })
  } catch {
    /* best-effort: the run executes regardless; only the wake-up is lost */
    return undefined
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
    readOutput: makeRunLogReader(surface, run),
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
 * Streamed read of the run's stdout.log: each call returns the bytes
 * appended since the previous call (one consuming cursor, like the bash
 * producer's stream). Missing or unreadable logs read as empty.
 */
function makeRunLogReader(surface: LabSurface, run: RunView): () => string {
  const runDir = run.runDir
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

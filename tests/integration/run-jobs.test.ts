/**
 * Run → DSH background-job bridge tests: registerRunJob against a fake job
 * registry and a fake lab surface. Covers the ownership contract the
 * deployment relies on —
 *   - the job is registered with kind `lab-run` and the calling agent as
 *     owner, labeled with the run id/title/command;
 *   - `done` settles only after the exit event fires and the finalized run
 *     record is read (completed / killed / failed mapping);
 *   - `cancel` synchronously initiates the SIGTERM (killProcess) and the
 *     outcome reports `killed`;
 *   - `readOutput` streams the run's stdout.log with a byte cursor;
 *   - degraded environments (no agent, no jobs service, refusing registry)
 *     return undefined and never break the run start.
 */

import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerRunJob } from '../../packages/lab-host/lib/run-jobs.js'
import type { RunView } from '../../packages/shared/lib/types.js'

/** Fake of the jobs-local registry: start() runs the producer synchronously. */
class FakeJobs {
  started: Array<Record<string, unknown>> = []
  hooks: Array<{ cancel: (r?: string) => void; done: Promise<unknown>; readOutput?: () => string }> = []
  refuse = false

  start(spec: Record<string, unknown>): string {
    if (this.refuse) throw new Error('background jobs unavailable: no job controller serves this agent')
    this.started.push(spec)
    this.hooks.push(spec.run() as { cancel: (r?: string) => void; done: Promise<unknown>; readOutput?: () => string })
    return `lab-run-${this.started.length}`
  }
}

type ExitListener = (runId: string, code: number | null) => void

/** Fake of the surface.runs slice the bridge touches. */
function makeSurface(runs: Map<string, RunView>, root = '/tmp/fake-lab') {
  const listeners = new Set<ExitListener>()
  const killed: string[] = []
  const stopped: string[] = []
  const surface = {
    root,
    runs: {
      get: async (id: string): Promise<RunView> => {
        const run = runs.get(id)
        if (!run) throw new Error(`run ${id} not found`)
        return run
      },
      stop: async (id: string): Promise<RunView> => {
        stopped.push(id)
        const run = runs.get(id)
        if (run) runs.set(id, { ...run, status: 'canceled' })
        return runs.get(id)!
      },
      killProcess: async (id: string): Promise<void> => {
        killed.push(id)
      },
      onRunExit: (fn: ExitListener): (() => void) => {
        listeners.add(fn)
        return () => {
          listeners.delete(fn)
        }
      },
    },
  }
  return {
    surface,
    killed,
    stopped,
    fireExit: (runId: string, code: number | null) => {
      for (const fn of [...listeners]) fn(runId, code)
    },
    hasListeners: () => listeners.size > 0,
  }
}

function makeRun(over: Partial<RunView> = {}): RunView {
  return {
    id: 'run-000042',
    solutionId: 'sol-1',
    solutionSlug: 'exp-a',
    snapshotCommit: 'a1b2c3d4',
    status: 'running',
    command: ['python', 'train.py', '--lr', '0.01'],
    title: 'baseline',
    runDir: 'experiments/run-000042',
    createdAt: Date.now(),
    tags: [],
    ...over,
  }
}

function makeExec(agent: unknown = { session: { header: { cwd: '/x' } } }) {
  return { agent, signal: new AbortController().signal }
}

/** An agent-shaped value carrying the cwd the bridge never needs but tools read. */
const AGENT = { session: { header: { cwd: '/x' } } }

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-jobs-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function ctxWithJobs(jobs: FakeJobs | undefined) {
  return { get: (name: string) => (name === 'jobs' ? jobs : undefined) }
}

describe('run → background job bridge', () => {
  it('registers a lab-run job owned by the calling agent, with a descriptive label', () => {
    const jobs = new FakeJobs()
    const { surface } = makeSurface(new Map([['run-000042', makeRun()]]))
    const jobId = registerRunJob(ctxWithJobs(jobs) as never, surface as never, makeExec(), makeRun())

    expect(jobId).toBe('lab-run-1')
    const spec = jobs.started[0]!
    expect(spec.kind).toBe('lab-run')
    expect(spec.label).toContain('run-000042')
    expect(spec.label).toContain('baseline')
    expect(spec.label).toContain('python train.py --lr 0.01')
    expect(spec.outputLimitBytes).toBeGreaterThan(0)
    expect(spec.owner).toBeTruthy() // the calling agent
    // hooks registered synchronously by start()
    expect(jobs.hooks).toHaveLength(1)
    expect(typeof jobs.hooks[0]!.cancel).toBe('function')
    expect(jobs.hooks[0]!.done).toBeInstanceOf(Promise)
    expect(typeof jobs.hooks[0]!.readOutput).toBe('function')
  })

  it('settles done from the finalized record, not the raw exit code', async () => {
    const jobs = new FakeJobs()
    const run = makeRun()
    const map = new Map([[run.id, run]])
    const { surface, fireExit } = makeSurface(map)
    registerRunJob(ctxWithJobs(jobs) as never, surface as never, makeExec(), run)

    // the exit callback fires with 0, but the persisted record says failed —
    // the outcome must reflect the authoritative record
    map.set(run.id, { ...run, status: 'failed', exitCode: 1 })
    fireExit(run.id, 0)
    const outcome = (await jobs.hooks[0]!.done) as { status: string; detail?: string }
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toBe('exit code: 1')
  })

  it('maps a canceled record to killed and a failed record to failed', async () => {
    const jobs = new FakeJobs()
    const run = makeRun({ id: 'run-000043' })
    const map = new Map([[run.id, run]])
    const { surface, fireExit } = makeSurface(map)
    registerRunJob(ctxWithJobs(jobs) as never, surface as never, makeExec(), run)

    map.set(run.id, { ...run, status: 'canceled' })
    fireExit(run.id, 143)
    const canceled = (await jobs.hooks[0]!.done) as { status: string }
    expect(canceled.status).toBe('killed')

    map.set(run.id, { ...run, status: 'failed', exitCode: 1 })
    fireExit(run.id, 1)
    // second exit on a settled job is a no-op; the first outcome stands
    const still = (await jobs.hooks[0]!.done) as { status: string }
    expect(still.status).toBe('killed')
  })

  it('cancel synchronously initiates the kill and reports killed', async () => {
    const jobs = new FakeJobs()
    const run = makeRun({ id: 'run-000044' })
    const map = new Map([[run.id, run]])
    const { surface, killed, fireExit } = makeSurface(map)
    registerRunJob(ctxWithJobs(jobs) as never, surface as never, makeExec(), run)

    jobs.hooks[0]!.cancel('user requested')
    // the SIGTERM initiation must happen synchronously inside cancel()
    expect(killed).toEqual([run.id])

    map.set(run.id, { ...run, status: 'failed', exitCode: 143 })
    fireExit(run.id, 143)
    const outcome = (await jobs.hooks[0]!.done) as { status: string; detail?: string }
    expect(outcome.status).toBe('killed')
    expect(outcome.detail).toBe('exit code: 143')
  })

  it('readOutput streams the run stdout.log with a consuming cursor', () => {
    const jobs = new FakeJobs()
    const logDir = join(dir, 'experiments/run-000045/logs')
    mkdirSync(logDir, { recursive: true })
    const logFile = join(logDir, 'stdout.log')
    writeFileSync(logFile, 'epoch 1\n')
    const run = makeRun({ id: 'run-000045', title: undefined, runDir: 'experiments/run-000045' })
    const map = new Map([[run.id, run]])
    const { surface } = makeSurface(map, dir)
    registerRunJob(ctxWithJobs(jobs) as never, surface as never, makeExec(), run)

    const read = jobs.hooks[0]!.readOutput!
    expect(read()).toBe('epoch 1\n')
    expect(read()).toBe('') // cursor consumed

    appendFileSync(logFile, 'epoch 2 acc=0.9\n')
    expect(read()).toBe('epoch 2 acc=0.9\n')

    // a job for a run whose directory is unknown reads empty, never throws
    const noDir = new FakeJobs()
    registerRunJob(
      ctxWithJobs(noDir) as never,
      surface as never,
      makeExec(),
      makeRun({ id: 'run-000046', runDir: undefined }),
    )
    expect(noDir.hooks[0]!.readOutput!()).toBe('')

    // label falls back to the command when the run is untitled
    expect(jobs.started[0]!.label).toBe('run-000045 · python train.py --lr 0.01')
  })

  it('degrades to undefined without an agent, without a jobs service, or on refusal', () => {
    const { surface } = makeSurface(new Map())
    const run = makeRun()

    // no owning agent (RPC/CLI caller): nothing to wake
    expect(registerRunJob(ctxWithJobs(new FakeJobs()) as never, surface as never, makeExec(null), run)).toBeUndefined()
    // no jobs service mounted
    expect(registerRunJob(ctxWithJobs(undefined) as never, surface as never, makeExec(), run)).toBeUndefined()
    // registry refuses (no controller serves the owner): the run still starts
    const refusing = new FakeJobs()
    refusing.refuse = true
    expect(registerRunJob(ctxWithJobs(refusing) as never, surface as never, makeExec(), run)).toBeUndefined()
    // and a refusal leaves no hooks behind
    expect(refusing.hooks).toHaveLength(0)
  })
})

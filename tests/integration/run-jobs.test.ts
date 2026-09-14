/**
 * Run → DSH background-job bridge tests: RunJobCoordinator against a fake
 * job registry and a fake lab surface. Covers the v0.1.9 batched ownership
 * contract (DESIGN §18.1) —
 *   - the per-run job (kind `lab-run`) is UNOWNED: a streaming/stopping
 *     handle whose settlement delivers no notice and no wake;
 *   - the session's umbrella (kind `lab-batch`) is the ONLY owned job: it
 *     settles — the single wake — after EVERY tracked run settled, with a
 *     summary of the batch;
 *   - per-run `done` settles from the finalized record, not the raw exit
 *     code (completed / killed / failed mapping);
 *   - per-run `cancel` synchronously initiates the SIGTERM (killProcess);
 *   - `readOutput` streams the run's stdout.log with a byte cursor;
 *   - degraded environments (no agent, no jobs service, refusal) never
 *     break the run start.
 */

import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RunJobCoordinator } from '../../packages/lab-host/lib/run-jobs.js'
import type { RunView } from '../../packages/shared/lib/types.js'

/** Fake of the jobs-local registry: start() runs the producer synchronously. */
class FakeJobs {
  started: Array<Record<string, unknown>> = []
  hooks: Array<{ cancel: (r?: string) => void; done: Promise<unknown>; readOutput?: () => string }> = []
  refuse = false
  /** Simulates "no job controller serves any agent": owned starts refuse. */
  refuseOwned = false

  start(spec: Record<string, unknown>): string {
    if (this.refuse) throw new Error('background jobs unavailable')
    if (this.refuseOwned && spec.owner !== undefined) {
      throw new Error('no job controller serves this agent')
    }
    this.started.push(spec)
    this.hooks.push(spec.run() as { cancel: (r?: string) => void; done: Promise<unknown>; readOutput?: () => string })
    return `${String(spec.kind)}-${this.started.length}`
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

const coordinator = (jobs: FakeJobs | undefined) => new RunJobCoordinator(ctxWithJobs(jobs) as never)

/** 'pending' when the promise has not settled within `ms`. */
async function pending(p: Promise<unknown>, ms: number): Promise<'pending' | 'done'> {
  return Promise.race([p.then(() => 'done' as const), new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))])
}

describe('run → background job bridge', () => {
  it('registers an UNOWNED per-run job plus ONE owned umbrella for the session', () => {
    const jobs = new FakeJobs()
    const { surface } = makeSurface(new Map([['run-000042', makeRun()]]))
    const exec = makeExec()
    const ids = coordinator(jobs).register(surface as never, exec, makeRun())

    expect(ids.dshJobId).toBe('lab-run-1')
    expect(ids.batchJobId).toBe('lab-batch-2')
    const [runSpec, batchSpec] = jobs.started
    // the per-run job: streaming/stopping handle, NO owner — its settlement
    // delivers nothing (dsh-tool-jobs routes notices by owner)
    expect(runSpec!.kind).toBe('lab-run')
    expect(runSpec!.label).toContain('run-000042')
    expect(runSpec!.label).toContain('baseline')
    expect(runSpec!.label).toContain('python train.py --lr 0.01')
    expect(runSpec!.outputLimitBytes).toBeGreaterThan(0)
    expect(runSpec!.owner).toBeUndefined()
    // the umbrella: the ONLY owned job — the single wake for the batch
    expect(batchSpec!.kind).toBe('lab-batch')
    expect(batchSpec!.owner).toBe(exec.agent)
    expect(batchSpec!.label).toContain('baseline') // `lab batch · <title ?? id>`
    // hooks registered synchronously by start(): run job first, then the umbrella
    expect(jobs.hooks).toHaveLength(2)
    expect(typeof jobs.hooks[0]!.cancel).toBe('function')
    expect(jobs.hooks[0]!.done).toBeInstanceOf(Promise)
    expect(typeof jobs.hooks[0]!.readOutput).toBe('function')
  })

  it('the umbrella settles once, after the LAST tracked run settles', async () => {
    const jobs = new FakeJobs()
    const a = makeRun({ id: 'run-000050' })
    const b = makeRun({ id: 'run-000051' })
    const map = new Map([
      [a.id, a],
      [b.id, b],
    ])
    const { surface, fireExit } = makeSurface(map)
    const exec = makeExec()
    const coord = coordinator(jobs)
    coord.register(surface as never, exec, a)
    coord.register(surface as never, exec, b)
    // registration order: run-a, umbrella, run-b
    const umbrella = jobs.hooks[1]!

    map.set(a.id, { ...a, status: 'succeeded' })
    fireExit(a.id, 0)
    await new Promise((r) => setTimeout(r, 20))
    expect(await pending(umbrella.done, 50)).toBe('pending') // b still live: NO wake

    map.set(b.id, { ...b, status: 'failed', exitCode: 2 })
    fireExit(b.id, 2)
    const outcome = (await umbrella.done) as { status: string; detail?: string }
    expect(outcome.status).toBe('completed')
    expect(outcome.detail).toContain('2 lab run(s) settled')
    expect(outcome.detail).toContain('1 succeeded')
    expect(outcome.detail).toContain('1 failed')
  })

  it('settles done from the finalized record, not the raw exit code', async () => {
    const jobs = new FakeJobs()
    const run = makeRun()
    const map = new Map([[run.id, run]])
    const { surface, fireExit } = makeSurface(map)
    coordinator(jobs).register(surface as never, makeExec(), run)

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
    coordinator(jobs).register(surface as never, makeExec(), run)

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
    coordinator(jobs).register(surface as never, makeExec(), run)

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
    coordinator(jobs).register(surface as never, makeExec(), run)

    const read = jobs.hooks[0]!.readOutput!
    expect(read()).toBe('epoch 1\n')
    expect(read()).toBe('') // cursor consumed

    appendFileSync(logFile, 'epoch 2 acc=0.9\n')
    expect(read()).toBe('epoch 2 acc=0.9\n')

    // a job for a run whose directory is unknown reads empty, never throws
    const noDir = new FakeJobs()
    coordinator(noDir).register(
      surface as never,
      makeExec(),
      makeRun({ id: 'run-000046', runDir: undefined }),
    )
    expect(noDir.hooks[0]!.readOutput!()).toBe('')

    // label falls back to the command when the run is untitled
    expect(jobs.started[0]!.label).toBe('run-000045 · python train.py --lr 0.01')
  })

  it('degrades gracefully without an agent, a jobs service, or under refusal', () => {
    const { surface } = makeSurface(new Map())
    const run = makeRun()

    // no owning agent (RPC/CLI caller): the unowned streaming job still
    // registers — only the wake (the umbrella) is agent-bound
    const solo = new FakeJobs()
    const noAgent = coordinator(solo).register(surface as never, makeExec(null), run)
    expect(noAgent.dshJobId).toBe('lab-run-1')
    expect(noAgent.batchJobId).toBeUndefined()
    expect(solo.started).toHaveLength(1)

    // no jobs service mounted: nothing at all
    expect(coordinator(undefined).register(surface as never, makeExec(), run)).toEqual({})

    // registry refuses everything: the run still starts, nothing registered
    const refusing = new FakeJobs()
    refusing.refuse = true
    expect(coordinator(refusing).register(surface as never, makeExec(), run)).toEqual({})
    expect(refusing.hooks).toHaveLength(0)

    // owned starts refused (no controller serves the owner) but unowned
    // allowed: streaming survives, only the wake is lost
    const noController = new FakeJobs()
    noController.refuseOwned = true
    const wakeless = coordinator(noController).register(surface as never, makeExec(), run)
    expect(wakeless.dshJobId).toBe('lab-run-1')
    expect(wakeless.batchJobId).toBeUndefined()
  })
})

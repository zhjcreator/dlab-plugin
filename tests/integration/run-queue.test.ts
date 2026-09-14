/**
 * GPU wait-queue integration tests (DESIGN §19): a full machine queues
 * instead of failing; FIFO + first-fit promotion on release; submission-time
 * snapshots hold across queue waits; queued runs are stable under reads.
 *
 * Real ports (git/store/runner) on a temp lab; the scheduler runs the REAL
 * GpuScheduler with a deterministic 2-card fake probe.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { makeDeps } from '../../packages/cli/lib/cli.js'
import { SolutionService, RunService } from '../../packages/core/lib/index.js'
import type { LabDeps } from '../../packages/core/lib/index.js'
import { GpuScheduler } from '../../packages/scheduler/lib/index.js'
import type { RawGpu } from '../../packages/scheduler/lib/index.js'

const SANDBOX = join(tmpdir(), 'dlab-queue')

/** Deterministic 2× fake GPU probe. */
const twoCards = (): RawGpu[] =>
  Array.from({ length: 2 }, (_, i) => ({
    index: i,
    name: 'Fake 4090',
    memoryTotalMB: 24564,
    memoryFreeMB: 24564,
  }))

let labRoot: string
let deps: LabDeps
let solutions: SolutionService
let runs: RunService

async function waitUntil(check: () => Promise<boolean> | boolean, ms = 15000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('waitUntil timed out')
}

const statusOf = async (runId: string) => ((await runs.get(runId)) as { status: string; resources: { gpuIds?: number[] } })

beforeAll(async () => {
  mkdirSync(SANDBOX, { recursive: true })
  labRoot = mkdtempSync(join(SANDBOX, 'lab-'))
  deps = { ...makeDeps(labRoot, 'QueueTest'), scheduler: new GpuScheduler({ probe: twoCards }) }
  solutions = new SolutionService(deps)
  runs = new RunService(deps)
  await solutions.init(labRoot, 'QueueTest')
  await solutions.fork({ sourceSolutionId: 'main', slug: 'exp', name: 'Exp' })
})

afterEach(async () => {
  // stop EVERYTHING non-terminal — stopping holds releases cards, which
  // promotes queued runs, so run extra passes for the just-promoted
  for (let pass = 0; pass < 3; pass++) {
    const live = (await runs.list().catch(() => [])).filter(
      (r) => r.status === 'running' || r.status === 'starting' || r.status === 'queued',
    )
    if (live.length === 0) return
    for (const r of live) await runs.stop(r.id).catch(() => undefined)
  }
})

afterAll(async () => {
  for (const r of await runs.list().catch(() => [])) {
    if (r.status === 'running' || r.status === 'starting' || r.status === 'queued') {
      await runs.stop(r.id).catch(() => undefined)
    }
  }
  ;(deps.store as unknown as { close(): void }).close()
  if (labRoot) rmSync(labRoot, { recursive: true, force: true })
})

const start = (title: string, command: string[], resources?: { gpuCount?: number; minFreeVramMB?: number }) =>
  runs.start({ solutionId: 'exp', command, title, resources })

describe('GPU wait-queue (DESIGN §19)', () => {
  it('a full machine queues the extra run instead of failing it', async () => {
    const a = await start('hold-a', ['sleep', '60'])
    const b = await start('hold-b', ['sleep', '60'])
    expect(a.status).toBe('running')
    expect(b.status).toBe('running')
    expect([a.resources.gpuIds, b.resources.gpuIds]).toEqual([[0], [1]])

    // every card busy → the third run QUEUES (status queued, no cards, no worktree)
    const c = await start('wait-c', ['sleep', '60'])
    expect(c.status).toBe('queued')
    expect(c.resources.gpuIds).toBeUndefined()
    expect(existsSync(join(labRoot, '.dsh-lab/run-worktrees', c.id))).toBe(false)

    // reads never disturb the queue (the lost-finalization trap)
    expect((await statusOf(c.id)).status).toBe('queued')

    // the resource snapshot lists the queue in order, with its request
    const snap = await runs.resourceSnapshot()
    expect(snap.queued.map((q) => q.runId)).toEqual([c.id])
    expect(snap.queued[0]!.need).toEqual({ mode: 'explicit' })

    await runs.stop(a.id)
    await runs.stop(b.id)
  },
    20000,
  )

  it('a released card promotes the waiting run', async () => {
    const a = await start('hold-d', ['sleep', '60'])
    await start('hold-e', ['sleep', '60'])
    const c = await start('wait-f', ['bash', '-c', 'echo promoted-ok'])

    await runs.stop(a.id) // releases card 0 → finalize pumps the queue
    await waitUntil(async () => (await statusOf(c.id)).status === 'succeeded')
    const final = await runs.get(c.id)
    expect(final.resources.gpuIds).toEqual([0]) // the freed card
    expect(readFileSync(join(labRoot, final.runDir, 'logs', 'stdout.log'), 'utf8')).toContain('promoted-ok')
    // the promoted run materialized a worktree (now cleaned by finalize)
    await runs.stop(((await runs.list()).find((r) => r.title === 'hold-e'))!.id)
  },
    25000,
  )

  it('FIFO scan with first-fit: a big head-of-queue request never blocks smaller ones', async () => {
    const a = await start('hold-g', ['sleep', '60'])
    const b = await start('hold-h', ['sleep', '60'])
    // X (submitted first) needs BOTH cards; Y only one
    const x = await start('big-x', ['sleep', '60'], { gpuCount: 2 })
    const y = await start('small-y', ['sleep', '60'])
    expect(x.status).toBe('queued')
    expect(y.status).toBe('queued')

    await runs.stop(a.id) // one card free: X cannot fit, Y can
    await waitUntil(async () => (await statusOf(y.id)).status === 'running')
    expect((await statusOf(x.id)).status).toBe('queued')
    expect((await runs.get(y.id)).resources.gpuIds).toEqual([0])

    await runs.stop(b.id) // still only one card free (Y holds 0): X keeps waiting
    await new Promise((r) => setTimeout(r, 300))
    expect((await statusOf(x.id)).status).toBe('queued')

    await runs.stop(y.id) // both cards free: X finally fits
    await waitUntil(async () => (await statusOf(x.id)).status === 'running')
    expect((await runs.get(x.id)).resources.gpuIds).toEqual([0, 1])
    await runs.stop(x.id)
  },
    30000,
  )

  it('the snapshot is taken at SUBMISSION — edits while queued never leak in', async () => {
    const a = await start('hold-i', ['sleep', '60'])
    await start('hold-j', ['sleep', '60'])
    writeFileSync(join(labRoot, 'solutions/exp/model.txt'), 'v1-submitted\n')
    const c = await start('snap-c', ['bash', '-c', 'cat model.txt'])
    expect(c.status).toBe('queued')

    // mutate the solution while the run waits in queue
    writeFileSync(join(labRoot, 'solutions/exp/model.txt'), 'v2-edited-while-queued\n')

    await runs.stop(a.id) // promote c
    await waitUntil(async () => (await statusOf(c.id)).status === 'succeeded')
    const stdout = readFileSync(join(labRoot, (await runs.get(c.id)).runDir, 'logs', 'stdout.log'), 'utf8')
    expect(stdout).toContain('v1-submitted')
    expect(stdout).not.toContain('v2-edited-while-queued')
    await runs.stop(((await runs.list()).find((r) => r.title === 'hold-j'))!.id)
  },
    25000,
  )

  it('stopping a queued run cancels it and it is never promoted', async () => {
    const a = await start('hold-k', ['sleep', '60'])
    await start('hold-l', ['sleep', '60'])
    const c = await start('cancel-m', ['sleep', '60'])
    expect(c.status).toBe('queued')

    await runs.stop(c.id)
    expect((await statusOf(c.id)).status).toBe('canceled')

    await runs.stop(a.id) // card frees — the canceled run must NOT come back
    await new Promise((r) => setTimeout(r, 300))
    expect((await statusOf(c.id)).status).toBe('canceled')
    await runs.stop(((await runs.list()).find((r) => r.title === 'hold-l'))!.id)
  },
    25000,
  )

  it('impossible requests fail immediately instead of queueing forever', async () => {
    await expect(start('impossible', ['sleep', '60'], { gpuCount: 3 })).rejects.toThrow(
      /not enough free GPUs/,
    )
    const failed = (await runs.list()).find((r) => r.title === 'impossible')!
    expect(failed.status).toBe('failed')
    expect(failed.resources.gpuIds).toBeUndefined()
    expect((await runs.resourceSnapshot()).queued).toEqual([])
  },
    15000,
  )

  it('queue and promotion land in the event log', async () => {
    const a = await start('hold-n', ['sleep', '60'])
    await start('hold-o', ['sleep', '60'])
    const c = await start('event-p', ['true'])
    await runs.stop(a.id)
    await waitUntil(async () => (await statusOf(c.id)).status === 'succeeded')
    const types = (await deps.store.listEvents(50)).map((e) => e.type)
    expect(types).toContain('RunQueued')
    expect(types).toContain('RunPromoted')
    await runs.stop(((await runs.list()).find((r) => r.title === 'hold-o'))!.id)
  },
    25000,
  )

  it('a command that selects its own card is rejected loudly with guidance', async () => {
    // inline env prefix inside a shell command
    await expect(
      runs.start({ solutionId: 'exp', command: ['bash', '-c', 'CUDA_VISIBLE_DEVICES=0 python train.py'] }),
    ).rejects.toThrow(/dlab owns card selection/)
    // the env(1) form
    await expect(
      runs.start({ solutionId: 'exp', command: ['env', 'CUDA_VISIBLE_DEVICES=0,1', 'python', 'train.py'] }),
    ).rejects.toThrow(/card-agnostic/)
    // via the resources env
    await expect(
      runs.start({
        solutionId: 'exp',
        command: ['true'],
        resources: { mode: 'auto', gpuCount: 1, env: { CUDA_VISIBLE_DEVICES: '0' } },
      }),
    ).rejects.toThrow(/silently break reservations/)
    // nothing was created by the rejections
    expect((await runs.list()).every((r) => !r.title?.includes('train.py'))).toBe(true)
  })

  it('a GPU-less machine: unrequested runs proceed on CPU, requests fail loudly', async () => {
    const cpuDeps = {
      ...makeDeps(mkdtempSync(join(SANDBOX, 'cpu-')), 'CpuTest'),
      scheduler: new GpuScheduler({
        probe: () => {
          throw new Error('no nvidia-smi')
        },
      }),
    }
    const cpuSolutions = new SolutionService(cpuDeps)
    const cpuRuns = new RunService(cpuDeps)
    await cpuSolutions.init(cpuDeps.config.projectRoot, 'CpuTest')
    await cpuSolutions.fork({ sourceSolutionId: 'main', slug: 'exp', name: 'Exp' })

    const plain = await cpuRuns.start({ solutionId: 'exp', command: ['true'] })
    expect(plain.status).toBe('running')
    expect(plain.resources.gpuIds).toBeUndefined()
    await expect(
      cpuRuns.start({ solutionId: 'exp', command: ['true'], resources: { mode: 'auto', gpuCount: 1 } }),
    ).rejects.toThrow()
    await cpuRuns.stop(plain.id)
    ;(cpuDeps.store as unknown as { close(): void }).close()
  },
    15000,
  )
})

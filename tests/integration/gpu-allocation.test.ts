/**
 * GPU allocation integration tests (DESIGN §19): reservations are binding,
 * atomic, and released on terminal states — concurrent submissions spread
 * across cards instead of piling onto the first free one.
 *
 * Real ports (git/store/runner) on a temp lab; the scheduler runs the REAL
 * GpuScheduler with a deterministic 4-card fake probe.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeDeps } from '../../packages/cli/lib/cli.js'
import { SolutionService, RunService } from '../../packages/core/lib/index.js'
import type { LabDeps } from '../../packages/core/lib/index.js'
import { GpuScheduler } from '../../packages/scheduler/lib/index.js'
import type { RawGpu } from '../../packages/scheduler/lib/index.js'

const SANDBOX = join(tmpdir(), 'dlab-gpu')

/** Deterministic 4× fake GPU probe (same shape queryNvidiaSmi returns). */
const fakeProbe = (): RawGpu[] =>
  Array.from({ length: 4 }, (_, i) => ({
    index: i,
    name: 'Fake 4090',
    memoryTotalMB: 24564,
    memoryFreeMB: 24564,
  }))

let labRoot: string
let deps: LabDeps
let solutions: SolutionService
let runs: RunService

beforeAll(async () => {
  mkdirSync(SANDBOX, { recursive: true })
  labRoot = mkdtempSync(join(SANDBOX, 'lab-'))
  deps = { ...makeDeps(labRoot, 'GpuTest'), scheduler: new GpuScheduler({ probe: fakeProbe }) }
  solutions = new SolutionService(deps)
  runs = new RunService(deps)
  await solutions.init(labRoot, 'GpuTest')
  await solutions.fork({ sourceSolutionId: 'main', slug: 'exp', name: 'Exp' })
})

afterAll(async () => {
  // stop everything still alive, then dispose
  for (const r of await runs.list().catch(() => [])) {
    if (r.status === 'running' || r.status === 'starting' || r.status === 'queued') {
      await runs.stop(r.id).catch(() => undefined)
    }
  }
  ;(deps.store as unknown as { close(): void }).close()
  if (labRoot) rmSync(labRoot, { recursive: true, force: true })
})

const start = (title: string, resources?: Parameters<RunService['start']>[0]['resources']) =>
  runs.start({ solutionId: 'exp', command: ['sleep', '600'], title, resources })

describe('GPU allocation (DESIGN §19)', () => {
  it('sequential submissions spread across cards — the reported pileup bug', async () => {
    const a = await start('spread-a')
    const b = await start('spread-b')
    const c = await start('spread-c')
    expect([a.resources.gpuIds, b.resources.gpuIds, c.resources.gpuIds]).toEqual([[0], [1], [2]])
  })

  it('reserved cards show as running in the resource snapshot before CUDA allocates', async () => {
    const snap = await runs.resourceSnapshot()
    const busy = snap.gpus.filter((g) => g.runningRunIds.length > 0)
    expect(busy.map((g) => g.id)).toEqual([0, 1, 2])
    const runIds = new Set(busy.flatMap((g) => g.runningRunIds))
    const live = (await runs.list()).filter((r) => r.status === 'running').map((r) => r.id)
    for (const id of live) expect(runIds.has(id)).toBe(true)
  })

  it('a released card is the next candidate again', async () => {
    const all = await runs.list()
    const a = all.find((r) => r.title === 'spread-a')!
    await runs.stop(a.id)
    const d = await start('reuse-d')
    expect(d.resources.gpuIds).toEqual([0])
    await runs.stop(d.id)
  })

  it('concurrent starters get distinct ids and never share a card', async () => {
    // two free cards left (0 and 3): two concurrent submissions must land
    // on DISTINCT cards — the race the old REPLACE-reservation lost
    const [x, y] = await Promise.all([start('conc-x'), start('conc-y')])
    expect(new Set([x.id, y.id]).size).toBe(2)
    const claimed = [x.resources.gpuIds, y.resources.gpuIds]
    expect(claimed.every((g) => g !== undefined)).toBe(true)
    expect(new Set(claimed.map((g) => g![0]))).toEqual(new Set([0, 3]))
    // a third submission with every card held: implicit request → CPU
    // fallback (no gpuIds), never a crash and never a stolen card
    const z = await start('conc-z')
    expect(z.resources.gpuIds).toBeUndefined()
    await runs.stop(x.id).catch(() => undefined)
    await runs.stop(y.id).catch(() => undefined)
    await runs.stop(z.id).catch(() => undefined)
  })

  it('an explicit request fails loudly instead of silently running on CPU', async () => {
    // cards 1,2 are still held; 3 cards cannot be mustered
    await expect(start('loud-fail', { mode: 'auto', gpuCount: 3 })).rejects.toThrow(/not enough free GPUs/)
    const failed = (await runs.list()).find((r) => r.title === 'loud-fail')!
    expect(failed.status).toBe('failed')
    expect(failed.resources.gpuIds).toBeUndefined()
    // the aborted start cleaned up its worktree
    expect(existsSync(join(labRoot, failed.worktreePath ?? 'nowhere'))).toBe(false)
    // and left the live reservations untouched
    const reserved = await deps.store.listReservations()
    expect(reserved.map((r) => r.gpuId).sort()).toEqual([1, 2])
  })

  it('pinned gpuIds are honored and protected from double-booking', async () => {
    const pinned = await start('pin-1', { mode: 'explicit', gpuIds: [0] })
    expect(pinned.resources.gpuIds).toEqual([0])
    await expect(start('pin-2', { mode: 'explicit', gpuIds: [0] })).rejects.toThrow(
      /GPU 0 is reserved by another run/,
    )
    const failed = (await runs.list()).find((r) => r.title === 'pin-2')!
    expect(failed.status).toBe('failed')
    await runs.stop(pinned.id)
  })

  it('stale reservations (missing/terminal run) are swept on the next allocation', async () => {
    // stop the remaining spread runs so every card is free
    for (const r of await runs.list()) {
      if (r.status === 'running') await runs.stop(r.id).catch(() => undefined)
    }
    // an orphaned reservation: its run does not exist (crashed launch)
    expect(await deps.store.tryReserveGpus([2], 'run-999999')).toBe(true)
    const next = await start('sweep-next')
    expect(next.resources.gpuIds).toEqual([0]) // stale row did not block card 2
    const reserved = await deps.store.listReservations()
    expect(reserved.map((r) => r.runId)).toEqual([next.id])
    await runs.stop(next.id)
  })
})

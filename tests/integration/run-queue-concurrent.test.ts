/**
 * Concurrent-submission card allocation (DESIGN §19 / §19.1).
 *
 * The PRD incident these guard (2026-09-14, runs 12–19): eight runs submitted
 * within ~4 seconds ALL received GPU 0 and seven died on OOM, because a
 * submission reserved its card only after the next submission had already
 * probed the machine. The invariant the fix must hold — and what the user
 * expects — is:
 *
 *   - a rapid concurrent batch spreads over DISTINCT free cards;
 *   - a batch that arrives on a full machine QUEUES, and nothing waits while a
 *     satisfiable card is free;
 *   - promotions land on DISTINCT freed cards, not all on one.
 *
 * The scheduler runs the REAL GpuScheduler against a deterministic 8-card
 * fake probe; the store's atomic reservation is the real SQLite one.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { makeDeps } from '../../packages/cli/lib/cli.js'
import { SolutionService, RunService } from '../../packages/core/lib/index.js'
import type { LabDeps } from '../../packages/core/lib/index.js'
import { GpuScheduler } from '../../packages/scheduler/lib/index.js'
import type { RawGpu } from '../../packages/scheduler/lib/index.js'

const SANDBOX = join(tmpdir(), 'dlab-queue-concurrent')
const CARDS = 8

/** Deterministic N× fake GPU probe — every card free and identical. */
const eightCards = (): RawGpu[] =>
  Array.from({ length: CARDS }, (_, i) => ({
    index: i,
    name: 'Fake 4090',
    memoryTotalMB: 24564,
    memoryFreeMB: 24564,
  }))

let labRoot: string
let deps: LabDeps
let runs: RunService

const auto = { mode: 'auto', gpuCount: 1 } as const

const start = (title: string) =>
  runs.start({ solutionId: 'exp', command: ['sleep', '60'], title, resources: auto })

const cardsOf = (rs: { resources: { gpuIds?: number[] } }[]) =>
  rs.map((r) => r.resources.gpuIds?.[0]).sort((a, b) => (a ?? -1) - (b ?? -1))

async function waitUntil(check: () => Promise<boolean>, ms = 20000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('waitUntil timed out')
}

beforeAll(async () => {
  mkdirSync(SANDBOX, { recursive: true })
  labRoot = mkdtempSync(join(SANDBOX, 'lab-'))
  deps = { ...makeDeps(labRoot, 'QueueConcurrent'), scheduler: new GpuScheduler({ probe: eightCards }) }
  const solutions = new SolutionService(deps)
  runs = new RunService(deps)
  await solutions.init(labRoot, 'QueueConcurrent')
  await solutions.fork({ sourceSolutionId: 'main', slug: 'exp', name: 'Exp' })
})

afterEach(async () => {
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
    if (['running', 'starting', 'queued'].includes(r.status)) await runs.stop(r.id).catch(() => undefined)
  }
  ;(deps.store as unknown as { close(): void }).close()
  if (labRoot) rmSync(labRoot, { recursive: true, force: true })
})

describe('concurrent submissions never pile onto one card', () => {
  it(`${CARDS} parallel submissions take ${CARDS} DISTINCT cards`, async () => {
    const batch = await Promise.all(Array.from({ length: CARDS }, (_, i) => start(`wave1-${i}`)))

    expect(batch.every((r) => r.status === 'running')).toBe(true)
    const cards = cardsOf(batch)
    expect(cards).toEqual(Array.from({ length: CARDS }, (_, i) => i))
    expect(new Set(cards).size).toBe(CARDS)
  }, 40000)

  it('a parallel batch on a full machine queues, then promotions take DISTINCT freed cards', async () => {
    const holders = await Promise.all(Array.from({ length: CARDS }, (_, i) => start(`hold-${i}`)))
    expect(cardsOf(holders)).toEqual(Array.from({ length: CARDS }, (_, i) => i))

    const waiting = await Promise.all(Array.from({ length: 4 }, (_, i) => start(`waiting-${i}`)))
    // nothing waits while a satisfiable card is free — here every card is held
    expect(waiting.every((r) => r.status === 'queued')).toBe(true)
    expect(waiting.every((r) => r.resources.gpuIds === undefined)).toBe(true)

    // free exactly two cards — whichever two this pair of runs holds
    const freed = [holders[2]!, holders[5]!].map((r) => r.resources.gpuIds![0]!)
    await runs.stop(holders[2]!.id)
    await runs.stop(holders[5]!.id)

    await waitUntil(async () =>
      (await runs.list()).filter((r) => r.title?.startsWith('waiting-') && r.status === 'running').length === 2,
    )
    const promoted = (await runs.list()).filter((r) => r.title?.startsWith('waiting-') && r.status === 'running')
    const cards = promoted.map((r) => r.resources.gpuIds?.[0]).sort((a, b) => (a ?? -1) - (b ?? -1))
    // one run per freed card — never two on one, never on a still-held card
    expect(cards).toEqual([...freed].sort((a, b) => a - b))
  }, 45000)

  it('queued runs hold their request: after promotion each still occupies exactly one card', async () => {
    const waiting = await Promise.all(Array.from({ length: 3 }, (_, i) => start(`idle-${i}`)))
    expect(waiting.every((r) => r.status === 'running')).toBe(true)
    expect(new Set(cardsOf(waiting)).size).toBe(3)

    const snapshot = await runs.resourceSnapshot()
    expect(snapshot.queued).toEqual([])
    const reserved = snapshot.gpus.filter((g) => g.runningRunIds.length > 0)
    expect(reserved.length).toBe(3)
  }, 30000)
})

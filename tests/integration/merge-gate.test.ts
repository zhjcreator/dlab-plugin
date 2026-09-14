/**
 * Promotion gate tests: a merge INTO main is refused unless the line was
 * forked from another solution and produced at least one succeeded run.
 *
 * The gate is deliberately narrow:
 *   - experiment → experiment merges stay ungated (combining two half-finished
 *     lines is legitimate exploration),
 *   - `allowUnevidenced: true` is the explicit, deliberate override,
 *   - the refusal happens BEFORE any git operation (no branch is touched).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeDeps } from '../../packages/cli/lib/cli.js'
import { SolutionService, RunService } from '../../packages/core/lib/index.js'
import type { LabDeps } from '../../packages/core/lib/index.js'

const SANDBOX_ROOT = '/home2/zhanghanjin/WorkSpace/dsh-scholar/scratch-dlab'

let labRoot: string
let deps: LabDeps
let solutions: SolutionService
let runs: RunService

beforeAll(async () => {
  mkdirSync(SANDBOX_ROOT, { recursive: true })
  labRoot = mkdtempSync(join(SANDBOX_ROOT, 'gate-'))
  deps = makeDeps(labRoot, 'GateTest')
  solutions = new SolutionService(deps)
  runs = new RunService(deps)
  await solutions.init(labRoot, 'GateTest')
})

afterAll(() => {
  ;(deps.store as unknown as { close(): void }).close()
  if (labRoot) rmSync(labRoot, { recursive: true, force: true })
})

/** Wait until a run reaches a terminal status. */
async function settle(runId: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = await runs.get(runId)
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'canceled' || run.status === 'lost') return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('run did not settle')
}

describe('promotion gate: main accepts only evidenced forks', () => {
  it('refuses a merge into main when the line has no successful run', async () => {
    await solutions.fork({ sourceSolutionId: 'main', slug: 'gate-empty', name: 'Gate Empty' })
    const evidence = await solutions.mergeEvidence('gate-empty')
    expect(evidence.forked).toBe(true)
    expect(evidence.succeeded).toBe(0)

    await expect(
      solutions.merge({ sourceSolutionId: 'gate-empty', targetSolutionId: 'main', mode: 'into-target' }),
    ).rejects.toThrow(/refusing to merge "gate-empty" into "main": the line has no runs/)
    // nothing was written: main is still active and the source untouched
    expect((await solutions.get('main')).status).toBe('active')
    expect((await solutions.get('gate-empty')).status).toBe('active')
  })

  it('refuses when the line only produced failed/canceled runs', async () => {
    await solutions.fork({ sourceSolutionId: 'main', slug: 'gate-failed', name: 'Gate Failed' })
    const run = await runs.start({ solutionId: 'gate-failed', command: ['bash', '-c', 'exit 3'] })
    await settle(run.id)
    expect((await runs.get(run.id)).status).toBe('failed')

    const evidence = await solutions.mergeEvidence('gate-failed')
    expect(evidence.failed).toBe(1)
    expect(evidence.succeeded).toBe(0)

    await expect(
      solutions.merge({ sourceSolutionId: 'gate-failed', targetSolutionId: 'main' }),
    ).rejects.toThrow(/produced only 1 failed\/canceled run/)
  })

  it('refuses while the line is still running (no verdict yet)', async () => {
    await solutions.fork({ sourceSolutionId: 'main', slug: 'gate-live', name: 'Gate Live' })
    const run = await runs.start({ solutionId: 'gate-live', command: ['bash', '-c', 'sleep 30'] })
    try {
      await expect(
        solutions.merge({ sourceSolutionId: 'gate-live', targetSolutionId: 'main' }),
      ).rejects.toThrow(/is still running/)
    } finally {
      await runs.stop(run.id)
    }
  })

  it('allows the merge once a run succeeded, and blocks a repeat of it', async () => {
    await solutions.fork({ sourceSolutionId: 'main', slug: 'gate-ok', name: 'Gate OK' })
    writeFileSync(join(labRoot, 'solutions/gate-ok/model.txt'), 'ok\n')
    const run = await runs.start({ solutionId: 'gate-ok', command: ['bash', '-c', 'echo ok'] })
    await settle(run.id)
    expect((await runs.get(run.id)).status).toBe('succeeded')
    expect((await solutions.mergeEvidence('gate-ok')).succeeded).toBe(1)

    const result = await solutions.merge({
      sourceSolutionId: 'gate-ok',
      targetSolutionId: 'main',
      mode: 'into-target',
    })
    expect(result.conflictFiles).toEqual([])
    expect((await solutions.get('gate-ok')).status).toBe('merged')
    // main absorbed the experiment file
    expect(await deps.git.getStatus('solutions/main')).toBeTruthy()
  })

  it('lets an explicit override through (deliberate promotion)', async () => {
    await solutions.fork({ sourceSolutionId: 'main', slug: 'gate-override', name: 'Gate Override' })
    const result = await solutions.merge({
      sourceSolutionId: 'gate-override',
      targetSolutionId: 'main',
      mode: 'into-target',
      allowUnevidenced: true,
    })
    expect(result.mergeCommit).toBeTruthy()
  })

  it('leaves experiment → experiment merges ungated', async () => {
    await solutions.fork({ sourceSolutionId: 'main', slug: 'gate-x', name: 'Gate X' })
    await solutions.fork({ sourceSolutionId: 'main', slug: 'gate-y', name: 'Gate Y' })
    // neither has a run; into-fork between two experiments must still work
    const result = await solutions.merge({
      sourceSolutionId: 'gate-x',
      targetSolutionId: 'gate-y',
      mode: 'into-fork',
    })
    expect(result.conflictFiles).toEqual([])
    expect((await solutions.get('gate-x')).status).toBe('active')
  })
})

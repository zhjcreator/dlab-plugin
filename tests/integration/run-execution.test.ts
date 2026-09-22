/**
 * Phase-3 run execution tests: snapshot isolation (Scenario B), full run
 * lifecycle (start → running → succeeded + metrics + worktree cleanup + ref
 * retention), stop, and reconcile-after-restart semantics.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeDeps } from '../../packages/cli/lib/cli.js'
import { SolutionService, RunService } from '../../packages/core/lib/index.js'
import type { LabDeps } from '../../packages/core/lib/index.js'

// Local integration sandbox. Override with DLAB_SANDBOX_ROOT=<dir> to keep
// scratch dirs across runs; otherwise vitest uses the OS temp dir.
const SANDBOX_ROOT = process.env.DLAB_SANDBOX_ROOT ?? join(tmpdir(), 'dlab-sandbox')

let labRoot: string
let deps: LabDeps
let solutions: SolutionService
let runs: RunService

beforeAll(() => {
  mkdirSync(SANDBOX_ROOT, { recursive: true })
  labRoot = mkdtempSync(join(SANDBOX_ROOT, 'run-'))
  deps = makeDeps(labRoot, 'RunTest')
  solutions = new SolutionService(deps)
  runs = new RunService(deps)
})

afterAll(() => {
  ;(deps.store as unknown as { close(): void }).close()
  if (labRoot) rmSync(labRoot, { recursive: true, force: true })
})

/** A tiny "training script": records code state, writes summary metrics, exits 0. */
function writeRunner(): string {
  const script = join(labRoot, 'train.sh')
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'set -e',
      'echo "RUN_ID=$DSH_LAB_RUN_ID"',
      'echo "CODE_STATE=$(cat model.txt)"',
      'sleep 0.4',
      'mkdir -p "$DSH_LAB_RUN_DIR/metrics"',
      'printf \'{"auc": 0.927, "f1": {"value": 0.881, "dataset": "celebdf", "split": "test"}}\' > "$DSH_LAB_RUN_DIR/metrics/summary.json"',
      'echo done',
    ].join('\n') + '\n',
    { mode: 0o755 },
  )
  return script
}

describe('run execution', () => {
  it('initializes and forks a solution with uncommitted model code', async () => {
    await solutions.init(labRoot, 'RunTest')
    await solutions.fork({ sourceSolutionId: 'main', slug: 'exp-a', name: 'Exp A' })
    // uncommitted change: the run must still see it via the snapshot
    writeFileSync(join(labRoot, 'solutions/exp-a/model.txt'), 'state=v1-uncommitted\n')
  })

  it('Scenario B: run executes the launch-moment snapshot, not later edits', async () => {
    const script = writeRunner()
    const run = await runs.start({
      solutionId: 'exp-a',
      command: ['bash', resolve(script)],
      title: 'scenario-b',
    })
    expect(run.id).toMatch(/^run-\d{6}$/)
    expect(run.status).toBe('running')
    expect(run.snapshotCommit).toBeTruthy()
    expect(run.pid).toBeGreaterThan(0)

    // the run worktree materialized the UNCOMMITTED v1 state
    const worktree = join(labRoot, '.dsh-lab/run-worktrees', run.id)
    expect(readFileSync(join(worktree, 'model.txt'), 'utf8')).toBe('state=v1-uncommitted\n')

    // snapshot did NOT touch the solution branch or its index
    const status = await deps.git.getStatus('solutions/exp-a')
    expect(status.clean).toBe(false)
    expect(await deps.git.branchHead('exp/exp-a')).toBe(run.sourceHeadCommit)

    // mutate the solution WHILE the run executes — must not leak into the run
    writeFileSync(join(labRoot, 'solutions/exp-a/model.txt'), 'state=v2-edited-during-run\n')

    await waitFor(
      async () =>
        (await runs.get(run.id)).status === 'succeeded' && !existsSync(worktree),
      15000,
    )

    // the run observed v1 — Scenario B contract
    const stdout = readFileSync(join(labRoot, run.runDir, 'logs', 'stdout.log'), 'utf8')
    expect(stdout).toContain('CODE_STATE=state=v1-uncommitted')
    expect(stdout).not.toContain('v2-edited-during-run')

    // snapshot ref retained forever even though the worktree is gone
    const ref = execFileSync(
      'git',
      ['--git-dir', join(labRoot, '.dsh-lab/repo.git'), 'rev-parse', `refs/dsh/runs/${run.id}`],
      { encoding: 'utf8' },
    ).trim()
    expect(ref).toBe(run.snapshotCommit)
  })

  it('ingests summary metrics into the store', async () => {
    const run = await runs.get('run-000001')
    expect(run.status).toBe('succeeded')
    expect(run.exitCode).toBe(0)
    const metrics = await deps.store.listRunMetrics(run.id)
    const byName = Object.fromEntries(metrics.map((m) => [m.name, m.value]))
    expect(byName.auc).toBeCloseTo(0.927)
    expect(byName.f1).toBeCloseTo(0.881)
  })

  it('manifest + environment snapshot exist in the run dir', () => {
    const runDir = join(labRoot, 'experiments/run-000001')
    const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    expect(manifest.snapshotCommit).toBeTruthy()
    expect(manifest.environmentFingerprint).toMatch(/^env:/)
    expect(existsSync(join(runDir, 'command.json'))).toBe(true)
    expect(existsSync(join(runDir, 'logs/stdout.log'))).toBe(true)
  })

  it('stop cancels a long run and cleans its worktree', async () => {
    await solutions.fork({ sourceSolutionId: 'main', slug: 'exp-b', name: 'Exp B' })
    const run = await runs.start({ solutionId: 'exp-b', command: ['bash', '-c', 'sleep 30'] })
    expect(run.status).toBe('running')
    const stopped = await runs.stop(run.id)
    expect(stopped.status).toBe('canceled')
    expect(existsSync(join(labRoot, '.dsh-lab/run-worktrees', run.id))).toBe(false)
  })

  it('cross-process finalize: a fresh reader finishes a run whose launcher is gone (CLI mode)', async () => {
    const script = writeRunner()
    const run = await runs.start({
      solutionId: 'exp-a',
      command: ['bash', resolve(script)],
      title: 'cross-process',
    })
    // wait for the process itself to end (wrapper records .exit_code)
    await waitFor(async () => {
      try {
        process.kill(run.pid!, 0)
        return false
      } catch {
        return true
      }
    }, 15000)

    // a completely fresh service over the same store, empty live map —
    // exactly what the next `dsh-lab run list` invocation sees
    const deps2 = makeDeps(labRoot, 'RunTest')
    const runs2 = new RunService(deps2)
    const synced = await runs2.get(run.id)
    expect(synced.status).toBe('succeeded')
    expect(synced.exitCode).toBe(0)
    // metrics ingested + worktree cleaned by the lazy finalize
    const metrics = await deps2.store.listRunMetrics(run.id)
    expect(metrics.some((m) => m.name === 'auc')).toBe(true)
    expect(existsSync(join(labRoot, '.dsh-lab/run-worktrees', run.id))).toBe(false)
    ;(deps2.store as unknown as { close(): void }).close()
  })

  it('reconcile after restart: live pid adopted, dead pid lost', async () => {
    // a real run whose pid is alive → a fresh service (empty live map) adopts it
    const run = await runs.start({ solutionId: 'exp-b', command: ['bash', '-c', 'sleep 30'] })
    const deps2 = makeDeps(labRoot, 'RunTest')
    const runs2 = new RunService(deps2)
    const first = await runs2.reconcile()
    expect(first.adopted).toContain(run.id)
    const stillRunning = await runs2.get(run.id)
    expect(stillRunning.status).toBe('running')
    await runs2.stop(run.id)

    // a store row whose pid is dead → lost + GPUs released
    await deps2.store.upsertRun({
      id: 'run-999999',
      projectId: stillRunning.projectId,
      solutionId: stillRunning.solutionId,
      snapshotCommit: 'deadbeef',
      sourceHeadCommit: 'deadbeef',
      status: 'running',
      command: ['sleep', '1'],
      resources: { mode: 'explicit' },
      runDir: 'experiments/run-999999',
      pid: 999999, // guaranteed-dead pid
      createdAt: Date.now(),
      tags: [],
    })
    const second = await runs2.reconcile()
    expect(second.lost).toContain('run-999999')
    expect((await runs2.get('run-999999')).status).toBe('lost')
    ;(deps2.store as unknown as { close(): void }).close()
  })
})

async function waitFor(pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('waitFor timed out')
}

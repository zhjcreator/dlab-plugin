/**
 * Run → background-job batching: ONE wake per session batch, not per run.
 *
 * A fake jobs registry (only start(), capturing every spec and its hooks —
 * the plugin calls nothing else) is mounted on a real Cordis context with
 * the real lab rows; real runs drive the full register → exit → drain path.
 *
 * The contract under test (DESIGN §18.1, v0.1.9):
 *   - per-run jobs (kind lab-run) are UNOWNED — settlement delivers nothing
 *   - one owned umbrella (kind lab-batch) settles only after the LAST live
 *     run of the agent settled, with a summary covering every run
 *   - umbrella cancel stops every tracked run; a new run after a drain
 *     creates a fresh umbrella
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { JobHooks } from '@deepseek-ai/dsh-jobs'
import { apply as rootApply, type Config } from '../../packages/lab-host/lib/index.js'
import { apply as toolsApply, inject as toolsInject } from '../../packages/lab-host/lib/tools.js'

const SANDBOX = join(tmpdir(), 'dlab-jobs')

interface CapturedJob {
  id: string
  kind: string
  label: string
  owner: unknown
  hooks: JobHooks
}

let labRoot: string
let ctx: Context
let registeredTools: { name: string; execute: (args: unknown, exec: unknown) => Promise<any> }[]
let jobs: CapturedJob[]
let jobSeq = 0
/** Flip to true to simulate "no job controller serves any agent" (owned starts refuse). */
let refuseOwned = false
/** The stable agent instance every tool execution carries. */
const agent: unknown = { session: { header: { cwd: '' } } }

const agentExec = () => ({ signal: new AbortController().signal, agent })

async function waitUntil(check: () => Promise<boolean>, ms = 15000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('waitUntil timed out')
}

/** 'pending' when the promise has not settled within `ms`. */
async function pending(p: Promise<unknown>, ms: number): Promise<'pending' | 'done'> {
  return Promise.race([p.then(() => 'done' as const), new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))])
}

beforeAll(async () => {
  mkdirSync(SANDBOX, { recursive: true })
  labRoot = mkdtempSync(join(SANDBOX, 'lab-'))
  ;(agent as { session: { header: { cwd: string } } }).session.header.cwd = labRoot

  ctx = new Context()
  registeredTools = []
  jobs = []
  ctx.provide('workspaceRegistry', {
    create: async (path: string, title?: string) => ({ id: `ws_${title ?? path}`, path, title: title ?? path, sessionIds: [] }),
    delete: async () => true,
    resolveByPath: async () => undefined,
    list: () => [],
  })
  ctx.provide('tools', {
    register: (t: (typeof registeredTools)[number]) => {
      registeredTools.push(t)
      return () => {}
    },
    get: () => undefined,
    schemas: () => registeredTools,
  })
  ctx.provide('jobs', {
    start(spec: { kind: string; label: string; owner?: unknown; run: () => JobHooks }) {
      if (refuseOwned && spec.owner !== undefined) throw new Error('no job controller serves this agent')
      const id = `${spec.kind}-${++jobSeq}`
      jobs.push({ id, kind: spec.kind, label: spec.label, owner: spec.owner, hooks: spec.run() })
      return id
    },
  })

  const config: Config = { solutionRoot: labRoot, projectName: 'JobsTest' }
  rootApply(ctx, config)
  await new Promise((r) => setTimeout(r, 50))
  await ctx.plugin({ name: 'tools-row', inject: toolsInject, apply: toolsApply })
  await ctx.lab.surface()!.init()
  await tool('lab_fork_solution').execute({ source: 'main', slug: 'exp', name: 'Exp' }, agentExec())
})

afterAll(() => {
  if (labRoot) rmSync(labRoot, { recursive: true, force: true })
})

function tool(name: string) {
  const t = registeredTools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not registered`)
  return t
}

const start = (title: string, command: string[]) =>
  tool('lab_start_run').execute({ solution: 'exp', command, title }, agentExec()) as Promise<{
    id: string
    dshJobId?: string
    batchJobId?: string
  }>

const statusOf = async (runId: string) => (await tool('lab_get_run').execute({ runId }, agentExec())) as { status: string }

describe('run → job batching (DESIGN §18.1: one wake per batch)', () => {
  it(
    'per-run jobs are unowned; the single owned umbrella settles only after the LAST run',
    async () => {
      // 'fast' must still be alive when the second start completes
      // (a start takes ~1-2s: snapshot + worktree + spawn)
      const fast = await start('fast', ['sleep', '4'])
      const slow = await start('slow', ['sleep', '30'])

      const runJobs = jobs.filter((j) => j.kind === 'lab-run')
      const batchJobs = jobs.filter((j) => j.kind === 'lab-batch')
      expect(runJobs).toHaveLength(2)
      expect(batchJobs).toHaveLength(1)
      for (const j of runJobs) expect(j.owner).toBeUndefined()
      const umbrella = batchJobs[0]!
      expect(umbrella.owner).toBe(agent)

      // the tool result carries both ids; both runs joined the SAME umbrella
      expect(fast.dshJobId).toBe(runJobs[0]!.id)
      expect(fast.batchJobId).toBe(umbrella.id)
      expect(slow.batchJobId).toBe(umbrella.id)

      // the fast run settles → the umbrella stays live: NO wake yet
      await waitUntil(async () => (await statusOf(fast.id)).status === 'succeeded')
      expect(await pending(umbrella.hooks.done, 300)).toBe('pending')

      // stopping the last live run drains the umbrella: ONE settle, full summary
      await tool('lab_stop_run').execute({ runId: slow.id }, agentExec())
      const outcome = await umbrella.hooks.done
      expect(outcome.status).toBe('completed')
      expect(outcome.detail).toContain('all 2 lab run(s) settled')
      expect(outcome.detail).toContain('1 succeeded')
      expect(outcome.detail).toContain('1 canceled')
      expect(outcome.detail).toContain(fast.id)
      expect(outcome.detail).toContain(slow.id)
    },
    25000,
  )

  it(
    'the umbrella readOutput interleaves every live run, prefixed by run id',
    async () => {
      // the run must still be LIVE when the first readOutput poll lands
      // (the reader interleaves live runs; settled ones drop out)
      const a = await start('echo-a', ['bash', '-c', 'echo hello-from-a; sleep 3'])
      const umbrella = jobs.filter((j) => j.kind === 'lab-batch').at(-1)!
      let streamed = ''
      await waitUntil(async () => {
        streamed = umbrella.hooks.readOutput?.() ?? ''
        return streamed.includes('hello-from-a')
      })
      expect(streamed).toContain(`[${a.id}] hello-from-a`)
      await waitUntil(async () => (await statusOf(a.id)).status === 'succeeded')
      await umbrella.hooks.done // drained once its only run settled
    },
    20000,
  )

  it(
    'a run started after the batch drained gets a FRESH umbrella',
    async () => {
      const before = jobs.filter((j) => j.kind === 'lab-batch').length
      const run = await start('fresh', ['sleep', '0.3'])
      await waitUntil(async () => (await statusOf(run.id)).status === 'succeeded')
      const umbrellas = jobs.filter((j) => j.kind === 'lab-batch')
      expect(umbrellas.length).toBe(before + 1)
      const fresh = umbrellas.at(-1)!
      const outcome = await fresh.hooks.done
      expect(outcome.detail).toContain('1 succeeded')
    },
    20000,
  )

  it(
    'canceling the umbrella stops every tracked run (the session-disposal path)',
    async () => {
      const a = await start('kill-a', ['sleep', '30'])
      const b = await start('kill-b', ['sleep', '30'])
      const umbrella = jobs.filter((j) => j.kind === 'lab-batch').at(-1)!
      umbrella.hooks.cancel()
      await waitUntil(async () => (await statusOf(a.id)).status === 'canceled')
      await waitUntil(async () => (await statusOf(b.id)).status === 'canceled')
      const outcome = await umbrella.hooks.done
      expect(outcome.status).toBe('killed')
      expect(outcome.detail).toContain('2 canceled')
    },
    20000,
  )

  it(
    'when no controller serves the owner, streaming survives and the wake is simply lost',
    async () => {
      refuseOwned = true
      const run = await start('no-controller', ['sleep', '0.3'])
      // the per-run job still registered (unowned); no umbrella could be created
      expect(run.dshJobId).toBeTruthy()
      expect(run.batchJobId).toBeUndefined()
      expect(jobs.filter((j) => j.kind === 'lab-batch').at(-1)?.owner).toBe(agent) // no NEW umbrella
      await waitUntil(async () => (await statusOf(run.id)).status === 'succeeded')
      refuseOwned = false
    },
    20000,
  )
})

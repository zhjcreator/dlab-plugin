/**
 * Regression: every lab_* tool must return LOSSLESS JSON.
 *
 * dsh-tools validates model-tool output with the isJsonValue rules from
 * dsh-util-values: an own property holding `undefined` — the TypeScript idiom
 * for an absent optional field, which SolutionView/RunView use pervasively
 * (parentSlug on main, hypothesis until set, title/gpuIds on an untitled
 * CPU run, exitCode/startedAt/finishedAt on a live run, …) — fails the WHOLE
 * output in the real runtime with
 *
 *   tool "lab_list_solutions" returned invalid output: value is not lossless JSON
 *
 * The plugin's own tests call execute() directly, which bypasses that
 * validation (it lives in the dsh-tools registry pipeline, not in the tool
 * body), so the contract is asserted here against the real validator
 * package. The wire boundary (json() in packages/lab-host/src/tools.ts)
 * strips undefined-valued properties with JSON.stringify semantics.
 */

import { Context } from '@deepseek-ai/cordis'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply as rootApply, type Config } from '../../packages/lab-host/lib/index.js'
import { apply as toolsApply, inject as toolsInject } from '../../packages/lab-host/lib/tools.js'

const SANDBOX_ROOT = join(tmpdir(), 'dlab-lossless')

let labRoot: string
let ctx: Context
let registeredTools: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }[]

const fakeExec = { signal: new AbortController().signal } as unknown

beforeAll(async () => {
  mkdirSync(SANDBOX_ROOT, { recursive: true })
  labRoot = mkdtempSync(join(SANDBOX_ROOT, 'lab-'))

  ctx = new Context()
  registeredTools = []
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

  const config: Config = { solutionRoot: labRoot, projectName: 'LosslessTest' }
  rootApply(ctx, config)
  await new Promise((r) => setTimeout(r, 50)) // let LabService register 'lab'
  await ctx.plugin({ name: 'tools-row', inject: toolsInject, apply: toolsApply })
  // initialize the configured-root lab: creates the repo + the main solution
  // (no parent, no hypothesis, no runs — the absent-optional-fields fixture)
  await ctx.lab.surface()!.init()
})

afterAll(() => {
  if (labRoot) rmSync(labRoot, { recursive: true, force: true })
})

function tool(name: string) {
  const t = registeredTools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not registered`)
  return t
}

/** Assert one tool's output satisfies the dsh-tools lossless-JSON contract. */
async function expectLossless(name: string, args: unknown): Promise<any> {
  const result = await tool(name).execute(args, fakeExec)
  expect(isJsonValue(result)).toBe(true)
  return result
}

describe('lab_* tool outputs are lossless JSON', () => {
  it('the validator rejects the pre-fix shape (own undefined property)', () => {
    // negative control: this is exactly what lab_list_solutions used to
    // return — an optional field explicitly assigned undefined
    expect(isJsonValue({ slug: 'main', parentSlug: undefined })).toBe(false)
    // and what the boundary must produce instead: the key simply absent
    expect(isJsonValue({ slug: 'main' })).toBe(true)
  })

  it('lab_status / lab_list_solutions / lab_get_solution stay lossless with absent optional fields', async () => {
    // main has NO parent, NO hypothesis, NO runs — every one of those
    // optional fields is undefined in the domain view
    await expectLossless('lab_status', {})
    const listed = (await expectLossless('lab_list_solutions', {})) as {
      solutions: Record<string, unknown>[]
    }
    const main = listed.solutions.find((s) => s.slug === 'main')
    expect(main).toBeDefined()

    const mainView = (await expectLossless('lab_get_solution', { solution: 'main' })) as Record<string, unknown>
    expect(mainView.slug).toBe('main')
    // strip semantics: absent optional fields are OMITTED, not nulled —
    // JSON.stringify would transmit nothing for them either
    expect(Object.hasOwn(mainView, 'parentSlug')).toBe(false)
    expect(Object.hasOwn(mainView, 'hypothesis')).toBe(false)
    expect(Object.hasOwn(mainView, 'lastRunAt')).toBe(false)
    expect(mainView.runCount).toBe(0)
  })

  it('lab_get_solution stays lossless for a fork (parentSlug present, conclusion absent)', async () => {
    const fork = (await expectLossless('lab_fork_solution', {
      source: 'main',
      slug: 'lossless-fork',
      name: 'Lossless Fork',
    })) as Record<string, unknown>
    expect(fork.parentSlug).toBe('main')
    expect(Object.hasOwn(fork, 'conclusion')).toBe(false)
  })

  it('run views stay lossless (untitled run, live run, finished run)', async () => {
    // finished run: untitled + no GPU request → title stays absent; gpuIds
    // is environment-dependent (the scheduler auto-assigns one free GPU even
    // to an unrequested run when the machine has one), so accept absent or
    // number[] — both are lossless
    const finished = (await expectLossless('lab_start_run', {
      solution: 'lossless-fork',
      command: ['true'],
    })) as Record<string, unknown>
    expect(Object.hasOwn(finished, 'title')).toBe(false)
    if (Object.hasOwn(finished, 'gpuIds')) expect(finished.gpuIds).toEqual(expect.any(Array))

    // live run: startedAt may be set but finishedAt/exitCode/durationMs are
    // undefined for as long as it runs — assert while it is in flight
    const live = (await expectLossless('lab_start_run', {
      solution: 'lossless-fork',
      command: ['sleep', '30'],
      title: 'live',
    })) as { id: string }
    await expectLossless('lab_list_runs', {})
    await expectLossless('lab_get_run', { runId: live.id })
    await expectLossless('lab_stop_run', { runId: live.id })

    // listing still includes the canceled run's view
    const runs = (await expectLossless('lab_list_runs', { solution: 'lossless-fork' })) as {
      runs: Record<string, unknown>[]
    }
    expect(runs.runs.length).toBeGreaterThanOrEqual(2)
  })

  it('diff / resources / docs outputs are lossless too', async () => {
    await expectLossless('lab_solution_diff', { a: 'main', b: 'lossless-fork' })
    const runs = (await tool('lab_list_runs').execute({ solution: 'lossless-fork' }, fakeExec)) as {
      runs: { id: string }[]
    }
    const ids = runs.runs.map((r) => r.id)
    if (ids.length >= 2) await expectLossless('lab_run_diff', { a: ids[0], b: ids[ids.length - 1] })
    await expectLossless('lab_get_resources', {})
    await expectLossless('lab_docs', { action: 'list' })
  })
})

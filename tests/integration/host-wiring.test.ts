/**
 * Host wiring integration test: mounts the REAL compiled lab-host rows on a
 * real Cordis root context with fake registries, then drives the full
 * service → tools → rpc → shell-env → system-prompt surface end to end.
 *
 * This verifies the Phase-2 DSH adapter without booting a dsh web process:
 * everything except the five injected DSH services is production code.
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply as rootApply, type Config } from '../../packages/lab-host/lib/index.js'
import { apply as toolsApply, inject as toolsInject } from '../../packages/lab-host/lib/tools.js'
import { apply as rpcApply, inject as rpcInject } from '../../packages/lab-host/lib/rpc-entry.js'
import { apply as shellEnvApply, inject as shellEnvInject } from '../../packages/lab-host/lib/shell-env.js'
import { apply as promptApply, inject as promptInject } from '../../packages/lab-host/lib/system-prompt.js'
import { RPC_CHANNEL } from '../../packages/lab-host/lib/rpc.js'

const SANDBOX_ROOT = '/home2/zhanghanjin/WorkSpace/dsh-scholar/scratch-dlab'

let labRoot: string
let ctx: Context
// fake registry captures
let workspaceCalls: string[]
let registeredTools: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }[]
let rpcChannel: string | undefined
let rpcHandler: ((endpoint: string, payload: unknown) => Promise<unknown>) | undefined
// biome-ignore lint: captured contributor/section shapes
let envContributor: { name: string; variables: Record<string, unknown>; resolve: (e: unknown) => Record<string, string> } | undefined
let promptSection: { name: string; order: number; text: () => string } | undefined

const fakeExec = { signal: new AbortController().signal } as unknown

beforeAll(async () => {
  labRoot = mkdtempSync(join(SANDBOX_ROOT, 'host-'))

  ctx = new Context()

  workspaceCalls = []
  registeredTools = []
  ctx.provide('workspaceRegistry', {
    create: async (path: string, title?: string) => {
      workspaceCalls.push(`create:${path}`)
      return { id: `ws_${title ?? path}`, path, title: title ?? path, sessionIds: [] }
    },
    delete: async (id: string) => {
      workspaceCalls.push(`delete:${id}`)
      return true
    },
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
  ctx.provide('connection', {
    rpc: {
      handle: (channel: string, handler: (endpoint: string, payload: unknown) => Promise<unknown>) => {
        rpcChannel = channel
        rpcHandler = handler
        return async () => {}
      },
    },
  })
  ctx.provide('shellEnv', {
    register: (c: NonNullable<typeof envContributor>) => {
      envContributor = c
      return () => {}
    },
    list: () => [],
  })
  ctx.provide('systemPrompt', {
    section: (s: NonNullable<typeof promptSection>) => {
      promptSection = s
      return () => {}
    },
  })

  // mount the real rows in dependency order
  const config: Config = { solutionRoot: labRoot, projectName: 'HostTest' }
  rootApply(ctx, config)
  await new Promise((r) => setTimeout(r, 50)) // let LabService register 'lab'
  await ctx.plugin({ name: 'tools-row', inject: toolsInject, apply: toolsApply })
  await ctx.plugin({ name: 'rpc-row', inject: rpcInject, apply: rpcApply })
  await ctx.plugin({ name: 'shell-env-row', inject: shellEnvInject, apply: shellEnvApply })
  await ctx.plugin({ name: 'prompt-row', inject: promptInject, apply: promptApply })
})

afterAll(() => {
  if (labRoot) rmSync(labRoot, { recursive: true, force: true })
})

function tool(name: string) {
  const t = registeredTools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not registered`)
  return t
}

describe('host wiring: LabService on real Cordis', () => {
  it('provides ctx.lab and initializes the lab', async () => {
    expect(ctx.lab).toBeDefined()
    const main = await ctx.lab.init()
    expect(main.slug).toBe('main')
    expect(main.status).toBe('active')
    expect(workspaceCalls).toContainEqual(`create:${join(labRoot, 'solutions/main')}`)
  })

  it('registers all 15 lab_* tools', () => {
    const names = registeredTools.map((t) => t.name).sort()
    expect(names).toEqual([
      'lab_archive_solution',
      'lab_checkpoint_solution',
      'lab_fork_solution',
      'lab_get_resources',
      'lab_get_run',
      'lab_get_solution',
      'lab_list_runs',
      'lab_list_solutions',
      'lab_merge_solution',
      'lab_restore_solution',
      'lab_solution_diff',
      'lab_start_run',
      'lab_status',
      'lab_stop_run',
      'lab_update_solution_metadata',
    ])
  })

  it('lab_status executes through the service', async () => {
    const result = (await tool('lab_status').execute({}, fakeExec)) as { initialized: boolean; project: string }
    expect(result.initialized).toBe(true)
    expect(result.project).toBe('HostTest')
  })

  it('lab_fork_solution creates a real solution', async () => {
    const view = (await tool('lab_fork_solution').execute(
      { source: 'main', slug: 'host-fork', name: 'Host Fork' },
      fakeExec,
    )) as { slug: string; status: string; branch: string }
    expect(view.slug).toBe('host-fork')
    expect(view.status).toBe('active')
    expect(view.branch).toBe('exp/host-fork')
    expect(readFileSync(join(labRoot, 'solutions/host-fork/README.md'), 'utf8')).toBeTruthy()
  })

  it('registers the /dlab RPC channel and dispatches', async () => {
    expect(rpcChannel).toBe(RPC_CHANNEL)
    expect(rpcHandler).toBeDefined()
    const res = (await rpcHandler!('solutions.list', {})) as {
      ok: boolean
      value: { solutions: { slug: string }[] }
    }
    expect(res.ok).toBe(true)
    expect(res.value.solutions.map((s) => s.slug)).toContain('host-fork')
  })

  it('RPC failures carry structured errors, not throws', async () => {
    const res = (await rpcHandler!('solutions.get', { solution: 'does-not-exist' })) as {
      ok: boolean
      error: { code: string; message: string }
    }
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('lab-error')
    expect(res.error.message).toContain('does-not-exist')
  })

  it('RPC unknown endpoint fails closed', async () => {
    const res = (await rpcHandler!('bogus.endpoint', {})) as { ok: boolean; error: { code: string } }
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('unknown-endpoint')
  })

  it('shellEnv contributor exposes DSH_LAB_ROOT / DSH_LAB_PROJECT', () => {
    expect(envContributor).toBeDefined()
    expect(envContributor!.name).toBe('dlab-lab')
    expect(Object.keys(envContributor!.variables).sort()).toEqual(['DSH_LAB_PROJECT', 'DSH_LAB_ROOT'])
    const resolved = envContributor!.resolve(fakeExec)
    expect(resolved.DSH_LAB_ROOT).toBe(labRoot)
    expect(resolved.DSH_LAB_PROJECT).toBe('HostTest')
  })

  it('systemPrompt section renders the live lab context', async () => {
    expect(promptSection).toBeDefined()
    expect(promptSection!.name).toBe('lab:context')
    // mutations refresh the cache asynchronously; let it settle
    await new Promise((r) => setTimeout(r, 100))
    const text = promptSection!.text()
    expect(text).toContain('DSH LAB CONTEXT')
    expect(text).toContain('host-fork')
  })

  it('full loop: checkpoint → merge fork→fork via RPC', async () => {
    // second fork, divergent change, then into-fork merge through RPC
    await rpcHandler!('solutions.fork', { source: 'main', slug: 'host-fork-2', name: 'Second' })
    writeFileSync(join(labRoot, 'solutions/host-fork/a.txt'), 'a\n')
    await rpcHandler!('solutions.checkpoint', { solution: 'host-fork', message: 'a' })
    writeFileSync(join(labRoot, 'solutions/host-fork-2/b.txt'), 'b\n')
    await rpcHandler!('solutions.checkpoint', { solution: 'host-fork-2', message: 'b' })
    const res = (await rpcHandler!('solutions.merge', {
      source: 'host-fork',
      target: 'host-fork-2',
      mode: 'into-fork',
    })) as { ok: boolean; value: { sourceStatusAfter: string; mergeCommit: string } }
    expect(res.ok).toBe(true)
    expect(res.value.sourceStatusAfter).toBe('active')
    expect(readFileSync(join(labRoot, 'solutions/host-fork-2/a.txt'), 'utf8')).toBe('a\n')
  })
})

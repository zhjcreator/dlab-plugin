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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply as rootApply, type Config } from '../../packages/lab-host/lib/index.js'
import { apply as toolsApply, inject as toolsInject } from '../../packages/lab-host/lib/tools.js'
import { apply as rpcApply, inject as rpcInject } from '../../packages/lab-host/lib/rpc-entry.js'
import { apply as shellEnvApply, inject as shellEnvInject } from '../../packages/lab-host/lib/shell-env.js'
import { apply as promptApply, inject as promptInject } from '../../packages/lab-host/lib/system-prompt.js'
import { LabCore } from '../../packages/lab-host/lib/lab-core.js'
import { DshWorkspacePort } from '../../packages/lab-host/lib/workspace-port.js'
import { RPC_CHANNEL } from '../../packages/lab-host/lib/rpc.js'

const SANDBOX_ROOT = '/home2/zhanghanjin/WorkSpace/dsh-scholar/scratch-dlab'

let labRoot: string
let ctx: Context
// fake registry captures
let workspaceCalls: string[]
let registeredTools: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }[]
let rpcRoute: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> } | undefined
// biome-ignore lint: captured contributor/section shapes
let envContributor: { name: string; variables: Record<string, unknown>; resolve: (e: unknown) => Record<string, string> } | undefined
let promptSection: { name: string; order: number; text: (context?: { agent?: unknown }) => string } | undefined

const fakeExec = { signal: new AbortController().signal } as unknown

/** One tool execution whose agent session was created in `cwd`. */
function agentExec(cwd?: string): unknown {
  return {
    signal: new AbortController().signal,
    agent: cwd === undefined ? undefined : { session: { header: { cwd } } },
  }
}

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
    requestRejection: () => undefined,
  })
  // The rpc row mounts its channel as a prefix route on the webServer table
  // (dsh >= 0.1.5-rc: connection.rpc.handle cannot resolve webServer through
  // the traceable shadow; see packages/lab-host/src/rpc-entry.ts).
  ctx.provide('webServer', {
    register: (route: NonNullable<typeof rpcRoute>) => {
      rpcRoute = route
      return () => {}
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

/**
 * Drive one RPC call through the registered prefix route the way the browser
 * half's connection.rpc.call does: POST <channel>/<endpoint> with a
 * client-request envelope; returns the unwrapped result.
 */
async function callRpc(endpoint: string, payload: unknown): Promise<any> {
  if (!rpcRoute) throw new Error('rpc route not registered')
  const req = new EventEmitter() as unknown as IncomingMessage
  ;(req as { method?: string }).method = 'POST'
  ;(req as { url?: string }).url = `${RPC_CHANNEL}/${endpoint}`
  ;(req as { headers: Record<string, string> }).headers = { 'content-type': 'application/json' }
  const res = {
    headersSent: false,
    status: 0,
    body: '',
    writeHead(code: number) {
      this.status = code
      this.headersSent = true
      return this
    },
    end(chunk?: string) {
      if (chunk !== undefined) this.body += chunk
      return this
    },
  }
  const handled = rpcRoute.handler(req, res as unknown as ServerResponse)
  queueMicrotask(() => {
    req.emit(
      'data',
      Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'test-1', method: endpoint, payload })),
    )
    req.emit('end')
  })
  await handled
  const envelope = JSON.parse(res.body) as { type: string; rpcId: string; result: unknown }
  expect(envelope.type).toBe('server-response')
  expect(envelope.rpcId).toBe('test-1')
  return envelope.result
}

describe('host wiring: LabService on real Cordis', () => {
  it('provides ctx.lab and initializes the lab', async () => {
    expect(ctx.lab).toBeDefined()
    // no configured-root convenience getters anymore: the surface is the API
    const surface = ctx.lab.surface()
    expect(surface).toBeDefined()
    const main = await surface!.init()
    expect(main.slug).toBe('main')
    expect(main.status).toBe('active')
    expect(workspaceCalls).toContainEqual(`create:${join(labRoot, 'solutions/main')}`)
  })

  it('registers all 20 lab_* tools', () => {
    const names = registeredTools.map((t) => t.name).sort()
    expect(names).toEqual([
      'lab_archive_solution',
      'lab_checkpoint_solution',
      'lab_docs',
      'lab_fork_solution',
      'lab_get_resources',
      'lab_get_run',
      'lab_get_solution',
      'lab_list_runs',
      'lab_list_solutions',
      'lab_merge_solution',
      'lab_migrate_docs',
      'lab_promote_docs',
      'lab_restore_solution',
      'lab_run_diff',
      'lab_solution_diff',
      'lab_start_run',
      'lab_status',
      'lab_stop_run',
      'lab_update_solution_metadata',
      'lab_write_doc',
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

  it('registers the /dsh-lab RPC channel and dispatches', async () => {
    expect(rpcInject).toContain('webServer') // the route mounts on ctx.webServer
    expect(rpcInject).toContain('connection') // the auth fence comes from ctx.connection
    expect(rpcRoute?.kind).toBe('prefix')
    expect(rpcRoute?.path).toBe(RPC_CHANNEL)
    const res = (await callRpc('solutions.list', {})) as {
      ok: boolean
      value: { solutions: { slug: string }[] }
    }
    expect(res.ok).toBe(true)
    expect(res.value.solutions.map((s) => s.slug)).toContain('host-fork')
  })

  it('RPC envelope rejects method/path mismatch', async () => {
    // method must equal the endpoint segment; anything else is a protocol error
    if (!rpcRoute) throw new Error('rpc route not registered')
    const req = new EventEmitter() as unknown as IncomingMessage
    ;(req as { method?: string }).method = 'POST'
    ;(req as { url?: string }).url = `${RPC_CHANNEL}/solutions.list`
    ;(req as { headers: Record<string, string> }).headers = { 'content-type': 'application/json' }
    const res = {
      headersSent: false,
      status: 0,
      body: '',
      writeHead(code: number) {
        this.status = code
        this.headersSent = true
        return this
      },
      end(chunk?: string) {
        if (chunk !== undefined) this.body += chunk
        return this
      },
    }
    const handled = rpcRoute.handler(req, res as unknown as ServerResponse)
    queueMicrotask(() => {
      req.emit(
        'data',
        Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'm-1', method: 'other.endpoint', payload: {} })),
      )
      req.emit('end')
    })
    await handled
    const envelope = JSON.parse(res.body) as { result: { ok: boolean; error: { code: string } } }
    expect(envelope.result.ok).toBe(false)
    expect(envelope.result.error.code).toBe('gateway/bad-request')
  })

  it('RPC failures carry structured errors, not throws', async () => {
    const res = (await callRpc('solutions.get', { solution: 'does-not-exist' })) as {
      ok: boolean
      error: { code: string; message: string }
    }
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('lab-error')
    expect(res.error.message).toContain('does-not-exist')
  })

  it('RPC unknown endpoint fails closed', async () => {
    const res = (await callRpc('bogus.endpoint', {})) as { ok: boolean; error: { code: string } }
    expect(res.ok).toBe(false)
    expect(res.error.code).toBe('unknown-endpoint')
  })

  it('shellEnv contributor exposes DSH_LAB_ROOT / DSH_LAB_PROJECT / docs paths', () => {
    expect(envContributor).toBeDefined()
    expect(envContributor!.name).toBe('dsh-lab')
    expect(Object.keys(envContributor!.variables).sort()).toEqual([
      'DSH_LAB_DOCS',
      'DSH_LAB_DOCS_LINK',
      'DSH_LAB_PROJECT',
      'DSH_LAB_ROOT',
    ])
    const resolved = envContributor!.resolve(fakeExec)
    expect(resolved.DSH_LAB_ROOT).toBe(labRoot)
    expect(resolved.DSH_LAB_PROJECT).toBe('HostTest')
    // the shared docs directory is the project-root docs/ dir, reached from a
    // solution through the identical link path
    expect(resolved.DSH_LAB_DOCS).toBe(join(labRoot, 'docs'))
    expect(resolved.DSH_LAB_DOCS_LINK).toBe('docs')
  })

  it('systemPrompt section renders the live lab context', async () => {
    expect(promptSection).toBeDefined()
    expect(promptSection!.name).toBe('lab:context')
    // mutations refresh the cache asynchronously; let it settle
    await new Promise((r) => setTimeout(r, 100))
    const text = promptSection!.text()
    expect(text).toContain('DSH LAB CONTEXT')
    expect(text).toContain('host-fork')
    // the workflow cheat sheet teaches the launch loop up front (and the
    // tool name must be the real one — an early version shipped `lab_run_start`)
    expect(text).toContain('Workflow (how to run an experiment)')
    expect(text).toContain('lab_start_run(solution, command, gpuCount)')
    expect(text).not.toContain('lab_run_start')
  })

  it('full loop: checkpoint → merge fork→fork via RPC', async () => {
    // second fork, divergent change, then into-fork merge through RPC
    await callRpc('solutions.fork', { source: 'main', slug: 'host-fork-2', name: 'Second' })
    writeFileSync(join(labRoot, 'solutions/host-fork/a.txt'), 'a\n')
    await callRpc('solutions.checkpoint', { solution: 'host-fork', message: 'a' })
    writeFileSync(join(labRoot, 'solutions/host-fork-2/b.txt'), 'b\n')
    await callRpc('solutions.checkpoint', { solution: 'host-fork-2', message: 'b' })
    const res = (await callRpc('solutions.merge', {
      source: 'host-fork',
      target: 'host-fork-2',
      mode: 'into-fork',
    })) as { ok: boolean; value: { sourceStatusAfter: string; mergeCommit: string } }
    expect(res.ok).toBe(true)
    expect(res.value.sourceStatusAfter).toBe('active')
    expect(readFileSync(join(labRoot, 'solutions/host-fork-2/a.txt'), 'utf8')).toBe('a\n')
  })

  it('parameter sweep via RPC: tags land on runs and runs.diff shows the config delta', async () => {
    // fork, then two runs from the same code state differing only in an
    // uncommitted config — the sweep convention from the lab:context rules
    await callRpc('solutions.fork', { source: 'main', slug: 'host-sweep', name: 'Sweep' })
    writeFileSync(join(labRoot, 'solutions/host-sweep/config.yaml'), 'lr: 0.01\n')
    const r1 = (await callRpc('runs.start', {
      solution: 'host-sweep',
      command: ['true'],
      tags: ['sweep/lr', 'lr=0.01'],
    })) as { ok: boolean; value: { id: string } }
    expect(r1.ok).toBe(true)

    writeFileSync(join(labRoot, 'solutions/host-sweep/config.yaml'), 'lr: 0.02\n')
    const r2 = (await callRpc('runs.start', {
      solution: 'host-sweep',
      command: ['true'],
      tags: ['sweep/lr', 'lr=0.02'],
    })) as { ok: boolean; value: { id: string } }
    expect(r2.ok).toBe(true)

    // RunViews carry tags + sourceHeadCommit (the group key)
    const got = (await callRpc('runs.get', { runId: r1.value!.id })) as {
      ok: boolean
      value: { tags: string[]; sourceHeadCommit?: string }
    }
    expect(got.ok).toBe(true)
    // tag order is normalized by the store; assert as a set
    expect([...got.value.tags].sort()).toEqual(['lr=0.01', 'sweep/lr'])
    expect(got.value.sourceHeadCommit).toBeTruthy()

    // the two snapshots differ exactly in the config file
    const diff = (await callRpc('runs.diff', { a: r1.value!.id, b: r2.value!.id })) as {
      ok: boolean
      value: { changedFiles: { path: string; status: string }[]; patch?: string }
    }
    expect(diff.ok).toBe(true)
    expect(diff.value.changedFiles).toEqual([{ path: 'config.yaml', status: 'M' }])
    expect(diff.value.patch).toContain('lr: 0.01')
    expect(diff.value.patch).toContain('lr: 0.02')

    // runs.list views also expose sourceHeadCommit for client-side grouping
    const list = (await callRpc('runs.list', {})) as {
      ok: boolean
      value: { runs: { id: string; sourceHeadCommit?: string }[] }
    }
    expect(list.ok).toBe(true)
    const sweepRuns = list.value.runs.filter((r) => r.id === r1.value!.id || r.id === r2.value!.id)
    expect(sweepRuns).toHaveLength(2)
    expect(sweepRuns[0]!.sourceHeadCommit).toBe(sweepRuns[1]!.sourceHeadCommit)
  })

  it('dynamic lab resolution: panel RPC follows the session cwd', async () => {
    // a cwd INSIDE the configured root resolves to the configured project
    const inRoot = (await callRpc('project.get', { cwd: join(labRoot, 'solutions') })) as {
      ok: boolean
      value: { root: string; source: string }
    }
    expect(inRoot.ok).toBe(true)
    expect(inRoot.value.root).toBe(labRoot)
    expect(inRoot.value.source).toBe('cwd')

    // a SECOND initialized lab elsewhere is detected dynamically and gets
    // its own read surface (its own store, its own graph)
    const lab2 = mkdtempSync(join(SANDBOX_ROOT, 'lab2-'))
    const core2 = new LabCore({
      solutionRoot: lab2,
      projectName: 'SecondLab',
      workspace: new DshWorkspacePort(ctx),
    })
    await core2.solutions.init(lab2, 'SecondLab')

    const second = (await callRpc('project.get', { cwd: lab2 })) as {
      ok: boolean
      value: { root: string; name: string; source: string }
    }
    expect(second.ok).toBe(true)
    expect(second.value.root).toBe(lab2)
    expect(second.value.name).toBe('SecondLab')
    expect(second.value.source).toBe('cwd')

    const g2 = (await callRpc('graph.get', { cwd: lab2 })) as {
      ok: boolean
      value: { nodes: { id: string }[] }
    }
    expect(g2.ok).toBe(true)
    expect(g2.value.nodes.map((n) => n.id)).toContain('main')

    // a directory under NO lab project resolves to `none`; data endpoints
    // fail closed instead of silently serving the configured lab
    const outside = mkdtempSync(join(tmpdir(), 'dlab-nolab-'))
    const none = (await callRpc('project.get', { cwd: outside })) as {
      ok: boolean
      value: { root: null; source: string }
    }
    expect(none.ok).toBe(true)
    expect(none.value.root).toBeNull()
    expect(none.value.source).toBe('none')
    const failed = (await callRpc('graph.get', { cwd: outside })) as {
      ok: boolean
      error: { code: string }
    }
    expect(failed.ok).toBe(false)
    expect(failed.error.code).toBe('no-lab-project')
    rmSync(lab2, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('agent tools resolve the lab from the session cwd', async () => {
    // a second initialized lab; a tool execution whose agent session cwd sits
    // inside it operates on THAT lab, not the configured one
    const lab2 = mkdtempSync(join(SANDBOX_ROOT, 'agentlab-'))
    const core2 = new LabCore({
      solutionRoot: lab2,
      projectName: 'AgentLab',
      workspace: new DshWorkspacePort(ctx),
    })
    await core2.solutions.init(lab2, 'AgentLab')

    const status = (await tool('lab_status').execute({}, agentExec(join(lab2, 'solutions')))) as {
      initialized: boolean
      root: string
      project: string
    }
    expect(status.initialized).toBe(true)
    expect(status.root).toBe(lab2)
    expect(status.project).toBe('AgentLab')

    // inside the configured root → the configured lab (unchanged behavior)
    const inConfigured = (await tool('lab_status').execute({}, agentExec(join(labRoot, 'solutions')))) as {
      root: string
      project: string
    }
    expect(inConfigured.root).toBe(labRoot)
    expect(inConfigured.project).toBe('HostTest')

    // no agent on the execution → cwd unknown → the configured root
    const noAgent = (await tool('lab_status').execute({}, fakeExec)) as { root: string }
    expect(noAgent.root).toBe(labRoot)

    // outside every lab: lab_status fails soft, the rest fail loud
    const outside = mkdtempSync(join(tmpdir(), 'dlab-agent-nolab-'))
    const soft = (await tool('lab_status').execute({}, agentExec(outside))) as {
      initialized: boolean
      root: string | null
      hint: string
    }
    expect(soft.initialized).toBe(false)
    expect(soft.root).toBeNull()
    expect(soft.hint).toContain('No lab project')
    await expect(tool('lab_list_solutions').execute({}, agentExec(outside))).rejects.toThrow(/No lab project/)

    rmSync(lab2, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('shellEnv contributor resolves per execution cwd', () => {
    // agent cwd inside the configured lab → that lab's variables
    const inside = envContributor!.resolve(agentExec(join(labRoot, 'solutions')))
    expect(inside.DSH_LAB_ROOT).toBe(labRoot)
    expect(inside.DSH_LAB_PROJECT).toBe('HostTest')

    // agent cwd outside every lab → no DSH_LAB_* variables at all
    const outside = mkdtempSync(join(tmpdir(), 'dlab-env-nolab-'))
    const none = envContributor!.resolve(agentExec(outside))
    expect(none).not.toHaveProperty('DSH_LAB_ROOT')
    expect(none).not.toHaveProperty('DSH_LAB_PROJECT')
    rmSync(outside, { recursive: true, force: true })
  })

  it('prompt section text follows the session cwd', async () => {
    // a second lab with a solution, so its context text is distinguishable
    const lab2 = mkdtempSync(join(SANDBOX_ROOT, 'promptlab-'))
    const core2 = new LabCore({
      solutionRoot: lab2,
      projectName: 'PromptLab',
      workspace: new DshWorkspacePort(ctx),
    })
    await core2.solutions.init(lab2, 'PromptLab')

    const agentCtx = (cwd: string) => ({ agent: { session: { header: { cwd } } } })
    const textFor = (cwd: string) => promptSection!.text(agentCtx(cwd))

    // first read primes the cache with a placeholder; refresh is async
    textFor(join(lab2, 'solutions'))
    await new Promise((r) => setTimeout(r, 100))
    expect(textFor(join(lab2, 'solutions'))).toContain('PromptLab')
    expect(textFor(join(lab2, 'solutions'))).toContain(lab2)
    expect(textFor(join(lab2, 'solutions'))).not.toContain('HostTest')

    // inside the configured root → the configured lab's context
    expect(promptSection!.text(agentCtx(join(labRoot, 'solutions')))).toContain('HostTest')

    // outside every lab → the no-lab hint, never another project's lab
    const outside = mkdtempSync(join(tmpdir(), 'dlab-prompt-nolab-'))
    expect(textFor(outside)).toContain('No lab project in this workspace')

    // no assemble context (diagnostics) → the configured root
    expect(promptSection!.text()).toContain('HostTest')

    rmSync(lab2, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
})

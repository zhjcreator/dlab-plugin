/**
 * Per-session cwd lab resolution WITHOUT a configured root: the deployment
 * pins nothing (the shipped cordis.patch.yml sets no solutionRoot), so every
 * consumer — agent tools, prompt section, shell env — resolves the lab
 * project that owns the session's working directory, and sessions outside
 * any lab get a clear "no lab" answer instead of some other project's lab.
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply as rootApply } from '../../packages/lab-host/lib/index.js'
import { apply as toolsApply, inject as toolsInject } from '../../packages/lab-host/lib/tools.js'
import { apply as shellEnvApply, inject as shellEnvInject } from '../../packages/lab-host/lib/shell-env.js'
import { apply as promptApply, inject as promptInject } from '../../packages/lab-host/lib/system-prompt.js'
import { LabCore } from '../../packages/lab-host/lib/lab-core.js'
import { DshWorkspacePort } from '../../packages/lab-host/lib/workspace-port.js'

const SANDBOX_ROOT = '/home2/zhanghanjin/WorkSpace/dsh-scholar/scratch-dlab'

let labA: string
let ctx: Context
let registeredTools: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }[]
// biome-ignore lint: captured contributor/section shapes
let envContributor: { name: string; variables: Record<string, unknown>; resolve: (e: unknown) => Record<string, string> } | undefined
let promptSection: { name: string; order: number; text: (context?: { agent?: unknown }) => string } | undefined

/** One tool execution whose agent session was created in `cwd`. */
function agentExec(cwd?: string): unknown {
  return {
    signal: new AbortController().signal,
    agent: cwd === undefined ? undefined : { session: { header: { cwd } } },
  }
}

beforeAll(async () => {
  labA = mkdtempSync(join(SANDBOX_ROOT, 'cwdlab-'))

  ctx = new Context()
  registeredTools = []
  ctx.provide('workspaceRegistry', {
    create: async (path: string, title?: string) => ({ id: `ws_${title ?? path}`, path, title: title ?? path }),
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

  // NO solutionRoot configured — resolution is purely cwd-based
  rootApply(ctx, {})
  await new Promise((r) => setTimeout(r, 50)) // let LabService register 'lab'
  await ctx.plugin({ name: 'tools-row', inject: toolsInject, apply: toolsApply })
  await ctx.plugin({ name: 'shell-env-row', inject: shellEnvInject, apply: shellEnvApply })
  await ctx.plugin({ name: 'prompt-row', inject: promptInject, apply: promptApply })

  // an initialized lab project the service does NOT know about up front
  const core = new LabCore({
    solutionRoot: labA,
    projectName: 'CwdLabA',
    workspace: new DshWorkspacePort(ctx),
  })
  await core.solutions.init(labA, 'CwdLabA')
})

afterAll(() => {
  if (labA) rmSync(labA, { recursive: true, force: true })
})

function tool(name: string) {
  const t = registeredTools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not registered`)
  return t
}

describe('cwd resolution without a configured root', () => {
  it('exposes no configured root', () => {
    expect(ctx.lab.root).toBeUndefined()
    expect(ctx.lab.projectName).toBeUndefined()
    expect(ctx.lab.surface()).toBeUndefined()
    expect(ctx.lab.rootFor(undefined)).toBeUndefined()
  })

  it('detects the lab owning the session cwd', async () => {
    expect(ctx.lab.rootFor(labA)).toBe(labA)
    expect(ctx.lab.rootFor(join(labA, 'solutions', 'main'))).toBe(labA)
    const surface = ctx.lab.surface(join(labA, 'solutions'))
    expect(surface?.root).toBe(labA)
  })

  it('lab_status follows the agent session cwd', async () => {
    const status = (await tool('lab_status').execute({}, agentExec(join(labA, 'solutions')))) as {
      initialized: boolean
      root: string
      project: string
    }
    expect(status.initialized).toBe(true)
    expect(status.root).toBe(labA)
    expect(status.project).toBe('CwdLabA')
  })

  it('sessions outside any lab fail soft via lab_status and loud via the rest', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'dlab-cwd-nolab-'))
    try {
      const soft = (await tool('lab_status').execute({}, agentExec(outside))) as {
        initialized: boolean
        root: string | null
        hint: string
      }
      expect(soft.initialized).toBe(false)
      expect(soft.root).toBeNull()
      expect(soft.hint).toContain('No lab project')

      await expect(tool('lab_list_solutions').execute({}, agentExec(outside))).rejects.toThrow(/No lab project/)
      // an execution with no agent and no configured root has nothing to
      // fall back to either
      await expect(tool('lab_list_solutions').execute({}, agentExec(undefined))).rejects.toThrow(
        /No lab project/,
      )
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('shellEnv variables follow the agent session cwd', () => {
    const inside = envContributor!.resolve(agentExec(join(labA, 'solutions')))
    expect(inside.DSH_LAB_ROOT).toBe(labA)

    const outside = mkdtempSync(join(tmpdir(), 'dlab-cwd-env-'))
    try {
      const none = envContributor!.resolve(agentExec(outside))
      expect(none).not.toHaveProperty('DSH_LAB_ROOT')
      expect(none).not.toHaveProperty('DSH_LAB_PROJECT')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('prompt section follows the agent session cwd', async () => {
    const agentCtx = (cwd: string) => ({ agent: { session: { header: { cwd } } } })

    // first read primes the per-root cache; the refresh itself is async
    promptSection!.text(agentCtx(join(labA, 'solutions')))
    await new Promise((r) => setTimeout(r, 100))
    const inside = promptSection!.text(agentCtx(join(labA, 'solutions')))
    expect(inside).toContain('DSH LAB CONTEXT')
    expect(inside).toContain('CwdLabA')
    expect(inside).toContain(labA)

    // outside every lab → the no-lab hint; with no assemble context and no
    // configured root → the same hint (never another project's lab)
    const outside = mkdtempSync(join(tmpdir(), 'dlab-cwd-prompt-'))
    try {
      expect(promptSection!.text(agentCtx(outside))).toContain('No lab project in this workspace')
      expect(promptSection!.text()).toContain('No lab project in this workspace')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

/**
 * @dlab/lab-host root entry: provides the `lab` service on ctx.
 *
 * Mount once per process (host composition). The consumer rows —
 * './tools', './rpc', './shell-env', './system-prompt' — mount separately so
 * HMR can replace each independently; they all inject `lab`.
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { LabCore } from './lab-core.js'
import { DshWorkspacePort } from './workspace-port.js'
import type {
  DiffView,
  EnvironmentView,
  ExperimentRun,
  MergeSolutionInput,
  ResourceView,
  RunView,
  Solution,
  SolutionView,
} from '@dlab/shared'

export interface Config {
  solutionRoot: string
  projectName: string
}

export const Config: Schema<Config> = Schema.object({
  solutionRoot: Schema.string().required(),
  projectName: Schema.string().default('Lab'),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    lab: LabService
  }
}

export class LabService extends Service {
  static inject = ['workspaceRegistry']

  readonly core: LabCore
  /** Cached prompt-section text; refreshed after every mutation (sync API). */
  private contextCache = 'DSH LAB CONTEXT (loading…)'
  private contextRefresh: Promise<void> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'lab')
    this.core = new LabCore({
      solutionRoot: config.solutionRoot,
      projectName: config.projectName,
      workspace: new DshWorkspacePort(ctx),
    })
    void this.refreshContext().catch(() => {
      /* uninitialized lab — the placeholder text stands */
    })
  }

  /** Current prompt-section text (synchronous by design). */
  get contextText(): string {
    return this.contextCache
  }

  /** Rebuild the prompt cache from live state; safe to call repeatedly. */
  async refreshContext(): Promise<void> {
    if (this.contextRefresh) return this.contextRefresh
    this.contextRefresh = (async () => {
      const lines: string[] = ['DSH LAB CONTEXT', '']
      lines.push(`Project: ${this.projectName}`)
      lines.push(`Root: ${this.root}`)
      const solutions = await this.core.solutions.list().catch(() => [])
      if (solutions.length > 0) {
        lines.push('', 'Solutions:')
        for (const s of solutions) {
          const view = await this.core.solutionView(s)
          const parts = [s.role === 'main' ? '★' : '●', s.slug, `(${s.status})`]
          if (view.dirty) parts.push('[dirty]')
          if (view.runCount > 0) parts.push(`${view.runCount} runs`)
          if (view.parentSlug && view.parentSlug !== s.slug) parts.push(`← ${view.parentSlug}`)
          lines.push(`  ${parts.join(' ')}`)
        }
        lines.push(
          '',
          'Rules:',
          '- Do not modify another Solution workspace directly; use lab tools for fork/archive/merge.',
          '- Experiment outputs should use DSH_LAB_RUN_DIR (Phase 3).',
        )
      } else {
        lines.push('', 'No solutions yet — the lab is not initialized. Use lab tools or `dsh-lab init`.')
      }
      this.contextCache = lines.join('\n')
    })()
    try {
      await this.contextRefresh
    } finally {
      this.contextRefresh = undefined
    }
  }

  get root(): string {
    return this.core.root
  }

  get projectName(): string {
    return this.core.projectName
  }

  // ── solutions ────────────────────────────────────────────────────────────

  solutions = {
    list: async (): Promise<SolutionView[]> => {
      const all = await this.core.solutions.list()
      const views: SolutionView[] = []
      for (const s of all) views.push(await this.core.solutionView(s))
      return views
    },
    get: async (idOrSlug: string): Promise<SolutionView> => {
      const s = await this.core.solutions.get(idOrSlug)
      return this.core.solutionView(s)
    },
    fork: async (input: {
      sourceSolutionId: string
      slug: string
      name?: string
      description?: string
      hypothesis?: string
      checkpointSource?: boolean
    }): Promise<SolutionView> => {
      const created = await this.core.solutions.fork({
        sourceSolutionId: input.sourceSolutionId,
        slug: input.slug,
        name: input.name ?? input.slug,
        description: input.description,
        hypothesis: input.hypothesis,
        checkpointSource: input.checkpointSource,
      })
      const view = await this.core.solutionView(created)
      void this.refreshContext().catch(() => {})
      return view
    },
    checkpoint: async (idOrSlug: string, message?: string): Promise<{ commit: string }> => {
      const result = await this.core.solutions.checkpoint(idOrSlug, message)
      void this.refreshContext().catch(() => {})
      return result
    },
    archive: async (idOrSlug: string, conclusion?: string): Promise<SolutionView> => {
      const archived = await this.core.solutions.archive(idOrSlug, conclusion)
      const view = await this.core.solutionView(archived)
      void this.refreshContext().catch(() => {})
      return view
    },
    restore: async (idOrSlug: string): Promise<SolutionView> => {
      const restored = await this.core.solutions.restore(idOrSlug)
      const view = await this.core.solutionView(restored)
      void this.refreshContext().catch(() => {})
      return view
    },
    diff: async (a: string, b: string): Promise<DiffView> => this.core.solutions.diff(a, b),
    merge: async (input: MergeSolutionInput): Promise<import('@dlab/shared').MergeResult> => {
      const result = await this.core.solutions.merge(input)
      void this.refreshContext().catch(() => {})
      return result
    },
    updateMetadata: async (
      idOrSlug: string,
      patch: { name?: string; description?: string; hypothesis?: string; conclusion?: string },
    ): Promise<SolutionView> => {
      const s: Solution = await this.core.solutions.get(idOrSlug)
      const updated: Solution = {
        ...s,
        ...patch,
        updatedAt: Date.now(),
      }
      await this.core.deps.store.upsertSolution(updated)
      const view = await this.core.solutionView(updated)
      void this.refreshContext().catch(() => {})
      return view
    },
  }

  // ── runs ──────────────────────────────────────────────────────────────────

  runs = {
    list: async (filter?: { solutionId?: string }): Promise<RunView[]> => {
      const all = await this.core.runs.list(filter)
      const views: RunView[] = []
      for (const r of all) views.push(await this.core.runView(r))
      return views
    },
    get: async (runIdValue: string): Promise<RunView> => {
      const run: ExperimentRun = await this.core.runs.get(runIdValue)
      return this.core.runView(run)
    },
    start: async (input: {
      solutionId: string
      command: string[]
      title?: string
      tags?: string[]
      resources?: import('@dlab/shared').RunResourceRequest
    }): Promise<RunView> => {
      const run = await this.core.runs.start(input)
      return this.core.runView(run)
    },
    stop: async (runIdValue: string): Promise<RunView> => {
      const run = await this.core.runs.stop(runIdValue)
      return this.core.runView(run)
    },
  }

  // ── resources / environment ──────────────────────────────────────────────

  resources = {
    snapshot: async (): Promise<ResourceView> => this.core.resourceView(),
  }

  environment = {
    get: async (): Promise<EnvironmentView> => this.core.environmentView(),
  }

  // ── lifecycle hooks ──────────────────────────────────────────────────────

  async init(): Promise<SolutionView> {
    const main = await this.core.solutions.init(this.core.root, this.core.projectName)
    const view = await this.core.solutionView(main)
    void this.refreshContext().catch(() => {})
    return view
  }
}

export const name = 'dlab-lab-host'

export function apply(ctx: Context, config: Config): void {
  ctx.plugin(LabService, config)
}

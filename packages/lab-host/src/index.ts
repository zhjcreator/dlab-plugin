/**
 * @dsh-lab/host root entry: provides the `lab` service on ctx.
 *
 * Mount once per process (host composition). The consumer rows —
 * './tools', './rpc', './shell-env', './system-prompt' — mount separately so
 * HMR can replace each independently; they all inject `lab`.
 *
 * Lab resolution is PER SESSION cwd, uniformly for every consumer (agent
 * tools, prompt section, shell env, browser panel):
 *
 *   1. The optional configured `solutionRoot` wins when the cwd sits inside
 *      it (or when no cwd is known) — a deployment may pin one primary lab.
 *   2. Otherwise the nearest ancestor of the cwd holding an initialized
 *      `.dsh-lab/lab.sqlite` is detected and gets its own LabCore/surface.
 *   3. Otherwise the session has NO lab: lab_* tools fail with a clear
 *      error, the prompt section degrades to a short hint, and DSH_LAB_*
 *      shell variables are omitted.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { LabCore } from './lab-core.js'
import { DshWorkspacePort } from './workspace-port.js'
import { DocsService } from '@dsh-lab/core'
import { tailFile } from '@dsh-lab/runner'
import type {
  DiffView,
  EnvironmentView,
  ExperimentRun,
  MergeSolutionInput,
  ResourceView,
  RunView,
  Solution,
  SolutionView,
} from '@dsh-lab/shared'

export interface Config {
  /**
   * Optional pinned lab root (the directory holding solutions/,
   * experiments/, .dsh-lab/). Sessions whose cwd sits inside it always
   * resolve to this lab; sessions elsewhere detect their own lab by walking
   * up for .dsh-lab/lab.sqlite. When omitted, resolution is purely
   * cwd-based and no lab is hardcoded for the deployment.
   */
  solutionRoot?: string
  /** Display name for the pinned lab root (cwd-detected labs read the name persisted in their own store). */
  projectName?: string
}

export const Config: Schema<Config> = Schema.object({
  solutionRoot: Schema.string().description(
    'Optional pinned lab root. Wins only for sessions whose cwd is inside it (and for cwd-less callers); everything else resolves per session cwd.',
  ),
  projectName: Schema.string().default('Lab').description(
    'Display name for the pinned lab root; cwd-detected labs use the name persisted in their own store.',
  ),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    lab: LabService
  }
}

/** The marker file that identifies an initialized lab project. */
const LAB_MARKER = '.dsh-lab/lab.sqlite'
/** Cap the cwd walk-up so a stray session cannot stat the whole disk. */
const MAX_WALK_UP = 15

/** Prompt-section text for a session whose workspace belongs to no lab. */
const NO_LAB_HINT = [
  'DSH LAB CONTEXT',
  '',
  'No lab project in this workspace: no .dsh-lab/lab.sqlite at or above the session working directory.',
  "The lab_* tools operate on the session's own lab project — open a session inside a lab project, or run `dsh-lab init` in the project root to create one.",
].join('\n')

/** True when `dir` equals or lives under `root`. */
function underRoot(root: string, dir: string): boolean {
  const r = resolve(root)
  const d = resolve(dir)
  return d === r || d.startsWith(r + '/')
}

/**
 * Walk up from `start` looking for an initialized lab project. Returns the
 * project root, or undefined when none is found.
 */
export function findLabRoot(start: string): string | undefined {
  let dir = resolve(start)
  for (let i = 0; i < MAX_WALK_UP; i++) {
    if (existsSync(resolve(dir, LAB_MARKER))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/**
 * Read the session working directory off a runtime Agent handle
 * (`agent.session.header.cwd`). Structural on purpose: lab-host does not
 * depend on dsh-agent, whose runtime face is augmented in place.
 */
export function agentSessionCwd(agent: unknown): string | undefined {
  const a = agent as { session?: { header?: { cwd?: string } } } | undefined
  const cwd = a?.session?.header?.cwd
  return typeof cwd === 'string' && cwd ? cwd : undefined
}

/**
 * One lab project's RPC-facing endpoint surface, bound to one LabCore. Every
 * consumer (tools, prompt, shell env, panel RPC) resolves the surface for
 * its session cwd; surfaces are cached per root.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function buildSurface(core: LabCore, hooks: { onMutation: () => void }) {
  const listSolutionViews = async (): Promise<SolutionView[]> => {
    const all = await core.solutions.list()
    const views: SolutionView[] = []
    for (const s of all) views.push(await core.solutionView(s))
    return views
  }
  const listRunViews = async (filter?: { solutionId?: string }): Promise<RunView[]> => {
    const all = await core.runs.list(filter)
    const views: RunView[] = []
    for (const r of all) views.push(await core.runView(r))
    return views
  }
  return {
    root: core.root,
    projectName: core.projectName,
    /** Shared-document locations, so shell env / prompt need no docs logic. */
    docsPaths: {
      sharedDir: core.docs.sharedDir,
      link: core.config.docLinkPath,
      relDir: core.config.docsDir,
    },

    /** The persisted project row (authoritative name for detected labs). */
    project: async (): Promise<import('@dsh-lab/shared').Project | undefined> =>
      core.deps.store.getProject(),

    // ── solutions ──────────────────────────────────────────────────────────

    solutions: {
      list: listSolutionViews,
      get: async (idOrSlug: string): Promise<SolutionView> => {
        const s = await core.solutions.get(idOrSlug)
        return core.solutionView(s)
      },
      /** Run evidence for one solution — the promotion gate's raw material. */
      evidence: async (idOrSlug: string): Promise<import('@dsh-lab/shared').MergeEvidence> => {
        const s: Solution = await core.solutions.get(idOrSlug)
        return core.solutions.mergeEvidence(s.id)
      },
      fork: async (input: {
        sourceSolutionId: string
        slug: string
        name?: string
        description?: string
        hypothesis?: string
        checkpointSource?: boolean
      }): Promise<SolutionView> => {
        const created = await core.solutions.fork({
          sourceSolutionId: input.sourceSolutionId,
          slug: input.slug,
          name: input.name ?? input.slug,
          description: input.description,
          hypothesis: input.hypothesis,
          checkpointSource: input.checkpointSource,
        })
        const view = await core.solutionView(created)
        hooks.onMutation()
        return view
      },
      checkpoint: async (idOrSlug: string, message?: string): Promise<{ commit: string }> => {
        const result = await core.solutions.checkpoint(idOrSlug, message)
        hooks.onMutation()
        return result
      },
      archive: async (idOrSlug: string, conclusion?: string): Promise<SolutionView> => {
        const archived = await core.solutions.archive(idOrSlug, conclusion)
        const view = await core.solutionView(archived)
        hooks.onMutation()
        return view
      },
      restore: async (idOrSlug: string): Promise<SolutionView> => {
        const restored = await core.solutions.restore(idOrSlug)
        const view = await core.solutionView(restored)
        hooks.onMutation()
        return view
      },
      diff: async (a: string, b: string): Promise<DiffView> => core.solutions.diff(a, b),
      merge: async (input: MergeSolutionInput): Promise<import('@dsh-lab/shared').MergeResult> => {
        const result = await core.solutions.merge(input)
        hooks.onMutation()
        return result
      },
      updateMetadata: async (
        idOrSlug: string,
        patch: { name?: string; description?: string; hypothesis?: string; conclusion?: string },
      ): Promise<SolutionView> => {
        const s: Solution = await core.solutions.get(idOrSlug)
        const updated: Solution = {
          ...s,
          ...patch,
          updatedAt: Date.now(),
        }
        await core.deps.store.upsertSolution(updated)
        const view = await core.solutionView(updated)
        hooks.onMutation()
        return view
      },
    },

    // ── runs ────────────────────────────────────────────────────────────────

    runs: {
      list: listRunViews,
      get: async (runIdValue: string): Promise<RunView> => {
        const run: ExperimentRun = await core.runs.get(runIdValue)
        return core.runView(run)
      },
      /**
       * Diff two runs' immutable snapshots. For parameter sweeps this is
       * usually exactly the config delta — the code state is shared via
       * sourceHeadCommit, the config lives in each snapshot.
       */
      diff: async (runA: string, runB: string): Promise<DiffView> => {
        const a: ExperimentRun = await core.runs.get(runA)
        const b: ExperimentRun = await core.runs.get(runB)
        const result = await core.deps.git.diff(undefined, a.snapshotCommit, b.snapshotCommit)
        return { headA: a.snapshotCommit, headB: b.snapshotCommit, ...result }
      },
      start: async (input: {
        solutionId: string
        command: string[]
        title?: string
        tags?: string[]
        resources?: import('@dsh-lab/shared').RunResourceRequest
      }): Promise<RunView> => {
        const run = await core.runs.start(input)
        return core.runView(run)
      },
      stop: async (runIdValue: string): Promise<RunView> => {
        const run = await core.runs.stop(runIdValue)
        return core.runView(run)
      },
      /**
       * Synchronously initiate cancellation: the runner's stop sends SIGTERM
       * to the detached process group before its first await, so a job
       * hook's `cancel` (which must be synchronous per the jobs contract)
       * can call this and rely on the signal going out immediately. The
       * follow-up bookkeeping (canceled record, GPU release, worktree
       * cleanup) belongs to `stop` / the exit finalize.
       */
      killProcess: (runIdValue: string): Promise<void> => core.deps.runner.stop(runIdValue),
      /** Subscribe to in-process run exits (fires after the run finalizes). */
      onRunExit: (listener: (runId: string, code: number | null) => void): (() => void) =>
        core.runs.onRunExit(listener),
      /**
       * Tail a run's log output for panel/agent reads: the last `maxLines`
       * of stdout.log plus stderr.log (training progress bars often live
       * there). Missing logs read as empty, never throw.
       */
      log: async (runIdValue: string, maxLines = 60): Promise<{ stdout: string; stderr: string }> => {
        const run: ExperimentRun = await core.runs.get(runIdValue)
        const logs = resolve(core.config.projectRoot, run.runDir, 'logs')
        const tail = async (file: string): Promise<string> => {
          try {
            return await tailFile(join(logs, file), maxLines)
          } catch {
            return ''
          }
        }
        return { stdout: await tail('stdout.log'), stderr: await tail('stderr.log') }
      },
    },

    // ── shared documents (DESIGN §26) ──────────────────────────────────────

    docs: {
      layout: async (): Promise<unknown> => {
        const layout = core.docs.layout()
        return {
          ...layout,
          link: core.config.docLinkPath,
          linkTarget: DocsService.linkTarget(core.config.docsDir, core.config.docLinkPath.split('/').length - 1),
          sharedRelative: core.config.docsDir,
          solutions: (await core.solutions.list()).map((sol) => ({
            slug: sol.slug,
            role: sol.role,
            status: sol.status,
            link: `${core.config.solutionsDir}/${sol.slug}/${core.config.docLinkPath}`,
          })),
        }
      },
      list: async (): Promise<unknown> => ({ docs: core.docs.list(), state: core.docs.state() }),
      read: async (relPath: string): Promise<unknown> => {
        if (typeof relPath !== 'string' || relPath === '') throw new Error('docs.read requires a path')
        return core.docs.read(relPath)
      },
      write: async (input: { path: string; text: string }): Promise<unknown> => {
        if (typeof input.path !== 'string' || input.path === '') throw new Error('docs.write requires a path')
        if (typeof input.text !== 'string') throw new Error('docs.write requires text')
        const written = core.docs.write(input.path, input.text)
        const version = await core.docs.commitVersion(`[dsh-lab] docs: update ${written}`)
        hooks.onMutation()
        return { path: written, bytes: Buffer.byteLength(input.text, 'utf8'), version }
      },
      promote: async (input: {
        solutionId: string
        includeLocal?: boolean
        promote?: string[]
        conclusion?: string
      }): Promise<unknown> => {
        const result = await core.docs.promoteSolution({
          solutionId: input.solutionId,
          includeLocal: input.includeLocal,
          promote: input.promote,
          conclusion: input.conclusion,
        })
        hooks.onMutation()
        return result
      },
      repair: async (): Promise<unknown> => ({ repaired: await core.docs.repairLinks() }),
      history: async (limit?: number): Promise<unknown> => ({
        versionRef: core.docs.versionRef,
        commits: await core.docs.history(typeof limit === 'number' ? limit : 20),
      }),
    },

    // ── resources / environment ────────────────────────────────────────────

    resources: {
      snapshot: async (): Promise<ResourceView> => core.resourceView(),
    },

    environment: {
      get: async (): Promise<EnvironmentView> => core.environmentView(),
    },

    // ── research evolution graph (derived projection) ─────────────────────

    /**
     * Build the research evolution graph: main milestones on a horizontal
     * line, experiments as branches with fork/merge edges, delta metrics.
     */
    graph: {
      get: async (): Promise<unknown> => {
        // use view projections (has parentSlug, mergedIntoSlug, bestSummary)
        const views = await listSolutionViews()
        const runs = await listRunViews()
        const events = await core.deps.store.listEvents(20)

        const bySlug: Record<string, (typeof views)[number]> = {}
        views.forEach((v) => { bySlug[v.slug] = v })

        // best metric per solution
        const bestMetric: Record<string, number> = {}
        for (const v of views) {
          if (v.bestSummary) {
            const entries = Object.entries(v.bestSummary)
            if (entries.length > 0 && entries[0]) bestMetric[v.slug] = entries[0][1]
          }
        }

        // derive main milestones from merge history
        const merged = views
          .filter((v) => v.mergedIntoSlug === 'main')
          .sort((a, b) => (a.lastRunAt ?? 0) - (b.lastRunAt ?? 0))

        const milestones: Record<string, unknown>[] = [
          { id: 'v1', label: 'v1', metric: bestMetric['main'], source: null },
        ]
        merged.forEach((m, i) => {
          milestones.push({
            id: 'v' + (i + 2), label: 'v' + (i + 2),
            metric: bestMetric[m.slug], source: m.slug,
          })
        })

        // per-solution local note inventory (cheap: one readdir per solution)
        const localDocsOf = (slug: string): { path: string; size: number; mtime: number }[] => {
          const out: { path: string; size: number; mtime: number }[] = []
          for (const dir of ['docs', 'notes', 'local']) {
            const abs = resolve(core.root, core.config.solutionsDir, slug, dir)
            try {
              for (const entry of readdirSync(abs, { withFileTypes: true })) {
                if (entry.isDirectory()) continue
                const stat = statSync(resolve(abs, entry.name))
                out.push({ path: `${dir}/${entry.name}`, size: stat.size, mtime: Math.round(stat.mtimeMs) })
              }
            } catch {
              /* no such local dir */
            }
          }
          return out
        }

        // nodes
        const nodes: Record<string, unknown>[] = []
        for (const v of views) {
          const parentMetric = v.parentSlug ? bestMetric[v.parentSlug] : bestMetric['main']
          const myMetric = bestMetric[v.slug]
          const delta = myMetric !== undefined && parentMetric !== undefined
            ? myMetric - parentMetric : undefined
          // promotion evidence per line (runs / succeeded / forked), so the
          // panel can show whether a merge into main is allowed yet
          const evidence = await core.solutions.mergeEvidence(v.id).catch(() => undefined)
          nodes.push({
            id: v.slug, label: v.name || v.slug,
            description: v.description,
            role: v.role, status: v.status,
            parent: v.parentSlug || 'main',
            mergedInto: v.mergedIntoSlug,
            branch: v.branch, headCommit: v.headCommit,
            metric: myMetric, delta,
            hypothesis: v.hypothesis, conclusion: v.conclusion,
            runCount: v.runCount,
            dirty: v.dirty,
            lastRunAt: v.lastRunAt,
            evidence,
            // docs partitioning (DESIGN §26): shared knowledge lives at the
            // project root; the solution contributes only its local notes
            localDocs: localDocsOf(v.slug),
            sharedDocs: core.docs.list().length,
          })
        }

        // edges
        const edges: Record<string, unknown>[] = []
        views.forEach((v) => {
          if (v.role === 'main') return
          edges.push({ from: v.parentSlug || 'main', to: v.slug, type: 'fork' })
          if (v.mergedIntoSlug === 'main') {
            const mileIdx = merged.findIndex((m) => m.slug === v.slug)
            if (mileIdx >= 0) {
              edges.push({ from: v.slug, to: 'v' + (mileIdx + 2), type: 'merge' })
            }
          }
        })

        // activity
        const activity = events.map((e) => ({
          time: e.createdAt, type: e.type, entityId: e.entityId,
          text: formatEventText(e),
        }))

        return { milestones, nodes, edges, activity }
      },
    },

    events: {
      list: async (limit?: number): Promise<unknown> => {
        const events = await core.deps.store.listEvents(limit ?? 20)
        return events.map((e) => ({ ...e, text: formatEventText(e) }))
      },
    },

    // ── lifecycle hooks ────────────────────────────────────────────────────

    async init(): Promise<SolutionView> {
      const main = await core.solutions.init(core.root, core.projectName)
      const view = await core.solutionView(main)
      hooks.onMutation()
      return view
    },
  }
}

/** One lab project's RPC-facing surface (see {@link buildSurface}). */
export type LabSurface = ReturnType<typeof buildSurface>

/** One lab root's prompt-section cache: synchronous reads, async refresh. */
interface ContextCache {
  text: string
  refresh?: Promise<void>
}

export class LabService extends Service {
  static inject = ['workspaceRegistry']

  /** The pinned lab from config, when the deployment set one. */
  private readonly configuredCore: LabCore | undefined
  /** LabCores for cwd-detected lab projects. */
  private detectedCores = new Map<string, LabCore>()
  private surfaces = new Map<string, LabSurface>()
  /** Per-root prompt-section caches (one per resolved lab). */
  private contextCaches = new Map<string, ContextCache>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'lab')
    if (config.solutionRoot) {
      this.configuredCore = new LabCore({
        solutionRoot: config.solutionRoot,
        projectName: config.projectName ?? 'Lab',
        workspace: new DshWorkspacePort(ctx),
      })
      void this.refreshContext(this.configuredCore.root).catch(() => {
        /* uninitialized lab — the placeholder text stands */
      })
    }
  }

  /** The pinned lab root, when the deployment configured one. */
  get root(): string | undefined {
    return this.configuredCore?.root
  }

  /** The pinned lab's display name, when a root is configured. */
  get projectName(): string | undefined {
    return this.configuredCore?.projectName
  }

  // ── per-cwd resolution ────────────────────────────────────────────────────

  /**
   * The lab root a consumer with this cwd operates on. Priority: the
   * configured root when the cwd sits inside it or no cwd is known → the
   * nearest ancestor holding an initialized `.dsh-lab/lab.sqlite`.
   * Undefined when the cwd belongs to no lab project.
   */
  rootFor(cwd?: string): string | undefined {
    if (this.configuredCore) {
      if (!cwd || underRoot(this.configuredCore.root, cwd)) return this.configuredCore.root
    }
    return cwd ? findLabRoot(cwd) : undefined
  }

  /**
   * Resolve the endpoint surface for a session cwd (see {@link rootFor}).
   * Undefined when the cwd belongs to no lab project.
   */
  surface(cwd?: string): LabSurface | undefined {
    const root = this.rootFor(cwd)
    if (!root) return undefined
    return this.surfaceOf(this.coreFor(root))
  }

  /** The LabCore for one resolved root — the pinned core when it matches, else a cached detected core. */
  private coreFor(root: string): LabCore {
    if (this.configuredCore && resolve(this.configuredCore.root) === resolve(root)) {
      return this.configuredCore
    }
    let core = this.detectedCores.get(root)
    if (!core) {
      core = new LabCore({
        solutionRoot: root,
        projectName: basename(root),
        workspace: new DshWorkspacePort(this.ctx),
      })
      this.detectedCores.set(root, core)
    }
    return core
  }

  private surfaceOf(core: LabCore): LabSurface {
    let s = this.surfaces.get(core.root)
    if (!s) {
      s = buildSurface(core, {
        // every lab's mutations refresh that lab's own prompt cache
        onMutation: () => {
          void this.refreshContext(core.root).catch(() => {})
        },
      })
      this.surfaces.set(core.root, s)
      if (core !== this.configuredCore) {
        // detected labs: hydrate the real project name from their store
        // (the constructor only knows the directory basename)
        void core.deps.store.getProject().then((proj) => {
          if (proj?.name) s!.projectName = proj.name
        }).catch(() => {})
      }
    }
    return s
  }

  // ── prompt-section cache ──────────────────────────────────────────────────

  /**
   * Prompt-section text for the lab a consumer with this cwd operates on.
   * Synchronous by contract: reads the per-root cache, priming it with a
   * placeholder and kicking an async refresh on first encounter. Sessions
   * whose workspace belongs to no lab get the short NO_LAB hint.
   */
  contextTextFor(cwd?: string): string {
    const root = this.rootFor(cwd)
    if (!root) return NO_LAB_HINT
    return this.ensureCache(root).text
  }

  /**
   * Rebuild one root's prompt cache from live state; safe to call
   * repeatedly. Without `root`, refreshes the pinned lab (no-op when the
   * deployment configured none).
   */
  async refreshContext(root?: string): Promise<void> {
    const target = root ?? this.configuredCore?.root
    if (!target) return
    const cache = this.ensureCache(target)
    if (cache.refresh) return cache.refresh
    cache.refresh = (async () => {
      const core = this.coreFor(target)
      const lines: string[] = ['DSH LAB CONTEXT', '']
      lines.push(`Project: ${await this.projectNameOf(core)}`)
      lines.push(`Root: ${core.root}`)
      lines.push(`Shared docs: ${core.docs.sharedDir} (link in every solution: ${core.config.docLinkPath})`)
      const solutions = await core.solutions.list().catch(() => [])
      if (solutions.length > 0) {
        lines.push('', 'Solutions:')
        for (const s of solutions) {
          const view = await core.solutionView(s)
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
          `- Documents: shared knowledge (charter, roadmap, baseline references, lessons) lives ONLY in the project-root ${core.config.docsDir}/ directory, which every solution reaches through ${core.config.docLinkPath} — one physical copy, no per-experiment forks of it. Keep per-experiment notes inside the solution and promote conclusions with lab_promote_docs (archiving promotes automatically).`,
          '- Experiment first, promote only what worked: a merge into main is refused unless the line was forked and has at least one succeeded run (allowUnevidenced overrides deliberately).',
          '- Experiment outputs should use DSH_LAB_RUN_DIR (Phase 3).',
          '- Parameter sweeps: start each variant with `lab_run_start` on the SAME solution, sharing one `sweep/<name>` tag plus a per-run `<param>=<value>` tag. Do NOT checkpoint config tweaks per run — each run snapshot already captures its config; checkpoint only the winning config. Fork a new Solution only when the hypothesis itself changes.',
        )
      } else {
        lines.push('', 'No solutions yet — the lab is not initialized. Use lab tools or `dsh-lab init`.')
      }
      cache.text = lines.join('\n')
    })()
    try {
      await cache.refresh
    } finally {
      cache.refresh = undefined
    }
  }

  private ensureCache(root: string): ContextCache {
    let cache = this.contextCaches.get(root)
    if (!cache) {
      cache = { text: `DSH LAB CONTEXT (loading…: ${root})` }
      this.contextCaches.set(root, cache)
      void this.refreshContext(root).catch(() => {
        /* uninitialized lab — the placeholder text stands */
      })
    }
    return cache
  }

  /** Authoritative project name for one core (detected labs read their own store). */
  private async projectNameOf(core: LabCore): Promise<string> {
    if (core === this.configuredCore) return core.projectName
    try {
      const proj = await core.deps.store.getProject()
      return proj?.name ?? core.projectName
    } catch {
      return core.projectName
    }
  }
}

function formatEventText(e: { type: string; entityId?: string; payloadJson?: string }): string {
  let payload: Record<string, unknown> = {}
  try { payload = e.payloadJson ? JSON.parse(e.payloadJson) : {} } catch { /* ignore */ }
  switch (e.type) {
    case 'SolutionForked': return `${e.entityId ?? ''} forked${payload.branch ? ' → ' + String(payload.branch) : ''}`
    case 'SolutionArchived': return `${e.entityId ?? ''} archived`
    case 'SolutionRestored': return `${e.entityId ?? ''} restored`
    case 'SolutionMerged': return `${e.entityId ?? ''} merged${payload.branch ? ' (' + String(payload.branch) + ')' : ''}`
    case 'RunCreated': return `run created: ${e.entityId ?? ''}`
    case 'RunStarted': return `run started: ${e.entityId ?? ''}`
    case 'RunCompleted': return `run completed: ${e.entityId ?? ''}`
    case 'RunFailed': return `run failed: ${e.entityId ?? ''}`
    case 'RunCanceled': return `run canceled: ${e.entityId ?? ''}`
    default: return e.type
  }
}

export const name = 'dsh-lab-host'

export function apply(ctx: Context, config: Config): void {
  ctx.plugin(LabService, config)
}

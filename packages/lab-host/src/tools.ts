/**
 * './tools' row: registers the lab_* model tools. Each tool executes through
 * ctx.lab — the model never touches git / sqlite / worktrees directly.
 *
 * Every tool resolves the lab project PER EXECUTION from the calling
 * agent's session cwd (falling back to the configured root when the
 * execution carries no agent). A session whose workspace belongs to no lab
 * gets a clear failure — lab tools never silently operate on some other
 * project's lab.
 *
 * Read tools: lab_status, lab_list_solutions, lab_get_solution,
 *             lab_solution_diff, lab_list_runs, lab_get_run, lab_run_diff,
 *             lab_get_resources
 * Mutation tools: lab_fork_solution, lab_checkpoint_solution,
 *                 lab_archive_solution, lab_restore_solution,
 *                 lab_merge_solution, lab_update_solution_metadata
 * Run tools:     lab_start_run, lab_stop_run (Phase 3)
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { agentSessionCwd, type LabSurface, type LabService } from './index.js'
import { registerRunJob } from './run-jobs.js'

export const name = 'dsh-lab-tools'
export const inject = ['lab', 'tools']

function jsonRender(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }] as ContentBlock[]
}

/**
 * Normalize a value for the model-tool wire: recursively drop `undefined`-valued
 * properties and turn `undefined` array items into null — exactly what
 * JSON.stringify transmits. Domain views use the TypeScript idiom for absent
 * optional fields (`parentSlug?: string` assigned `undefined`), but dsh-tools
 * validates tool output as LOSSLESS JSON, where an own property holding
 * `undefined` fails the whole output with "value is not lossless JSON".
 * Values JSON could not represent losslessly anyway (Date, BigInt, class
 * instances, NaN, …) pass through untouched, so the runtime check still fails
 * loudly on genuinely malformed data instead of silently mangling it.
 */
function jsonSafe(value: unknown): any {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : jsonSafe(item)))
  }
  if (typeof value === 'object' && value !== null) {
    const proto = Object.getPrototypeOf(value)
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(value)) {
        const item = (value as Record<string, unknown>)[key]
        if (item !== undefined) out[key] = jsonSafe(item)
      }
      return out
    }
  }
  return value
}

/**
 * Domain views cross into the wire as unconstrained JSON (`{ type: 'json' }`
 * output schema); this boundary applies JSON serialization semantics — absent
 * optional fields are simply omitted — so every lab_* tool returns lossless
 * JSON.
 */
function json<T>(value: T): any {
  return jsonSafe(value)
}

/** The error every lab tool raises when the session's workspace has no lab. */
const NO_LAB_MESSAGE =
  'No lab project for this session: no .dsh-lab/lab.sqlite at or above the session working directory' +
  ' and no solutionRoot is configured. lab_* tools operate on the session\'s own lab project —' +
  ' open the session inside a lab project, or run `dsh-lab init` in the project root to create one.'

/** Resolve the lab surface for one tool execution (per the agent's session cwd). */
function surfaceFor(lab: LabService, exec: { agent?: unknown }): LabSurface {
  const surface = lab.surface(agentSessionCwd(exec.agent))
  if (!surface) throw new Error(NO_LAB_MESSAGE)
  return surface
}

export function apply(ctx: Context): void {
  const lab = ctx.lab

  ctx.tools.register(
    defineTool({
      name: 'lab_status',
      description:
        "Show the Deep Learning Lab project status for this session's workspace: whether it is initialized, the solution counts by status, and the lab root. Fails soft with a hint when the workspace belongs to no lab project.",
      parameters: {},
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(_args, exec) {
        const surface = lab.surface(agentSessionCwd(exec.agent))
        if (!surface) {
          return json({
            initialized: false,
            root: null,
            project: null,
            hint: NO_LAB_MESSAGE,
          })
        }
        const solutions = await surface.solutions.list()
        const byStatus: Record<string, number> = {}
        for (const s of solutions) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1
        // the surface's projectName hydrates asynchronously for detected
        // labs — read the store row for an authoritative answer
        const project = await surface.project().catch(() => undefined)
        return json({
          initialized: solutions.length > 0,
          root: surface.root,
          project: project?.name ?? surface.projectName,
          solutionsByStatus: byStatus,
        })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lab_list_solutions',
      description:
        'List all lab solutions with status, branch, HEAD commit, dirty flag, run count, and parentage.',
      parameters: {},
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(_args, exec) {
        return json({ solutions: await surfaceFor(lab, exec).solutions.list() })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lab_get_solution',
      description: 'Get one lab solution by id or slug, including hypothesis/conclusion metadata.',
      parameters: {
        solution: { type: 'string', required: true, description: 'Solution id or slug' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args, exec) {
        return json(await surfaceFor(lab, exec).solutions.get(args.solution))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lab_solution_diff',
      description: 'Diff two solutions (changed files and patch). Most common: experiment solution vs main.',
      parameters: {
        a: { type: 'string', required: true, description: 'First solution id or slug' },
        b: { type: 'string', required: true, description: 'Second solution id or slug (usually "main")' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args, exec) {
        return json(await surfaceFor(lab, exec).solutions.diff(args.a, args.b))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lab_list_runs',
      description: 'List experiment runs, newest first, optionally filtered by solution.',
      parameters: {
        solution: { type: 'string', description: 'Filter: solution id or slug' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args, exec) {
        const surface = surfaceFor(lab, exec)
        // the parameter accepts id OR slug (per its description); the store
        // filters on the internal solution id, so resolve the slug first
        const filter = args.solution
          ? { solutionId: (await surface.solutions.get(args.solution)).id }
          : undefined
        return json({ runs: await surface.runs.list(filter) })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lab_get_run',
      description: 'Get one experiment run by id: snapshot commit, command, status, metrics.',
      parameters: {
        runId: { type: 'string', required: true, description: 'Run id' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args, exec) {
        return json(await surfaceFor(lab, exec).runs.get(args.runId))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lab_run_diff',
      description:
        "Diff two runs' immutable snapshots (changed files and patch). For parameter sweeps started from the same code state this shows exactly the config delta between the two runs.",
      parameters: {
        a: { type: 'string', required: true, description: 'First run id' },
        b: { type: 'string', required: true, description: 'Second run id' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args, exec) {
        return json(await surfaceFor(lab, exec).runs.diff(args.a, args.b))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lab_get_resources',
      description: 'Show GPU resources: per-GPU free VRAM and running runs.',
      parameters: {},
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(_args, exec) {
        return json(await surfaceFor(lab, exec).resources.snapshot())
      },
    }),
  )

  // ── mutation tools ────────────────────────────────────────────────────────

  ctx.tools.register(
    defineTool({
      name: 'lab_fork_solution',
      description:
        'Fork a new experiment solution from a source (main, an active experiment, or an archived/merged one). Creates the git branch + worktree and registers the DSH workspace.',
      parameters: {
        source: { type: 'string', required: true, description: 'Source solution id or slug (usually "main")' },
        slug: {
          type: 'string',
          required: true,
          description: 'New solution slug (kebab-case, becomes solutions/<slug> and exp/<slug>)',
        },
        name: { type: 'string', description: 'Display name' },
        hypothesis: { type: 'string', description: 'Research hypothesis for this experiment' },
        description: { type: 'string', description: 'Short description' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args, exec) {
        return json(
          await surfaceFor(lab, exec).solutions.fork({
            sourceSolutionId: args.source,
            slug: args.slug,
            name: args.name,
            description: args.description,
            hypothesis: args.hypothesis,
          }),
        )
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lab_checkpoint_solution',
      description: 'Commit all current changes on a solution branch (a normal git checkpoint).',
      parameters: {
        solution: { type: 'string', required: true, description: 'Solution id or slug' },
        message: { type: 'string', description: 'Commit message' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args, exec) {
        return json(await surfaceFor(lab, exec).solutions.checkpoint(args.solution, args.message))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lab_archive_solution',
      description:
        'Archive a solution: auto-checkpoints dirty work, removes the worktree and DSH workspace, keeps the branch and all experiment records.',
      parameters: {
        solution: { type: 'string', required: true, description: 'Solution id or slug' },
        conclusion: { type: 'string', description: 'Final conclusion note recorded on the solution' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args, exec) {
        return json(await surfaceFor(lab, exec).solutions.archive(args.solution, args.conclusion))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lab_restore_solution',
      description: 'Restore an archived or merged solution: re-creates the worktree at the branch HEAD.',
      parameters: {
        solution: { type: 'string', required: true, description: 'Solution id or slug' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args, exec) {
        return json(await surfaceFor(lab, exec).solutions.restore(args.solution))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lab_merge_solution',
      description:
        'Merge a source solution into a target. Modes: into-fork (default; source stays active), into-target (source becomes merged, workspace archived), consolidate (squash into one commit). Merge-to-main is target="main" with into-target. Promotion gate: a merge INTO main is refused unless the source was forked from another solution and has at least one succeeded run — experiment first, promote only what worked (allowUnevidenced overrides deliberately).',
      parameters: {
        source: { type: 'string', required: true, description: 'Source solution id or slug' },
        target: { type: 'string', required: true, description: 'Target solution id or slug (e.g. "main")' },
        mode: {
          type: 'string',
          description: 'into-fork | into-target | consolidate',
        },
        message: { type: 'string', description: 'Merge / squash commit message' },
        archiveSource: {
          type: 'boolean',
          description: 'Archive the source workspace after into-target/consolidate (default true)',
        },
        allowUnevidenced: {
          type: 'boolean',
          description:
            'Override the promotion gate: by default a merge INTO main requires the source to be a fork with at least one succeeded run. Set true only to deliberately promote an unevidenced line.',
        },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args, exec) {
        const mode = args.mode === 'into-target' || args.mode === 'consolidate' ? args.mode : 'into-fork'
        return json(
          await surfaceFor(lab, exec).solutions.merge({
            sourceSolutionId: args.source,
            targetSolutionId: args.target,
            mode,
            message: args.message,
            archiveSource: args.archiveSource,
            allowUnevidenced: args.allowUnevidenced,
          }),
        )
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lab_update_solution_metadata',
      description: "Update a solution's editable metadata: name, description, hypothesis, conclusion.",
      parameters: {
        solution: { type: 'string', required: true, description: 'Solution id or slug' },
        name: { type: 'string' },
        description: { type: 'string' },
        hypothesis: { type: 'string' },
        conclusion: { type: 'string' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args, exec) {
        return json(
          await surfaceFor(lab, exec).solutions.updateMetadata(args.solution, {
            name: args.name,
            description: args.description,
            hypothesis: args.hypothesis,
            conclusion: args.conclusion,
          }),
        )
      },
    }),
  )

  // ── shared documents (DESIGN §26) ─────────────────────────────────────────

  ctx.tools.register(
    defineTool({
      name: 'lab_docs',
      description:
        'Read the project-wide shared documents (charter, roadmap, baseline references, lessons) and inspect the docs layout. Shared documents live ONLY at the project root docs/ directory — every solution worktree reaches them through the link local/docs, so there is exactly one copy, and the directory is versioned under refs/dsh/docs (it lives outside every worktree). Actions: "layout" (paths, per-solution link, where local notes belong), "list" (documents with size/mtime), "read" (requires path), "history" (version commits). Per-experiment notes stay inside the solution; promote them with lab_promote_docs.',
      parameters: {
        action: {
          type: 'string',
          description: 'layout | list | read | history (default: list)',
        },
        path: {
          type: 'string',
          description: 'Document path relative to the shared docs directory (required for action=read)',
        },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args, exec) {
        const surface = surfaceFor(lab, exec)
        const action = args.action ?? 'list'
        if (action === 'layout') return json(await surface.docs.layout())
        if (action === 'list') return json(await surface.docs.list())
        if (action === 'history') return json(await surface.docs.history())
        if (action === 'read') {
          if (!args.path) throw new Error('lab_docs action=read requires a path')
          return json(await surface.docs.read(args.path))
        }
        throw new Error(`unknown lab_docs action "${action}" (layout | list | read | history)`)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lab_write_doc',
      description:
        'Create or overwrite one project-wide shared document (path relative to the docs directory). Use it for knowledge that must outlive a single experiment: project goals, the current roadmap, baseline references, environment setup, and cross-cutting lessons with their evidence. Never put per-experiment scratch notes here — keep those inside the solution and promote them with lab_promote_docs.',
      parameters: {
        path: { type: 'string', required: true, description: 'Document path, e.g. "roadmap.md" or "baselines/r2m.md"' },
        text: { type: 'string', required: true, description: 'Full document body' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args, exec) {
        return json(await surfaceFor(lab, exec).docs.write({ path: args.path, text: args.text }))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lab_promote_docs',
      description:
        "Promote a solution's results into the shared documents: mirrors its local notes (docs/, notes/, local/) into docs/local/<slug>/, optionally copies chosen files to shared paths, and writes an immutable snapshot under docs/.dlab/snapshots/ that survives archiving the solution. Use it when an experiment produced a conclusion worth keeping, or before archiving. Lab archive also promotes automatically.",
      parameters: {
        solution: { type: 'string', required: true, description: 'Solution id or slug' },
        promote: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths relative to the solution that should be copied to the SAME path in the shared docs',
        },
        conclusion: { type: 'string', description: 'Short conclusion to record as docs/local/<slug>/conclusion.md' },
        includeLocal: {
          type: 'boolean',
          description: 'Mirror the solution local notes into docs/local/<slug>/ (default true)',
        },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args, exec) {
        return json(
          await surfaceFor(lab, exec).docs.promote({
            solutionId: args.solution,
            includeLocal: args.includeLocal,
            promote: args.promote,
            conclusion: args.conclusion,
          }),
        )
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lab_migrate_docs',
      description:
        'Move documents that currently live INSIDE a solution worktree into the project-wide shared docs directory (docs/ at the project root). Use it once on an existing project whose charter/roadmap/reports were written inside a solution: without an explicit "apply" it returns the plan (files, collisions, target) and changes nothing. After migrating, the files are reachable from every solution through local/docs and are versioned under refs/dsh/docs.',
      parameters: {
        solution: { type: 'string', required: true, description: 'Solution whose documents should move' },
        path: { type: 'string', description: 'Directory inside the solution (default: docs)' },
        apply: { type: 'boolean', description: 'Perform the migration (default false: plan only)' },
        move: { type: 'boolean', description: 'Also delete the migrated files from the solution worktree' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args, exec) {
        const surface = surfaceFor(lab, exec)
        if (args.apply !== true) {
          return json(await surface.docs.migrationPlan({ solutionId: args.solution, path: args.path }))
        }
        return json(
          await surface.docs.migrate({ solutionId: args.solution, path: args.path, move: args.move }),
        )
      },
    }),
  )

  // ── run tools (Phase 3) ───────────────────────────────────────────────────

  ctx.tools.register(
    defineTool({
      name: 'lab_start_run',
      description:
        'Start an experiment run on a solution. Snapshots the current working tree immutably (uncommitted changes included, branch untouched), materializes a detached run worktree, and launches the command there with DSH_LAB_RUN_DIR pointing at experiments/run-NNNNNN. Later edits to the solution never affect the run. The run is registered as a DSH background job (kind lab-run, e.g. job id lab-run-3) owned by this session: you are notified in-session when the run settles — do not busy-poll lab_list_runs; track the run live with job_output (streams the run stdout) and stop it with job_kill or lab_stop_run. Disposing the owning session cancels its runs.',
      parameters: {
        solution: { type: 'string', required: true, description: 'Solution id or slug' },
        command: {
          type: 'array',
          required: true,
          items: { type: 'string' },
          description: 'argv to execute in the run worktree, e.g. ["python","train.py","--config","configs/x.yaml"]',
        },
        title: { type: 'string', description: 'Human-readable run title' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Labels for this run. Convention: parameter sweeps share one `sweep/<name>` tag plus a per-run `<param>=<value>` tag (e.g. lr=0.01), so runs group in the panel and stay diffable.',
        },
        gpuCount: { type: 'number', description: 'Auto-allocate this many GPUs' },
        minFreeVramMB: { type: 'number', description: 'Minimum free VRAM per GPU (MB)' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args, exec) {
        if (exec.signal.aborted) {
          const error = new Error('tool call aborted')
          error.name = 'AbortError'
          throw error
        }
        const surface: LabSurface = surfaceFor(lab, exec)
        const view = await surface.runs.start({
          solutionId: args.solution,
          command: args.command,
          title: args.title,
          tags: args.tags,
          resources:
            args.gpuCount !== undefined || args.minFreeVramMB !== undefined
              ? {
                  mode: 'auto',
                  ...(args.gpuCount !== undefined ? { gpuCount: args.gpuCount } : {}),
                  ...(args.minFreeVramMB !== undefined ? { minFreeVramMB: args.minFreeVramMB } : {}),
                }
              : undefined,
        })
        const jobId = registerRunJob(ctx, surface, exec, view)
        return json(jobId ? { ...view, dshJobId: jobId } : view)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lab_stop_run',
      description:
        'Stop a running or queued experiment run (SIGTERM to its process group). A run started via lab_start_run also has a DSH background job (lab-run-N); stopping it through either path settles the job and notifies the owning session.',
      parameters: {
        runId: { type: 'string', required: true, description: 'Run id, e.g. run-000001' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args, exec) {
        return json(await surfaceFor(lab, exec).runs.stop(args.runId))
      },
    }),
  )
}

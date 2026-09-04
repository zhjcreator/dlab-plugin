/**
 * './tools' row: registers the lab_* model tools. Each tool executes through
 * ctx.lab — the model never touches git / sqlite / worktrees directly.
 *
 * Read tools: lab_status, lab_list_solutions, lab_get_solution,
 *             lab_solution_diff, lab_list_runs, lab_get_run,
 *             lab_get_resources
 * Mutation tools: lab_fork_solution, lab_checkpoint_solution,
 *                 lab_archive_solution, lab_restore_solution,
 *                 lab_merge_solution, lab_update_solution_metadata
 * Run tools:     lab_start_run, lab_stop_run (Phase 3)
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-lab-tools'
export const inject = ['lab', 'tools']

function jsonRender(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }] as ContentBlock[]
}

/**
 * Domain views cross into the wire as unconstrained JSON (`{ type: 'json' }`
 * output schema); this cast marks that boundary explicitly.
 */
function json<T>(value: T): any {
  return value
}

export function apply(ctx: Context): void {
  const lab = ctx.lab

  ctx.tools.register(
    defineTool({
      name: 'lab_status',
      description:
        'Show the Deep Learning Lab project status: whether it is initialized, the solution counts by status, and the lab root.',
      parameters: {},
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute() {
        const solutions = await lab.solutions.list()
        const byStatus: Record<string, number> = {}
        for (const s of solutions) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1
        return {
          initialized: solutions.length > 0,
          root: lab.root,
          project: lab.projectName,
          solutionsByStatus: byStatus,
        }
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
      async execute() {
        return json({ solutions: await lab.solutions.list() })
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
      async execute(args) {
        return json(await lab.solutions.get(args.solution))
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
      async execute(args) {
        return json(await lab.solutions.diff(args.a, args.b))
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
      async execute(args) {
        return json({ runs: await lab.runs.list(args.solution ? { solutionId: args.solution } : undefined) })
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
      async execute(args) {
        return json(await lab.runs.get(args.runId))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lab_get_resources',
      description: 'Show GPU resources: per-GPU free VRAM and running runs.',
      parameters: {},
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute() {
        return json(await lab.resources.snapshot())
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
      async execute(args) {
        return json(
          await lab.solutions.fork({
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
      async execute(args) {
        return json(await lab.solutions.checkpoint(args.solution, args.message))
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
      async execute(args) {
        return json(await lab.solutions.archive(args.solution, args.conclusion))
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
      async execute(args) {
        return json(await lab.solutions.restore(args.solution))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lab_merge_solution',
      description:
        'Merge a source solution into a target. Modes: into-fork (default; source stays active), into-target (source becomes merged, workspace archived), consolidate (squash into one commit). Merge-to-main is target="main" with into-target.',
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
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args) {
        const mode = args.mode === 'into-target' || args.mode === 'consolidate' ? args.mode : 'into-fork'
        return json(
          await lab.solutions.merge({
            sourceSolutionId: args.source,
            targetSolutionId: args.target,
            mode,
            message: args.message,
            archiveSource: args.archiveSource,
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
      async execute(args) {
        return json(
          await lab.solutions.updateMetadata(args.solution, {
            name: args.name,
            description: args.description,
            hypothesis: args.hypothesis,
            conclusion: args.conclusion,
          }),
        )
      },
    }),
  )

  // ── run tools (Phase 3) ───────────────────────────────────────────────────

  ctx.tools.register(
    defineTool({
      name: 'lab_start_run',
      description:
        'Start an experiment run on a solution. Snapshots the current working tree immutably (uncommitted changes included, branch untouched), materializes a detached run worktree, and launches the command there with DSH_LAB_RUN_DIR pointing at experiments/run-NNNNNN. Later edits to the solution never affect the run.',
      parameters: {
        solution: { type: 'string', required: true, description: 'Solution id or slug' },
        command: {
          type: 'array',
          required: true,
          items: { type: 'string' },
          description: 'argv to execute in the run worktree, e.g. ["python","train.py","--config","configs/x.yaml"]',
        },
        title: { type: 'string', description: 'Human-readable run title' },
        gpuCount: { type: 'number', description: 'Auto-allocate this many GPUs' },
        minFreeVramMB: { type: 'number', description: 'Minimum free VRAM per GPU (MB)' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args) {
        return json(
          await lab.runs.start({
            solutionId: args.solution,
            command: args.command,
            title: args.title,
            resources:
              args.gpuCount !== undefined || args.minFreeVramMB !== undefined
                ? {
                    mode: 'auto',
                    ...(args.gpuCount !== undefined ? { gpuCount: args.gpuCount } : {}),
                    ...(args.minFreeVramMB !== undefined ? { minFreeVramMB: args.minFreeVramMB } : {}),
                  }
                : undefined,
          }),
        )
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'lab_stop_run',
      description: 'Stop a running or queued experiment run (SIGTERM to its process group).',
      parameters: {
        runId: { type: 'string', required: true, description: 'Run id, e.g. run-000001' },
      },
      output: { schema: { type: 'json' }, render: jsonRender },
      async execute(args) {
        return json(await lab.runs.stop(args.runId))
      },
    }),
  )
}

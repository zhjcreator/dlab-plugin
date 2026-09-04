/**
 * CLI implementation: wires the pure ports (LocalGitPort, SqliteStore,
 * LocalRunner, GpuScheduler, no-op WorkspacePort) and runs the full
 * Solution lifecycle headlessly. This is the Phase-1 validation surface —
 * no DSH runtime involved.
 */

import { mkdirSync, existsSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'
import { Command } from 'commander'
import { LocalGitPort } from '@dsh-lab/git'
import { SqliteStore } from '@dsh-lab/store'
import { LocalRunner } from '@dsh-lab/runner'
import { GpuScheduler } from '@dsh-lab/scheduler'
import { SolutionService } from '@dsh-lab/core'
import type { LabConfig, LabDeps } from '@dsh-lab/core'

export function makeConfig(root: string, projectName: string): LabConfig {
  const projectRoot = isAbsolute(root) ? root : resolve(process.cwd(), root)
  return {
    projectName,
    projectRoot,
    solutionsDir: 'solutions',
    experimentsDir: 'experiments',
    labStateDir: '.dsh-lab',
    venvDir: '.venv',
    gitDir: '.dsh-lab/repo.git',
    runWorktreesDir: '.dsh-lab/run-worktrees',
    runRefPrefix: 'refs/dsh/runs/',
    experimentBranchPrefix: 'exp/',
    mainBranch: 'main',
  }
}

export function makeDeps(root: string, projectName: string): LabDeps {
  const config = makeConfig(root, projectName)
  mkdirSync(resolve(config.projectRoot, config.labStateDir), { recursive: true })
  const git = new LocalGitPort({
    gitDir: resolve(config.projectRoot, config.gitDir),
    worktreeRoot: config.projectRoot,
  })
  const store = new SqliteStore({
    path: resolve(config.projectRoot, config.labStateDir, 'lab.sqlite'),
  })
  const runner = new LocalRunner()
  const scheduler = new GpuScheduler()
  // CLI mode has no DSH workspace registry
  const workspace = {
    async createWorkspace() {
      return undefined
    },
    async deleteWorkspace() {},
    async resolveByPath() {
      return undefined
    },
  }
  return { config, git, store, runner, scheduler, workspace }
}

export function makeSolutionService(root: string, projectName: string): { service: SolutionService; deps: LabDeps } {
  const deps = makeDeps(root, projectName)
  return { service: new SolutionService(deps), deps }
}

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command()
  program
    .name('dsh-lab')
    .description('Deep Learning Lab manager — solutions, runs, experiments')
    .version('0.1.0')
    .option('--root <dir>', 'project root (default: cwd)', process.cwd())

  const rootOf = (): string => {
    const opts = program.opts()
    return typeof opts.root === 'string' ? opts.root : process.cwd()
  }

  program
    .command('status')
    .description('show project status / init guidance')
    .action(async () => {
      const root = rootOf()
      const { deps } = makeSolutionService(root, 'lab')
      const store = deps.store as SqliteStore
      const project = await store.getProject()
      if (!project) {
        console.log(`no lab state under ${root} — run:`)
        console.log(`  dsh-lab --root ${root} init`)
        store.close()
        return
      }
      const solutions = await store.listSolutions()
      console.log(`project: ${project.name} @ ${project.rootPath}`)
      for (const s of solutions) {
        console.log(
          `  ${s.role === 'main' ? '★' : '●'} ${s.slug.padEnd(20)} ${s.status.padEnd(8)} ${s.branch} @ ${s.headCommit.slice(0, 8)}`,
        )
      }
      store.close()
    })

  program
    .command('init')
    .description('initialize a lab at a project root')
    .argument('[name]', 'project name', 'Lab')
    .action(async (name: string) => {
      const root = rootOf()
      const { service, deps } = makeSolutionService(root, name)
      const main = await service.init(root, name)
      console.log(`initialized project "${name}" at ${root}`)
      console.log(`  main solution: ${main.slug} branch=${main.branch} head=${main.headCommit.slice(0, 8)}`)
      ;(deps.store as SqliteStore).close()
    })

  const solution = program.command('solution').description('solution lifecycle')

  solution
    .command('list')
    .description('list solutions')
    .action(async () => {
      const root = rootOf()
      const { service, deps } = makeSolutionService(root, 'lab')
      const list = await service.list()
      for (const s of list) {
        console.log(`${s.slug.padEnd(20)} ${s.status.padEnd(8)} ${s.branch} @ ${s.headCommit.slice(0, 8)}`)
      }
      ;(deps.store as SqliteStore).close()
    })

  solution
    .command('fork <source> <slug>')
    .description('fork a new experiment solution')
    .option('-n, --name <name>', 'display name', '')
    .option('--hypothesis <text>', 'research hypothesis', '')
    .option('--no-checkpoint', 'fork from HEAD without checkpointing a dirty source')
    .action(async (source: string, slug: string, opts: { name: string; hypothesis: string; checkpoint: boolean }) => {
      const root = rootOf()
      const { service, deps } = makeSolutionService(root, 'lab')
      const created = await service.fork({
        sourceSolutionId: source,
        slug,
        name: opts.name || slug,
        hypothesis: opts.hypothesis || undefined,
        checkpointSource: opts.checkpoint,
      })
      console.log(`forked ${slug} from ${source}: branch=${created.branch} head=${created.headCommit.slice(0, 8)}`)
      ;(deps.store as SqliteStore).close()
    })

  solution
    .command('checkpoint <slug>')
    .description('commit all changes on a solution branch')
    .option('-m, --message <msg>', 'commit message')
    .action(async (slug: string, opts: { message?: string }) => {
      const root = rootOf()
      const { service, deps } = makeSolutionService(root, 'lab')
      const { commit } = await service.checkpoint(slug, opts.message)
      console.log(`checkpoint: ${commit}`)
      ;(deps.store as SqliteStore).close()
    })

  solution
    .command('archive <slug>')
    .description('archive a solution (keeps branch + experiments)')
    .option('--conclusion <text>', 'final conclusion note')
    .action(async (slug: string, opts: { conclusion?: string }) => {
      const root = rootOf()
      const { service, deps } = makeSolutionService(root, 'lab')
      const archived = await service.archive(slug, opts.conclusion)
      console.log(`archived ${archived.slug}: branch ${archived.branch} preserved at ${archived.headCommit.slice(0, 8)}`)
      ;(deps.store as SqliteStore).close()
    })

  solution
    .command('restore <slug>')
    .description('restore an archived/merged solution worktree')
    .action(async (slug: string) => {
      const root = rootOf()
      const { service, deps } = makeSolutionService(root, 'lab')
      const restored = await service.restore(slug)
      console.log(`restored ${restored.slug}: head=${restored.headCommit.slice(0, 8)}`)
      ;(deps.store as SqliteStore).close()
    })

  solution
    .command('diff <a> <b>')
    .description('diff two solutions (or vs main)')
    .action(async (a: string, b: string) => {
      const root = rootOf()
      const { service, deps } = makeSolutionService(root, 'lab')
      const view = await service.diff(a, b)
      console.log(`forkBase: ${view.forkBase ?? '(none)'}  A: ${view.headA}  B: ${view.headB}`)
      for (const f of view.changedFiles) console.log(`  ${f.status} ${f.path}`)
      ;(deps.store as SqliteStore).close()
    })

  solution
    .command('merge <source>')
    .description('merge a solution into a target (default: main)')
    .requiredOption('--target <slug>', 'target solution slug')
    .option('--mode <mode>', 'into-target | into-fork | consolidate', 'into-fork')
    .option('--message <msg>', 'merge/squash commit message')
    .option('--no-archive', 'keep the source workspace after an into-target/consolidate merge')
    .action(
      async (
        source: string,
        opts: { target: string; mode: 'into-target' | 'into-fork' | 'consolidate'; message?: string; archive: boolean },
      ) => {
        const root = rootOf()
        const { service, deps } = makeSolutionService(root, 'lab')
        const result = await service.merge({
          sourceSolutionId: source,
          targetSolutionId: opts.target,
          mode: opts.mode,
          message: opts.message,
          archiveSource: opts.archive,
        })
        console.log(
          `merged ${source} → ${opts.target} (${result.mode}): commit ${result.mergeCommit.slice(0, 8)}, source now ${result.sourceStatusAfter}`,
        )
        ;(deps.store as SqliteStore).close()
      },
    )

  const run = program.command('run').description('experiment runs')

  run
    .command('start <solution>')
    .description('start a run: snapshot the solution tree and execute a command in a detached worktree')
    .requiredOption('-c, --command <argv...>', 'argv to execute (e.g. -c python train.py --config x.yaml)')
    .option('-t, --title <title>', 'run title')
    .option('--gpu-count <n>', 'auto-allocate N GPUs', Number)
    .option('--min-free-vram <mb>', 'minimum free VRAM per GPU (MB)', Number)
    .option('--wait', 'wait for the run to finish and print its final status')
    .action(
      async (
        solution: string,
        opts: { command: string[]; title?: string; gpuCount?: number; minFreeVram?: number; wait?: boolean },
      ) => {
        const root = rootOf()
        const { deps } = makeSolutionService(root, 'lab')
        const { RunService } = await import('@dsh-lab/core')
        const runs = new RunService(deps)
        const started = await runs.start({
          solutionId: solution,
          command: opts.command,
          title: opts.title,
          resources:
            opts.gpuCount !== undefined || opts.minFreeVram !== undefined
              ? {
                  mode: 'auto',
                  ...(opts.gpuCount !== undefined ? { gpuCount: opts.gpuCount } : {}),
                  ...(opts.minFreeVram !== undefined ? { minFreeVramMB: opts.minFreeVram } : {}),
                }
              : undefined,
        })
        console.log(`started ${started.id}: snapshot=${started.snapshotCommit.slice(0, 8)} pid=${started.pid}`)
        console.log(`  run dir:    ${started.runDir}`)
        console.log(`  snapshot:   refs/dsh/runs/${started.id}`)
        if (opts.wait) {
          const deadline = Date.now() + 24 * 3600 * 1000
          while (Date.now() < deadline) {
            const r = await runs.get(started.id)
            if (r.status !== 'running' && r.status !== 'starting' && r.status !== 'queued') {
              console.log(`finished ${r.id}: status=${r.status} exit=${r.exitCode ?? '-'}`)
              break
            }
            await new Promise((res) => setTimeout(res, 500))
          }
        }
        ;(deps.store as SqliteStore).close()
      },
    )

  run
    .command('list')
    .description('list runs, newest first')
    .action(async () => {
      const root = rootOf()
      const { deps } = makeSolutionService(root, 'lab')
      const { RunService } = await import('@dsh-lab/core')
      const all = await new RunService(deps).list()
      for (const r of all) {
        const gpuIds = (r.resources as { gpuIds?: number[] })?.gpuIds
        console.log(
          `${r.id}  ${r.status.padEnd(10)} ${String(r.exitCode ?? '-').padEnd(4)} ${gpuIds ? `gpu=${gpuIds.join(',')} ` : ''}${r.command.join(' ')}`,
        )
      }
      ;(deps.store as SqliteStore).close()
    })

  run
    .command('stop <runId>')
    .description('stop a running run')
    .action(async (runId: string) => {
      const root = rootOf()
      const { deps } = makeSolutionService(root, 'lab')
      const { RunService } = await import('@dsh-lab/core')
      const runs = new RunService(deps)
      const stopped = await runs.stop(runId)
      console.log(`stopped ${stopped.id}: status=${stopped.status}`)
      ;(deps.store as SqliteStore).close()
    })

  await program.parseAsync(argv)
}

export function isLabRoot(root: string): boolean {
  return existsSync(resolve(root, '.dsh-lab'))
}

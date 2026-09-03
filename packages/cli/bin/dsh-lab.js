#!/usr/bin/env node
/**
 * dsh-lab CLI entry. Builds the CLI-only ports (LocalGitPort, SqliteStore,
 * LocalRunner, GpuScheduler, no-op WorkspacePort) then dispatches commands.
 * Phase 1: commander wiring only.
 */

import { Command } from 'commander'

const program = new Command()

program
  .name('dsh-lab')
  .description('Deep Learning Lab manager — solutions, runs, experiments')
  .version('0.1.0')

program
  .command('status')
  .description('show project status / init guidance')
  .action(async () => {
    console.log('dsh-lab: no project state found; run `dsh-lab init --root <dir>` first')
  })

program
  .command('init')
  .description('initialize a lab at a project root')
  .requiredOption('--root <dir>', 'project root that holds (or will hold) solutions/')
  .action(async (opts: { root: string }) => {
    console.log(`dsh-lab init --root ${opts.root} (Phase 1 pending)`)
  })

program
  .command('solution')
  .description('solution lifecycle subcommands')
  .command('list')
  .description('list solutions')
  .action(async () => {
    console.log('dsh-lab solution list (Phase 1 pending)')
  })

program
  .command('solution fork <source> <newSlug>')
  .description('fork a new experiment solution')
  .action(async (source: string, newSlug: string) => {
    console.log(`dsh-lab solution fork ${source} ${newSlug} (Phase 1 pending)`)
  })

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

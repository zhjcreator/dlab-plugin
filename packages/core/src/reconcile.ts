/**
 * Startup reconciliation: make DB projections match Git + FS + Workspace
 * registry reality without pretending anything is healthy. Solutions whose
 * directory is missing while DB says active → status 'broken' (repair shown
 * in UI). Run process reconciliation lives in RunService.reconcile().
 */

import type { LabDeps } from './ports.js'

export class ReconcileService {
  constructor(private readonly deps: LabDeps) {}

  /** Idempotent; safe to run at every host/cli boot. */
  async reconcile(): Promise<{ broken: string[]; repaired: string[] }> {
    const broken: string[] = []
    const repaired: string[] = []

    // Phase 1 implementation fills this in with:
    //   git worktree list --porcelain   vs   solutions table (worktreePath)
    //   git branch list                 vs   solutions table (branch)
    //   ctx.workspaceRegistry.list()    vs   solutions table (workspaceId)
    return { broken, repaired }
  }
}

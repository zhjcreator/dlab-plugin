/**
 * Startup reconciliation: make DB projections match Git + FS + Workspace
 * registry reality without pretending anything is healthy. Solutions whose
 * directory is missing while DB says active → status 'broken' (repair shown
 * in UI). Run process reconciliation lives in RunService.reconcile().
 *
 * The workspace phase exists for ONE migration: through v0.2.3, init/fork/
 * restore registered every solution directory as a DSH workspace, which
 * cluttered the workspace list with directories nobody had ever opened a
 * session in. dlab no longer registers (v0.2.4+); rows still carrying a
 * workspaceId are legacy registrations, and this sweep unregisters them. A
 * workspace a human created by hand is never recorded in
 * solutions.workspace_id, so the sweep cannot touch it — and once no row
 * carries an id, the sweep is a no-op on every later boot.
 */

import type { LabDeps } from './ports.js'

export class ReconcileService {
  constructor(private readonly deps: LabDeps) {}

  /** Idempotent; safe to run at every host/cli boot. */
  async reconcile(): Promise<{ broken: string[]; repaired: string[] }> {
    const broken: string[] = []
    const repaired: string[] = []

    // Workspace phase — unregister legacy solution workspaces (see header).
    // Delete first, clear the row second: a row without a registration is
    // the sweep's own definition of "done", so a delete that somehow fails
    // must leave the id in place for the next boot to retry.
    for (const solution of await this.deps.store.listSolutions()) {
      if (!solution.workspaceId) continue
      await this.deps.workspace.deleteWorkspace(solution.workspaceId)
      await this.deps.store.upsertSolution({ ...solution, workspaceId: undefined, updatedAt: Date.now() })
      repaired.push(`${solution.slug}: unregistered legacy workspace ${solution.workspaceId}`)
    }

    // Future phases fill this in with:
    //   git worktree list --porcelain   vs   solutions table (worktreePath)
    //   git branch list                 vs   solutions table (branch)
    return { broken, repaired }
  }
}

/**
 * WorkspacePort implementation over the DSH workspace registry — the
 * UNREGISTER direction only.
 *
 * dlab never registers a solution directory as a DSH workspace (v0.2.4+): a
 * workspace appears when a human actually opens a session in that directory,
 * never as a fork side effect. What remains here is the cleanup of the
 * pre-0.2.4 behavior: archive/merge/reconcile remove registrations recorded
 * in solutions.workspace_id. Sessions that lived in an unregistered
 * workspace stay, becoming Ungrouped; workspaces a human created by hand
 * carry no row in the lab DB and are never touched.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspacePort } from '@dsh-lab/core'

/** Minimal structural view of ctx.workspaceRegistry this bridge needs. */
interface WorkspaceRegistryShape {
  delete(id: string): Promise<boolean>
}

export class DshWorkspacePort implements WorkspacePort {
  constructor(private readonly ctx: Context) {}

  private get registry(): WorkspaceRegistryShape {
    return this.ctx.workspaceRegistry as unknown as WorkspaceRegistryShape
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    try {
      await this.registry.delete(workspaceId)
    } catch {
      // already gone — unregistering is idempotent at the call sites
    }
  }
}

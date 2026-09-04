/**
 * WorkspacePort implementation over the DSH workspace registry. Every active
 * Solution directory registers as a DSH workspace; archive removes the
 * registration (sessions stay, becoming Ungrouped).
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspacePort } from '@dsh-lab/core'

/** Minimal structural view of ctx.workspaceRegistry this bridge needs. */
interface WorkspaceRegistryShape {
  create(path: string, title?: string): Promise<{ id: string; path: string; title: string }>
  delete(id: string): Promise<boolean>
  resolveByPath(path: string): Promise<{ id: string; path: string } | undefined>
}

export class DshWorkspacePort implements WorkspacePort {
  constructor(private readonly ctx: Context) {}

  private get registry(): WorkspaceRegistryShape {
    return this.ctx.workspaceRegistry as unknown as WorkspaceRegistryShape
  }

  async createWorkspace(path: string, title: string): Promise<string | undefined> {
    try {
      const ws = await this.registry.create(path, title)
      return ws.id
    } catch {
      // registry unavailable or path missing — the solution still works
      // without a DSH workspace; reconcile reports the gap.
      return undefined
    }
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    try {
      await this.registry.delete(workspaceId)
    } catch {
      // already gone
    }
  }

  async resolveByPath(path: string): Promise<{ id: string } | undefined> {
    try {
      const ws = await this.registry.resolveByPath(path)
      return ws ? { id: ws.id } : undefined
    } catch {
      return undefined
    }
  }
}

/**
 * lab_* model tools. Each tool executes through ctx.lab — the model never
 * touches git / sqlite / worktrees directly. Skeleton: first three tools with
 * real signatures; execute bodies call LabService once Phase 1 lands.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Minimal structural shape of the tools service the skeleton consumes. */
interface ToolsShape {
  defineTool(def: object): unknown
  register(tool: unknown): unknown
}

interface CtxShape {
  tools?: ToolsShape
  get(name: string): unknown
}

export const name = 'dlab-lab-tools'
export const inject = ['lab', 'tools']

export function apply(ctx: Context): void {
  const tools = (ctx as unknown as CtxShape).tools
  if (!tools) return
  const { defineTool } = tools as ToolsShape
  void defineTool
  void ctx
}

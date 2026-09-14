/**
 * './shell-env' row: contributes DSH_LAB_* variables to every model shell
 * call so agents know which lab root they operate on. The values resolve
 * PER EXECUTION from the calling agent's session cwd — a session whose
 * workspace belongs to no lab project gets no DSH_LAB_* variables at all.
 * Per-run variables (DSH_LAB_RUN_DIR etc.) are injected into the RUN process
 * by the runner in Phase 3, not here.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-shell-env'
import { agentSessionCwd } from './index.js'

export const name = 'dsh-lab-shell-env'
export const inject = ['lab', 'shellEnv']

export function apply(ctx: Context): void {
  ctx.shellEnv.register({
    name: 'dsh-lab',
    variables: {
      DSH_LAB_ROOT: {
        description:
          "Absolute root of the lab project owning the session's workspace (solutions/, experiments/, .dsh-lab/); absent when the workspace belongs to no lab.",
      },
      DSH_LAB_PROJECT: {
        description: "Display name of the lab project owning the session's workspace.",
      },
      DSH_LAB_DOCS: {
        description:
          'Absolute path of the project-wide shared documents directory. Shared documents (charter, roadmap, baseline references, lessons) live ONLY here — never inside a solution worktree; the worktree link local/docs points at it.',
      },
      DSH_LAB_DOCS_LINK: {
        description:
          'Path of the shared-docs link inside the current solution worktree (local/docs); identical in every solution.',
      },
    },
    resolve: (execution) => {
      const surface = ctx.lab.surface(agentSessionCwd((execution as { agent?: unknown }).agent))
      if (!surface) return {}
      return {
        DSH_LAB_ROOT: surface.root,
        DSH_LAB_PROJECT: surface.projectName,
        DSH_LAB_DOCS: surface.docsPaths.sharedDir,
        DSH_LAB_DOCS_LINK: surface.docsPaths.link,
      }
    },
  })
}

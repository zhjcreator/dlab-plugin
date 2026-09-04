/**
 * './shell-env' row: contributes DSH_LAB_* variables to every model shell
 * call so agents in the lab know which root they operate on. Per-run
 * variables (DSH_LAB_RUN_DIR etc.) are injected into the RUN process by the
 * runner in Phase 3, not here.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-shell-env'

export const name = 'dsh-lab-shell-env'
export const inject = ['lab', 'shellEnv']

export function apply(ctx: Context): void {
  ctx.shellEnv.register({
    name: 'dsh-lab',
    variables: {
      DSH_LAB_ROOT: {
        description: 'Absolute root of the Deep Learning Lab project (solutions/, experiments/, .dsh-lab/).',
      },
      DSH_LAB_PROJECT: {
        description: 'Display name of the Deep Learning Lab project.',
      },
    },
    resolve: () => ({
      DSH_LAB_ROOT: ctx.lab.root,
      DSH_LAB_PROJECT: ctx.lab.projectName,
    }),
  })
}

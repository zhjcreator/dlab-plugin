/**
 * './system-prompt' row: registers the `lab:context` prompt section. The
 * section text is synchronous by contract; it reads a snapshot cache that
 * LabService refreshes after every mutation and at mount.
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-lab-system-prompt'
export const inject = ['lab', 'systemPrompt']

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'lab:context',
    order: 400,
    text: () => ctx.lab.contextText,
  })
}

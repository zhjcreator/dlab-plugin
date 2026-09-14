/**
 * './system-prompt' row: registers the `lab:context` prompt section. The
 * section text is synchronous by contract; it reads the per-root snapshot
 * cache that LabService refreshes after every mutation and at first read.
 *
 * The text resolves PER ASSEMBLY from the agent's session cwd: a session
 * inside a lab project sees that lab's context (solutions, runs, rules), a
 * session elsewhere sees a short no-lab hint instead of some other
 * project's lab.
 */

import type { Context } from '@deepseek-ai/cordis'
import { agentSessionCwd } from './index.js'

export const name = 'dsh-lab-system-prompt'
export const inject = ['lab', 'systemPrompt']

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'lab:context',
    order: 400,
    text: (context) =>
      ctx.lab.contextTextFor(
        agentSessionCwd((context as { agent?: unknown } | undefined)?.agent),
      ),
  })
}

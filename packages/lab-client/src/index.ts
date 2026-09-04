/**
 * @dsh-lab/client host half: a deliberate no-op. The package exists for its
 * browser half (./client) — the modules scanner needs this host row mounted
 * so it can discover the package's `dsh.client` declaration and serve the
 * client bundle; the host side contributes nothing itself.
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-lab-client'

export function apply(_ctx: Context): void {
  /* browser-only plugin; the host half has nothing to do */
}

/**
 * './rpc' row: mounts the /dlab Connection RPC channel for the browser half.
 * inject ['lab','connection'] — waits for both the service and the transport.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { dispatch, RPC_CHANNEL } from './rpc.js'

export const name = 'dsh-lab-rpc'
export const inject = ['lab', 'connection']

export function apply(ctx: Context): void {
  const handler = async (endpoint: string, payload: unknown) => dispatch(ctx.lab, endpoint, payload)

  // Real signature in dsh 0.1.2: handle(channel, handler) → () => Promise<void>
  const dispose = ctx.connection.rpc.handle(RPC_CHANNEL, handler)

  ctx.effect(() => {
    return () => {
      void dispose().catch(() => {
        /* best-effort cleanup */
      })
    }
  }, 'dsh-lab-rpc: channel')
}

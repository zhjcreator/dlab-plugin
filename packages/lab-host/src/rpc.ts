/**
 * /dlab RPC channel dispatch for the browser half. Host registers
 * `ctx.connection.rpc.handle('/dlab', dispatch, { authority: 'loopback' })`.
 * Envelope follows the connection-rpc.md standard:
 *   { ok: true, value } | { ok: false, error: { code, message } }
 */

import type { LabService } from './index.js'

const RPC_CHANNEL = '/dlab'

type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function fail<T = never>(code: string, message: string): RpcResult<T> {
  return { ok: false, error: { code, message } }
}

type Endpoint =
  | 'project.get'
  | 'solutions.list'
  | 'solutions.get'
  | 'runs.list'
  | 'resources.get'
  | 'environment.get'
  | 'follow'

export async function dispatch(
  service: LabService,
  endpoint: string,
  payload: unknown,
): Promise<RpcResult<unknown>> {
  switch (endpoint as Endpoint) {
    case 'solutions.list':
      try {
        return ok(await service.solutions.list())
      } catch (error) {
        return fail('list-failed', error instanceof Error ? error.message : String(error))
      }
    case 'solutions.get':
      try {
        const { id } = payload as { id: string }
        return ok(await service.solutions.get(id))
      } catch (error) {
        return fail('get-failed', error instanceof Error ? error.message : String(error))
      }
    default:
      return fail('unknown-endpoint', `unknown endpoint "${endpoint}"`)
  }
}

export { RPC_CHANNEL }
export type { RpcResult, Endpoint }

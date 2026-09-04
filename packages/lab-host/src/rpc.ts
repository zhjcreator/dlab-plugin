/**
 * /dlab RPC channel dispatch for the browser half. The './rpc' row registers
 * `ctx.connection.rpc.handle('/dlab', dispatch, { authority: 'loopback' })`.
 * Envelope follows the connection-rpc standard:
 *   { ok: true, value } | { ok: false, error: { code, message } }
 */

import type { LabService } from './index.js'

import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'

const RPC_CHANNEL = '/dlab'

type RpcResult<T> = ConnectionRpcResult<T>

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function fail<T = never>(code: string, message: string): RpcResult<T> {
  return { ok: false, error: { code, message, details: {} } }
}

type Endpoint =
  | 'project.get'
  | 'solutions.list'
  | 'solutions.get'
  | 'solutions.fork'
  | 'solutions.checkpoint'
  | 'solutions.archive'
  | 'solutions.restore'
  | 'solutions.merge'
  | 'solutions.diff'
  | 'solutions.updateMetadata'
  | 'runs.list'
  | 'runs.get'
  | 'runs.start'
  | 'runs.stop'
  | 'resources.get'
  | 'environment.get'

/** Single-switch dispatch over every /dlab endpoint. Never throws. */
export async function dispatch(
  service: LabService,
  endpoint: string,
  payload: unknown,
): Promise<RpcResult<unknown>> {
  const p = (payload ?? {}) as Record<string, unknown>
  try {
    switch (endpoint as Endpoint) {
      case 'project.get':
        return ok({ name: service.projectName, root: service.root })

      case 'solutions.list':
        return ok({ solutions: await service.solutions.list() })

      case 'solutions.get':
        return ok(await service.solutions.get(String(p.solution)))

      case 'solutions.fork':
        return ok(
          await service.solutions.fork({
            sourceSolutionId: String(p.source),
            slug: String(p.slug),
            name: typeof p.name === 'string' ? p.name : undefined,
            description: typeof p.description === 'string' ? p.description : undefined,
            hypothesis: typeof p.hypothesis === 'string' ? p.hypothesis : undefined,
          }),
        )

      case 'solutions.checkpoint':
        return ok(
          await service.solutions.checkpoint(String(p.solution), typeof p.message === 'string' ? p.message : undefined),
        )

      case 'solutions.archive':
        return ok(
          await service.solutions.archive(
            String(p.solution),
            typeof p.conclusion === 'string' ? p.conclusion : undefined,
          ),
        )

      case 'solutions.restore':
        return ok(await service.solutions.restore(String(p.solution)))

      case 'solutions.merge':
        return ok(
          await service.solutions.merge({
            sourceSolutionId: String(p.source),
            targetSolutionId: String(p.target),
            mode: p.mode === 'into-target' || p.mode === 'consolidate' ? p.mode : 'into-fork',
            message: typeof p.message === 'string' ? p.message : undefined,
            archiveSource: typeof p.archiveSource === 'boolean' ? p.archiveSource : undefined,
          }),
        )

      case 'solutions.diff':
        return ok(await service.solutions.diff(String(p.a), String(p.b)))

      case 'solutions.updateMetadata':
        return ok(
          await service.solutions.updateMetadata(String(p.solution), {
            name: typeof p.name === 'string' ? p.name : undefined,
            description: typeof p.description === 'string' ? p.description : undefined,
            hypothesis: typeof p.hypothesis === 'string' ? p.hypothesis : undefined,
            conclusion: typeof p.conclusion === 'string' ? p.conclusion : undefined,
          }),
        )

      case 'runs.list':
        return ok({
          runs: await service.runs.list(typeof p.solution === 'string' ? { solutionId: p.solution } : undefined),
        })

      case 'runs.get':
        return ok(await service.runs.get(String(p.runId)))

      case 'runs.start': {
        const command = Array.isArray(p.command) ? (p.command as unknown[]).map(String) : []
        return ok(
          await service.runs.start({
            solutionId: String(p.solution),
            command,
            title: typeof p.title === 'string' ? p.title : undefined,
            resources:
              p.gpuCount !== undefined || p.minFreeVramMB !== undefined
                ? {
                    mode: 'auto',
                    ...(p.gpuCount !== undefined ? { gpuCount: Number(p.gpuCount) } : {}),
                    ...(p.minFreeVramMB !== undefined ? { minFreeVramMB: Number(p.minFreeVramMB) } : {}),
                  }
                : undefined,
          }),
        )
      }

      case 'runs.stop':
        return ok(await service.runs.stop(String(p.runId)))

      case 'resources.get':
        return ok(await service.resources.snapshot())

      case 'environment.get':
        return ok(await service.environment.get())

      default:
        return fail('unknown-endpoint', `unknown endpoint "${endpoint}"`)
    }
  } catch (error) {
    return fail(
      'lab-error',
      error instanceof Error ? error.message : String(error),
    )
  }
}

export { RPC_CHANNEL }
export type { RpcResult }
export type { Endpoint }

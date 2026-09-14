/**
 * /dlab RPC channel dispatch for the browser half. The './rpc' entry mounts
 * the channel as a prefix route on ctx.webServer (see rpc-entry.ts) and
 * dispatches every request through here.
 * Envelope follows the connection-rpc standard:
 *   { ok: true, value } | { ok: false, error: { code, message, details } }
 */

import type { LabService } from './index.js'

import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'

const RPC_CHANNEL = '/dsh-lab'

type RpcResult<T> = ConnectionRpcResult<T>

function ok<T>(value: T): RpcResult<T> {
  return { ok: true, value }
}

function fail<T = never>(code: string, message: string): RpcResult<T> {
  return { ok: false, error: { code, message, details: {} } }
}

type Endpoint =
  | 'project.get'
  | 'project.init'
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
  | 'runs.log'
  | 'runs.diff'
  | 'runs.start'
  | 'runs.stop'
  | 'resources.get'
  | 'environment.get'
  | 'graph.get'
  | 'events.list'
  | 'docs.layout'
  | 'docs.list'
  | 'docs.read'
  | 'docs.write'
  | 'docs.promote'
  | 'docs.repair'
  | 'docs.history'

/**
 * Single-switch dispatch over every /dlab endpoint. Never throws.
 *
 * Dynamic lab resolution: every payload may carry `cwd` (the sidebar panel
 * sends the session's working directory). The endpoint then operates on the
 * lab project that cwd belongs to — the configured root when the cwd sits
 * inside it, otherwise the nearest ancestor holding `.dsh-lab/lab.sqlite`.
 * Without a cwd the configured root is used when the deployment pinned one
 * (same fallback the agent tools apply for executions without an agent).
 */
export async function dispatch(
  service: LabService,
  endpoint: string,
  payload: unknown,
): Promise<RpcResult<unknown>> {
  const p = (payload ?? {}) as Record<string, unknown>
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : undefined
  try {
    if (endpoint === 'project.get') {
      if (!cwd) {
        // no cwd: the pinned root when the deployment configured one
        return service.root
          ? ok({ name: service.projectName ?? null, root: service.root, source: 'config' })
          : ok({ name: null, root: null, source: 'none' })
      }
      const scoped = service.surface(cwd)
      if (!scoped) {
        // not an error: the panel renders its "not a lab workspace" state
        return ok({ name: null, root: null, source: 'none' })
      }
      // detected labs report the name persisted in THEIR store
      const proj = await scoped.project()
      return ok({ name: (proj && proj.name) || scoped.projectName, root: scoped.root, source: 'cwd' })
    }
    const svc = service.surface(cwd)
    if (!svc) {
      return fail('no-lab-project', `no initialized lab project (.dsh-lab) found for ${cwd}`)
    }
    switch (endpoint as Endpoint) {
      case 'project.get':
        return ok({ name: svc.projectName, root: svc.root, source: 'config' })

      case 'project.init':
        return ok(await svc.init())

      case 'solutions.list':
        return ok({ solutions: await svc.solutions.list() })

      case 'solutions.get':
        return ok(await svc.solutions.get(String(p.solution)))

      case 'solutions.fork':
        return ok(
          await svc.solutions.fork({
            sourceSolutionId: String(p.source),
            slug: String(p.slug),
            name: typeof p.name === 'string' ? p.name : undefined,
            description: typeof p.description === 'string' ? p.description : undefined,
            hypothesis: typeof p.hypothesis === 'string' ? p.hypothesis : undefined,
          }),
        )

      case 'solutions.checkpoint':
        return ok(
          await svc.solutions.checkpoint(String(p.solution), typeof p.message === 'string' ? p.message : undefined),
        )

      case 'solutions.archive':
        return ok(
          await svc.solutions.archive(
            String(p.solution),
            typeof p.conclusion === 'string' ? p.conclusion : undefined,
          ),
        )

      case 'solutions.restore':
        return ok(await svc.solutions.restore(String(p.solution)))

      case 'solutions.merge':
        return ok(
          await svc.solutions.merge({
            sourceSolutionId: String(p.source),
            targetSolutionId: String(p.target),
            mode: p.mode === 'into-target' || p.mode === 'consolidate' ? p.mode : 'into-fork',
            message: typeof p.message === 'string' ? p.message : undefined,
            archiveSource: typeof p.archiveSource === 'boolean' ? p.archiveSource : undefined,
          }),
        )

      case 'solutions.diff':
        return ok(await svc.solutions.diff(String(p.a), String(p.b)))

      case 'solutions.updateMetadata':
        return ok(
          await svc.solutions.updateMetadata(String(p.solution), {
            name: typeof p.name === 'string' ? p.name : undefined,
            description: typeof p.description === 'string' ? p.description : undefined,
            hypothesis: typeof p.hypothesis === 'string' ? p.hypothesis : undefined,
            conclusion: typeof p.conclusion === 'string' ? p.conclusion : undefined,
          }),
        )

      case 'runs.list':
        return ok({
          runs: await svc.runs.list(typeof p.solution === 'string' ? { solutionId: p.solution } : undefined),
        })

      case 'runs.get':
        return ok(await svc.runs.get(String(p.runId)))

      case 'runs.log': {
        const requested = typeof p.maxLines === 'number' ? Math.trunc(p.maxLines) : 80
        const maxLines = Math.min(Math.max(requested, 1), 400)
        return ok(await svc.runs.log(String(p.runId), maxLines))
      }

      case 'runs.diff':
        return ok(await svc.runs.diff(String(p.a), String(p.b)))

      case 'runs.start': {
        const command = Array.isArray(p.command) ? (p.command as unknown[]).map(String) : []
        const tags = Array.isArray(p.tags) ? (p.tags as unknown[]).map(String) : undefined
        return ok(
          await svc.runs.start({
            solutionId: String(p.solution),
            command,
            title: typeof p.title === 'string' ? p.title : undefined,
            tags,
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
        return ok(await svc.runs.stop(String(p.runId)))

      case 'resources.get':
        return ok(await svc.resources.snapshot())

      case 'environment.get':
        return ok(await svc.environment.get())

      case 'graph.get':
        return ok(await svc.graph.get())

      case 'events.list':
        return ok(await svc.events.list(typeof p.limit === 'number' ? p.limit : 20))

      case 'docs.layout':
        return ok(await svc.docs.layout())

      case 'docs.list':
        return ok(await svc.docs.list())

      case 'docs.read':
        return ok(await svc.docs.read(String(p.path)))

      case 'docs.write':
        return ok(await svc.docs.write({ path: String(p.path), text: String(p.text ?? '') }))

      case 'docs.promote':
        return ok(
          await svc.docs.promote({
            solutionId: String(p.solution),
            includeLocal: typeof p.includeLocal === 'boolean' ? p.includeLocal : undefined,
            promote: Array.isArray(p.promote) ? (p.promote as unknown[]).map(String) : undefined,
            conclusion: typeof p.conclusion === 'string' ? p.conclusion : undefined,
          }),
        )

      case 'docs.repair':
        return ok(await svc.docs.repair())

      case 'docs.history':
        return ok(await svc.docs.history(typeof p.limit === 'number' ? p.limit : 20))

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

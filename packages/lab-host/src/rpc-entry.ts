/**
 * './rpc' row: mounts the /dlab RPC channel for the browser half.
 *
 * Why this row registers its HTTP route directly on ctx.webServer instead of
 * calling ctx.connection.rpc.handle(): dsh 0.1.5-rc moved the webServer
 * provision from the app root into a sibling loader row, and inside
 * HostConnectionService the traceable-shadow ctx resolves `owner.webServer`
 * on the CONNECTION plugin's fiber — which does not inject webServer and
 * cannot see the sibling row — so rpc.handle() throws "cannot get property
 * webServer without inject" regardless of what the caller injects. First-party
 * dsh code never hits this (it uses rpc.intercept / connection.fetch, whose
 * effect callbacks touch no ctx services).
 *
 * This row therefore owns the whole channel: a prefix route on ctx.webServer
 * speaking the documented Connection RPC envelope (client-request /
 * server-response with rpcId correlation — exactly what the browser half's
 * connection.rpc.call('/dsh-lab', …) sends and expects) behind the same
 * Host/Origin + browser-auth fence as /api via ctx.connection.requestRejection.
 *
 * inject ['lab','connection','webServer'] — the service, the fence, and the
 * route table; the route unloads with this row.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import { dispatch, RPC_CHANNEL } from './rpc.js'

export const name = 'dsh-lab-rpc'
export const inject = ['lab', 'connection', 'webServer']

/** Request body cap for the channel (lab payloads are small JSON documents). */
const MAX_BODY_BYTES = 16 * 1024 * 1024

/** Minimal structural view of ctx.webServer this row needs. */
interface WebServerShape {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The Connection RPC client-request envelope (see dsh-client-connection). */
interface ClientRequestEnvelope {
  type: 'client-request'
  rpcId: string
  method: string
  payload?: unknown
}

/** Read one request body, rejecting early above `limit`. */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Write one server-response envelope. */
function respond(res: ServerResponse, rpcId: string, result: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
}

/** Write one server-response envelope carrying a protocol-level failure. */
function respondError(
  res: ServerResponse,
  rpcId: string,
  code: string,
  message: string,
): void {
  respond(res, rpcId, { ok: false, error: { code, message, details: {} } })
}

export function apply(ctx: Context): void {
  const connection = ctx.connection
  const webServer = (ctx as unknown as { webServer: WebServerShape }).webServer

  const route = {
    kind: 'prefix' as const,
    path: RPC_CHANNEL,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      try {
        // Same fence as the /api transport: Host/Origin check, then the
        // persistent browser-session authentication.
        const rejection = connection.requestRejection(req as ConnectionTrustRequest)
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }

        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const endpoint = pathname.startsWith(`${RPC_CHANNEL}/`)
          ? pathname.slice(RPC_CHANNEL.length + 1)
          : ''
        if (req.method !== 'POST' || endpoint === '') {
          res.writeHead(404)
          res.end('not found')
          return
        }
        const contentType = req.headers['content-type']
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase()
        if (contentType !== 'application/json') {
          res.writeHead(415)
          res.end('content type must be application/json')
          return
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(await readBody(req, MAX_BODY_BYTES))
        } catch {
          res.writeHead(400)
          res.end('body is not JSON')
          return
        }
        const message = parsed as Partial<ClientRequestEnvelope> | null
        if (
          message === null ||
          typeof message !== 'object' ||
          message.type !== 'client-request' ||
          typeof message.rpcId !== 'string' ||
          typeof message.method !== 'string'
        ) {
          res.writeHead(400)
          res.end('invalid client-request message')
          return
        }
        if (message.method !== endpoint) {
          respondError(
            res,
            message.rpcId,
            'gateway/bad-request',
            `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          )
          return
        }

        const result = await dispatch(ctx.lab, endpoint, message.payload)
        respond(res, message.rpcId, result)
      } catch (error) {
        if (!res.headersSent) res.writeHead(500)
        res.end(`handler failure: ${String(error)}`)
      }
    },
  }

  ctx.effect(() => webServer.register(route), 'dsh-lab-rpc: channel')
}

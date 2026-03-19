// src/daemon/webhook-server.ts
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import crypto from 'node:crypto'
import type { WebhookConfig } from './types.js'

export interface WebhookServer {
  start(): Promise<void>
  stop(): Promise<void>
  readonly port: number
}

function normalizePath(p: string | undefined): string {
  const raw = p ?? '/'
  return raw.startsWith('/') ? raw : '/' + raw
}

function verifyHmac(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  if (expected.length !== signatureHeader.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader))
  } catch {
    return false
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function respond(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(json)
}

export function createWebhookServer(
  webhooks: WebhookConfig[],
  onTrigger: (webhook: WebhookConfig, payload: Record<string, unknown>) => void,
): WebhookServer {
  const listenPort = webhooks[0].port

  // Build a map from normalized path to webhook config
  const pathMap = new Map<string, WebhookConfig>()
  for (const wh of webhooks) {
    pathMap.set(normalizePath(wh.path), wh)
  }

  const server: Server = createServer(async (req, res) => {
    // Only allow POST
    if (req.method !== 'POST') {
      respond(res, 405, { error: 'Method Not Allowed' })
      return
    }

    // Match path
    const urlPath = req.url ?? '/'
    const webhook = pathMap.get(urlPath)
    if (!webhook) {
      respond(res, 404, { error: 'Not Found' })
      return
    }

    try {
      const rawBody = await readBody(req)

      // HMAC validation
      if (webhook.secret) {
        const signatureHeader = req.headers['x-hub-signature-256'] as string | undefined
        if (!verifyHmac(webhook.secret, rawBody, signatureHeader)) {
          respond(res, 403, { error: 'Forbidden' })
          return
        }
      }

      // Parse JSON
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(rawBody.toString('utf-8'))
      } catch {
        respond(res, 400, { error: 'Bad Request' })
        return
      }

      onTrigger(webhook, payload)
      respond(res, 200, { ok: true })
    } catch {
      respond(res, 500, { error: 'Internal Server Error' })
    }
  })

  let actualPort = 0
  let closed = false

  return {
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(listenPort, () => {
          const addr = server.address()
          if (addr && typeof addr === 'object') {
            actualPort = addr.port
          }
          closed = false
          resolve()
        })
      })
    },

    stop(): Promise<void> {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise((resolve) => {
        server.close(() => resolve())
      })
    },

    get port(): number {
      return actualPort
    },
  }
}

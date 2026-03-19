// tests/webhook-server.test.ts
import { afterEach, describe, it, expect, vi } from 'vitest'
import { createWebhookServer, type WebhookServer } from '../src/daemon/webhook-server.js'
import type { WebhookConfig } from '../src/daemon/types.js'
import crypto from 'node:crypto'

function sign(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

function makeWebhook(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    name: 'test-hook',
    port: 0,
    spec: '/specs/deploy.md',
    ...overrides,
  }
}

let server: WebhookServer

afterEach(async () => {
  if (server) await server.stop()
})

function url(path = '/'): string {
  return `http://127.0.0.1:${server.port}${path}`
}

describe('createWebhookServer', () => {
  it('POST to configured path triggers onTrigger with parsed payload', async () => {
    const onTrigger = vi.fn()
    const webhook = makeWebhook({ path: '/deploy' })
    server = createWebhookServer([webhook], onTrigger)
    await server.start()

    const body = JSON.stringify({ ref: 'refs/heads/main' })
    const res = await fetch(url('/deploy'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(onTrigger).toHaveBeenCalledOnce()
    expect(onTrigger).toHaveBeenCalledWith(webhook, { ref: 'refs/heads/main' })
  })

  it('POST to unconfigured path returns 404', async () => {
    const onTrigger = vi.fn()
    server = createWebhookServer([makeWebhook({ path: '/deploy' })], onTrigger)
    await server.start()

    const res = await fetch(url('/unknown'), {
      method: 'POST',
      body: '{}',
    })

    expect(res.status).toBe(404)
    expect(onTrigger).not.toHaveBeenCalled()
  })

  it('GET request returns 405', async () => {
    const onTrigger = vi.fn()
    server = createWebhookServer([makeWebhook()], onTrigger)
    await server.start()

    const res = await fetch(url('/'), { method: 'GET' })

    expect(res.status).toBe(405)
    expect(onTrigger).not.toHaveBeenCalled()
  })

  it('HMAC validation succeeds with correct secret', async () => {
    const secret = 'my-secret-key'
    const onTrigger = vi.fn()
    server = createWebhookServer([makeWebhook({ secret })], onTrigger)
    await server.start()

    const body = JSON.stringify({ action: 'push' })
    const signature = sign(secret, body)
    const res = await fetch(url('/'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': signature,
      },
      body,
    })

    expect(res.status).toBe(200)
    expect(onTrigger).toHaveBeenCalledOnce()
  })

  it('HMAC validation fails with wrong secret, returns 403', async () => {
    const onTrigger = vi.fn()
    server = createWebhookServer([makeWebhook({ secret: 'correct-secret' })], onTrigger)
    await server.start()

    const body = JSON.stringify({ action: 'push' })
    const wrongSignature = sign('wrong-secret', body)
    const res = await fetch(url('/'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': wrongSignature,
      },
      body,
    })

    expect(res.status).toBe(403)
    expect(onTrigger).not.toHaveBeenCalled()
  })

  it('POST without HMAC header when secret is configured returns 403', async () => {
    const onTrigger = vi.fn()
    server = createWebhookServer([makeWebhook({ secret: 'some-secret' })], onTrigger)
    await server.start()

    const res = await fetch(url('/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'push' }),
    })

    expect(res.status).toBe(403)
    expect(onTrigger).not.toHaveBeenCalled()
  })

  it('POST without secret configured skips HMAC validation', async () => {
    const onTrigger = vi.fn()
    server = createWebhookServer([makeWebhook()], onTrigger)
    await server.start()

    const res = await fetch(url('/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    })

    expect(res.status).toBe(200)
    expect(onTrigger).toHaveBeenCalledOnce()
  })

  it('stop() closes the server', async () => {
    const onTrigger = vi.fn()
    server = createWebhookServer([makeWebhook()], onTrigger)
    await server.start()

    const port = server.port
    await server.stop()

    // After stop, fetching should fail
    await expect(
      fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: '{}' }),
    ).rejects.toThrow()
  })

  it('start() binds to configured port (verify port > 0)', async () => {
    const onTrigger = vi.fn()
    server = createWebhookServer([makeWebhook({ port: 0 })], onTrigger)
    await server.start()

    expect(server.port).toBeGreaterThan(0)
  })

  it('invalid JSON body returns 400', async () => {
    const onTrigger = vi.fn()
    server = createWebhookServer([makeWebhook()], onTrigger)
    await server.start()

    const res = await fetch(url('/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    })

    expect(res.status).toBe(400)
    expect(onTrigger).not.toHaveBeenCalled()
  })

  it('multiple webhooks with different paths dispatch correctly', async () => {
    const onTrigger = vi.fn()
    const hookA = makeWebhook({ name: 'hook-a', path: '/alpha' })
    const hookB = makeWebhook({ name: 'hook-b', path: '/beta' })
    server = createWebhookServer([hookA, hookB], onTrigger)
    await server.start()

    const resA = await fetch(url('/alpha'), {
      method: 'POST',
      body: JSON.stringify({ from: 'alpha' }),
    })
    expect(resA.status).toBe(200)
    expect(onTrigger).toHaveBeenCalledWith(hookA, { from: 'alpha' })

    const resB = await fetch(url('/beta'), {
      method: 'POST',
      body: JSON.stringify({ from: 'beta' }),
    })
    expect(resB.status).toBe(200)
    expect(onTrigger).toHaveBeenCalledWith(hookB, { from: 'beta' })

    expect(onTrigger).toHaveBeenCalledTimes(2)
  })

  it('payload is passed through to onTrigger callback', async () => {
    const onTrigger = vi.fn()
    server = createWebhookServer([makeWebhook()], onTrigger)
    await server.start()

    const payload = {
      repository: { full_name: 'owner/repo' },
      ref: 'refs/heads/main',
      commits: [{ id: 'abc123', message: 'fix bug' }],
    }

    const res = await fetch(url('/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    expect(res.status).toBe(200)
    expect(onTrigger).toHaveBeenCalledOnce()
    const receivedPayload = onTrigger.mock.calls[0][1]
    expect(receivedPayload).toEqual(payload)
  })
})

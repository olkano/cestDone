import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import type { MailConfig } from '../src/email/types.js'

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => Buffer.from('file-content')),
}))

import { SendGridMailProvider } from '../src/email/sendgrid-provider.js'

const BASE_CONFIG: MailConfig = {
  provider: 'sendgrid',
  from: 'notifier@itmplatform.com',
  sendgrid: { apiKey: 'SG.test-key', sandboxMode: true, liveSendApproved: false },
}

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  fetchSpy = vi.spyOn(globalThis, 'fetch')
})

afterEach(() => {
  fetchSpy.mockRestore()
})

describe('SendGridMailProvider', () => {
  it('throws when sendgrid config is missing', () => {
    expect(() => new SendGridMailProvider({ provider: 'sendgrid', from: 'a@b.com' }))
      .toThrow('SendGrid API key required')
  })

  it('has name "sendgrid"', () => {
    const provider = new SendGridMailProvider(BASE_CONFIG)
    expect(provider.name).toBe('sendgrid')
  })

  it('send() calls SendGrid API with correct payload', async () => {
    fetchSpy.mockResolvedValue(new Response(null, {
      status: 202,
      headers: { 'x-message-id': 'sg-msg-123' },
    }))

    const provider = new SendGridMailProvider(BASE_CONFIG)
    await provider.send({ to: 'recipient@example.com', subject: 'Hi', body: 'Hello' })

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.sendgrid.com/v3/mail/send',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer SG.test-key',
          'Content-Type': 'application/json',
        },
      }),
    )

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as any).body)
    expect(body.personalizations[0].to).toEqual([{ email: 'recipient@example.com' }])
    expect(body.from).toEqual({ email: 'notifier@itmplatform.com' })
    expect(body.subject).toBe('Hi')
    expect(body.content).toEqual([{ type: 'text/plain', value: 'Hello' }])
    expect(body.mail_settings).toEqual({ sandbox_mode: { enable: true } })
  })

  it('omits sandbox settings for an approved live-send configuration', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }))
    const provider = new SendGridMailProvider({
      ...BASE_CONFIG,
      sendgrid: { apiKey: 'SG.test-key', sandboxMode: false, liveSendApproved: true },
    })

    await provider.send({ to: 'recipient@example.com', subject: 'Hi', body: 'Hello' })

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as any).body)
    expect(body).not.toHaveProperty('mail_settings')
  })

  it('send() returns success with messageId on 202', async () => {
    fetchSpy.mockResolvedValue(new Response(null, {
      status: 202,
      headers: { 'x-message-id': 'sg-msg-456' },
    }))

    const provider = new SendGridMailProvider(BASE_CONFIG)
    const result = await provider.send({ to: 'r@e.com', subject: 'S', body: 'B' })

    expect(result).toEqual({ success: true, messageId: 'sg-msg-456' })
  })

  it('send() returns error on non-202 status', async () => {
    fetchSpy.mockResolvedValue(new Response('{"errors":[{"message":"Forbidden"}]}', {
      status: 403,
    }))

    const provider = new SendGridMailProvider(BASE_CONFIG)
    const result = await provider.send({ to: 'r@e.com', subject: 'S', body: 'B' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('SendGrid API 403')
    expect(result.error).toContain('Forbidden')
  })

  it('send() returns error on fetch failure', async () => {
    fetchSpy.mockRejectedValue(new Error('Network error'))

    const provider = new SendGridMailProvider(BASE_CONFIG)
    const result = await provider.send({ to: 'r@e.com', subject: 'S', body: 'B' })

    expect(result).toEqual({ success: false, error: 'Network error' })
  })

  it('send() handles array of recipients', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }))

    const provider = new SendGridMailProvider(BASE_CONFIG)
    await provider.send({ to: ['a@b.com', 'c@d.com'], subject: 'S', body: 'B' })

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as any).body)
    expect(body.personalizations[0].to).toEqual([
      { email: 'a@b.com' },
      { email: 'c@d.com' },
    ])
  })

  it('send() includes html content when provided', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }))

    const provider = new SendGridMailProvider(BASE_CONFIG)
    await provider.send({ to: 'r@e.com', subject: 'S', body: 'B', html: '<b>Bold</b>' })

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as any).body)
    expect(body.content).toEqual([
      { type: 'text/plain', value: 'B' },
      { type: 'text/html', value: '<b>Bold</b>' },
    ])
  })

  it('send() includes base64-encoded attachments', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }))

    const provider = new SendGridMailProvider(BASE_CONFIG)
    await provider.send({
      to: 'r@e.com',
      subject: 'S',
      body: 'B',
      attachments: ['/path/to/report.pdf'],
    })

    expect(readFileSync).toHaveBeenCalledWith('/path/to/report.pdf')
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as any).body)
    expect(body.attachments).toEqual([{
      content: Buffer.from('file-content').toString('base64'),
      filename: 'report.pdf',
      disposition: 'attachment',
    }])
  })

  it('send() omits attachments field when none provided', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 202 }))

    const provider = new SendGridMailProvider(BASE_CONFIG)
    await provider.send({ to: 'r@e.com', subject: 'S', body: 'B' })

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as any).body)
    expect(body).not.toHaveProperty('attachments')
  })

  it('verify() returns ok:true when API responds 200', async () => {
    fetchSpy.mockResolvedValue(new Response('{}', { status: 200 }))

    const provider = new SendGridMailProvider(BASE_CONFIG)
    const result = await provider.verify()

    expect(result).toEqual({ ok: true })
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.sendgrid.com/v3/scopes',
      expect.objectContaining({
        headers: { Authorization: 'Bearer SG.test-key' },
      }),
    )
  })

  it('verify() returns ok:false on API error', async () => {
    fetchSpy.mockResolvedValue(new Response('Unauthorized', { status: 401 }))

    const provider = new SendGridMailProvider(BASE_CONFIG)
    const result = await provider.verify()

    expect(result).toEqual({ ok: false, error: 'SendGrid API 401' })
  })

  it('verify() returns ok:false on fetch failure', async () => {
    fetchSpy.mockRejectedValue(new Error('DNS fail'))

    const provider = new SendGridMailProvider(BASE_CONFIG)
    const result = await provider.verify()

    expect(result).toEqual({ ok: false, error: 'DNS fail' })
  })
})

// tests/smtp-provider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MailConfig } from '../src/email/types.js'

const mockSendMail = vi.fn()
const mockVerify = vi.fn()
const mockCreateTransport = vi.fn(() => ({
  sendMail: mockSendMail,
  verify: mockVerify,
}))

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
}))

import { SmtpMailProvider } from '../src/email/smtp-provider.js'

const BASE_CONFIG: MailConfig = {
  provider: 'smtp',
  from: 'sender@example.com',
  smtp: { host: 'smtp.example.com', port: 587, user: 'user', pass: 'pass', secure: false },
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SmtpMailProvider', () => {
  it('throws when smtp config is missing', () => {
    expect(() => new SmtpMailProvider({ provider: 'smtp', from: 'a@b.com' }))
      .toThrow('SMTP config required')
  })

  it('has name "smtp"', () => {
    const provider = new SmtpMailProvider(BASE_CONFIG)
    expect(provider.name).toBe('smtp')
  })

  it('send() calls sendMail with correct params', async () => {
    mockSendMail.mockResolvedValue({ messageId: '<abc@example.com>' })
    const provider = new SmtpMailProvider(BASE_CONFIG)
    await provider.send({ to: 'recipient@example.com', subject: 'Hi', body: 'Hello' })

    expect(mockSendMail).toHaveBeenCalledWith({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Hi',
      text: 'Hello',
    })
  })

  it('send() returns success with messageId', async () => {
    mockSendMail.mockResolvedValue({ messageId: '<abc@example.com>' })
    const provider = new SmtpMailProvider(BASE_CONFIG)
    const result = await provider.send({ to: 'r@e.com', subject: 'S', body: 'B' })

    expect(result).toEqual({ success: true, messageId: '<abc@example.com>' })
  })

  it('send() returns error result on failure (does not throw)', async () => {
    mockSendMail.mockRejectedValue(new Error('Connection refused'))
    const provider = new SmtpMailProvider(BASE_CONFIG)
    const result = await provider.send({ to: 'r@e.com', subject: 'S', body: 'B' })

    expect(result).toEqual({ success: false, error: 'Connection refused' })
  })

  it('send() joins array of recipients with comma', async () => {
    mockSendMail.mockResolvedValue({ messageId: '<x>' })
    const provider = new SmtpMailProvider(BASE_CONFIG)
    await provider.send({ to: ['a@b.com', 'c@d.com'], subject: 'S', body: 'B' })

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@b.com, c@d.com' }),
    )
  })

  it('send() includes html when provided', async () => {
    mockSendMail.mockResolvedValue({ messageId: '<x>' })
    const provider = new SmtpMailProvider(BASE_CONFIG)
    await provider.send({ to: 'r@e.com', subject: 'S', body: 'B', html: '<b>Bold</b>' })

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ html: '<b>Bold</b>' }),
    )
  })

  it('send() omits html field when not provided', async () => {
    mockSendMail.mockResolvedValue({ messageId: '<x>' })
    const provider = new SmtpMailProvider(BASE_CONFIG)
    await provider.send({ to: 'r@e.com', subject: 'S', body: 'B' })

    const callArg = mockSendMail.mock.calls[0][0]
    expect(callArg).not.toHaveProperty('html')
  })

  it('verify() returns ok:true on success', async () => {
    mockVerify.mockResolvedValue(true)
    const provider = new SmtpMailProvider(BASE_CONFIG)
    const result = await provider.verify()

    expect(result).toEqual({ ok: true })
  })

  it('verify() returns ok:false with error on failure', async () => {
    mockVerify.mockRejectedValue(new Error('Auth failed'))
    const provider = new SmtpMailProvider(BASE_CONFIG)
    const result = await provider.verify()

    expect(result).toEqual({ ok: false, error: 'Auth failed' })
  })

  it('creates transporter with correct SMTP config', async () => {
    mockSendMail.mockResolvedValue({ messageId: '<x>' })
    const provider = new SmtpMailProvider(BASE_CONFIG)
    await provider.send({ to: 'r@e.com', subject: 'S', body: 'B' })

    expect(mockCreateTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'user', pass: 'pass' },
    })
  })
})

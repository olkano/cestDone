// tests/mail-factory.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MailConfig } from '../src/email/types.js'

const mockSendMail = vi.fn()
const mockVerify = vi.fn()

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: mockSendMail,
      verify: mockVerify,
    })),
  },
}))

import { createMailProvider, sendEmail } from '../src/email/index.js'
import { SmtpMailProvider } from '../src/email/smtp-provider.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createMailProvider', () => {
  it('returns SmtpMailProvider for smtp type', () => {
    const config: MailConfig = {
      provider: 'smtp',
      from: 'a@b.com',
      smtp: { host: 'h', port: 587, user: 'u', pass: 'p' },
    }
    const provider = createMailProvider(config)
    expect(provider).toBeInstanceOf(SmtpMailProvider)
    expect(provider.name).toBe('smtp')
  })

  it('throws for unknown provider type', () => {
    const config = { provider: 'unknown' as any, from: 'a@b.com' }
    expect(() => createMailProvider(config)).toThrow('Unknown mail provider: unknown')
  })
})

describe('sendEmail', () => {
  it('sends email using config from env', async () => {
    mockSendMail.mockResolvedValue({ messageId: '<test@msg>' })

    const result = await sendEmail(
      { to: 'r@e.com', subject: 'S', body: 'B' },
      {
        MAIL_PROVIDER: 'smtp',
        MAIL_FROM: 'sender@example.com',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '587',
        SMTP_USER: 'user',
        SMTP_PASS: 'pass',
      },
    )

    expect(result.success).toBe(true)
    expect(result.messageId).toBe('<test@msg>')
  })

  it('returns error result when config validation fails', async () => {
    const result = await sendEmail(
      { to: 'r@e.com', subject: 'S', body: 'B' },
      {}, // no env vars → missing MAIL_FROM, SMTP_HOST, etc.
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid mail config')
  })

  it('returns error result when send fails', async () => {
    mockSendMail.mockRejectedValue(new Error('SMTP error'))

    const result = await sendEmail(
      { to: 'r@e.com', subject: 'S', body: 'B' },
      {
        MAIL_PROVIDER: 'smtp',
        MAIL_FROM: 'sender@example.com',
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'user',
        SMTP_PASS: 'pass',
      },
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe('SMTP error')
  })
})

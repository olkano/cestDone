// tests/mail-config.test.ts
import { describe, it, expect } from 'vitest'
import { loadMailConfig, validateMailConfig } from '../src/email/config.js'

describe('loadMailConfig', () => {
  it('defaults provider to smtp when MAIL_PROVIDER not set', () => {
    const config = loadMailConfig({})
    expect(config.provider).toBe('smtp')
  })

  it('reads all SMTP env vars', () => {
    const config = loadMailConfig({
      MAIL_PROVIDER: 'smtp',
      MAIL_FROM: 'test@example.com',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '465',
      SMTP_USER: 'user@example.com',
      SMTP_PASS: 'secret',
    })
    expect(config).toEqual({
      provider: 'smtp',
      from: 'test@example.com',
      smtp: {
        host: 'smtp.example.com',
        port: 465,
        user: 'user@example.com',
        pass: 'secret',
        secure: true,
      },
    })
  })

  it('defaults SMTP_PORT to 587', () => {
    const config = loadMailConfig({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' })
    expect(config.smtp?.port).toBe(587)
  })

  it('sets secure=true when port is 465', () => {
    const config = loadMailConfig({ SMTP_PORT: '465', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' })
    expect(config.smtp?.secure).toBe(true)
  })

  it('sets secure=true when SMTP_SECURE=true', () => {
    const config = loadMailConfig({ SMTP_SECURE: 'true', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' })
    expect(config.smtp?.secure).toBe(true)
  })

  it('sets secure=false for port 587 without SMTP_SECURE', () => {
    const config = loadMailConfig({ SMTP_PORT: '587', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' })
    expect(config.smtp?.secure).toBe(false)
  })

  it('defaults from to empty string when MAIL_FROM not set', () => {
    const config = loadMailConfig({})
    expect(config.from).toBe('')
  })

  it('defaults SendGrid to sandbox mode outside Production', () => {
    const config = loadMailConfig({
      MAIL_PROVIDER: 'sendgrid',
      MAIL_FROM: 'notifier@itmplatform.com',
      SENDGRID_API_KEY: 'mail-key',
      NODE_ENV: 'development',
    })

    expect(config.sendgrid).toEqual({
      apiKey: 'mail-key',
      sandboxMode: true,
      liveSendApproved: false,
    })
  })

  it('requires an explicit approval flag for live SendGrid automation outside Production', () => {
    const config = loadMailConfig({
      MAIL_PROVIDER: 'sendgrid',
      MAIL_FROM: 'notifier@itmplatform.com',
      SENDGRID_API_KEY: 'mail-key',
      SENDGRID_SANDBOX_MODE: 'false',
    })

    expect(validateMailConfig(config).errors)
      .toContain('SENDGRID_ALLOW_LIVE_SEND=true is required when sandbox mode is disabled outside Production')
  })

  it('accepts explicitly approved live SendGrid automation', () => {
    const config = loadMailConfig({
      MAIL_PROVIDER: 'sendgrid',
      MAIL_FROM: 'notifier@itmplatform.com',
      SENDGRID_API_KEY: 'mail-key',
      SENDGRID_SANDBOX_MODE: 'false',
      SENDGRID_ALLOW_LIVE_SEND: 'true',
    })

    expect(validateMailConfig(config)).toEqual({ valid: true, errors: [] })
  })

  it('rejects an invalid SendGrid sandbox value', () => {
    expect(() => loadMailConfig({
      MAIL_PROVIDER: 'sendgrid',
      SENDGRID_API_KEY: 'mail-key',
      SENDGRID_SANDBOX_MODE: 'sometimes',
    })).toThrow('SENDGRID_SANDBOX_MODE must be true or false')
  })
})

describe('validateMailConfig', () => {
  it('returns valid when all required fields present', () => {
    const result = validateMailConfig({
      provider: 'smtp',
      from: 'test@example.com',
      smtp: { host: 'smtp.example.com', port: 587, user: 'u', pass: 'p' },
    })
    expect(result).toEqual({ valid: true, errors: [] })
  })

  it('returns error when MAIL_FROM missing', () => {
    const result = validateMailConfig({ provider: 'smtp', from: '', smtp: { host: 'h', port: 587, user: 'u', pass: 'p' } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('MAIL_FROM is required')
  })

  it('returns error when SMTP_HOST missing for smtp provider', () => {
    const result = validateMailConfig({ provider: 'smtp', from: 'a@b.com', smtp: { host: '', port: 587, user: 'u', pass: 'p' } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('SMTP_HOST is required')
  })

  it('returns error when SMTP_USER missing for smtp provider', () => {
    const result = validateMailConfig({ provider: 'smtp', from: 'a@b.com', smtp: { host: 'h', port: 587, user: '', pass: 'p' } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('SMTP_USER is required')
  })

  it('returns error when SMTP_PASS missing for smtp provider', () => {
    const result = validateMailConfig({ provider: 'smtp', from: 'a@b.com', smtp: { host: 'h', port: 587, user: 'u', pass: '' } })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('SMTP_PASS is required')
  })

  it('returns error when smtp config object missing entirely', () => {
    const result = validateMailConfig({ provider: 'smtp', from: 'a@b.com' })
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('returns multiple errors when multiple fields missing', () => {
    const result = validateMailConfig({ provider: 'smtp', from: '' })
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(2)
    expect(result.errors).toContain('MAIL_FROM is required')
  })
})

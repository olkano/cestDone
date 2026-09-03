// src/email/config.ts
import type { MailConfig, MailProviderType } from './types.js'

function parseOptionalBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  throw new Error(`${name} must be true or false`)
}

export function loadMailConfig(env: Record<string, string | undefined> = process.env): MailConfig {
  const provider = (env.MAIL_PROVIDER ?? 'smtp') as MailProviderType
  const from = env.MAIL_FROM ?? ''

  if (provider === 'smtp') {
    const host = env.SMTP_HOST ?? ''
    const port = parseInt(env.SMTP_PORT ?? '587', 10)
    const user = env.SMTP_USER ?? ''
    const pass = env.SMTP_PASS ?? ''
    const secure = env.SMTP_SECURE === 'true' || port === 465

    return { provider, from, smtp: { host, port, user, pass, secure } }
  }

  if (provider === 'sendgrid') {
    const apiKey = env.SENDGRID_API_KEY ?? ''
    const isProduction = env.NODE_ENV?.trim().toLowerCase() === 'production'
    const sandboxMode = parseOptionalBoolean(
      env.SENDGRID_SANDBOX_MODE,
      'SENDGRID_SANDBOX_MODE',
    ) ?? !isProduction
    const liveSendApproved = isProduction || (
      parseOptionalBoolean(env.SENDGRID_ALLOW_LIVE_SEND, 'SENDGRID_ALLOW_LIVE_SEND') ?? false
    )
    return { provider, from, sendgrid: { apiKey, sandboxMode, liveSendApproved } }
  }

  return { provider, from }
}

export function validateMailConfig(config: MailConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!config.from) errors.push('MAIL_FROM is required')
  if (config.provider === 'smtp') {
    if (!config.smtp?.host) errors.push('SMTP_HOST is required')
    if (!config.smtp?.user) errors.push('SMTP_USER is required')
    if (!config.smtp?.pass) errors.push('SMTP_PASS is required')
  }
  if (config.provider === 'sendgrid') {
    if (!config.sendgrid?.apiKey) errors.push('SENDGRID_API_KEY is required')
    if (config.sendgrid?.sandboxMode === false && !config.sendgrid.liveSendApproved) {
      errors.push('SENDGRID_ALLOW_LIVE_SEND=true is required when sandbox mode is disabled outside Production')
    }
  }
  return { valid: errors.length === 0, errors }
}

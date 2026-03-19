// src/email/config.ts
import type { MailConfig, MailProviderType } from './types.js'

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
  return { valid: errors.length === 0, errors }
}

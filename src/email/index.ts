// src/email/index.ts
import type { MailProvider, MailProviderType, MailConfig, MailMessage, MailResult } from './types.js'
import { SmtpMailProvider } from './smtp-provider.js'
import { loadMailConfig, validateMailConfig } from './config.js'

export { type MailProvider, type MailMessage, type MailResult, type MailConfig, type MailProviderType } from './types.js'
export { loadMailConfig, validateMailConfig } from './config.js'
export { SmtpMailProvider } from './smtp-provider.js'

export function createMailProvider(config: MailConfig): MailProvider {
  switch (config.provider) {
    case 'smtp':
      return new SmtpMailProvider(config)
    default:
      throw new Error(`Unknown mail provider: ${config.provider as string}`)
  }
}

export async function sendEmail(
  message: MailMessage,
  env?: Record<string, string | undefined>,
): Promise<MailResult> {
  const config = loadMailConfig(env)
  const validation = validateMailConfig(config)
  if (!validation.valid) {
    return { success: false, error: `Invalid mail config: ${validation.errors.join(', ')}` }
  }
  const provider = createMailProvider(config)
  return provider.send(message)
}

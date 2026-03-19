// src/email/types.ts

export type MailProviderType = 'smtp' // future: 'sendgrid' | 'ses' | ...

export interface MailMessage {
  to: string | string[]
  subject: string
  body: string
  html?: string
}

export interface MailResult {
  success: boolean
  messageId?: string
  error?: string
}

export interface MailProvider {
  send(message: MailMessage): Promise<MailResult>
  verify(): Promise<{ ok: boolean; error?: string }>
  readonly name: MailProviderType
}

export interface MailConfig {
  provider: MailProviderType
  from: string
  smtp?: {
    host: string
    port: number
    user: string
    pass: string
    secure?: boolean
  }
}

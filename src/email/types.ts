// src/email/types.ts

export type MailProviderType = 'smtp' | 'sendgrid'

export interface MailMessage {
  to: string | string[]
  subject: string
  body: string
  html?: string
  /** Absolute or CWD-relative paths of files to attach */
  attachments?: string[]
  /** Images embedded in the HTML body, referenced as cid:<cid>. Gmail strips inline SVG and data URIs, so charts travel this way. */
  inlineImages?: Array<{ path: string; cid: string }>
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
  sendgrid?: {
    apiKey: string
    sandboxMode?: boolean
    liveSendApproved?: boolean
  }
}

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { MailProvider, MailMessage, MailResult, MailConfig } from './types.js'

interface SendGridPersonalization {
  to: Array<{ email: string }>
}

interface SendGridAttachment {
  content: string
  filename: string
  disposition: string
}

interface SendGridPayload {
  personalizations: SendGridPersonalization[]
  from: { email: string }
  subject: string
  content: Array<{ type: string; value: string }>
  attachments?: SendGridAttachment[]
}

export class SendGridMailProvider implements MailProvider {
  readonly name = 'sendgrid' as const
  private apiKey: string
  private from: string

  constructor(config: MailConfig) {
    if (!config.sendgrid?.apiKey) throw new Error('SendGrid API key required for SendGridMailProvider')
    this.apiKey = config.sendgrid.apiKey
    this.from = config.from
  }

  async send(message: MailMessage): Promise<MailResult> {
    const recipients = Array.isArray(message.to) ? message.to : [message.to]

    const content: Array<{ type: string; value: string }> = [
      { type: 'text/plain', value: message.body },
    ]
    if (message.html) {
      content.push({ type: 'text/html', value: message.html })
    }

    const payload: SendGridPayload = {
      personalizations: [{ to: recipients.map((email) => ({ email })) }],
      from: { email: this.from },
      subject: message.subject,
      content,
    }

    if (message.attachments && message.attachments.length > 0) {
      payload.attachments = message.attachments.map((filePath) => ({
        content: readFileSync(filePath).toString('base64'),
        filename: basename(filePath),
        disposition: 'attachment',
      }))
    }

    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })

      if (res.status === 202) {
        const messageId = res.headers.get('x-message-id') ?? undefined
        return { success: true, messageId }
      }

      const body = await res.text()
      return { success: false, error: `SendGrid API ${res.status}: ${body}` }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async verify(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch('https://api.sendgrid.com/v3/scopes', {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      })
      if (res.ok) return { ok: true }
      return { ok: false, error: `SendGrid API ${res.status}` }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}

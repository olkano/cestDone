// src/email/smtp-provider.ts
import type { MailProvider, MailMessage, MailResult, MailConfig } from './types.js'

export class SmtpMailProvider implements MailProvider {
  readonly name = 'smtp' as const
  private config: MailConfig
  private transporter: unknown

  constructor(config: MailConfig) {
    if (!config.smtp) throw new Error('SMTP config required for SmtpMailProvider')
    this.config = config
  }

  async send(message: MailMessage): Promise<MailResult> {
    const transporter = await this.getTransporter()
    try {
      const info = await (transporter as any).sendMail({
        from: this.config.from,
        to: Array.isArray(message.to) ? message.to.join(', ') : message.to,
        subject: message.subject,
        text: message.body,
        ...(message.html ? { html: message.html } : {}),
      })
      return { success: true, messageId: info.messageId }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async verify(): Promise<{ ok: boolean; error?: string }> {
    const transporter = await this.getTransporter()
    try {
      await (transporter as any).verify()
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async getTransporter(): Promise<unknown> {
    if (!this.transporter) {
      const nodemailer = await import('nodemailer')
      const smtp = this.config.smtp!
      this.transporter = nodemailer.default.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure ?? false,
        auth: { user: smtp.user, pass: smtp.pass },
      })
    }
    return this.transporter
  }
}

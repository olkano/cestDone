// tests/cli-send-email.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const mockSendEmail = vi.fn()

vi.mock('../src/email/index.js', () => ({
  sendEmail: mockSendEmail,
}))

import { handleSendEmail } from '../src/cli/index.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('handleSendEmail', () => {
  it('calls sendEmail with correct options', async () => {
    mockSendEmail.mockResolvedValue({ success: true, messageId: '<abc>' })

    await handleSendEmail({ to: 'r@e.com', subject: 'Hi', body: 'Hello' })

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'r@e.com', subject: 'Hi', body: 'Hello' }),
    )
  })

  it('sends one message to every address of a comma-separated --to', async () => {
    mockSendEmail.mockResolvedValue({ success: true, messageId: '<abc>' })

    await handleSendEmail({ to: 'a@e.com, b@e.com,c@e.com', subject: 'Hi', body: 'Hello' })

    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['a@e.com', 'b@e.com', 'c@e.com'] }),
    )
  })

  it('rejects a --to with an empty or malformed address before sending', async () => {
    await expect(handleSendEmail({ to: 'a@e.com,,b@e.com', subject: 'Hi', body: 'x' })).rejects.toThrow(/recipient/i)
    await expect(handleSendEmail({ to: 'a@e.com, not-an-address', subject: 'Hi', body: 'x' })).rejects.toThrow(/not-an-address/)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('renders the markdown body to an HTML alternative by default', async () => {
    mockSendEmail.mockResolvedValue({ success: true, messageId: '<abc>' })

    await handleSendEmail({ to: 'r@e.com', subject: 'Hi', body: '## Hola\n\nun **informe**' })

    const call = mockSendEmail.mock.calls[0][0]
    expect(call.body).toBe('## Hola\n\nun **informe**')
    expect(call.html).toContain('<h2')
    expect(call.html).toContain('<strong>informe</strong>')
  })

  it('does not render HTML when markdown is disabled', async () => {
    mockSendEmail.mockResolvedValue({ success: true, messageId: '<abc>' })

    await handleSendEmail({ to: 'r@e.com', subject: 'Hi', body: '**raw**', markdown: false })

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ html: undefined }),
    )
  })

  it('reads the HTML body from --html-file and embeds --inline images under their file name', async () => {
    mockSendEmail.mockResolvedValue({ success: true, messageId: '<abc>' })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-mail-'))
    const htmlFile = path.join(dir, 'report.html')
    const png = path.join(dir, 'chart-1.png')
    fs.writeFileSync(htmlFile, '<p>Hola <img src="cid:chart-1.png"></p>')
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await handleSendEmail({ to: 'r@e.com', subject: 'Hi', body: 'Resumen', htmlFile, inline: [png] })
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Resumen',
        html: '<p>Hola <img src="cid:chart-1.png"></p>',
        inlineImages: [{ path: png, cid: 'chart-1.png' }],
      }),
    )
  })

  it('rejects --html together with --html-file, and a missing inline image', async () => {
    await expect(handleSendEmail({ to: 'r@e.com', subject: 'Hi', body: 'B', html: '<b></b>', htmlFile: 'x.html' }))
      .rejects.toThrow('at most one of --html or --html-file')
    await expect(handleSendEmail({ to: 'r@e.com', subject: 'Hi', body: 'B', inline: ['/nope/chart.png'] }))
      .rejects.toThrow('Attachment file(s) not found')
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('passes html option when provided', async () => {
    mockSendEmail.mockResolvedValue({ success: true, messageId: '<abc>' })

    await handleSendEmail({ to: 'r@e.com', subject: 'Hi', body: 'Hello', html: '<b>Hi</b>' })

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ html: '<b>Hi</b>' }),
    )
  })

  it('throws on send failure', async () => {
    mockSendEmail.mockResolvedValue({ success: false, error: 'Connection refused' })

    await expect(handleSendEmail({ to: 'r@e.com', subject: 'Hi', body: 'Hello' }))
      .rejects.toThrow('Connection refused')
  })

  it('resolves on success', async () => {
    mockSendEmail.mockResolvedValue({ success: true, messageId: '<msg-id>' })

    await expect(handleSendEmail({ to: 'r@e.com', subject: 'S', body: 'B' }))
      .resolves.toBeUndefined()
  })

  it('passes attachments when the files exist', async () => {
    mockSendEmail.mockResolvedValue({ success: true, messageId: '<abc>' })
    const tmp = path.join(os.tmpdir(), `cestdone-attach-test-${Date.now()}.txt`)
    fs.writeFileSync(tmp, 'attachment content')

    try {
      await handleSendEmail({ to: 'r@e.com', subject: 'Hi', body: 'B', attach: [tmp] })
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ attachments: [tmp] }),
      )
    } finally {
      fs.unlinkSync(tmp)
    }
  })

  it('omits the attachments field when --attach is not used', async () => {
    mockSendEmail.mockResolvedValue({ success: true, messageId: '<abc>' })

    await handleSendEmail({ to: 'r@e.com', subject: 'Hi', body: 'B', attach: [] })

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.not.objectContaining({ attachments: expect.anything() }),
    )
  })

  it('reads the body from a file when bodyFile is given', async () => {
    mockSendEmail.mockResolvedValue({ success: true, messageId: '<abc>' })
    const tmp = path.join(os.tmpdir(), `cestdone-bodyfile-test-${Date.now()}.md`)
    fs.writeFileSync(tmp, '## Informe\n\nContenido **completo**', 'utf-8')

    try {
      await handleSendEmail({ to: 'r@e.com', subject: 'Hi', bodyFile: tmp })
      const call = mockSendEmail.mock.calls[0][0]
      expect(call.body).toBe('## Informe\n\nContenido **completo**')
      expect(call.html).toContain('<strong>completo</strong>')
    } finally {
      fs.unlinkSync(tmp)
    }
  })

  it('throws when both body and bodyFile are given', async () => {
    await expect(handleSendEmail({ to: 'r@e.com', subject: 'Hi', body: 'x', bodyFile: 'y.md' }))
      .rejects.toThrow('either --body or --body-file')
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('throws when neither body nor bodyFile is given', async () => {
    await expect(handleSendEmail({ to: 'r@e.com', subject: 'Hi' }))
      .rejects.toThrow('either --body or --body-file')
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('throws when the bodyFile does not exist', async () => {
    const missing = path.join(os.tmpdir(), 'cestdone-missing-body.md')
    await expect(handleSendEmail({ to: 'r@e.com', subject: 'Hi', bodyFile: missing }))
      .rejects.toThrow('Body file not found')
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('throws and sends nothing when an attachment file is missing', async () => {
    const missing = path.join(os.tmpdir(), 'cestdone-definitely-missing.xlsx')

    await expect(handleSendEmail({ to: 'r@e.com', subject: 'Hi', body: 'B', attach: [missing] }))
      .rejects.toThrow('Attachment file(s) not found')
    expect(mockSendEmail).not.toHaveBeenCalled()
  })
})

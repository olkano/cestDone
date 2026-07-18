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

    expect(mockSendEmail).toHaveBeenCalledWith({
      to: 'r@e.com',
      subject: 'Hi',
      body: 'Hello',
      html: undefined,
    })
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

  it('throws and sends nothing when an attachment file is missing', async () => {
    const missing = path.join(os.tmpdir(), 'cestdone-definitely-missing.xlsx')

    await expect(handleSendEmail({ to: 'r@e.com', subject: 'Hi', body: 'B', attach: [missing] }))
      .rejects.toThrow('Attachment file(s) not found')
    expect(mockSendEmail).not.toHaveBeenCalled()
  })
})

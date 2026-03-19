// tests/cli-send-email.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
})

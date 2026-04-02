// tests/daemon-notifications.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from '../src/daemon/job-queue.js'
import type { DaemonConfig } from '../src/daemon/types.js'
import type { DaemonLogger } from '../src/daemon/daemon-logger.js'

vi.mock('../src/email/index.js', () => ({
  sendEmail: vi.fn().mockResolvedValue({ success: true, messageId: '<test@msg>' }),
}))

import { notifyJobFailure } from '../src/daemon/notifications.js'
import { sendEmail } from '../src/email/index.js'

function makeJob(overrides?: Partial<Job>): Job {
  return {
    id: 'test-job-id',
    trigger: 'nightly-blog',
    specPath: 'specs/blog-update.md',
    options: { target: '/repos/blog' },
    status: 'failed',
    createdAt: new Date('2026-04-01T02:00:00Z'),
    startedAt: new Date('2026-04-01T02:00:01Z'),
    completedAt: new Date('2026-04-01T02:05:00Z'),
    error: 'git push timed out',
    maxRetries: 2,
    retryDelayMs: 60000,
    attempt: 1,
    ...overrides,
  }
}

function makeLogger(): DaemonLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    jobStart: vi.fn(),
    jobEnd: vi.fn(),
    logDir: '.cestdone/test-daemon',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(sendEmail).mockResolvedValue({ success: true, messageId: '<test@msg>' })
})

describe('notifyJobFailure', () => {
  // NF-1
  it('does nothing when notifications.email is not configured', async () => {
    const config: DaemonConfig = {}
    await notifyJobFailure(makeJob(), 'some error', config, makeLogger())
    expect(sendEmail).not.toHaveBeenCalled()
  })

  // NF-2
  it('sends email when notifications.email is configured', async () => {
    const config: DaemonConfig = {
      notifications: { email: { recipients: 'user@example.com' } },
    }
    await notifyJobFailure(makeJob(), 'git push timed out', config, makeLogger())
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  // NF-3
  it('email subject contains trigger name and failed', async () => {
    const config: DaemonConfig = {
      notifications: { email: { recipients: 'user@example.com' } },
    }
    await notifyJobFailure(makeJob(), 'error', config, makeLogger())
    const call = vi.mocked(sendEmail).mock.calls[0][0]
    expect(call.subject).toContain('nightly-blog')
    expect(call.subject).toContain('failed')
  })

  // NF-4
  it('email body contains job details and attempt count', async () => {
    const config: DaemonConfig = {
      notifications: { email: { recipients: 'user@example.com' } },
    }
    await notifyJobFailure(makeJob(), 'git push timed out', config, makeLogger())
    const call = vi.mocked(sendEmail).mock.calls[0][0]
    expect(call.body).toContain('nightly-blog')
    expect(call.body).toContain('specs/blog-update.md')
    expect(call.body).toContain('git push timed out')
    // Total attempts = maxRetries + 1 = 3
    expect(call.body).toContain('3')
  })

  // NF-5
  it('sends to array of recipients', async () => {
    const config: DaemonConfig = {
      notifications: { email: { recipients: ['a@b.com', 'c@d.com'] } },
    }
    await notifyJobFailure(makeJob(), 'error', config, makeLogger())
    const call = vi.mocked(sendEmail).mock.calls[0][0]
    expect(call.to).toEqual(['a@b.com', 'c@d.com'])
  })

  // NF-6
  it('never throws even if sendEmail returns failure', async () => {
    vi.mocked(sendEmail).mockResolvedValueOnce({ success: false, error: 'SMTP down' })
    const config: DaemonConfig = {
      notifications: { email: { recipients: 'user@example.com' } },
    }
    const logger = makeLogger()
    await expect(
      notifyJobFailure(makeJob(), 'error', config, logger),
    ).resolves.not.toThrow()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('SMTP down'))
  })

  // NF-7
  it('never throws even if sendEmail throws unexpectedly', async () => {
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error('unexpected crash'))
    const config: DaemonConfig = {
      notifications: { email: { recipients: 'user@example.com' } },
    }
    const logger = makeLogger()
    await expect(
      notifyJobFailure(makeJob(), 'error', config, logger),
    ).resolves.not.toThrow()
    expect(logger.warn).toHaveBeenCalled()
  })

  // NF-8
  it('logs success when email is sent', async () => {
    const config: DaemonConfig = {
      notifications: { email: { recipients: 'user@example.com' } },
    }
    const logger = makeLogger()
    await notifyJobFailure(makeJob(), 'error', config, logger)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('notification'))
  })

  // NF-9
  it('email body includes target repo path from job options', async () => {
    const config: DaemonConfig = {
      notifications: { email: { recipients: 'user@example.com' } },
    }
    const job = makeJob({ options: { target: '/repos/my-blog' } })
    await notifyJobFailure(job, 'error', config, makeLogger())
    const call = vi.mocked(sendEmail).mock.calls[0][0]
    expect(call.body).toContain('/repos/my-blog')
  })
})

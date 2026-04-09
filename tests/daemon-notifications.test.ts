// tests/daemon-notifications.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
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

  // NF-10
  it('email body includes last phase report when run dir exists', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-test-'))
    const runDir = path.join(tmpDir, '.cestdone', 'blog-update_2026-04-01_020000')
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(path.join(runDir, 'phase-3-report.md'), '# Phase 3\n\nStatus: failed\n\nBLOCKER: git push timed out')
    fs.writeFileSync(path.join(runDir, 'blog-update_2026-04-01_020000.log'), 'log content')

    const config: DaemonConfig = {
      notifications: { email: { recipients: 'user@example.com' } },
    }
    const job = makeJob({ specPath: 'specs/blog-update.md', options: { target: tmpDir } })
    await notifyJobFailure(job, 'error', config, makeLogger(), tmpDir)
    const call = vi.mocked(sendEmail).mock.calls[0][0]
    expect(call.body).toContain('BLOCKER: git push timed out')
    expect(call.body).toContain('Last Phase Report')
    expect(call.body).toContain('.log')

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // NF-11
  it('picks the latest run dir when multiple exist', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-test-'))
    const oldDir = path.join(tmpDir, '.cestdone', 'blog-update_2026-03-01_010000')
    const newDir = path.join(tmpDir, '.cestdone', 'blog-update_2026-04-01_020000')
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(newDir, { recursive: true })
    fs.writeFileSync(path.join(oldDir, 'phase-1-report.md'), 'old report')
    fs.writeFileSync(path.join(newDir, 'phase-2-report.md'), 'latest report content')

    const config: DaemonConfig = {
      notifications: { email: { recipients: 'user@example.com' } },
    }
    const job = makeJob({ specPath: 'specs/blog-update.md', options: { target: tmpDir } })
    await notifyJobFailure(job, 'error', config, makeLogger(), tmpDir)
    const call = vi.mocked(sendEmail).mock.calls[0][0]
    expect(call.body).toContain('latest report content')
    expect(call.body).not.toContain('old report')

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // NF-12
  it('picks the highest phase report in the run dir', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-test-'))
    const runDir = path.join(tmpDir, '.cestdone', 'blog-update_2026-04-01_020000')
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(path.join(runDir, 'phase-1-report.md'), 'phase 1 done')
    fs.writeFileSync(path.join(runDir, 'phase-5-report.md'), 'phase 5 blocker info')

    const config: DaemonConfig = {
      notifications: { email: { recipients: 'user@example.com' } },
    }
    const job = makeJob({ specPath: 'specs/blog-update.md', options: { target: tmpDir } })
    await notifyJobFailure(job, 'error', config, makeLogger(), tmpDir)
    const call = vi.mocked(sendEmail).mock.calls[0][0]
    expect(call.body).toContain('phase 5 blocker info')
    expect(call.body).not.toContain('phase 1 done')

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // NF-13
  it('gracefully handles missing run dir', async () => {
    const config: DaemonConfig = {
      notifications: { email: { recipients: 'user@example.com' } },
    }
    await notifyJobFailure(makeJob(), 'error', config, makeLogger(), '/nonexistent/path')
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const call = vi.mocked(sendEmail).mock.calls[0][0]
    expect(call.body).not.toContain('Last Phase Report')
  })

  // NF-14
  it('uses targetRepoPath fallback when job options has no target', async () => {
    const config: DaemonConfig = {
      notifications: { email: { recipients: 'user@example.com' } },
    }
    const job = makeJob({ options: {} })
    await notifyJobFailure(job, 'error', config, makeLogger(), '/fallback/repo')
    const call = vi.mocked(sendEmail).mock.calls[0][0]
    expect(call.body).toContain('/fallback/repo')
  })
})

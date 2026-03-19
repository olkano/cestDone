// tests/daemon-logger.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createDaemonLogger } from '../src/daemon/daemon-logger.js'
import type { Job } from '../src/daemon/job-queue.js'

vi.mock('node:fs')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fs.mkdirSync).mockReturnValue(undefined as unknown as string)
  vi.mocked(fs.appendFileSync).mockReturnValue(undefined)
})

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'test-job-123',
    trigger: 'schedule',
    specPath: '/specs/feature.md',
    options: {},
    status: 'running',
    createdAt: new Date(),
    ...overrides,
  }
}

describe('createDaemonLogger', () => {
  it('info writes timestamped [INFO] line to daemon.log', () => {
    const logger = createDaemonLogger('/tmp/logs')

    logger.info('Daemon started')

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      path.join('/tmp/logs', 'daemon.log'),
      expect.stringMatching(/^\[\d{4}-\d{2}-\d{2}T.+Z\] \[INFO\] Daemon started\n$/),
      'utf-8'
    )
  })

  it('error writes with [ERROR] prefix', () => {
    const logger = createDaemonLogger('/tmp/logs')

    logger.error('Something broke')

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      path.join('/tmp/logs', 'daemon.log'),
      expect.stringMatching(/\[ERROR\] Something broke\n$/),
      'utf-8'
    )
  })

  it('warn writes with [WARN] prefix', () => {
    const logger = createDaemonLogger('/tmp/logs')

    logger.warn('Low disk space')

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      path.join('/tmp/logs', 'daemon.log'),
      expect.stringMatching(/\[WARN\] Low disk space\n$/),
      'utf-8'
    )
  })

  it('jobStart writes job start entry to daemon.log', () => {
    const logger = createDaemonLogger('/tmp/logs')
    const job = makeJob({ id: 'abc-123', trigger: 'cron', specPath: '/specs/deploy.md' })

    logger.jobStart(job)

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      path.join('/tmp/logs', 'daemon.log'),
      expect.stringContaining('[INFO] Job abc-123 started: trigger=cron, spec=/specs/deploy.md'),
      'utf-8'
    )
  })

  it('jobEnd writes completion entry', () => {
    const logger = createDaemonLogger('/tmp/logs')
    const job = makeJob({ id: 'abc-123' })

    logger.jobEnd(job)

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      path.join('/tmp/logs', 'daemon.log'),
      expect.stringContaining('[INFO] Job abc-123 completed'),
      'utf-8'
    )
  })

  it('jobEnd with error writes error details', () => {
    const logger = createDaemonLogger('/tmp/logs')
    const job = makeJob({ id: 'abc-123' })

    logger.jobEnd(job, new Error('Coder crashed'))

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      path.join('/tmp/logs', 'daemon.log'),
      expect.stringContaining('[ERROR] Job abc-123 failed: Coder crashed'),
      'utf-8'
    )
  })
})

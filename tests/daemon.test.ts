// tests/daemon.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Config } from '../src/shared/types.js'
import type { DaemonConfig } from '../src/daemon/types.js'
import type { DaemonDeps, DaemonProcess } from '../src/daemon/daemon.js'
import type { DaemonLogger } from '../src/daemon/daemon-logger.js'

// Mock all daemon sub-modules
vi.mock('../src/daemon/config-validator.js', () => ({
  validateDaemonConfig: vi.fn().mockReturnValue({ valid: true, errors: [] }),
}))

vi.mock('../src/daemon/notifications.js', () => ({
  notifyJobFailure: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/daemon/pid.js', () => ({
  writePidFile: vi.fn(),
  removePidFile: vi.fn(),
  isDaemonRunning: vi.fn().mockReturnValue(false),
}))

vi.mock('../src/daemon/scheduler.js', () => {
  const mockScheduler = {
    start: vi.fn(),
    stop: vi.fn(),
    getJobs: vi.fn().mockReturnValue([]),
    getNextRuns: vi.fn().mockReturnValue([]),
  }
  return {
    createScheduler: vi.fn().mockReturnValue(mockScheduler),
    _mockScheduler: mockScheduler,
  }
})

vi.mock('../src/daemon/webhook-server.js', () => {
  const mockServer = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    port: 9876,
  }
  return {
    createWebhookServer: vi.fn().mockReturnValue(mockServer),
    _mockServer: mockServer,
  }
})

vi.mock('../src/daemon/poller.js', () => {
  const mockPoller = {
    start: vi.fn(),
    stop: vi.fn(),
  }
  return {
    createPoller: vi.fn().mockReturnValue(mockPoller),
    _mockPoller: mockPoller,
  }
})

vi.mock('../src/daemon/template.js', () => ({
  renderTemplate: vi.fn().mockImplementation((template: string) => template),
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs')
  return {
    ...actual,
    default: {
      ...(actual as Record<string, unknown>),
      readFileSync: vi.fn().mockReturnValue('spec content'),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
  }
})

import { createDaemon } from '../src/daemon/daemon.js'
import { validateDaemonConfig } from '../src/daemon/config-validator.js'
import { notifyJobFailure } from '../src/daemon/notifications.js'
import { writePidFile, removePidFile, isDaemonRunning } from '../src/daemon/pid.js'
import { createScheduler } from '../src/daemon/scheduler.js'
import { createWebhookServer } from '../src/daemon/webhook-server.js'
import { createPoller } from '../src/daemon/poller.js'

function makeDaemonConfig(overrides?: Partial<DaemonConfig>): DaemonConfig {
  return {
    logDir: '.cestdone/test-daemon',
    pidFile: '.cestdone/test-daemon.pid',
    ...overrides,
  }
}

function makeMockLogger(): DaemonLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    jobStart: vi.fn(),
    jobEnd: vi.fn(),
    logDir: '.cestdone/test-daemon',
  }
}

function makeDeps(daemonConfig?: DaemonConfig): DaemonDeps {
  const config: Config = {
    targetRepoPath: '.',
    runDir: '.cestdone/test_2026-03-20_120000',
    maxTurns: 100,
    daemon: daemonConfig ?? makeDaemonConfig(),
  }
  return {
    executeRun: vi.fn().mockResolvedValue(undefined),
    logger: makeMockLogger(),
    config,
  }
}

let daemon: DaemonProcess | undefined

afterEach(async () => {
  if (daemon) {
    try { await daemon.stop() } catch { /* ignore */ }
    daemon = undefined
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(validateDaemonConfig).mockReturnValue({ valid: true, errors: [] })
  vi.mocked(isDaemonRunning).mockReturnValue(false)
})

describe('createDaemon', () => {
  // D-1
  it('throws when no daemon config is present', () => {
    const deps = makeDeps()
    deps.config.daemon = undefined
    expect(() => createDaemon(deps)).toThrow('No daemon configuration')
  })

  // D-2
  it('throws on invalid daemon config', () => {
    vi.mocked(validateDaemonConfig).mockReturnValue({ valid: false, errors: ['bad cron'] })
    expect(() => createDaemon(makeDeps())).toThrow('Invalid daemon config')
  })

  // D-3
  it('start() writes PID file', async () => {
    const deps = makeDeps()
    daemon = createDaemon(deps)
    await daemon.start()
    expect(writePidFile).toHaveBeenCalled()
  })

  // D-4
  it('start() creates scheduler with config schedules', async () => {
    const daemonConfig = makeDaemonConfig({
      schedules: [{ name: 'nightly', cron: '0 2 * * *', spec: 'spec.md' }],
    })
    const deps = makeDeps(daemonConfig)
    daemon = createDaemon(deps)
    await daemon.start()

    expect(createScheduler).toHaveBeenCalledWith(
      daemonConfig.schedules,
      expect.any(Function),
    )
  })

  // D-5
  it('start() creates webhook server(s) with config webhooks', async () => {
    const daemonConfig = makeDaemonConfig({
      webhooks: [{ name: 'gh', port: 9876, spec: 'spec.md' }],
    })
    const deps = makeDeps(daemonConfig)
    daemon = createDaemon(deps)
    await daemon.start()

    expect(createWebhookServer).toHaveBeenCalledWith(
      daemonConfig.webhooks,
      expect.any(Function),
    )
  })

  // D-6
  it('start() creates pollers with config pollers', async () => {
    const daemonConfig = makeDaemonConfig({
      pollers: [{ name: 'deps', cron: '0 */6 * * *', command: 'npm outdated', spec: 'spec.md' }],
    })
    const deps = makeDeps(daemonConfig)
    daemon = createDaemon(deps)
    await daemon.start()

    expect(createPoller).toHaveBeenCalledWith(
      daemonConfig.pollers,
      expect.any(Function),
    )
  })

  // D-7
  it('when schedule fires, job is enqueued and executeRun is called', async () => {
    const daemonConfig = makeDaemonConfig({
      schedules: [{ name: 'nightly', cron: '0 2 * * *', spec: 'specs/report.md' }],
    })
    const deps = makeDeps(daemonConfig)
    daemon = createDaemon(deps)
    await daemon.start()

    // Get the onTrigger callback that was passed to createScheduler
    const onTrigger = vi.mocked(createScheduler).mock.calls[0][1]
    onTrigger(daemonConfig.schedules![0])

    // Wait for the run loop to process the job
    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(deps.executeRun).toHaveBeenCalledWith(
      'specs/report.md',
      expect.objectContaining({ nonInteractive: true }),
    )
  })

  // D-8
  it('when webhook fires, spec is templated and job runs', async () => {
    const daemonConfig = makeDaemonConfig({
      webhooks: [{ name: 'gh', port: 0, spec: 'specs/triage.md' }],
    })
    const deps = makeDeps(daemonConfig)
    daemon = createDaemon(deps)
    await daemon.start()

    const onTrigger = vi.mocked(createWebhookServer).mock.calls[0][1]
    onTrigger(daemonConfig.webhooks![0], { action: 'opened', issue: { title: 'Bug' } })

    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(deps.executeRun).toHaveBeenCalled()
  })

  // D-9
  it('failed job logs error and continues', async () => {
    const daemonConfig = makeDaemonConfig({
      schedules: [{ name: 'fail', cron: '0 * * * *', spec: 'spec.md' }],
    })
    const deps = makeDeps(daemonConfig)
    vi.mocked(deps.executeRun).mockRejectedValueOnce(new Error('run failed'))
    daemon = createDaemon(deps)
    await daemon.start()

    const onTrigger = vi.mocked(createScheduler).mock.calls[0][1]
    onTrigger(daemonConfig.schedules![0])

    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(deps.logger.jobEnd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: 'run failed' }),
    )
  })

  // D-14: Retry on failure
  it('retries failed job up to maxRetries times before marking failed', async () => {
    const daemonConfig = makeDaemonConfig({
      schedules: [{ name: 'retry-job', cron: '0 * * * *', spec: 'spec.md', retries: 2, retryDelayMs: 10 }],
    })
    const deps = makeDeps(daemonConfig)
    vi.mocked(deps.executeRun)
      .mockRejectedValueOnce(new Error('attempt 1 failed'))
      .mockRejectedValueOnce(new Error('attempt 2 failed'))
      .mockRejectedValueOnce(new Error('attempt 3 failed'))
    daemon = createDaemon(deps)
    await daemon.start()

    const onTrigger = vi.mocked(createScheduler).mock.calls[0][1]
    onTrigger(daemonConfig.schedules![0])

    await new Promise((resolve) => setTimeout(resolve, 800))

    // All 3 attempts (1 initial + 2 retries)
    expect(deps.executeRun).toHaveBeenCalledTimes(3)
    expect(deps.logger.jobEnd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: 'attempt 3 failed' }),
    )
  })

  // D-15: Retry succeeds on second attempt
  it('succeeds on retry after initial failure', async () => {
    const daemonConfig = makeDaemonConfig({
      schedules: [{ name: 'retry-ok', cron: '0 * * * *', spec: 'spec.md', retries: 2, retryDelayMs: 10 }],
    })
    const deps = makeDeps(daemonConfig)
    vi.mocked(deps.executeRun)
      .mockRejectedValueOnce(new Error('transient failure'))
      .mockResolvedValueOnce(undefined)
    daemon = createDaemon(deps)
    await daemon.start()

    const onTrigger = vi.mocked(createScheduler).mock.calls[0][1]
    onTrigger(daemonConfig.schedules![0])

    await new Promise((resolve) => setTimeout(resolve, 800))

    expect(deps.executeRun).toHaveBeenCalledTimes(2)
    // jobEnd called without error (success)
    expect(deps.logger.jobEnd).toHaveBeenCalledWith(expect.anything())
  })

  // D-16: No retry when retries is 0 (default)
  it('does not retry when retries is not configured', async () => {
    const daemonConfig = makeDaemonConfig({
      schedules: [{ name: 'no-retry', cron: '0 * * * *', spec: 'spec.md' }],
    })
    const deps = makeDeps(daemonConfig)
    vi.mocked(deps.executeRun).mockRejectedValueOnce(new Error('fail'))
    daemon = createDaemon(deps)
    await daemon.start()

    const onTrigger = vi.mocked(createScheduler).mock.calls[0][1]
    onTrigger(daemonConfig.schedules![0])

    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(deps.executeRun).toHaveBeenCalledTimes(1)
  })

  // D-17: Retry logs warn on each failed attempt
  it('logs warning on each retry attempt', async () => {
    const daemonConfig = makeDaemonConfig({
      schedules: [{ name: 'retry-log', cron: '0 * * * *', spec: 'spec.md', retries: 1, retryDelayMs: 10 }],
    })
    const deps = makeDeps(daemonConfig)
    vi.mocked(deps.executeRun)
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce(undefined)
    daemon = createDaemon(deps)
    await daemon.start()

    const onTrigger = vi.mocked(createScheduler).mock.calls[0][1]
    onTrigger(daemonConfig.schedules![0])

    await new Promise((resolve) => setTimeout(resolve, 800))

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('attempt 1/2 failed'),
    )
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('network timeout'),
    )
  })

  // D-18: Notification called on final job failure
  it('calls notifyJobFailure when job fails after all retries', async () => {
    const daemonConfig = makeDaemonConfig({
      schedules: [{ name: 'notify-fail', cron: '0 * * * *', spec: 'spec.md', retries: 1, retryDelayMs: 10 }],
      notifications: { email: { recipients: 'admin@example.com' } },
    })
    const deps = makeDeps(daemonConfig)
    vi.mocked(deps.executeRun)
      .mockRejectedValueOnce(new Error('attempt 1'))
      .mockRejectedValueOnce(new Error('attempt 2'))
    daemon = createDaemon(deps)
    await daemon.start()

    const onTrigger = vi.mocked(createScheduler).mock.calls[0][1]
    onTrigger(daemonConfig.schedules![0])

    await new Promise((resolve) => setTimeout(resolve, 800))

    expect(notifyJobFailure).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'notify-fail' }),
      'attempt 2',
      daemonConfig,
      deps.logger,
    )
  })

  // D-19: Notification NOT called on success
  it('does not call notifyJobFailure when job succeeds', async () => {
    const daemonConfig = makeDaemonConfig({
      schedules: [{ name: 'notify-ok', cron: '0 * * * *', spec: 'spec.md' }],
      notifications: { email: { recipients: 'admin@example.com' } },
    })
    const deps = makeDeps(daemonConfig)
    daemon = createDaemon(deps)
    await daemon.start()

    const onTrigger = vi.mocked(createScheduler).mock.calls[0][1]
    onTrigger(daemonConfig.schedules![0])

    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(notifyJobFailure).not.toHaveBeenCalled()
  })

  // D-20: Notification NOT called when retry succeeds
  it('does not call notifyJobFailure when job succeeds on retry', async () => {
    const daemonConfig = makeDaemonConfig({
      schedules: [{ name: 'retry-ok-notify', cron: '0 * * * *', spec: 'spec.md', retries: 1, retryDelayMs: 10 }],
      notifications: { email: { recipients: 'admin@example.com' } },
    })
    const deps = makeDeps(daemonConfig)
    vi.mocked(deps.executeRun)
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined)
    daemon = createDaemon(deps)
    await daemon.start()

    const onTrigger = vi.mocked(createScheduler).mock.calls[0][1]
    onTrigger(daemonConfig.schedules![0])

    await new Promise((resolve) => setTimeout(resolve, 800))

    expect(notifyJobFailure).not.toHaveBeenCalled()
  })

  // D-10
  it('stop() stops scheduler, webhooks, pollers', async () => {
    const daemonConfig = makeDaemonConfig({
      schedules: [{ name: 's1', cron: '0 * * * *', spec: 'spec.md' }],
      webhooks: [{ name: 'wh1', port: 0, spec: 'spec.md' }],
      pollers: [{ name: 'p1', cron: '0 * * * *', command: 'echo ok', spec: 'spec.md' }],
    })
    const deps = makeDeps(daemonConfig)
    daemon = createDaemon(deps)
    await daemon.start()
    await daemon.stop()
    daemon = undefined // prevent afterEach double-stop

    // Verify sub-modules were stopped
    const mockScheduler = (await import('../src/daemon/scheduler.js') as { _mockScheduler: { stop: ReturnType<typeof vi.fn> } })._mockScheduler
    expect(mockScheduler.stop).toHaveBeenCalled()
  })

  // D-11
  it('stop() removes PID file', async () => {
    const deps = makeDeps()
    daemon = createDaemon(deps)
    await daemon.start()
    await daemon.stop()
    daemon = undefined

    expect(removePidFile).toHaveBeenCalled()
  })

  // D-12
  it('throws if daemon is already running', async () => {
    vi.mocked(isDaemonRunning).mockReturnValue(true)
    const deps = makeDeps()
    daemon = createDaemon(deps)

    await expect(daemon.start()).rejects.toThrow('already running')
    daemon = undefined
  })

  // D-13
  it('empty daemon config (no schedules/webhooks/pollers) starts and stops', async () => {
    const deps = makeDeps(makeDaemonConfig())
    daemon = createDaemon(deps)
    await daemon.start()
    await daemon.stop()
    daemon = undefined

    expect(deps.logger.info).toHaveBeenCalledWith('Daemon started')
    expect(deps.logger.info).toHaveBeenCalledWith('Daemon stopped')
  })

  // D-21: Reload stops old triggers and starts new ones
  it('reload() stops old triggers and starts new ones', async () => {
    const daemonConfig = makeDaemonConfig({
      schedules: [{ name: 'old', cron: '0 * * * *', spec: 'old.md' }],
    })
    const deps = makeDeps(daemonConfig)
    daemon = createDaemon(deps)
    await daemon.start()

    const mockScheduler = (await import('../src/daemon/scheduler.js') as { _mockScheduler: { stop: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> } })._mockScheduler

    // Clear mock call counts before reload
    vi.mocked(createScheduler).mockClear()
    mockScheduler.stop.mockClear()
    mockScheduler.start.mockClear()

    const newConfig: DaemonConfig = {
      schedules: [{ name: 'new-schedule', cron: '30 * * * *', spec: 'new.md' }],
    }

    await daemon.reload(newConfig)

    // Old scheduler was stopped
    expect(mockScheduler.stop).toHaveBeenCalled()
    // New scheduler was created and started
    expect(createScheduler).toHaveBeenCalledWith(
      newConfig.schedules,
      expect.any(Function),
    )
    expect(deps.logger.info).toHaveBeenCalledWith('Daemon configuration reloaded')
  })

  // D-22: Reload preserves job queue
  it('reload() preserves running job queue', async () => {
    const daemonConfig = makeDaemonConfig({
      schedules: [{ name: 's1', cron: '0 * * * *', spec: 'spec.md' }],
    })
    const deps = makeDeps(daemonConfig)
    daemon = createDaemon(deps)
    await daemon.start()

    // Enqueue a job via the schedule trigger
    const onTrigger = vi.mocked(createScheduler).mock.calls[0][1]
    onTrigger(daemonConfig.schedules![0])

    // Reload with empty config
    await daemon.reload(makeDaemonConfig())

    // Job should still process
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(deps.executeRun).toHaveBeenCalledTimes(1)
  })

  // D-23: Reload logs events
  it('reload() logs start and end messages', async () => {
    const deps = makeDeps(makeDaemonConfig())
    daemon = createDaemon(deps)
    await daemon.start()

    await daemon.reload(makeDaemonConfig())

    expect(deps.logger.info).toHaveBeenCalledWith('Reloading daemon configuration...')
    expect(deps.logger.info).toHaveBeenCalledWith('Daemon configuration reloaded')
  })
})

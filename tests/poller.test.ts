// tests/poller.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PollingConfig } from '../src/daemon/types.js'

// Mock croner to capture callbacks
const mockCronInstances: Array<{ callback: () => void; paused: boolean; stopped: boolean }> = []

vi.mock('croner', () => ({
  Cron: class MockCron {
    callback: () => void
    paused: boolean
    stopped = false
    constructor(_expression: string, options: { paused?: boolean }, callback: () => void) {
      this.paused = options?.paused ?? false
      this.callback = callback
      mockCronInstances.push(this)
    }
    resume() { this.paused = false }
    stop() { this.stopped = true }
  },
}))

// Mock child_process.execSync
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

import { execSync } from 'node:child_process'
import { createPoller } from '../src/daemon/poller.js'

function makeConfig(overrides?: Partial<PollingConfig>): PollingConfig {
  return { name: 'test-poll', cron: '* * * * *', spec: 'spec.md', command: 'echo hello', ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCronInstances.length = 0
})

describe('poller', () => {
  // P-1
  it('creates a cron job for each poller config', () => {
    createPoller([makeConfig(), makeConfig({ name: 'poll-2' })], vi.fn())
    expect(mockCronInstances).toHaveLength(2)
  })

  // P-2
  it('calls onTrigger when command output changes', async () => {
    const onTrigger = vi.fn()
    vi.mocked(execSync).mockReturnValue('output-1')
    createPoller([makeConfig()], onTrigger)

    // Fire the cron callback
    await mockCronInstances[0].callback()

    expect(onTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test-poll' }),
      'output-1'
    )
  })

  // P-3
  it('does NOT call onTrigger when output is same as last run', async () => {
    const onTrigger = vi.fn()
    vi.mocked(execSync).mockReturnValue('same-output')
    createPoller([makeConfig()], onTrigger)

    await mockCronInstances[0].callback()
    expect(onTrigger).toHaveBeenCalledTimes(1)

    // Second poll — same output
    await mockCronInstances[0].callback()
    expect(onTrigger).toHaveBeenCalledTimes(1) // not called again
  })

  // P-4
  it('calls onTrigger again when output changes after being same', async () => {
    const onTrigger = vi.fn()
    vi.mocked(execSync)
      .mockReturnValueOnce('output-1')
      .mockReturnValueOnce('output-1')
      .mockReturnValueOnce('output-2')
    createPoller([makeConfig()], onTrigger)

    await mockCronInstances[0].callback()
    await mockCronInstances[0].callback()
    await mockCronInstances[0].callback()

    expect(onTrigger).toHaveBeenCalledTimes(2)
    expect(onTrigger).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'test-poll' }),
      'output-2'
    )
  })

  // P-5
  it('handles command failure gracefully (no trigger)', async () => {
    const onTrigger = vi.fn()
    vi.mocked(execSync).mockImplementation(() => { throw new Error('cmd failed') })
    createPoller([makeConfig()], onTrigger)

    await mockCronInstances[0].callback()

    expect(onTrigger).not.toHaveBeenCalled()
  })

  // P-6
  it('stop() stops all cron jobs', () => {
    const poller = createPoller([makeConfig(), makeConfig({ name: 'poll-2' })], vi.fn())
    poller.stop()
    expect(mockCronInstances.every(j => j.stopped)).toBe(true)
  })

  // P-7
  it('first poll always triggers (no previous hash)', async () => {
    const onTrigger = vi.fn()
    vi.mocked(execSync).mockReturnValue('anything')
    createPoller([makeConfig()], onTrigger)

    await mockCronInstances[0].callback()

    expect(onTrigger).toHaveBeenCalledTimes(1)
  })
})

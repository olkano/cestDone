// tests/poller.test.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
import { createPollerStateStore, type PollerObservation, type PollerStateStore } from '../src/daemon/poller-state.js'

function makeConfig(overrides?: Partial<PollingConfig>): PollingConfig {
  return { name: 'test-poll', cron: '* * * * *', spec: 'spec.md', command: 'echo hello', ...overrides }
}

function makeStateStore(): PollerStateStore {
  const observations = new Map<string, PollerObservation>()
  return {
    get: vi.fn((name) => observations.get(name)),
    accept: vi.fn((name, observation) => { observations.set(name, observation) }),
    retain: vi.fn((sources) => {
      for (const [name, observation] of observations) {
        if (sources.get(name) !== observation.sourceFingerprint) observations.delete(name)
      }
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCronInstances.length = 0
})

describe('poller', () => {
  // P-1
  it('creates a cron job for each poller config', () => {
    createPoller([makeConfig(), makeConfig({ name: 'poll-2' })], vi.fn(), makeStateStore())
    expect(mockCronInstances).toHaveLength(2)
  })

  // P-2
  it('calls onTrigger when command output changes', async () => {
    const onTrigger = vi.fn()
    vi.mocked(execSync).mockReturnValue('output-1')
    createPoller([makeConfig()], onTrigger, makeStateStore())

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
    createPoller([makeConfig()], onTrigger, makeStateStore())

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
    createPoller([makeConfig()], onTrigger, makeStateStore())

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
    const stateStore = makeStateStore()
    vi.mocked(execSync).mockImplementation(() => { throw new Error('cmd failed') })
    createPoller([makeConfig()], onTrigger, stateStore)

    await mockCronInstances[0].callback()

    expect(onTrigger).not.toHaveBeenCalled()
    expect(stateStore.accept).not.toHaveBeenCalled()
  })

  // P-6
  it('stop() stops all cron jobs', () => {
    const poller = createPoller([makeConfig(), makeConfig({ name: 'poll-2' })], vi.fn(), makeStateStore())
    poller.stop()
    expect(mockCronInstances.every(j => j.stopped)).toBe(true)
  })

  it('does not accept an in-flight URL result after the poller is stopped', async () => {
    let resolveText: ((value: string) => void) | undefined
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn(() => new Promise<string>(resolve => { resolveText = resolve })),
    }))
    const onTrigger = vi.fn()
    const stateStore = makeStateStore()
    const poller = createPoller([
      makeConfig({ command: undefined, url: 'https://example.test/status' }),
    ], onTrigger, stateStore)

    try {
      const pendingPoll = mockCronInstances[0].callback()
      await vi.waitFor(() => expect(resolveText).toBeDefined())
      poller.stop()
      resolveText!('late-output')
      await pendingPoll

      expect(onTrigger).not.toHaveBeenCalled()
      expect(stateStore.accept).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // P-7
  it('first poll always triggers (no previous hash)', async () => {
    const onTrigger = vi.fn()
    vi.mocked(execSync).mockReturnValue('anything')
    createPoller([makeConfig()], onTrigger, makeStateStore())

    await mockCronInstances[0].callback()

    expect(onTrigger).toHaveBeenCalledTimes(1)
  })

  it('does not trigger when a recreated poller observes the accepted output', async () => {
    const stateStore = makeStateStore()
    const onTrigger = vi.fn()
    vi.mocked(execSync).mockReturnValue('stable-output')

    const first = createPoller([makeConfig()], onTrigger, stateStore)
    await mockCronInstances[0].callback()
    first.stop()

    createPoller([makeConfig()], onTrigger, stateStore)
    await mockCronInstances[1].callback()

    expect(onTrigger).toHaveBeenCalledTimes(1)
  })

  it('does not trigger after a process restart reloads the same accepted output', async () => {
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-poller-restart-'))
    const statePath = path.join(stateDirectory, 'poller-state.json')
    const onTrigger = vi.fn()
    vi.mocked(execSync).mockReturnValue('privacy-minimal-output')

    try {
      createPoller([makeConfig()], onTrigger, createPollerStateStore(statePath))
      await mockCronInstances[0].callback()
      createPoller([makeConfig()], onTrigger, createPollerStateStore(statePath))
      await mockCronInstances[1].callback()

      expect(onTrigger).toHaveBeenCalledTimes(1)
      expect(fs.readFileSync(statePath, 'utf8')).not.toContain('privacy-minimal-output')
    } finally {
      fs.rmSync(stateDirectory, { recursive: true, force: true })
    }
  })

  it('retries the changed output when the trigger callback rejects it', async () => {
    const stateStore = makeStateStore()
    const onTrigger = vi.fn()
      .mockImplementationOnce(() => { throw new Error('queue unavailable') })
      .mockImplementationOnce(() => undefined)
    vi.mocked(execSync).mockReturnValue('changed-output')
    createPoller([makeConfig()], onTrigger, stateStore)

    await mockCronInstances[0].callback()
    await mockCronInstances[0].callback()

    expect(onTrigger).toHaveBeenCalledTimes(2)
    expect(stateStore.accept).toHaveBeenCalledTimes(1)
  })

  it('does not let an old command state suppress a new command source', async () => {
    const stateStore = makeStateStore()
    const onTrigger = vi.fn()
    vi.mocked(execSync).mockReturnValue('same-output')

    createPoller([makeConfig({ command: 'command-a' })], onTrigger, stateStore)
    await mockCronInstances[0].callback()
    createPoller([makeConfig({ command: 'command-b' })], onTrigger, stateStore)
    await mockCronInstances[1].callback()

    expect(onTrigger).toHaveBeenCalledTimes(2)
  })

  it('keeps observations isolated by poller name', async () => {
    const stateStore = makeStateStore()
    const onTrigger = vi.fn()
    vi.mocked(execSync).mockReturnValue('same-output')
    createPoller([
      makeConfig({ name: 'poll-a' }),
      makeConfig({ name: 'poll-b' }),
    ], onTrigger, stateStore)

    await mockCronInstances[0].callback()
    await mockCronInstances[1].callback()

    expect(onTrigger).toHaveBeenCalledTimes(2)
  })

  it('does not trigger or update state on an HTTP failure', async () => {
    const stateStore = makeStateStore()
    const onTrigger = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: vi.fn() }))
    createPoller([
      makeConfig({ command: undefined, url: 'https://example.test/status' }),
    ], onTrigger, stateStore)

    await mockCronInstances[0].callback()

    expect(onTrigger).not.toHaveBeenCalled()
    expect(stateStore.accept).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('does not let an old URL state suppress a new URL source', async () => {
    const stateStore = makeStateStore()
    const onTrigger = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('same-output'),
    }))

    try {
      createPoller([makeConfig({ command: undefined, url: 'https://example.test/a' })], onTrigger, stateStore)
      await mockCronInstances[0].callback()
      createPoller([makeConfig({ command: undefined, url: 'https://example.test/b' })], onTrigger, stateStore)
      await mockCronInstances[1].callback()

      expect(onTrigger).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

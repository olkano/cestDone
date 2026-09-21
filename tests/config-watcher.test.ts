// tests/config-watcher.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockWatcherOn, mockWatcherClose } = vi.hoisted(() => ({
  mockWatcherOn: vi.fn(),
  mockWatcherClose: vi.fn(),
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs')
  return {
    ...actual,
    default: {
      ...(actual as Record<string, unknown>),
      watch: vi.fn().mockReturnValue({ on: mockWatcherOn, close: mockWatcherClose }),
      readFileSync: vi.fn(),
    },
  }
})

vi.mock('../src/daemon/config-validator.js', () => ({
  validateConfig: vi.fn().mockReturnValue({ valid: true, errors: [] }),
}))

import fs from 'node:fs'
import { createConfigWatcher, type ConfigWatcher } from '../src/daemon/config-watcher.js'
import { validateConfig } from '../src/daemon/config-validator.js'

let watcher: ConfigWatcher | undefined

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.mocked(validateConfig).mockReturnValue({ valid: true, errors: [] })
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ daemon: {} }))
})

afterEach(() => {
  watcher?.stop()
  watcher = undefined
  vi.useRealTimers()
})

describe('createConfigWatcher', () => {
  it('calls fs.watch on start', () => {
    const onReload = vi.fn()
    const onError = vi.fn()
    watcher = createConfigWatcher({ configPath: '/tmp/config.json', onReload, onError })
    watcher.start()

    expect(fs.watch).toHaveBeenCalledWith(
      '/tmp/config.json',
      { persistent: false },
      expect.any(Function),
    )
  })

  it('closes watcher on stop', () => {
    const onReload = vi.fn()
    const onError = vi.fn()
    watcher = createConfigWatcher({ configPath: '/tmp/config.json', onReload, onError })
    watcher.start()
    watcher.stop()
    watcher = undefined

    expect(mockWatcherClose).toHaveBeenCalled()
  })

  it('debounces and calls onReload with valid daemon config', () => {
    const validConfig = {
      daemon: {
        schedules: [{ name: 'test', cron: '0 * * * *', spec: 'spec.md' }],
      },
    }
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(JSON.stringify({ daemon: {} }))
      .mockReturnValue(JSON.stringify(validConfig))

    const onReload = vi.fn()
    const onError = vi.fn()
    watcher = createConfigWatcher({ configPath: '/tmp/config.json', onReload, onError, debounceMs: 100 })
    watcher.start()

    // Simulate fs.watch 'change' event
    const watchCallback = vi.mocked(fs.watch).mock.calls[0][2] as (event: string) => void
    watchCallback('change')

    // Before debounce fires
    expect(onReload).not.toHaveBeenCalled()

    // After debounce
    vi.advanceTimersByTime(100)

    expect(onReload).toHaveBeenCalledWith(validConfig)
  })

  it('debounces multiple rapid changes into one reload', () => {
    const validConfig = { daemon: { schedules: [{ name: 'test', cron: '0 * * * *', spec: 'spec.md' }] } }
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(JSON.stringify({ daemon: {} }))
      .mockReturnValue(JSON.stringify(validConfig))

    const onReload = vi.fn()
    const onError = vi.fn()
    watcher = createConfigWatcher({ configPath: '/tmp/config.json', onReload, onError, debounceMs: 200 })
    watcher.start()

    const watchCallback = vi.mocked(fs.watch).mock.calls[0][2] as (event: string) => void

    // Fire 5 rapid changes
    watchCallback('change')
    vi.advanceTimersByTime(50)
    watchCallback('change')
    vi.advanceTimersByTime(50)
    watchCallback('change')
    vi.advanceTimersByTime(50)
    watchCallback('change')
    vi.advanceTimersByTime(50)
    watchCallback('change')

    // Wait for debounce
    vi.advanceTimersByTime(200)

    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('calls onError when daemon section is missing', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ targetRepoPath: '.' }))

    const onReload = vi.fn()
    const onError = vi.fn()
    watcher = createConfigWatcher({ configPath: '/tmp/config.json', onReload, onError, debounceMs: 0 })
    watcher.start()

    const watchCallback = vi.mocked(fs.watch).mock.calls[0][2] as (event: string) => void
    watchCallback('change')
    vi.advanceTimersByTime(1)

    expect(onReload).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('No "daemon" section'),
    }))
  })

  it('calls onError when config validation fails', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ daemon: { schedules: [{}] } }))
    vi.mocked(validateConfig).mockReturnValue({ valid: false, errors: ['bad cron'] })

    const onReload = vi.fn()
    const onError = vi.fn()
    watcher = createConfigWatcher({ configPath: '/tmp/config.json', onReload, onError, debounceMs: 0 })
    watcher.start()

    const watchCallback = vi.mocked(fs.watch).mock.calls[0][2] as (event: string) => void
    watchCallback('change')
    vi.advanceTimersByTime(1)

    expect(onReload).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Invalid daemon config'),
    }))
  })

  it('calls onError on JSON parse failure (partial write)', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('{ broken json')

    const onReload = vi.fn()
    const onError = vi.fn()
    watcher = createConfigWatcher({ configPath: '/tmp/config.json', onReload, onError, debounceMs: 0 })
    watcher.start()

    const watchCallback = vi.mocked(fs.watch).mock.calls[0][2] as (event: string) => void
    watchCallback('change')
    vi.advanceTimersByTime(1)

    expect(onReload).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalled()
  })

  it('ignores non-change events', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ daemon: {} }))

    const onReload = vi.fn()
    const onError = vi.fn()
    watcher = createConfigWatcher({ configPath: '/tmp/config.json', onReload, onError, debounceMs: 0 })
    watcher.start()

    const watchCallback = vi.mocked(fs.watch).mock.calls[0][2] as (event: string) => void
    watchCallback('rename')
    vi.advanceTimersByTime(1)

    expect(onReload).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('uses default debounce of 500ms', () => {
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(JSON.stringify({ daemon: {} }))
      .mockReturnValue(JSON.stringify({ daemon: { schedules: [{ name: 'test', cron: '0 * * * *', spec: 'spec.md' }] } }))

    const onReload = vi.fn()
    const onError = vi.fn()
    watcher = createConfigWatcher({ configPath: '/tmp/config.json', onReload, onError })
    watcher.start()

    const watchCallback = vi.mocked(fs.watch).mock.calls[0][2] as (event: string) => void
    watchCallback('change')

    vi.advanceTimersByTime(499)
    expect(onReload).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('does not reload for an identical in-place rewrite', () => {
    const config = { targetRepoPath: '.', daemon: { schedules: [] } }
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config))
    const onReload = vi.fn()
    const onError = vi.fn()
    const onInfo = vi.fn()
    watcher = createConfigWatcher({ configPath: '/tmp/config.json', onReload, onError, onInfo, debounceMs: 0 })
    watcher.start()

    const watchCallback = vi.mocked(fs.watch).mock.calls[0][2] as (event: string) => void
    watchCallback('change')
    vi.advanceTimersByTime(1)

    expect(onReload).not.toHaveBeenCalled()
    expect(onInfo).toHaveBeenCalledWith('Skipped daemon config reload: no semantic changes')
  })

  it('does not reload for formatting or object-key-order changes', () => {
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce('{"targetRepoPath":".","daemon":{"schedules":[]}}')
      .mockReturnValue('{\n  "daemon": { "schedules": [] },\n  "targetRepoPath": "."\n}')
    const onReload = vi.fn()
    const onError = vi.fn()
    watcher = createConfigWatcher({ configPath: '/tmp/config.json', onReload, onError, debounceMs: 0 })
    watcher.start()

    const watchCallback = vi.mocked(fs.watch).mock.calls[0][2] as (event: string) => void
    watchCallback('change')
    vi.advanceTimersByTime(1)

    expect(onReload).not.toHaveBeenCalled()
  })

  it('does not replace the accepted config after an invalid write', async () => {
    const accepted = JSON.stringify({ daemon: { schedules: [] } })
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(accepted)
      .mockReturnValueOnce('{broken')
      .mockReturnValueOnce(accepted)
    const onReload = vi.fn()
    const onError = vi.fn()
    const onInfo = vi.fn()
    watcher = createConfigWatcher({ configPath: '/tmp/config.json', onReload, onError, onInfo, debounceMs: 0 })
    watcher.start()

    const watchCallback = vi.mocked(fs.watch).mock.calls[0][2] as (event: string) => void
    watchCallback('change')
    await vi.advanceTimersByTimeAsync(1)
    watchCallback('change')
    await vi.advanceTimersByTimeAsync(1)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onReload).not.toHaveBeenCalled()
    expect(onInfo).toHaveBeenCalledWith('Skipped daemon config reload: no semantic changes')
  })

  it('reloads one real semantic change exactly once', async () => {
    const initial = JSON.stringify({ daemon: { schedules: [] } })
    const changed = JSON.stringify({ daemon: { schedules: [{ name: 'daily', cron: '0 9 * * *', spec: 'daily.md' }] } })
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(initial)
      .mockReturnValue(changed)
    const onReload = vi.fn()
    const onError = vi.fn()
    watcher = createConfigWatcher({ configPath: '/tmp/config.json', onReload, onError, debounceMs: 0 })
    watcher.start()

    const watchCallback = vi.mocked(fs.watch).mock.calls[0][2] as (event: string) => void
    watchCallback('change')
    await vi.advanceTimersByTimeAsync(1)
    watchCallback('change')
    await vi.advanceTimersByTimeAsync(1)

    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('retries a semantic change when the reload callback rejects it', async () => {
    const initial = JSON.stringify({ daemon: { schedules: [] } })
    const changed = JSON.stringify({ daemon: { schedules: [{ name: 'daily', cron: '0 9 * * *', spec: 'daily.md' }] } })
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(initial)
      .mockReturnValue(changed)
    const onReload = vi.fn()
      .mockRejectedValueOnce(new Error('reload failed'))
      .mockResolvedValueOnce(undefined)
    const onError = vi.fn()
    watcher = createConfigWatcher({ configPath: '/tmp/config.json', onReload, onError, debounceMs: 0 })
    watcher.start()

    const watchCallback = vi.mocked(fs.watch).mock.calls[0][2] as (event: string) => void
    watchCallback('change')
    await vi.advanceTimersByTimeAsync(1)
    watchCallback('change')
    await vi.advanceTimersByTimeAsync(1)

    expect(onReload).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'reload failed' }))
  })
})

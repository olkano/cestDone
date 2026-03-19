// tests/daemon-config.test.ts
import { describe, it, expect } from 'vitest'
import { validateDaemonConfig } from '../src/daemon/config-validator.js'
import type { DaemonConfig, ScheduleConfig, WebhookConfig, PollingConfig } from '../src/daemon/types.js'

function schedule(overrides?: Partial<ScheduleConfig>): ScheduleConfig {
  return { name: 'test-schedule', cron: '0 * * * *', spec: 'spec.md', ...overrides }
}

function webhook(overrides?: Partial<WebhookConfig>): WebhookConfig {
  return { name: 'test-webhook', port: 9876, spec: 'spec.md', ...overrides }
}

function poller(overrides?: Partial<PollingConfig>): PollingConfig {
  return { name: 'test-poller', cron: '0 * * * *', spec: 'spec.md', command: 'echo ok', ...overrides }
}

describe('validateDaemonConfig', () => {
  // DC-1
  it('valid schedule config passes', () => {
    const result = validateDaemonConfig({ schedules: [schedule()] })
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  // DC-2
  it('schedule without name fails', () => {
    const result = validateDaemonConfig({ schedules: [schedule({ name: '' })] })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('name is required')
  })

  // DC-3
  it('schedule with invalid cron fails', () => {
    const result = validateDaemonConfig({ schedules: [schedule({ cron: 'not-a-cron' })] })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('invalid cron')
  })

  // DC-4
  it('schedule with missing spec fails', () => {
    const result = validateDaemonConfig({ schedules: [schedule({ spec: '' })] })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('spec is required')
  })

  // DC-5
  it('valid webhook config passes', () => {
    const result = validateDaemonConfig({ webhooks: [webhook()] })
    expect(result.valid).toBe(true)
  })

  // DC-6
  it('webhook without port fails', () => {
    const result = validateDaemonConfig({ webhooks: [webhook({ port: undefined as unknown as number })] })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('port is required')
  })

  // DC-7
  it('webhook with port out of range fails', () => {
    const r1 = validateDaemonConfig({ webhooks: [webhook({ port: 0 })] })
    expect(r1.valid).toBe(false)
    expect(r1.errors[0]).toContain('port must be between')

    const r2 = validateDaemonConfig({ webhooks: [webhook({ port: 65536 })] })
    expect(r2.valid).toBe(false)
    expect(r2.errors[0]).toContain('port must be between')
  })

  // DC-8
  it('valid poller with command passes', () => {
    const result = validateDaemonConfig({ pollers: [poller()] })
    expect(result.valid).toBe(true)
  })

  // DC-9
  it('valid poller with url passes', () => {
    const result = validateDaemonConfig({
      pollers: [poller({ command: undefined, url: 'https://example.com' })],
    })
    expect(result.valid).toBe(true)
  })

  // DC-10
  it('poller with neither command nor url fails', () => {
    const result = validateDaemonConfig({
      pollers: [poller({ command: undefined, url: undefined })],
    })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('either command or url')
  })

  // DC-11
  it('duplicate names across trigger types fails', () => {
    const result = validateDaemonConfig({
      schedules: [schedule({ name: 'duplicate' })],
      webhooks: [webhook({ name: 'duplicate' })],
    })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('Duplicate trigger name')
  })

  // DC-12
  it('empty config passes', () => {
    const result = validateDaemonConfig({})
    expect(result.valid).toBe(true)
  })

  // DC-13
  it('config with all trigger types passes', () => {
    const result = validateDaemonConfig({
      schedules: [schedule()],
      webhooks: [webhook()],
      pollers: [poller()],
    })
    expect(result.valid).toBe(true)
  })

  // DC-14
  it('schedule without cron fails', () => {
    const result = validateDaemonConfig({ schedules: [schedule({ cron: '' })] })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('cron is required')
  })
})

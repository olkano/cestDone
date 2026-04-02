import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ScheduleConfig } from '../src/daemon/types.js'

interface MockCron {
  callback: (() => void) | null
  paused: boolean
  stopped: boolean
  expression: string
  timezone: string | undefined
  resume(): void
  stop(): void
  nextRun(): Date
}

let instances: MockCron[] = []

vi.mock('croner', () => {
  class MockCron {
    callback: (() => void) | null = null
    paused: boolean
    stopped = false
    expression: string
    timezone: string | undefined
    constructor(
      expression: string,
      options: { paused?: boolean; timezone?: string },
      callback: () => void,
    ) {
      this.expression = expression
      this.paused = options?.paused ?? false
      this.timezone = options?.timezone
      this.callback = callback
      instances.push(this)
    }
    resume() {
      this.paused = false
    }
    stop() {
      this.stopped = true
    }
    nextRun() {
      return new Date('2026-01-01T00:00:00Z')
    }
  }
  return { Cron: MockCron }
})

import { createScheduler } from '../src/daemon/scheduler.js'

function makeSchedule(overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    name: 'test-job',
    cron: '*/5 * * * *',
    spec: 'spec.md',
    ...overrides,
  }
}

describe('scheduler', () => {
  beforeEach(() => {
    instances.length = 0
  })

  it('creates Cron instances for each schedule', () => {
    const schedules = [
      makeSchedule({ name: 'job-a', cron: '0 * * * *' }),
      makeSchedule({ name: 'job-b', cron: '*/10 * * * *' }),
    ]
    createScheduler(schedules, vi.fn())

    expect(instances).toHaveLength(2)
    expect(instances[0].expression).toBe('0 * * * *')
    expect(instances[1].expression).toBe('*/10 * * * *')
    // Both should be created paused
    expect(instances[0].paused).toBe(true)
    expect(instances[1].paused).toBe(true)
  })

  it('start resumes all cron jobs', () => {
    const schedules = [
      makeSchedule({ name: 'job-a' }),
      makeSchedule({ name: 'job-b' }),
    ]
    const scheduler = createScheduler(schedules, vi.fn())

    expect(instances[0].paused).toBe(true)
    expect(instances[1].paused).toBe(true)

    scheduler.start()

    expect(instances[0].paused).toBe(false)
    expect(instances[1].paused).toBe(false)
  })

  it('stop stops all cron jobs', () => {
    const schedules = [
      makeSchedule({ name: 'job-a' }),
      makeSchedule({ name: 'job-b' }),
    ]
    const scheduler = createScheduler(schedules, vi.fn())
    scheduler.start()

    scheduler.stop()

    expect(instances[0].stopped).toBe(true)
    expect(instances[1].stopped).toBe(true)
  })

  it('invokes onTrigger with the correct ScheduleConfig when cron fires', () => {
    const scheduleA = makeSchedule({ name: 'job-a', spec: 'a.md' })
    const scheduleB = makeSchedule({ name: 'job-b', spec: 'b.md' })
    const onTrigger = vi.fn()

    createScheduler([scheduleA, scheduleB], onTrigger)

    // Simulate cron firing for the first job
    instances[0].callback!()
    expect(onTrigger).toHaveBeenCalledTimes(1)
    expect(onTrigger).toHaveBeenCalledWith(scheduleA)

    // Simulate cron firing for the second job
    instances[1].callback!()
    expect(onTrigger).toHaveBeenCalledTimes(2)
    expect(onTrigger).toHaveBeenCalledWith(scheduleB)
  })

  it('getJobs returns all scheduled jobs', () => {
    const scheduleA = makeSchedule({ name: 'job-a' })
    const scheduleB = makeSchedule({ name: 'job-b' })
    const scheduler = createScheduler([scheduleA, scheduleB], vi.fn())

    const jobs = scheduler.getJobs()

    expect(jobs).toHaveLength(2)
    expect(jobs[0].name).toBe('job-a')
    expect(jobs[0].config).toBe(scheduleA)
    expect(jobs[0].cronJob).toBe(instances[0])
    expect(jobs[1].name).toBe('job-b')
    expect(jobs[1].config).toBe(scheduleB)
    expect(jobs[1].cronJob).toBe(instances[1])
  })

  it('getNextRuns returns next execution time for each job', () => {
    const schedules = [
      makeSchedule({ name: 'job-a' }),
      makeSchedule({ name: 'job-b' }),
    ]
    const scheduler = createScheduler(schedules, vi.fn())

    const nextRuns = scheduler.getNextRuns()

    expect(nextRuns).toEqual([
      { name: 'job-a', next: new Date('2026-01-01T00:00:00Z') },
      { name: 'job-b', next: new Date('2026-01-01T00:00:00Z') },
    ])
  })

  it('invalid cron expression throws at creation time', async () => {
    // Temporarily override the mock to throw on construction
    const croner = await import('croner')
    const OriginalMock = croner.Cron as any
    const originalConstructor = OriginalMock.prototype.constructor

    // Patch the constructor to throw for an invalid expression
    const origImpl = OriginalMock
    ;(croner as any).Cron = class ThrowingCron {
      constructor() {
        throw new Error('Invalid cron expression')
      }
    }

    expect(() =>
      createScheduler(
        [makeSchedule({ cron: 'not-a-cron' })],
        vi.fn(),
      ),
    ).toThrow('Invalid cron expression')

    // Restore
    ;(croner as any).Cron = origImpl
  })

  it('passes timezone option to Cron when specified', () => {
    const schedules = [
      makeSchedule({ name: 'utc-job', cron: '0 9 * * 4', timezone: 'Etc/UTC' }),
      makeSchedule({ name: 'local-job', cron: '0 9 * * 4' }),
    ]
    createScheduler(schedules, vi.fn())

    expect(instances).toHaveLength(2)
    // The mock captures constructor args; check that timezone was passed
    expect((instances[0] as any).timezone).toBe('Etc/UTC')
    expect((instances[1] as any).timezone).toBeUndefined()
  })

  it('empty schedules array works with no jobs created', () => {
    const scheduler = createScheduler([], vi.fn())

    expect(scheduler.getJobs()).toHaveLength(0)
    expect(scheduler.getNextRuns()).toEqual([])

    // start and stop should not throw
    scheduler.start()
    scheduler.stop()

    expect(instances).toHaveLength(0)
  })
})

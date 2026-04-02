// src/daemon/scheduler.ts
import { Cron } from 'croner'
import type { ScheduleConfig } from './types.js'

export interface ScheduledJob {
  name: string
  cronJob: Cron
  config: ScheduleConfig
}

export interface Scheduler {
  start(): void
  stop(): void
  getJobs(): readonly ScheduledJob[]
  getNextRuns(): Array<{ name: string; next: Date | null }>
}

export function createScheduler(
  schedules: ScheduleConfig[],
  onTrigger: (schedule: ScheduleConfig) => void,
): Scheduler {
  const jobs: ScheduledJob[] = schedules.map((schedule) => {
    const cronJob = new Cron(
      schedule.cron,
      { paused: true, ...(schedule.timezone ? { timezone: schedule.timezone } : {}) },
      () => { onTrigger(schedule) },
    )
    return { name: schedule.name, cronJob, config: schedule }
  })

  return {
    start() {
      for (const job of jobs) {
        job.cronJob.resume()
      }
    },
    stop() {
      for (const job of jobs) {
        job.cronJob.stop()
      }
    },
    getJobs() {
      return jobs
    },
    getNextRuns() {
      return jobs.map((job) => ({
        name: job.name,
        next: job.cronJob.nextRun(),
      }))
    },
  }
}

// src/daemon/types.ts
import type { RunOptions } from '../cli/index.js'

export interface ScheduleConfig {
  name: string
  cron: string
  spec: string
  target?: string
  houseRules?: string
  options?: Partial<RunOptions>
}

export interface WebhookConfig {
  name: string
  port: number
  path?: string
  spec: string
  target?: string
  secret?: string
  options?: Partial<RunOptions>
}

export interface PollingConfig {
  name: string
  cron: string
  command?: string
  url?: string
  spec: string
  target?: string
  options?: Partial<RunOptions>
}

export interface DaemonConfig {
  schedules?: ScheduleConfig[]
  webhooks?: WebhookConfig[]
  pollers?: PollingConfig[]
  logDir?: string
  pidFile?: string
}

// src/daemon/types.ts
import type { RunOptions } from '../cli/index.js'

export interface RetryConfig {
  retries?: number       // max retry attempts on failure (default: 0 = no retry)
  retryDelayMs?: number  // delay between retries in ms (default: 60 000)
}

export interface ScheduleConfig extends RetryConfig {
  name: string
  cron: string
  spec: string
  target?: string
  houseRules?: string
  timezone?: string
  options?: Partial<RunOptions>
}

export interface WebhookConfig extends RetryConfig {
  name: string
  port: number
  path?: string
  spec: string
  target?: string
  secret?: string
  options?: Partial<RunOptions>
}

export interface PollingConfig extends RetryConfig {
  name: string
  cron: string
  command?: string
  url?: string
  spec: string
  target?: string
  options?: Partial<RunOptions>
}

export interface CleanupConfig {
  maxRuns?: number        // keep last N run dirs per spec (default: 7)
  maxCentralLogs?: number // keep last N central log files per spec (default: maxRuns)
}

export interface EmailNotificationConfig {
  recipients: string | string[]
}

export interface NotificationConfig {
  email?: EmailNotificationConfig
}

export interface DaemonConfig {
  schedules?: ScheduleConfig[]
  webhooks?: WebhookConfig[]
  pollers?: PollingConfig[]
  logDir?: string
  pidFile?: string
  cleanup?: CleanupConfig
  notifications?: NotificationConfig
}

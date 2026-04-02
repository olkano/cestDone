// src/daemon/config-validator.ts
import { Cron } from 'croner'
import type { DaemonConfig } from './types.js'

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

export function validateDaemonConfig(config: DaemonConfig): ValidationResult {
  const errors: string[] = []
  const names = new Set<string>()

  function checkDuplicate(name: string, source: string): void {
    if (!name) {
      errors.push(`${source}: name is required`)
      return
    }
    if (names.has(name)) {
      errors.push(`Duplicate trigger name: "${name}"`)
    }
    names.add(name)
  }

  function checkRetry(config: { retries?: number; retryDelayMs?: number }, source: string): void {
    if (config.retries !== undefined) {
      if (!Number.isInteger(config.retries) || config.retries < 0) {
        errors.push(`${source}: retries must be a non-negative integer`)
      }
    }
    if (config.retryDelayMs !== undefined) {
      if (!Number.isInteger(config.retryDelayMs) || config.retryDelayMs < 0) {
        errors.push(`${source}: retryDelayMs must be a non-negative integer`)
      }
    }
  }

  function checkCron(expression: string, source: string): void {
    try {
      // Validate by attempting to create a Cron instance
      new Cron(expression, { paused: true })
    } catch {
      errors.push(`${source}: invalid cron expression "${expression}"`)
    }
  }

  // Validate schedules
  for (const s of config.schedules ?? []) {
    const src = `schedule "${s.name || '(unnamed)'}"`
    checkDuplicate(s.name, 'schedule')
    if (!s.spec) errors.push(`${src}: spec is required`)
    if (!s.cron) errors.push(`${src}: cron is required`)
    else checkCron(s.cron, src)
    checkRetry(s, src)
  }

  // Validate webhooks
  for (const w of config.webhooks ?? []) {
    const src = `webhook "${w.name || '(unnamed)'}"`
    checkDuplicate(w.name, 'webhook')
    if (!w.spec) errors.push(`${src}: spec is required`)
    if (w.port === undefined || w.port === null) {
      errors.push(`${src}: port is required`)
    } else if (w.port < 1 || w.port > 65535) {
      errors.push(`${src}: port must be between 1 and 65535`)
    }
    checkRetry(w, src)
  }

  // Validate pollers
  for (const p of config.pollers ?? []) {
    const src = `poller "${p.name || '(unnamed)'}"`
    checkDuplicate(p.name, 'poller')
    if (!p.spec) errors.push(`${src}: spec is required`)
    if (!p.cron) errors.push(`${src}: cron is required`)
    else checkCron(p.cron, src)
    if (!p.command && !p.url) {
      errors.push(`${src}: either command or url is required`)
    }
    checkRetry(p, src)
  }

  // Validate cleanup
  if (config.cleanup) {
    if (config.cleanup.maxRuns !== undefined) {
      if (!Number.isInteger(config.cleanup.maxRuns) || config.cleanup.maxRuns < 1) {
        errors.push('cleanup.maxRuns must be a positive integer')
      }
    }
    if (config.cleanup.maxCentralLogs !== undefined) {
      if (!Number.isInteger(config.cleanup.maxCentralLogs) || config.cleanup.maxCentralLogs < 1) {
        errors.push('cleanup.maxCentralLogs must be a positive integer')
      }
    }
  }

  // Validate notifications
  if (config.notifications?.email) {
    const r = config.notifications.email.recipients
    if (typeof r === 'string') {
      if (!r.trim()) {
        errors.push('notifications.email.recipients must be a non-empty string')
      }
    } else if (Array.isArray(r)) {
      if (r.length === 0) {
        errors.push('notifications.email.recipients must be a non-empty array')
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

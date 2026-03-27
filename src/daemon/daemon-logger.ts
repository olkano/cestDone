// src/daemon/daemon-logger.ts
import fs from 'node:fs'
import path from 'node:path'
import type { Job } from './job-queue.js'

export interface DaemonLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  jobStart(job: Job): void
  jobEnd(job: Job, error?: Error): void
  readonly logDir: string
}

export function createDaemonLogger(logDir: string): DaemonLogger {
  fs.mkdirSync(logDir, { recursive: true })

  const logFilePath = path.join(logDir, 'daemon.log')

  function write(level: string, message: string): void {
    const timestamp = new Date().toISOString()
    const line = `[${timestamp}] [${level}] ${message}`
    fs.appendFileSync(logFilePath, line + '\n', 'utf-8')
    // Also write to stdout/stderr so pm2 and other process managers capture it
    if (level === 'ERROR') {
      console.error(line)
    } else {
      console.log(line)
    }
  }

  function info(message: string): void {
    write('INFO', message)
  }

  function warn(message: string): void {
    write('WARN', message)
  }

  function error(message: string): void {
    write('ERROR', message)
  }

  function jobStart(job: Job): void {
    info(`Job ${job.id} started: trigger=${job.trigger}, spec=${job.specPath}`)
  }

  function jobEnd(job: Job, err?: Error): void {
    if (err) {
      error(`Job ${job.id} failed: ${err.message}`)
    } else {
      info(`Job ${job.id} completed`)
    }
  }

  return {
    info,
    warn,
    error,
    jobStart,
    jobEnd,
    logDir,
  }
}

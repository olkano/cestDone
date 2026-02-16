// src/shared/logger.ts
import fs from 'node:fs'
import path from 'node:path'

export interface SessionLogger {
  log(caller: string, message: string): void
  logVerbose(caller: string, message: string): void
  readonly logFilePath: string
}

export function createSessionLogger(options?: { silent?: boolean; specName?: string }): SessionLogger {
  if (options?.silent) {
    return { log: () => {}, logVerbose: () => {}, logFilePath: '' }
  }

  const verbose = process.env.VERBOSE_LOGGING === 'true'
  const logsDir = path.join(process.cwd(), 'logs')
  fs.mkdirSync(logsDir, { recursive: true })

  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10)
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '')
  const prefix = options?.specName
    ? options.specName.replace(/[^a-zA-Z0-9_-]/g, '-') + '_'
    : ''
  const logFilePath = path.join(logsDir, `${prefix}${dateStr}_${timeStr}.log`)

  function appendToFile(line: string): void {
    fs.appendFileSync(logFilePath, line + '\n', 'utf-8')
  }

  function log(caller: string, message: string): void {
    const line = `${caller}: ${message}`
    console.log(line)
    appendToFile(`[${new Date().toISOString()}] ${line}`)
  }

  function logVerbose(caller: string, message: string): void {
    if (!verbose) return
    appendToFile(`[${new Date().toISOString()}] [VERBOSE] ${caller}: ${message}`)
  }

  return { log, logVerbose, logFilePath }
}

// src/shared/logger.ts
import fs from 'node:fs'
import path from 'node:path'

export interface SessionLogger {
  log(caller: string, message: string): void
  logVerbose(caller: string, message: string): void
}

export function createSessionLogger(options?: { silent?: boolean }): SessionLogger {
  if (options?.silent) {
    return { log: () => {}, logVerbose: () => {} }
  }

  const verbose = process.env.VERBOSE_LOGGING === 'true'
  const logsDir = path.join(process.cwd(), 'logs')
  fs.mkdirSync(logsDir, { recursive: true })

  const dateStr = new Date().toISOString().slice(0, 10)
  const logFilePath = path.join(logsDir, `${dateStr}.log`)

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

  return { log, logVerbose }
}

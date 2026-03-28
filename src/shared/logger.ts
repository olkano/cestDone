// src/shared/logger.ts
import fs from 'node:fs'
import path from 'node:path'

export interface SessionLogger {
  log(caller: string, message: string): void
  logVerbose(caller: string, message: string): void
  readonly logFilePath: string
}

export function createSessionLogger(options?: { silent?: boolean; specName?: string; runDir?: string; centralLogDir?: string }): SessionLogger {
  if (options?.silent) {
    return { log: () => {}, logVerbose: () => {}, logFilePath: '' }
  }

  const verbose = process.env.VERBOSE_LOGGING === 'true'

  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10)
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '')
  const prefix = options?.specName
    ? options.specName.replace(/[^a-zA-Z0-9_-]/g, '-') + '_'
    : ''

  const logsDir = options?.runDir ?? path.join(process.cwd(), '.cestdone', 'logs')
  fs.mkdirSync(logsDir, { recursive: true })

  const logFileName = `${prefix}${dateStr}_${timeStr}.log`
  const logFilePath = path.join(logsDir, logFileName)

  // Central log mirror (dual-write)
  let centralLogFilePath: string | undefined
  if (options?.centralLogDir) {
    try {
      fs.mkdirSync(options.centralLogDir, { recursive: true })
      centralLogFilePath = path.join(options.centralLogDir, logFileName)
    } catch {
      // Best-effort — don't fail the run if central dir is inaccessible
    }
  }

  function appendToFile(line: string): void {
    fs.appendFileSync(logFilePath, line + '\n', 'utf-8')
    if (centralLogFilePath) {
      try {
        fs.appendFileSync(centralLogFilePath, line + '\n', 'utf-8')
      } catch {
        // Best-effort
      }
    }
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

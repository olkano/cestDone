// src/shared/logger.ts
import pino from 'pino'

export function createLogger(level: string = 'info'): pino.Logger {
  return pino({ level })
}

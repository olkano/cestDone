// src/shared/logger.ts
import path from 'node:path'
import pino from 'pino'

export function createLogger(level: string = 'info'): pino.Logger {
  if (level === 'silent') {
    return pino({ level: 'silent' })
  }

  return pino({
    level: 'debug',
    transport: {
      target: 'pino-roll',
      options: {
        file: path.join('logs', 'cestdone.log'),
        size: '2m',
        limit: { count: 3 },
        mkdir: true,
      }
    }
  })
}

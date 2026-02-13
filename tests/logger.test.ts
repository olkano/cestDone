// tests/logger.test.ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('pino', () => ({
  default: vi.fn((opts: { level?: string }) => ({ level: opts?.level ?? 'info' }))
}))

import pino from 'pino'
import { createLogger } from '../src/shared/logger.js'

describe('createLogger', () => {
  it('returns a silent logger with no transport when level is silent', () => {
    const logger = createLogger('silent')

    expect(logger.level).toBe('silent')
    expect(pino).toHaveBeenCalledWith({ level: 'silent' })
  })

  it('creates a file transport logger at debug level', () => {
    vi.mocked(pino).mockClear()

    createLogger('info')

    expect(pino).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'debug',
        transport: expect.objectContaining({
          target: 'pino-roll',
          options: expect.objectContaining({
            file: expect.stringContaining('cestdone.log'),
            size: '2m',
            limit: { count: 3 },
            mkdir: true,
          })
        })
      })
    )
  })

  it('uses file transport for default level', () => {
    vi.mocked(pino).mockClear()

    createLogger()

    expect(pino).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'debug',
        transport: expect.objectContaining({
          target: 'pino-roll',
        })
      })
    )
  })
})

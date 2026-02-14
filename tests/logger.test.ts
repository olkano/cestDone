// tests/logger.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { createSessionLogger } from '../src/shared/logger.js'

vi.mock('node:fs')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fs.mkdirSync).mockReturnValue(undefined as unknown as string)
  vi.mocked(fs.appendFileSync).mockReturnValue(undefined)
})

afterEach(() => {
  delete process.env.VERBOSE_LOGGING
})

describe('createSessionLogger', () => {
  it('returns a silent logger when silent option is true', () => {
    const logger = createSessionLogger({ silent: true })

    logger.log('Test', 'message')
    logger.logVerbose('Test', 'verbose message')

    expect(fs.mkdirSync).not.toHaveBeenCalled()
    expect(fs.appendFileSync).not.toHaveBeenCalled()
  })

  it('creates logs directory on initialization', () => {
    createSessionLogger()

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('logs'),
      { recursive: true }
    )
  })

  it('log() writes to console and file', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logger = createSessionLogger()

    logger.log('Director', 'Step 1: Analyzing')

    expect(consoleSpy).toHaveBeenCalledWith('Director: Step 1: Analyzing')
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/logs[\\/]\d{4}-\d{2}-\d{2}\.log$/),
      expect.stringContaining('Director: Step 1: Analyzing'),
      'utf-8'
    )
    consoleSpy.mockRestore()
  })

  it('log() file output includes ISO timestamp', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logger = createSessionLogger()

    logger.log('Coder', 'Working')

    const writtenLine = vi.mocked(fs.appendFileSync).mock.calls[0][1] as string
    expect(writtenLine).toMatch(/^\[\d{4}-\d{2}-\d{2}T/)
    consoleSpy.mockRestore()
  })

  it('logVerbose() is a no-op when VERBOSE_LOGGING is not set', () => {
    delete process.env.VERBOSE_LOGGING
    const logger = createSessionLogger()

    logger.logVerbose('Coder', 'Full prompt here')

    expect(fs.appendFileSync).not.toHaveBeenCalled()
  })

  it('logVerbose() writes to file when VERBOSE_LOGGING=true', () => {
    process.env.VERBOSE_LOGGING = 'true'
    const logger = createSessionLogger()

    logger.logVerbose('Coder', 'Full prompt here')

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.log$/),
      expect.stringContaining('[VERBOSE] Coder: Full prompt here'),
      'utf-8'
    )
  })

  it('logVerbose() does not write to console', () => {
    process.env.VERBOSE_LOGGING = 'true'
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logger = createSessionLogger()

    logger.logVerbose('Coder', 'Verbose data')

    expect(consoleSpy).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('uses date-stamped filename', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logger = createSessionLogger()

    logger.log('Test', 'msg')

    const filePath = vi.mocked(fs.appendFileSync).mock.calls[0][0] as string
    const today = new Date().toISOString().slice(0, 10)
    expect(filePath).toContain(today)
    consoleSpy.mockRestore()
  })
})

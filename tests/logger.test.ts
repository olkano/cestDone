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

    expect(logger.logFilePath).toBe('')
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
      expect.stringMatching(/logs[\\/]\d{4}-\d{2}-\d{2}_\d{6}\.log$/),
      expect.stringContaining('Director: Step 1: Analyzing'),
      'utf-8'
    )
    consoleSpy.mockRestore()
  })

  it('log() file output includes ISO timestamp', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logger = createSessionLogger()

    logger.log('Worker', 'Working')

    const writtenLine = vi.mocked(fs.appendFileSync).mock.calls[0][1] as string
    expect(writtenLine).toMatch(/^\[\d{4}-\d{2}-\d{2}T/)
    consoleSpy.mockRestore()
  })

  it('logVerbose() is a no-op when VERBOSE_LOGGING is not set', () => {
    delete process.env.VERBOSE_LOGGING
    const logger = createSessionLogger()

    logger.logVerbose('Worker', 'Full prompt here')

    expect(fs.appendFileSync).not.toHaveBeenCalled()
  })

  it('logVerbose() writes to file when VERBOSE_LOGGING=true', () => {
    process.env.VERBOSE_LOGGING = 'true'
    const logger = createSessionLogger()

    logger.logVerbose('Worker', 'Full prompt here')

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.log$/),
      expect.stringContaining('[VERBOSE] Worker: Full prompt here'),
      'utf-8'
    )
  })

  it('logVerbose() does not write to console', () => {
    process.env.VERBOSE_LOGGING = 'true'
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logger = createSessionLogger()

    logger.logVerbose('Worker', 'Verbose data')

    expect(consoleSpy).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('uses date-and-time-stamped filename', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logger = createSessionLogger()

    logger.log('Test', 'msg')

    const filePath = vi.mocked(fs.appendFileSync).mock.calls[0][0] as string
    const today = new Date().toISOString().slice(0, 10)
    expect(filePath).toContain(today)
    expect(filePath).toMatch(/\d{4}-\d{2}-\d{2}_\d{6}\.log$/)
    consoleSpy.mockRestore()
  })

  it('includes specName prefix in filename when provided', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logger = createSessionLogger({ specName: 'my-feature' })

    logger.log('Test', 'msg')

    const filePath = vi.mocked(fs.appendFileSync).mock.calls[0][0] as string
    expect(filePath).toMatch(/my-feature_\d{4}-\d{2}-\d{2}_\d{6}\.log$/)
    consoleSpy.mockRestore()
  })

  it('sanitizes specName to remove unsafe characters', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logger = createSessionLogger({ specName: 'my feature/spec' })

    logger.log('Test', 'msg')

    const filePath = vi.mocked(fs.appendFileSync).mock.calls[0][0] as string
    expect(filePath).toMatch(/my-feature-spec_\d{4}-\d{2}-\d{2}_\d{6}\.log$/)
    consoleSpy.mockRestore()
  })

  it('exposes logFilePath', () => {
    const logger = createSessionLogger({ specName: 'test' })
    expect(logger.logFilePath).toMatch(/test_\d{4}-\d{2}-\d{2}_\d{6}\.log$/)
  })

  it('dual-writes to central log dir when centralLogDir is provided', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logger = createSessionLogger({ specName: 'my-spec', centralLogDir: '/central/logs' })

    logger.log('Director', 'Step 1')

    // Should have called mkdirSync for both run dir and central dir
    expect(fs.mkdirSync).toHaveBeenCalledWith('/central/logs', { recursive: true })

    // appendFileSync should be called twice per log line (run dir + central)
    expect(fs.appendFileSync).toHaveBeenCalledTimes(2)
    const calls = vi.mocked(fs.appendFileSync).mock.calls
    // First call = run dir, second = central dir
    expect(String(calls[1][0])).toContain('central')
    expect(String(calls[1][1])).toContain('Director: Step 1')
    consoleSpy.mockRestore()
  })

  it('dual-writes verbose lines to central log when VERBOSE_LOGGING=true', () => {
    process.env.VERBOSE_LOGGING = 'true'
    const logger = createSessionLogger({ specName: 'my-spec', centralLogDir: '/central/logs' })

    logger.logVerbose('Worker', 'verbose data')

    expect(fs.appendFileSync).toHaveBeenCalledTimes(2)
    const calls = vi.mocked(fs.appendFileSync).mock.calls
    expect(String(calls[1][0])).toContain('central')
    expect(String(calls[1][1])).toContain('[VERBOSE] Worker: verbose data')
  })

  it('still works if central log dir creation fails', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    // Make mkdirSync fail on the second call (central dir)
    let callCount = 0
    vi.mocked(fs.mkdirSync).mockImplementation(() => {
      callCount++
      if (callCount === 2) throw new Error('permission denied')
      return undefined as unknown as string
    })

    const logger = createSessionLogger({ specName: 'my-spec', centralLogDir: '/no-access' })
    logger.log('Test', 'msg')

    // Should still write to run dir (1 call only, no central)
    expect(fs.appendFileSync).toHaveBeenCalledTimes(1)
    consoleSpy.mockRestore()
  })

  it('does not dual-write when centralLogDir is not provided', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const logger = createSessionLogger({ specName: 'my-spec' })

    logger.log('Test', 'msg')

    // Only one appendFileSync call (run dir only)
    expect(fs.appendFileSync).toHaveBeenCalledTimes(1)
    consoleSpy.mockRestore()
  })
})

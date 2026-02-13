// tests/config.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { loadConfig, resolveConfig } from '../src/shared/config.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('loadConfig', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // B1: Loads .cestdonerc.json from CWD, returns typed config
  it('loads .cestdonerc.json from the given directory', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-test-'))
    const config = { defaultModel: 'claude-sonnet-4-20250514', logLevel: 'debug' }
    fs.writeFileSync(path.join(tmpDir, '.cestdonerc.json'), JSON.stringify(config))

    const result = loadConfig(tmpDir)

    expect(result.defaultModel).toBe('claude-sonnet-4-20250514')
    expect(result.logLevel).toBe('debug')
    expect(result.targetRepoPath).toBe('.')
  })

  // B2: Returns defaults when no .cestdonerc.json exists
  it('returns defaults when .cestdonerc.json does not exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-test-'))

    const result = loadConfig(tmpDir)

    expect(result.defaultModel).toBe('claude-opus-4-20250514')
    expect(result.targetRepoPath).toBe('.')
    expect(result.logLevel).toBe('info')
  })
})

describe('resolveConfig', () => {
  const originalKey = process.env.ANTHROPIC_API_KEY

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalKey
    } else {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  // B3: Reads ANTHROPIC_API_KEY from process.env
  it('reads ANTHROPIC_API_KEY from process.env', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key-123'
    const config = loadConfig(os.tmpdir())

    const resolved = resolveConfig(config)

    expect(resolved.apiKey).toBe('sk-test-key-123')
    expect(resolved.defaultModel).toBe(config.defaultModel)
  })

  // B4: Throws clear error when API key missing
  it('throws clear error when ANTHROPIC_API_KEY is not set', () => {
    delete process.env.ANTHROPIC_API_KEY
    const config = loadConfig(os.tmpdir())

    expect(() => resolveConfig(config)).toThrow(
      'ANTHROPIC_API_KEY environment variable is required'
    )
  })
})

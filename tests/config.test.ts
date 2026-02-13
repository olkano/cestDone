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

  // M1: maxTurns defaults to 100 when not in .cestdonerc.json
  it('defaults maxTurns to 100', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-test-'))

    const result = loadConfig(tmpDir)

    expect(result.maxTurns).toBe(100)
  })

  // M2: maxBudgetUsd defaults to undefined when not set
  it('defaults maxBudgetUsd to undefined', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-test-'))

    const result = loadConfig(tmpDir)

    expect(result.maxBudgetUsd).toBeUndefined()
  })

  // M3: .cestdonerc.json with maxTurns: 50 overrides default
  it('reads maxTurns from .cestdonerc.json', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-test-'))
    const config = { maxTurns: 50, maxBudgetUsd: 5.0 }
    fs.writeFileSync(path.join(tmpDir, '.cestdonerc.json'), JSON.stringify(config))

    const result = loadConfig(tmpDir)

    expect(result.maxTurns).toBe(50)
    expect(result.maxBudgetUsd).toBe(5.0)
  })
})

describe('resolveConfig', () => {
  const originalKey = process.env.ANTHROPIC_API_KEY
  const originalCestdoneKey = process.env.CESTDONE_CLAUDE_API_KEY

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalKey
    } else {
      delete process.env.ANTHROPIC_API_KEY
    }
    if (originalCestdoneKey !== undefined) {
      process.env.CESTDONE_CLAUDE_API_KEY = originalCestdoneKey
    } else {
      delete process.env.CESTDONE_CLAUDE_API_KEY
    }
  })

  // B3: Reads ANTHROPIC_API_KEY from process.env
  it('reads ANTHROPIC_API_KEY from process.env', () => {
    delete process.env.CESTDONE_CLAUDE_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-test-key-123'
    const config = loadConfig(os.tmpdir())

    const resolved = resolveConfig(config)

    expect(resolved.apiKey).toBe('sk-test-key-123')
    expect(resolved.defaultModel).toBe(config.defaultModel)
  })

  // B4: Throws clear error when both API keys are missing
  it('throws clear error when no API key env var is set', () => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CESTDONE_CLAUDE_API_KEY
    const config = loadConfig(os.tmpdir())

    expect(() => resolveConfig(config)).toThrow(
      'CESTDONE_CLAUDE_API_KEY or ANTHROPIC_API_KEY'
    )
  })

  // B5: CESTDONE_CLAUDE_API_KEY takes priority over ANTHROPIC_API_KEY
  it('prefers CESTDONE_CLAUDE_API_KEY over ANTHROPIC_API_KEY', () => {
    process.env.CESTDONE_CLAUDE_API_KEY = 'sk-cestdone-key'
    process.env.ANTHROPIC_API_KEY = 'sk-anthropic-key'
    const config = loadConfig(os.tmpdir())

    const resolved = resolveConfig(config)

    expect(resolved.apiKey).toBe('sk-cestdone-key')
  })
})

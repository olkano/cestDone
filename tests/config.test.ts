// tests/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig } from '../src/shared/config.js'
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
    const config = { defaultModel: 'claude-sonnet-4-20250514' }
    fs.writeFileSync(path.join(tmpDir, '.cestdonerc.json'), JSON.stringify(config))

    const result = loadConfig(tmpDir)

    expect(result.defaultModel).toBe('claude-sonnet-4-20250514')
    expect(result.targetRepoPath).toBe('.')
  })

  // B2: Returns defaults when no .cestdonerc.json exists
  it('returns defaults when .cestdonerc.json does not exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-test-'))

    const result = loadConfig(tmpDir)

    expect(result.defaultModel).toBe('claude-opus-4-20250514')
    expect(result.targetRepoPath).toBe('.')
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


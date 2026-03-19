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
    const config = { maxTurns: 50 }
    fs.writeFileSync(path.join(tmpDir, '.cestdonerc.json'), JSON.stringify(config))

    const result = loadConfig(tmpDir)

    expect(result.maxTurns).toBe(50)
    expect(result.targetRepoPath).toBe('.')
  })

  // B2: Returns defaults when no .cestdonerc.json exists
  it('returns defaults when .cestdonerc.json does not exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-test-'))

    const result = loadConfig(tmpDir)

    expect(result.targetRepoPath).toBe('.')
    expect(result.maxTurns).toBe(100)
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

  // C1: New parameter fields default to undefined when not in .cestdonerc.json
  it('defaults new parameter fields to undefined', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-test-'))

    const result = loadConfig(tmpDir)

    expect(result.directorModel).toBeUndefined()
    expect(result.workerModel).toBeUndefined()
    expect(result.withWorker).toBeUndefined()
    expect(result.withReviews).toBeUndefined()
    expect(result.withBashReviews).toBeUndefined()
    expect(result.withHumanValidation).toBeUndefined()
  })

  // C2: Reads all new fields from .cestdonerc.json
  it('reads parameter fields from .cestdonerc.json', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-test-'))
    const config = {
      directorModel: 'opus',
      workerModel: 'sonnet',
      withWorker: true,
      withReviews: true,
      withBashReviews: false,
      withHumanValidation: true,
    }
    fs.writeFileSync(path.join(tmpDir, '.cestdonerc.json'), JSON.stringify(config))

    const result = loadConfig(tmpDir)

    expect(result.directorModel).toBe('opus')
    expect(result.workerModel).toBe('sonnet')
    expect(result.withWorker).toBe(true)
    expect(result.withReviews).toBe(true)
    expect(result.withBashReviews).toBe(false)
    expect(result.withHumanValidation).toBe(true)
  })

  // C3: Existing fields still merge correctly alongside new fields
  it('existing config fields work alongside new fields', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-test-'))
    const config = { maxTurns: 50, directorModel: 'haiku' }
    fs.writeFileSync(path.join(tmpDir, '.cestdonerc.json'), JSON.stringify(config))

    const result = loadConfig(tmpDir)

    expect(result.maxTurns).toBe(50)
    expect(result.directorModel).toBe('haiku')
    expect(result.withWorker).toBeUndefined()
  })

  // B1: Backend fields default to undefined
  it('defaults backend fields to undefined', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-test-'))

    const result = loadConfig(tmpDir)

    expect(result.directorBackend).toBeUndefined()
    expect(result.workerBackend).toBeUndefined()
    expect(result.claudeCliPath).toBeUndefined()
  })

  // B2: Reads backend fields from .cestdonerc.json
  it('reads backend fields from .cestdonerc.json', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-test-'))
    const config = {
      directorBackend: 'claude-cli',
      workerBackend: 'agent-sdk',
      claudeCliPath: '/usr/local/bin/claude',
    }
    fs.writeFileSync(path.join(tmpDir, '.cestdonerc.json'), JSON.stringify(config))

    const result = loadConfig(tmpDir)

    expect(result.directorBackend).toBe('claude-cli')
    expect(result.workerBackend).toBe('agent-sdk')
    expect(result.claudeCliPath).toBe('/usr/local/bin/claude')
  })
})


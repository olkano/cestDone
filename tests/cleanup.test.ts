// tests/cleanup.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { cleanupOldRuns, cleanupCentralLogs } from '../src/daemon/cleanup.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-cleanup-'))
  fs.mkdirSync(path.join(tmpDir, '.cestdone'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function createRunDir(specName: string, date: string, time: string): string {
  const dirName = `${specName}_${date}_${time}`
  const fullPath = path.join(tmpDir, '.cestdone', dirName)
  fs.mkdirSync(fullPath, { recursive: true })
  // Add a file inside so we verify recursive deletion
  fs.writeFileSync(path.join(fullPath, 'phase-0-report.md'), 'test')
  return dirName
}

describe('cleanupOldRuns', () => {
  // CL-1
  it('keeps all dirs when count <= maxRuns', () => {
    createRunDir('my-spec', '2026-03-01', '100000')
    createRunDir('my-spec', '2026-03-02', '100000')
    createRunDir('my-spec', '2026-03-03', '100000')

    const removed = cleanupOldRuns(tmpDir, 7)
    expect(removed).toEqual([])

    const remaining = fs.readdirSync(path.join(tmpDir, '.cestdone'))
    expect(remaining).toHaveLength(3)
  })

  // CL-2
  it('removes oldest dirs when count > maxRuns', () => {
    createRunDir('my-spec', '2026-03-01', '100000')
    createRunDir('my-spec', '2026-03-02', '100000')
    createRunDir('my-spec', '2026-03-03', '100000')
    createRunDir('my-spec', '2026-03-04', '100000')
    createRunDir('my-spec', '2026-03-05', '100000')

    const removed = cleanupOldRuns(tmpDir, 3)
    expect(removed).toHaveLength(2)
    expect(removed).toContain('my-spec_2026-03-01_100000')
    expect(removed).toContain('my-spec_2026-03-02_100000')

    const remaining = fs.readdirSync(path.join(tmpDir, '.cestdone'))
    expect(remaining).toHaveLength(3)
    expect(remaining).toContain('my-spec_2026-03-03_100000')
    expect(remaining).toContain('my-spec_2026-03-04_100000')
    expect(remaining).toContain('my-spec_2026-03-05_100000')
  })

  // CL-3
  it('groups by spec name independently', () => {
    createRunDir('spec-a', '2026-03-01', '100000')
    createRunDir('spec-a', '2026-03-02', '100000')
    createRunDir('spec-a', '2026-03-03', '100000')
    createRunDir('spec-b', '2026-03-01', '100000')
    createRunDir('spec-b', '2026-03-02', '100000')

    const removed = cleanupOldRuns(tmpDir, 2)
    expect(removed).toHaveLength(1)
    expect(removed).toContain('spec-a_2026-03-01_100000')

    // spec-b should be untouched (only 2 dirs, maxRuns=2)
    const remaining = fs.readdirSync(path.join(tmpDir, '.cestdone'))
    expect(remaining).toHaveLength(4)
  })

  // CL-4
  it('ignores non-matching directories and files', () => {
    createRunDir('my-spec', '2026-03-01', '100000')
    // Create a non-matching dir (like logs/)
    fs.mkdirSync(path.join(tmpDir, '.cestdone', 'logs'), { recursive: true })
    // Create a plan file
    fs.writeFileSync(path.join(tmpDir, '.cestdone', 'my-spec.plan.md'), 'plan')

    const removed = cleanupOldRuns(tmpDir, 7)
    expect(removed).toEqual([])

    // Non-matching entries still exist
    const remaining = fs.readdirSync(path.join(tmpDir, '.cestdone'))
    expect(remaining).toContain('logs')
    expect(remaining).toContain('my-spec.plan.md')
  })

  // CL-5
  it('defaults to maxRuns=7 when not specified', () => {
    for (let i = 1; i <= 9; i++) {
      createRunDir('my-spec', `2026-03-${String(i).padStart(2, '0')}`, '100000')
    }

    const removed = cleanupOldRuns(tmpDir) // no maxRuns arg
    expect(removed).toHaveLength(2)
    expect(removed).toContain('my-spec_2026-03-01_100000')
    expect(removed).toContain('my-spec_2026-03-02_100000')
  })

  // CL-6
  it('returns empty array when .cestdone dir does not exist', () => {
    const noDir = path.join(tmpDir, 'nonexistent')
    const removed = cleanupOldRuns(noDir)
    expect(removed).toEqual([])
  })

  // CL-7
  it('sorts by time within same date', () => {
    createRunDir('my-spec', '2026-03-15', '080000')
    createRunDir('my-spec', '2026-03-15', '120000')
    createRunDir('my-spec', '2026-03-15', '160000')

    const removed = cleanupOldRuns(tmpDir, 2)
    expect(removed).toHaveLength(1)
    expect(removed).toContain('my-spec_2026-03-15_080000')
  })

  // CL-8
  it('recursively deletes run dir contents', () => {
    const dirName = createRunDir('my-spec', '2026-03-01', '100000')
    createRunDir('my-spec', '2026-03-02', '100000')
    createRunDir('my-spec', '2026-03-03', '100000')

    // Verify the file exists before cleanup
    expect(fs.existsSync(path.join(tmpDir, '.cestdone', dirName, 'phase-0-report.md'))).toBe(true)

    cleanupOldRuns(tmpDir, 2)

    // Dir and its contents should be gone
    expect(fs.existsSync(path.join(tmpDir, '.cestdone', dirName))).toBe(false)
  })
})

describe('cleanupCentralLogs', () => {
  let centralDir: string

  beforeEach(() => {
    centralDir = path.join(tmpDir, 'central-logs')
    fs.mkdirSync(centralDir, { recursive: true })
  })

  function createLogFile(specName: string, date: string, time: string): string {
    const fileName = `${specName}_${date}_${time}.log`
    fs.writeFileSync(path.join(centralDir, fileName), 'log content')
    return fileName
  }

  // CCL-1
  it('keeps all logs when count <= maxLogs', () => {
    createLogFile('my-spec', '2026-03-01', '100000')
    createLogFile('my-spec', '2026-03-02', '100000')

    const removed = cleanupCentralLogs(centralDir, 7)
    expect(removed).toEqual([])
    expect(fs.readdirSync(centralDir)).toHaveLength(2)
  })

  // CCL-2
  it('removes oldest logs when count > maxLogs', () => {
    createLogFile('my-spec', '2026-03-01', '100000')
    createLogFile('my-spec', '2026-03-02', '100000')
    createLogFile('my-spec', '2026-03-03', '100000')
    createLogFile('my-spec', '2026-03-04', '100000')

    const removed = cleanupCentralLogs(centralDir, 2)
    expect(removed).toHaveLength(2)
    expect(removed).toContain('my-spec_2026-03-01_100000.log')
    expect(removed).toContain('my-spec_2026-03-02_100000.log')

    const remaining = fs.readdirSync(centralDir)
    expect(remaining).toHaveLength(2)
    expect(remaining).toContain('my-spec_2026-03-03_100000.log')
    expect(remaining).toContain('my-spec_2026-03-04_100000.log')
  })

  // CCL-3
  it('groups by spec name independently', () => {
    createLogFile('spec-a', '2026-03-01', '100000')
    createLogFile('spec-a', '2026-03-02', '100000')
    createLogFile('spec-a', '2026-03-03', '100000')
    createLogFile('spec-b', '2026-03-01', '100000')

    const removed = cleanupCentralLogs(centralDir, 2)
    expect(removed).toHaveLength(1)
    expect(removed).toContain('spec-a_2026-03-01_100000.log')
  })

  // CCL-4
  it('ignores non-matching files', () => {
    createLogFile('my-spec', '2026-03-01', '100000')
    fs.writeFileSync(path.join(centralDir, 'daemon.log'), 'daemon output')
    fs.writeFileSync(path.join(centralDir, 'notes.txt'), 'notes')

    const removed = cleanupCentralLogs(centralDir, 7)
    expect(removed).toEqual([])
    expect(fs.readdirSync(centralDir)).toHaveLength(3)
  })

  // CCL-5
  it('returns empty array when dir does not exist', () => {
    const removed = cleanupCentralLogs(path.join(tmpDir, 'nonexistent'))
    expect(removed).toEqual([])
  })

  // CCL-6
  it('defaults to maxLogs=7', () => {
    for (let i = 1; i <= 9; i++) {
      createLogFile('my-spec', `2026-03-${String(i).padStart(2, '0')}`, '100000')
    }

    const removed = cleanupCentralLogs(centralDir)
    expect(removed).toHaveLength(2)
  })
})

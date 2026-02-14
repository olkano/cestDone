// tests/spec-writer.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { createPlanFile, updatePhaseStatus, writePhaseCompletion } from '../src/shared/spec-writer.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function makeTmpSpec(content: string): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-writer-'))
  const filePath = path.join(dir, 'spec.md')
  fs.writeFileSync(filePath, content)
  return { dir, filePath }
}

const SAMPLE_SPEC = [
  '# Project',
  '',
  '## Context',
  'Some context.',
  '',
  '## House rules',
  'See `house-rules.md`.',
  '',
  '## Phase 0: Setup',
  '',
  '### Status: pending',
  '',
  '### Spec',
  'Set up the project structure.',
  '',
  '### Done',
  '_(to be filled)_',
  '',
  '## Phase 1: Features',
  '',
  '### Status: pending',
  '',
  '### Spec',
  'Build the features.',
  '',
  '### Done',
  '_(to be filled)_',
].join('\n')

describe('createPlanFile', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes plan content to file atomically', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-plan-'))
    const planPath = path.join(tmpDir, 'spec.plan.md')
    const content = '# Plan: Test\n\n## Phase 1: Setup\n### Status: pending\n### Spec\nDo stuff.\n### Done\n_(tbd)_\n'

    createPlanFile(planPath, content)

    const result = fs.readFileSync(planPath, 'utf-8')
    expect(result).toBe(content)
    // No leftover .tmp file
    const tmpFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tmp'))
    expect(tmpFiles).toHaveLength(0)
  })
})

describe('updatePhaseStatus', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // E1: Updates phase status (pending → in-progress) in spec file
  it('updates phase status from pending to in-progress', () => {
    const { dir, filePath } = makeTmpSpec(SAMPLE_SPEC)
    tmpDir = dir

    updatePhaseStatus(filePath, 0, 'in-progress')

    const result = fs.readFileSync(filePath, 'utf-8')
    expect(result).toContain('## Phase 0: Setup')
    expect(result).toMatch(/### Status: in-progress/)
    // Phase 1 unchanged
    const phase1Match = result.match(/## Phase 1[\s\S]*?### Status: (\S+)/)
    expect(phase1Match?.[1]).toBe('pending')
  })

  // E4: Preserves rest of file untouched when updating one phase
  it('preserves all other content when updating status', () => {
    const { dir, filePath } = makeTmpSpec(SAMPLE_SPEC)
    tmpDir = dir

    updatePhaseStatus(filePath, 0, 'in-progress')

    const result = fs.readFileSync(filePath, 'utf-8')
    expect(result).toContain('## Context')
    expect(result).toContain('Some context.')
    expect(result).toContain('Build the features.')
    expect(result).toContain('_(to be filled)_')
  })
})

describe('writePhaseCompletion', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // E2: Writes Done summary — clears Spec content to placeholder, populates Done
  it('clears Spec content and writes Done summary', () => {
    const { dir, filePath } = makeTmpSpec(SAMPLE_SPEC)
    tmpDir = dir

    writePhaseCompletion(filePath, 0, 'Built the scaffold. All tests pass.')

    const result = fs.readFileSync(filePath, 'utf-8')
    expect(result).toContain('### Status: done')
    expect(result).toContain('_See Done summary below._')
    expect(result).toContain('Built the scaffold. All tests pass.')
    expect(result).not.toContain('Set up the project structure.')
  })

  // E3: Write is atomic — uses temp file + rename
  it('writes atomically via temp file', () => {
    const { dir, filePath } = makeTmpSpec(SAMPLE_SPEC)
    tmpDir = dir

    writePhaseCompletion(filePath, 0, 'Done summary.')

    // Verify the file exists and is valid (atomic write succeeded)
    const result = fs.readFileSync(filePath, 'utf-8')
    expect(result).toContain('Done summary.')
    // No leftover .tmp file
    const tmpFiles = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))
    expect(tmpFiles).toHaveLength(0)
  })

  // E4b: Phase 1 is untouched when completing Phase 0
  it('does not modify other phases', () => {
    const { dir, filePath } = makeTmpSpec(SAMPLE_SPEC)
    tmpDir = dir

    writePhaseCompletion(filePath, 0, 'Phase 0 done.')

    const result = fs.readFileSync(filePath, 'utf-8')
    // Phase 1 still pending with original spec
    expect(result).toContain('### Status: pending')
    expect(result).toContain('Build the features.')
  })
})

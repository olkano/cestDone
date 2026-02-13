// tests/spec-parser.test.ts
import { describe, it, expect } from 'vitest'
import { parseSpec } from '../src/shared/spec-parser.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('parseSpec', () => {
  // D1: Parses single phase — extracts name, status, spec content, done content
  it('parses a single-phase spec with all fields', () => {
    const content = fs.readFileSync(path.resolve('tests/fixtures/valid-spec.md'), 'utf-8')

    const result = parseSpec(content)

    expect(result.title).toBe('Test Project')
    expect(result.phases).toHaveLength(1)
    expect(result.phases[0].number).toBe(0)
    expect(result.phases[0].name).toBe('Setup')
    expect(result.phases[0].status).toBe('pending')
    expect(result.phases[0].spec).toContain('Set up the project structure.')
    expect(result.phases[0].done).toContain('_(to be filled)_')
  })

  // D2: Parses multi-phase spec with pending/in-progress/done statuses
  it('parses multi-phase spec with various statuses', () => {
    const content = fs.readFileSync(path.resolve('tests/fixtures/multi-phase-spec.md'), 'utf-8')

    const result = parseSpec(content)

    expect(result.phases).toHaveLength(3)
    expect(result.phases[0].number).toBe(0)
    expect(result.phases[0].status).toBe('done')
    expect(result.phases[0].spec).toBe('_See Done summary below._')
    expect(result.phases[1].number).toBe(1)
    expect(result.phases[1].status).toBe('in-progress')
    expect(result.phases[2].number).toBe(3)
    expect(result.phases[2].status).toBe('pending')
  })

  // D3: Extracts Context and House rules as metadata
  it('extracts Context and House rules as metadata', () => {
    const content = fs.readFileSync(path.resolve('tests/fixtures/valid-spec.md'), 'utf-8')

    const result = parseSpec(content)

    expect(result.metadata.context).toContain('A simple test project for parser validation.')
    expect(result.metadata.houseRulesRef).toContain('house-rules.md')
  })

  // D4: Handles "last H1 heading" — ignores docs above the actual spec
  it('uses the last H1 heading as the spec start', () => {
    const content = [
      '# Documentation Header',
      'Some documentation text.',
      '',
      '# Actual Project',
      '',
      '## Context',
      'The real context.',
      '',
      '## House rules',
      'See `rules.md`.',
      '',
      '## Phase 0: Init',
      '',
      '### Status: pending',
      '',
      '### Spec',
      'Initialize everything.',
      '',
      '### Done',
      '_(to be filled)_',
    ].join('\n')

    const result = parseSpec(content)

    expect(result.title).toBe('Actual Project')
    expect(result.metadata.context).toContain('The real context.')
    expect(result.phases).toHaveLength(1)
  })

  // D5: Throws on malformed input — non-numeric phase number
  it('throws on non-numeric phase number', () => {
    const content = fs.readFileSync(path.resolve('tests/fixtures/malformed-spec.md'), 'utf-8')

    expect(() => parseSpec(content)).toThrow('Phase numbers must be integers')
  })

  // D5b: Throws on malformed input — missing ### Status
  it('throws when ### Status is missing', () => {
    const content = [
      '# Project',
      '',
      '## Context',
      'Some context.',
      '',
      '## House rules',
      'None.',
      '',
      '## Phase 0: Init',
      '',
      '### Spec',
      'Do stuff.',
      '',
      '### Done',
      '_(empty)_',
    ].join('\n')

    expect(() => parseSpec(content)).toThrow('Status')
  })

  // D5c: Throws on invalid status value
  it('throws on invalid status value', () => {
    const content = [
      '# Project',
      '',
      '## Context',
      'ctx.',
      '',
      '## House rules',
      'None.',
      '',
      '## Phase 0: Init',
      '',
      '### Status: blocked',
      '',
      '### Spec',
      'Do stuff.',
      '',
      '### Done',
      '_(empty)_',
    ].join('\n')

    expect(() => parseSpec(content)).toThrow('Invalid status')
  })

  // D6: Handles gaps in phase numbering (Phase 0, 1, 3 — no Phase 2)
  it('allows gaps in phase numbering', () => {
    const content = fs.readFileSync(path.resolve('tests/fixtures/multi-phase-spec.md'), 'utf-8')

    const result = parseSpec(content)
    const numbers = result.phases.map(p => p.number)

    expect(numbers).toEqual([0, 1, 3])
  })

  // D7: Resolves house-rules path relative to target dir; reads content when file exists
  it('resolves house-rules path and reads content when file exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-test-'))
    try {
      fs.writeFileSync(path.join(tmpDir, 'house-rules.md'), '# Rules\nUse TDD.')

      const content = [
        '# Project',
        '',
        '## Context',
        'Some context.',
        '',
        '## House rules',
        'See `house-rules.md` in repo root.',
        '',
        '## Phase 0: Init',
        '',
        '### Status: pending',
        '',
        '### Spec',
        'Do stuff.',
        '',
        '### Done',
        '_(empty)_',
      ].join('\n')

      const result = parseSpec(content, tmpDir)

      expect(result.metadata.houseRulesContent).toContain('Use TDD.')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // D7b: Warns but continues when house-rules file does not exist
  it('continues with undefined content when house-rules file is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-test-'))
    try {
      const content = [
        '# Project',
        '',
        '## Context',
        'Some context.',
        '',
        '## House rules',
        'See `house-rules.md`.',
        '',
        '## Phase 0: Init',
        '',
        '### Status: pending',
        '',
        '### Spec',
        'Do stuff.',
        '',
        '### Done',
        '_(empty)_',
      ].join('\n')

      const result = parseSpec(content, tmpDir)

      expect(result.metadata.houseRulesContent).toBeUndefined()
      expect(result.phases).toHaveLength(1)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

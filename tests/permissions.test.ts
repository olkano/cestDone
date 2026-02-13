// tests/permissions.test.ts
import { describe, it, expect } from 'vitest'
import { getAllowedTools } from '../src/coder/permissions.js'
import { WorkflowStep } from '../src/shared/types.js'

describe('getAllowedTools', () => {
  // N1: Steps 1, 4 return read-only tools
  it('returns read-only tools for Analyze step', () => {
    expect(getAllowedTools(WorkflowStep.Analyze)).toEqual(['Read', 'Glob', 'Grep'])
  })

  it('returns read-only tools for Plan step', () => {
    expect(getAllowedTools(WorkflowStep.Plan)).toEqual(['Read', 'Glob', 'Grep'])
  })

  // N2: Step 3 returns spec-editing tools
  it('returns spec-editing tools for UpdateSpec step', () => {
    expect(getAllowedTools(WorkflowStep.UpdateSpec)).toEqual(
      ['Read', 'Write', 'Edit', 'Glob', 'Grep']
    )
  })

  // N3: Step 6 returns full auto-edit tools
  it('returns full auto-edit tools for Execute step', () => {
    expect(getAllowedTools(WorkflowStep.Execute)).toEqual(
      ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep']
    )
  })

  // N4: Director-only steps throw
  it('throws for Clarify step (Director-only)', () => {
    expect(() => getAllowedTools(WorkflowStep.Clarify)).toThrow('no Coder call')
  })

  it('throws for ApprovePlan step (Director-only)', () => {
    expect(() => getAllowedTools(WorkflowStep.ApprovePlan)).toThrow('no Coder call')
  })

  it('throws for Review step (Director-only)', () => {
    expect(() => getAllowedTools(WorkflowStep.Review)).toThrow('no Coder call')
  })

  it('throws for Complete step (Director-only)', () => {
    expect(() => getAllowedTools(WorkflowStep.Complete)).toThrow('no Coder call')
  })
})

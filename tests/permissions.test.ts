// tests/permissions.test.ts
import { describe, it, expect } from 'vitest'
import { getTools } from '../src/coder/permissions.js'
import { WorkflowStep } from '../src/shared/types.js'

describe('getTools', () => {
  // N1: Step 1 returns read-only tools
  it('returns read-only tools for Analyze step', () => {
    expect(getTools(WorkflowStep.Analyze)).toEqual(['Read', 'Glob', 'Grep'])
  })

  // N2: Step 3 is Director-only (orchestrator writes spec directly)
  it('throws for CreatePlan step (Director-only)', () => {
    expect(() => getTools(WorkflowStep.CreatePlan)).toThrow('no Coder call')
  })

  // N3: Execute returns full auto-edit tools
  it('returns full auto-edit tools for Execute step', () => {
    expect(getTools(WorkflowStep.Execute)).toEqual(
      ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep']
    )
  })

  // N4: Director-only steps throw
  it('throws for Clarify step (Director-only)', () => {
    expect(() => getTools(WorkflowStep.Clarify)).toThrow('no Coder call')
  })

  it('throws for Review step (Director-only)', () => {
    expect(() => getTools(WorkflowStep.Review)).toThrow('no Coder call')
  })

  it('throws for Complete step (Director-only)', () => {
    expect(() => getTools(WorkflowStep.Complete)).toThrow('no Coder call')
  })
})

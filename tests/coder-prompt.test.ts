// tests/coder-prompt.test.ts
import { describe, it, expect } from 'vitest'
import { buildCoderPrompt } from '../src/coder/coder-prompt.js'
import { WorkflowStep } from '../src/shared/types.js'
import type { Phase } from '../src/shared/types.js'

const TEST_PHASE: Phase = {
  number: 1,
  name: 'Agent SDK integration',
  status: 'in-progress',
  spec: 'Connect Director to Coder via Agent SDK.',
  done: '_(to be filled)_',
}

describe('buildCoderPrompt', () => {
  // O1: Includes Director's instructions in prompt
  it('includes Director instructions', () => {
    const result = buildCoderPrompt({
      instructions: 'Implement the login endpoint using TDD.',
      phase: TEST_PHASE,
      step: WorkflowStep.Execute,
    })

    expect(result).toContain('Implement the login endpoint using TDD.')
  })

  // O2: House rules are NOT in the user prompt (they go in systemPrompt.append)
  it('does not include house-rules in the prompt', () => {
    const result = buildCoderPrompt({
      instructions: 'Do something.',
      phase: TEST_PHASE,
      step: WorkflowStep.Execute,
    })

    expect(result).not.toContain('House Rules')
  })

  // O3: Includes phase context (number, name, spec)
  it('includes phase context', () => {
    const result = buildCoderPrompt({
      instructions: 'Do something.',
      phase: TEST_PHASE,
      step: WorkflowStep.Execute,
    })

    expect(result).toContain('Phase 1')
    expect(result).toContain('Agent SDK integration')
    expect(result).toContain('Connect Director to Coder via Agent SDK.')
  })

  // O4: Includes reporting instructions
  it('includes reporting instructions', () => {
    const result = buildCoderPrompt({
      instructions: 'Do something.',
      phase: TEST_PHASE,
      step: WorkflowStep.Execute,
    })

    expect(result).toContain('cestdone-diff.txt')
    expect(result).toContain('test results')
  })

  // O5: Read-only steps include constraint about not modifying files
  it('includes read-only constraint for Analyze step', () => {
    const result = buildCoderPrompt({
      instructions: 'Analyze the codebase.',
      phase: TEST_PHASE,
      step: WorkflowStep.Analyze,
    })

    expect(result).toContain('Do NOT modify any files')
  })

  it('does not include read-only constraint for Execute step', () => {
    const result = buildCoderPrompt({
      instructions: 'Implement the feature.',
      phase: TEST_PHASE,
      step: WorkflowStep.Execute,
    })

    expect(result).not.toContain('Do NOT modify any files')
  })

  it('includes read-only constraint for Plan step', () => {
    const result = buildCoderPrompt({
      instructions: 'Create an implementation plan.',
      phase: TEST_PHASE,
      step: WorkflowStep.Plan,
    })

    expect(result).toContain('Do NOT modify any files')
  })
})

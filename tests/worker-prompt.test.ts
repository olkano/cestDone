// tests/worker-prompt.test.ts
import { describe, it, expect } from 'vitest'
import { buildWorkerPrompt } from '../src/worker/worker-prompt.js'
import { WorkflowStep } from '../src/shared/types.js'
import type { Phase } from '../src/shared/types.js'

const TEST_PHASE: Phase = {
  number: 1,
  name: 'Agent SDK integration',
  status: 'in-progress',
  spec: 'Connect Director to Worker via Agent SDK.',
  applicableRules: '',
  done: '_(to be filled)_',
}

const TEST_RUN_DIR = '.cestdone/test-spec_2026-03-20_120000'

describe('buildWorkerPrompt', () => {
  // O1: Includes Director's instructions in prompt
  it('includes Director instructions', () => {
    const result = buildWorkerPrompt({
      instructions: 'Implement the login endpoint using TDD.',
      phase: TEST_PHASE,
      step: WorkflowStep.Execute,
      runDir: TEST_RUN_DIR,
    })

    expect(result).toContain('Implement the login endpoint using TDD.')
  })

  // O2: House rules are NOT in the user prompt (they go in systemPrompt.append)
  it('does not include house-rules in the prompt', () => {
    const result = buildWorkerPrompt({
      instructions: 'Do something.',
      phase: TEST_PHASE,
      step: WorkflowStep.Execute,
      runDir: TEST_RUN_DIR,
    })

    expect(result).not.toContain('House Rules')
  })

  // O3: Includes phase context (number, name, spec)
  it('includes phase context', () => {
    const result = buildWorkerPrompt({
      instructions: 'Do something.',
      phase: TEST_PHASE,
      step: WorkflowStep.Execute,
      runDir: TEST_RUN_DIR,
    })

    expect(result).toContain('Phase 1')
    expect(result).toContain('Agent SDK integration')
    expect(result).toContain('Connect Director to Worker via Agent SDK.')
  })

  // O4: Includes reporting instructions with runDir paths
  it('includes reporting instructions with runDir paths', () => {
    const result = buildWorkerPrompt({
      instructions: 'Do something.',
      phase: TEST_PHASE,
      step: WorkflowStep.Execute,
      runDir: TEST_RUN_DIR,
    })

    expect(result).toContain(`${TEST_RUN_DIR}/cestdone-diff.txt`)
    expect(result).toContain('Test Results')
  })

  // O5: Read-only steps include constraint about not modifying files
  it('includes read-only constraint for Analyze step', () => {
    const result = buildWorkerPrompt({
      instructions: 'Analyze the codebase.',
      phase: TEST_PHASE,
      step: WorkflowStep.Analyze,
      runDir: TEST_RUN_DIR,
    })

    expect(result).toContain('Do NOT modify any files')
  })

  it('does not include read-only constraint for Execute step', () => {
    const result = buildWorkerPrompt({
      instructions: 'Implement the feature.',
      phase: TEST_PHASE,
      step: WorkflowStep.Execute,
      runDir: TEST_RUN_DIR,
    })

    expect(result).not.toContain('Do NOT modify any files')
  })

  // O6: Includes completed sub-phases context
  it('includes completed sub-phases when provided', () => {
    const result = buildWorkerPrompt({
      instructions: 'Implement sub-phase B.',
      phase: TEST_PHASE,
      step: WorkflowStep.Execute,
      runDir: TEST_RUN_DIR,
      completedSubPhases: ['Created models and migrations', 'Added API routes'],
    })

    expect(result).toContain('Previously Completed Sub-phases')
    expect(result).toContain('1. Created models and migrations')
    expect(result).toContain('2. Added API routes')
    expect(result).toContain('Do NOT redo them')
  })

  it('omits sub-phases section when none completed', () => {
    const result = buildWorkerPrompt({
      instructions: 'Implement sub-phase A.',
      phase: TEST_PHASE,
      step: WorkflowStep.Execute,
      runDir: TEST_RUN_DIR,
      completedSubPhases: [],
    })

    expect(result).not.toContain('Previously Completed Sub-phases')
  })

  it('includes compliance self-check section', () => {
    const result = buildWorkerPrompt({
      instructions: 'Implement the feature.',
      phase: TEST_PHASE,
      step: WorkflowStep.Execute,
      runDir: TEST_RUN_DIR,
    })

    expect(result).toContain('Compliance Self-Check')
    expect(result).toContain('Compliance Checklist')
    expect(result).toContain('Reference Component')
  })

  // O7: Includes phase report file path in reporting section
  it('includes phase report file path in reporting section', () => {
    const result = buildWorkerPrompt({
      instructions: 'Implement the feature.',
      phase: TEST_PHASE,
      step: WorkflowStep.Execute,
      runDir: TEST_RUN_DIR,
    })

    expect(result).toContain(`${TEST_RUN_DIR}/phase-1-report.md`)
  })

  // O8: Report path uses correct phase number
  it('uses correct phase number in report file path', () => {
    const phase3 = { ...TEST_PHASE, number: 3 }
    const result = buildWorkerPrompt({
      instructions: 'Implement the feature.',
      phase: phase3,
      step: WorkflowStep.Execute,
      runDir: TEST_RUN_DIR,
    })

    expect(result).toContain(`${TEST_RUN_DIR}/phase-3-report.md`)
  })
})

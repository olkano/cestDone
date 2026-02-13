// tests/model-selector.test.ts
import { describe, it, expect } from 'vitest'
import { selectModel, OPUS, SONNET } from '../src/director/model-selector.js'
import { WorkflowStep } from '../src/shared/types.js'

describe('selectModel', () => {
  // F1: Steps 1, 4 → Opus always
  it('returns Opus for Analyze step regardless of complexity', () => {
    expect(selectModel(WorkflowStep.Analyze, 'low')).toBe(OPUS)
    expect(selectModel(WorkflowStep.Analyze, 'high')).toBe(OPUS)
  })

  it('returns Opus for Plan step regardless of complexity', () => {
    expect(selectModel(WorkflowStep.Plan, 'low')).toBe(OPUS)
    expect(selectModel(WorkflowStep.Plan, 'high')).toBe(OPUS)
  })

  // F2: Steps 2, 3, 5 → Sonnet if low complexity, Opus if high
  it('returns Sonnet for Clarify step with low complexity', () => {
    expect(selectModel(WorkflowStep.Clarify, 'low')).toBe(SONNET)
  })

  it('returns Opus for Clarify step with high complexity', () => {
    expect(selectModel(WorkflowStep.Clarify, 'high')).toBe(OPUS)
  })

  it('returns Sonnet for UpdateSpec step with low complexity', () => {
    expect(selectModel(WorkflowStep.UpdateSpec, 'low')).toBe(SONNET)
  })

  it('returns Opus for ApprovePlan step with high complexity', () => {
    expect(selectModel(WorkflowStep.ApprovePlan, 'high')).toBe(OPUS)
  })

  // F3: Step 6 → Opus for high (full phase), Sonnet for low (small fix)
  it('returns Opus for Execute step with high complexity', () => {
    expect(selectModel(WorkflowStep.Execute, 'high')).toBe(OPUS)
  })

  it('returns Sonnet for Execute step with low complexity', () => {
    expect(selectModel(WorkflowStep.Execute, 'low')).toBe(SONNET)
  })

  // F4: Steps 7, 8 → Opus always
  it('returns Opus for Review step regardless of complexity', () => {
    expect(selectModel(WorkflowStep.Review, 'low')).toBe(OPUS)
    expect(selectModel(WorkflowStep.Review, 'high')).toBe(OPUS)
  })

  it('returns Opus for Complete step regardless of complexity', () => {
    expect(selectModel(WorkflowStep.Complete, 'low')).toBe(OPUS)
    expect(selectModel(WorkflowStep.Complete, 'high')).toBe(OPUS)
  })
})

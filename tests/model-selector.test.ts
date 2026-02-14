// tests/model-selector.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { selectModel, OPUS, SONNET } from '../src/director/model-selector.js'
import { WorkflowStep } from '../src/shared/types.js'

describe('selectModel', () => {
  const origModel = process.env.CESTDONE_MODEL

  beforeEach(() => {
    delete process.env.CESTDONE_MODEL
  })

  afterEach(() => {
    if (origModel !== undefined) {
      process.env.CESTDONE_MODEL = origModel
    } else {
      delete process.env.CESTDONE_MODEL
    }
  })

  // F1: Step 1 → Opus always
  it('returns Opus for Analyze step regardless of complexity', () => {
    expect(selectModel(WorkflowStep.Analyze, 'low')).toBe(OPUS)
    expect(selectModel(WorkflowStep.Analyze, 'high')).toBe(OPUS)
  })

  // F2: Steps 2, 4 → complexity-dependent (Clarify, Execute)
  it('returns Sonnet for Clarify step with low complexity', () => {
    expect(selectModel(WorkflowStep.Clarify, 'low')).toBe(SONNET)
  })

  it('returns Opus for Clarify step with high complexity', () => {
    expect(selectModel(WorkflowStep.Clarify, 'high')).toBe(OPUS)
  })

  it('returns Opus for CreatePlan step regardless of complexity', () => {
    expect(selectModel(WorkflowStep.CreatePlan, 'low')).toBe(OPUS)
    expect(selectModel(WorkflowStep.CreatePlan, 'high')).toBe(OPUS)
  })

  // F3: Execute → Opus for high (full phase), Sonnet for low (small fix)
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

  // ENV override: CESTDONE_MODEL overrides all selection logic
  it('returns CESTDONE_MODEL env var when set, ignoring step and complexity', () => {
    process.env.CESTDONE_MODEL = 'claude-haiku-4-20250514'

    expect(selectModel(WorkflowStep.Analyze, 'high')).toBe('claude-haiku-4-20250514')
    expect(selectModel(WorkflowStep.Execute, 'low')).toBe('claude-haiku-4-20250514')
    expect(selectModel(WorkflowStep.Review, 'high')).toBe('claude-haiku-4-20250514')
  })
})

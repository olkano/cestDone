// src/director/model-selector.ts
import { WorkflowStep, type Complexity } from '../shared/types.js'

export const OPUS = 'claude-opus-4-20250514'
export const SONNET = 'claude-sonnet-4-20250514'

const ALWAYS_OPUS: WorkflowStep[] = [
  WorkflowStep.Analyze,
  WorkflowStep.Plan,
  WorkflowStep.Review,
  WorkflowStep.Complete,
]

export function selectModel(step: WorkflowStep, complexity: Complexity): string {
  if (ALWAYS_OPUS.includes(step)) {
    return OPUS
  }
  // Steps 2, 3, 5, 6: complexity-dependent
  return complexity === 'high' ? OPUS : SONNET
}

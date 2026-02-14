// src/director/model-selector.ts
import { WorkflowStep, type Complexity } from '../shared/types.js'

export const OPUS = 'claude-opus-4-20250514'
export const SONNET = 'claude-sonnet-4-20250514'

const ALWAYS_OPUS: WorkflowStep[] = [
  WorkflowStep.Analyze,
  WorkflowStep.CreatePlan,
  WorkflowStep.Plan,
  WorkflowStep.Review,
  WorkflowStep.Complete,
]

/**
 * Returns the model to use for a given workflow step.
 *
 * If `CESTDONE_MODEL` env var is set, it overrides ALL selection logic
 * and that model is used for every call (Director + Coder).
 *
 * TODO: Split into separate env vars for finer control:
 *   - CESTDONE_DIRECTOR_MODEL — model for Director reasoning calls
 *   - CESTDONE_CODER_MODEL    — model for Coder execution calls
 *   - Let Director pick model per-phase based on complexity
 */
export function selectModel(step: WorkflowStep, complexity: Complexity): string {
  const override = process.env.CESTDONE_MODEL
  if (override) {
    return override
  }

  if (ALWAYS_OPUS.includes(step)) {
    return OPUS
  }
  // Steps 2, 3, 5, 6: complexity-dependent
  return complexity === 'high' ? OPUS : SONNET
}

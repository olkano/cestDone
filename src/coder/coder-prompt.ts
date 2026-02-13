// src/coder/coder-prompt.ts
import { WorkflowStep } from '../shared/types.js'
import type { Phase } from '../shared/types.js'

export interface CoderPromptInput {
  instructions: string
  phase: Phase
  step: WorkflowStep
  completedSubPhases?: string[]
}

const READ_ONLY_STEPS = [WorkflowStep.Analyze, WorkflowStep.Plan]

export function buildCoderPrompt(input: CoderPromptInput): string {
  const parts: string[] = []

  parts.push(`## Phase ${input.phase.number}: ${input.phase.name}`)
  parts.push('')
  parts.push('### Phase Spec')
  parts.push(input.phase.spec)
  parts.push('')

  if (input.completedSubPhases && input.completedSubPhases.length > 0) {
    parts.push('### Previously Completed Sub-phases')
    input.completedSubPhases.forEach((summary, i) => {
      parts.push(`${i + 1}. ${summary}`)
    })
    parts.push('')
    parts.push('The above sub-phases are already implemented and tested. Do NOT redo them.')
    parts.push('Build on top of the existing code.')
    parts.push('')
  }

  if (READ_ONLY_STEPS.includes(input.step)) {
    parts.push('**CONSTRAINT:** Do NOT modify any files. Read and analyze only.')
    parts.push('')
  }

  parts.push('### Instructions')
  parts.push(input.instructions)
  parts.push('')

  parts.push('### Reporting')
  parts.push('After modifications, write the diff to `cestdone-diff.txt` in the repo root:')
  parts.push('`git --no-pager diff > cestdone-diff.txt`')
  parts.push('Also report: test results (raw output from test runner), `tsc --noEmit` output, and a list of files changed.')

  return parts.join('\n')
}

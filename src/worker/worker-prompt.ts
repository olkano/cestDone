// src/worker/worker-prompt.ts
import { WorkflowStep } from '../shared/types.js'
import type { Phase } from '../shared/types.js'

export interface WorkerPromptInput {
  instructions: string
  phase: Phase
  step: WorkflowStep
  completedSubPhases?: string[]
}

const READ_ONLY_STEPS = [WorkflowStep.Analyze]

export function buildWorkerPrompt(input: WorkerPromptInput): string {
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

  parts.push('### Testing')
  parts.push('Run tests in non-interactive mode (no watch mode). Run type checks if applicable.')
  parts.push('If tests require starting a server or background process, kill it when tests are done.')
  parts.push('')

  parts.push('### Reporting')
  parts.push(`After modifications, write your report to \`.cestdone/reports/phase-${input.phase.number}-report.md\`:`)
  parts.push('- Status: success | partial | failed')
  parts.push('- Summary: what was implemented')
  parts.push('- Files Changed: list of files')
  parts.push('- Test Results: raw output from test runner')
  parts.push('- Issues: any blockers or concerns')
  parts.push('')
  parts.push('Also write the diff to `cestdone-diff.txt` in the repo root:')
  parts.push('`git --no-pager diff > cestdone-diff.txt`')

  return parts.join('\n')
}

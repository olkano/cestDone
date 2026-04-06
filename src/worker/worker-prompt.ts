// src/worker/worker-prompt.ts
import { WorkflowStep } from '../shared/types.js'
import type { Phase } from '../shared/types.js'

export interface WorkerPromptInput {
  instructions: string
  phase: Phase
  step: WorkflowStep
  runDir: string
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

  parts.push('### Available CLI Tools')
  parts.push('- `cestdone send-email --to <addr> --subject <subj> --body <text> [--html <html>]` — send email notifications via SMTP (pre-configured)')
  parts.push('')

  parts.push('### External Operations')
  parts.push('When running git push, deployment scripts, merge scripts, or API calls:')
  parts.push('- Use a long Bash timeout (e.g., 300000 ms / 5 minutes) to avoid premature timeouts.')
  parts.push('- Retry up to 3 times on failure or timeout before reporting them as failures in your report.')
  parts.push('- These operations are critical -- a phase is NOT complete if they fail.')
  parts.push('')

  parts.push('### Testing')
  parts.push('If this phase changes code, run tests in non-interactive mode (no watch mode) and type checks if applicable.')
  parts.push('Kill any servers or background processes when done.')
  parts.push('')

  parts.push('### Compliance Self-Check')
  parts.push('Before writing your report, re-read the phase spec. If it contains a #### Compliance Checklist,')
  parts.push('verify each item against your implementation. If it contains a #### Reference Component,')
  parts.push('confirm you matched the referenced patterns. Flag deviations in your report under Issues.')
  parts.push('')

  parts.push('### Reporting')
  parts.push(`After modifications, write your report to \`${input.runDir}/phase-${input.phase.number}-report.md\`:`)
  parts.push('- Status: success | partial | failed')
  parts.push('- Summary: what was implemented')
  parts.push('- Files Changed: list of files')
  parts.push('- Test Results: raw output from test runner (if applicable)')
  parts.push('- Issues: any blockers or concerns')
  parts.push('')
  parts.push(`Also write the diff to \`${input.runDir}/cestdone-diff.txt\`:`)
  parts.push(`\`git --no-pager diff > ${input.runDir}/cestdone-diff.txt\``)

  return parts.join('\n')
}

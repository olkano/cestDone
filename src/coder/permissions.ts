// src/coder/permissions.ts
import { WorkflowStep } from '../shared/types.js'

const READ_ONLY = ['Read', 'Glob', 'Grep']
const FULL_EDIT = ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep']

export function getTools(step: WorkflowStep): string[] {
  switch (step) {
    case WorkflowStep.Analyze:
      return READ_ONLY
    case WorkflowStep.Execute:
      return FULL_EDIT
    default:
      throw new Error(`Step ${step} is Director-only — no Coder call`)
  }
}

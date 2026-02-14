// src/director/prompts.ts
import { WorkflowStep } from '../shared/types.js'
import type { Phase, FreeFormSpec, Plan } from '../shared/types.js'

export const DIRECTOR_RESPONSE_SCHEMA = {
  type: 'object' as const,
  properties: {
    action: {
      type: 'string',
      enum: ['analyze', 'ask_human', 'approve', 'fix', 'continue', 'done', 'escalate'],
    },
    message: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['action', 'message'],
}

export function buildDirectorTools(step: WorkflowStep): string[] {
  const READ_ONLY = ['Read', 'Glob', 'Grep']
  const READ_BASH = ['Read', 'Glob', 'Grep', 'Bash']

  switch (step) {
    case WorkflowStep.Review:
      return READ_BASH
    default:
      return READ_ONLY
  }
}

export function buildClarifyPrompt(questions: string[], answers: string[]): string {
  const clarifications = questions
    .map((q, i) => `Q: ${q}\nA: ${answers[i]}`)
    .join('\n\n')

  return [
    'You asked these questions about the spec:',
    '',
    clarifications,
    '',
    'Based on these clarifications, are there any remaining ambiguities?',
    'If clear, indicate ready to proceed.',
  ].join('\n')
}

export function buildInitialCoderInstructions(plan: Plan, phase: Phase, completedPhases: Phase[]): string {
  const parts: string[] = [
    '## Project: ' + plan.title,
    '',
    '## Context',
    plan.context,
    '',
    '## Tech Stack',
    plan.techStack,
  ]

  if (completedPhases.length > 0) {
    parts.push('', '## Previously Completed Phases')
    for (const p of completedPhases) {
      parts.push(`### Phase ${p.number}: ${p.name}`, p.done)
    }
  }

  parts.push(
    '',
    '## Your Task',
    `Implement Phase ${phase.number}: ${phase.name}`,
    '',
    'Read the phase spec above, explore the codebase, determine implementation order, and execute.',
    'If the work is large, implement incrementally and ensure tests pass at each step.',
  )

  return parts.join('\n')
}

export function buildReviewPrompt(phaseSpec: string, coderReport: string, completedSubPhases: string[] = []): string {
  const parts: string[] = [
    '## Phase Spec',
    phaseSpec,
    '',
    '## Coder Report',
    coderReport,
  ]

  if (completedSubPhases.length > 0) {
    parts.push('', '## Previously Completed Sub-phases')
    completedSubPhases.forEach((summary, i) => {
      parts.push(`### Sub-phase ${i + 1}`, summary)
    })
  }

  parts.push(
    '',
    '## Task',
    'Verify the implementation:',
    '1. Read the files the Coder changed',
    '2. Run `npm test` (or equivalent) via Bash',
    '3. Run `tsc --noEmit` if TypeScript',
    "4. Check that the plan's requirements are met so far",
    '',
    "Report: what works, what's broken, what's missing.",
    '',
    '## Git Commits',
    'If tests pass and the work is correct, commit the changes before responding:',
    '```',
    'git add -A',
    'git commit -m "cestdone: <concise description of what was built>"',
    '```',
    'Do NOT commit if tests fail, types have errors, or the implementation is incomplete.',
    '',
    '## Response Actions',
    '- **fix**: Issues found. Do NOT commit. Return specific fix instructions for the Coder.',
    '- **continue**: Current sub-phase is correct, committed, AND more sub-phases remain.',
    '  Include the next sub-phase instructions in your message.',
    '- **done**: All sub-phases are complete, verified, and committed. Everything passes.',
  )

  return parts.join('\n')
}

export function buildCompletePrompt(phase: Phase): string {
  return [
    `Phase ${phase.number}: ${phase.name} is complete.`,
    'Write a concise Done summary (under 10 lines) covering:',
    'what was built, key files changed, and any spec deviations.',
  ].join('\n')
}

// === Planning flow prompts ===

export function buildPlanningSystemPrompt(spec: FreeFormSpec): string {
  const parts: string[] = [
    'You are the Director of cestdone, an AI-orchestrated development system.',
    'Your role is to analyze the user\'s requirements, ask clarifying questions, and create a structured implementation plan.',
    '',
    '## User Spec',
    spec.text,
  ]

  if (spec.houseRulesContent) {
    parts.push('', '## House Rules', spec.houseRulesContent)
  }

  parts.push(
    '',
    '## Output Format',
    'Always respond with a JSON object containing action, message, and optionally questions.',
    'Use the questions field only with the ask_human action.',
  )

  return parts.join('\n')
}

export function buildFreeFormAnalyzePrompt(spec: FreeFormSpec): string {
  const parts: string[] = [
    'You are analyzing a free-form project specification.',
    '',
    '## Spec',
    spec.text,
  ]

  if (spec.houseRulesContent) {
    parts.push('', '## House Rules', spec.houseRulesContent)
  }

  parts.push(
    '',
    '## Current Codebase',
    'Explore the project using Read/Glob/Grep to understand existing code (if any).',
    '',
    '## Task',
    'List clarifying questions about requirements, ambiguities, or assumptions.',
    'The spec is free-form text — extract what you can and identify what\'s missing.',
    'If the spec is clear enough to proceed, say so.',
    'Do NOT make any file changes.',
  )

  return parts.join('\n')
}

export function buildCreatePlanPrompt(spec: FreeFormSpec, clarifications: string): string {
  const parts: string[] = [
    '## Spec',
    spec.text,
  ]

  if (clarifications) {
    parts.push('', '## Clarifications', clarifications)
  }

  parts.push(
    '',
    '## Task',
    'Create a structured implementation plan. Return the full plan content in your message field.',
    'The plan must follow this exact format:',
    '',
    '```',
    '# Plan: <project title>',
    '',
    '## Context',
    '<description derived from spec + Q&A>',
    '',
    '## Tech Stack',
    '<extracted/decided technologies>',
    '',
    '## House Rules',
    '<house rules that apply to this project>',
    '',
    '## Phase 1: <name>',
    '### Status: pending',
    '### Spec',
    '<detailed phase specification>',
    '### Applicable Rules',
    '<only the house rules relevant to THIS phase>',
    '### Done',
    '_(to be filled)_',
    '```',
    '',
    'Guidelines:',
    '- Each phase should be a discrete, testable deliverable',
    '- Include only the relevant house rules in each phase\'s ### Applicable Rules',
    '- Number phases starting from 1',
    '- Each phase spec should be self-contained enough for a Coder to work on independently',
    'Do NOT write code yet.',
  )

  return parts.join('\n')
}

export function buildRevisePlanPrompt(currentPlan: string, feedback: string): string {
  return [
    '## Current Plan',
    currentPlan,
    '',
    '## Feedback',
    feedback,
    '',
    '## Task',
    'Revise the plan based on the feedback above.',
    'Return the full revised plan content in your message field.',
    'Keep the same format (# Plan:, ## Context, ## Tech Stack, ## House Rules, ## Phase N:, etc.).',
  ].join('\n')
}

export function buildExecutionSystemPrompt(plan: Plan, completedPhases: Phase[]): string {
  const parts: string[] = [
    'You are the Director of cestdone, an AI-orchestrated development system.',
    'Your role is to analyze specs, create plans, and guide implementation.',
    '',
    '## Project: ' + plan.title,
    '',
    '## Context',
    plan.context,
    '',
    '## Tech Stack',
    plan.techStack,
  ]

  if (plan.houseRules) {
    parts.push('', '## House Rules', plan.houseRules)
  }

  if (completedPhases.length > 0) {
    parts.push('', '## Completed Phases')
    for (const phase of completedPhases) {
      parts.push(`### Phase ${phase.number}: ${phase.name}`, phase.done)
    }
  }

  parts.push(
    '',
    '## Output Format',
    'Always respond with a JSON object containing action, message, and optionally questions.',
    'Use the questions field only with the ask_human action.',
  )

  return parts.join('\n')
}

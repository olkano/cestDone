// src/director/prompts.ts
import type { Phase, SpecMetadata } from '../shared/types.js'

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

export function buildDirectorSystemPrompt(metadata: SpecMetadata, completedPhases: Phase[]): string {
  const parts: string[] = [
    'You are the Director of cestdone, an AI-orchestrated development system.',
    'Your role is to analyze specs, create plans, and guide implementation.',
    '',
    '## Project Context',
    metadata.context,
  ]

  if (metadata.houseRulesContent) {
    parts.push('', '## House Rules', metadata.houseRulesContent)
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

export function buildDirectorTools(step: number): string[] {
  const READ_ONLY = ['Read', 'Glob', 'Grep']
  const READ_BASH = ['Read', 'Glob', 'Grep', 'Bash']

  switch (step) {
    case 7: // Review — needs Bash for running tests
      return READ_BASH
    default:
      return READ_ONLY
  }
}

export function buildAnalyzePrompt(phase: Phase, specContent: string): string {
  return [
    'You are analyzing a software project for implementation.',
    '',
    '## Spec',
    specContent,
    '',
    `## Phase ${phase.number}: ${phase.name}`,
    '',
    '### Phase Spec',
    phase.spec,
    '',
    '## Current Codebase',
    'Explore the project using Read/Glob/Grep to understand existing code.',
    '',
    '## Task',
    'List clarifying questions about requirements, ambiguities, or assumptions.',
    'If the spec is clear enough to proceed, say so.',
    'Do NOT make any file changes.',
  ].join('\n')
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

export function buildUpdateSpecPrompt(specContent: string, clarificationsText: string): string {
  return [
    '## Original Spec',
    specContent,
    '',
    '## Clarifications',
    clarificationsText,
    '',
    '## Task',
    'Produce an updated spec that incorporates all clarifications.',
    'Return the full updated spec text in your message field.',
    'Do NOT modify any files — just return the text.',
  ].join('\n')
}

export function buildPlanPrompt(phase: Phase, updatedSpec: string): string {
  return [
    '## Updated Spec',
    updatedSpec,
    '',
    `## Phase ${phase.number}: ${phase.name}`,
    '',
    '## Current Codebase',
    'Explore the project using Read/Glob/Grep to understand what already exists.',
    '',
    '## Task',
    'Produce a detailed implementation plan as a numbered list of tasks.',
    "Consider existing code — don't plan work that's already done.",
    'Include: file paths, function signatures, TDD sequence (which tests first), and a TODO checklist.',
    '',
    '## Sub-phase Chunking',
    'If the plan is too large for a single Coder session (~15-25 turns), break it into sub-phases.',
    'Each sub-phase should be a discrete, testable feature that:',
    '- Can be implemented in 15-25 Coder turns',
    '- Ends with all tests passing and a clean state',
    '- Builds on previous sub-phases without breaking them',
    'Label sub-phases clearly: **Sub-phase A**, **Sub-phase B**, etc.',
    'If the plan fits in one session, a single sub-phase is fine.',
    '',
    'Do NOT write code yet.',
  ].join('\n')
}

export function buildReviewPrompt(plan: string, coderReport: string, completedSubPhases: string[] = []): string {
  const parts: string[] = [
    '## Implementation Plan',
    plan,
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

// src/director/prompts.ts
import { WorkflowStep } from '../shared/types.js'
import type { Phase, FreeFormSpec, Plan } from '../shared/types.js'
import type { EnvironmentInfo } from '../shared/environment.js'

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
    'The human answered your questions:',
    '',
    clarifications,
    '',
    'Based on these answers, do any NEW questions arise that are essential for creating the plan and implement it?',
    'For example, if the human said "yes, add polling", you may need to ask about polling interval.',
    '',
    'Rules:',
    '- Each question MUST include a recommendation.',
    '- If no follow-up is needed, respond with action "approve" to proceed to plan creation.',
    '- Do NOT repeat questions already answered.',
  ].join('\n')
}

export function buildInitialCoderInstructions(plan: Plan, phase: Phase, completedPhases: Phase[], env?: EnvironmentInfo): string {
  const parts: string[] = [
    '## Project: ' + plan.title,
    '',
    '## Context',
    plan.context,
    '',
    '## Tech Stack',
    plan.techStack,
  ]

  if (env) {
    parts.push('', '## Environment', env.summary)
  }

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
    'Run tests in non-interactive mode (no watch mode). Kill any servers or background processes when done.',
  )

  return parts.join('\n')
}

export function buildReviewPrompt(phaseNumber: number, phaseName: string, phaseSpec: string, coderReport: string, completedSubPhases: string[] = []): string {
  const parts: string[] = [
    `## You are reviewing: Phase ${phaseNumber} — ${phaseName}`,
    '',
    '## Phase Spec',
    phaseSpec,
    '',
    '## Coder Report',
    coderReport,
  ]

  if (completedSubPhases.length > 0) {
    parts.push('', '## Previously Completed Sub-phases (within this phase)')
    completedSubPhases.forEach((summary, i) => {
      parts.push(`### Sub-phase ${i + 1}`, summary)
    })
  }

  parts.push(
    '',
    '## Task',
    'Review the Coder\'s work. The Coder already ran tests and type checks — do NOT re-run them.',
    'Focus on what the Coder cannot self-verify: code quality, spec compliance, and integration.',
    '',
    '### 1. Code Review (mandatory)',
    'Read the diff (`cestdone-diff.txt`) or changed files. Assess:',
    '- **Correctness**: Does the logic implement what the phase spec requires?',
    '- **Completeness**: Missing edge cases, TODO stubs, or unhandled errors?',
    '- **Quality**: Clean, well-structured, consistent with existing codebase?',
    '- **Security**: Obvious vulnerabilities (injection, hardcoded secrets, etc.)?',
    '',
    '### 2. Functional Verification (only when needed)',
    'Only do this when the phase delivers user-visible behavior that unit tests cannot cover,',
    'such as a web endpoint, CLI command, or UI interaction.',
    'If you determine functional testing is needed:',
    '- Start any required servers or processes',
    '- Verify the behavior works as specified',
    '- **IMPORTANT: Kill all servers and background processes when done**',
    '',
    'Skip this step entirely if the Coder\'s test results already cover the functionality.',
    '',
    '### 3. Requirements Check',
    'Compare delivered code against the phase spec. Flag anything missing or divergent.',
    '',
    '## Git Commits',
    'If the work is correct, commit before responding:',
    '```',
    'git add -A',
    'git commit -m "cestDone: <concise description of what was built>"',
    '```',
    'Do NOT commit if the Coder reported test failures or the implementation is incomplete.',
    '',
    '## Response Actions',
    `Your scope is ONLY Phase ${phaseNumber} (${phaseName}). Do NOT plan or include work for subsequent phases.`,
    '',
    '- **fix**: Issues found. Do NOT commit. Return specific fix instructions for the Coder.',
    '- **continue**: Current sub-phase correct and committed, but more sub-phases remain WITHIN THIS PHASE.',
    '  Do NOT use "continue" to advance to the next plan phase — that is handled automatically.',
    `- **done**: Phase ${phaseNumber} is complete — all deliverables verified and committed.`,
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

export function buildPlanningSystemPrompt(spec: FreeFormSpec, env?: EnvironmentInfo): string {
  const parts: string[] = [
    'You are the Director of cestDone, an AI-orchestrated development system.',
    'Your role spans the full project lifecycle:',
    '1. Analyze specs and ask clarifying questions',
    '2. Create structured implementation plans',
    '3. Oversee Coder execution of each phase',
    '4. Review code quality and verify functionality',
    '5. Track progress and provide completion summaries',
    '',
    'This is a continuous session — you retain full context from prior steps.',
    'Do not re-read files you have already seen unless checking for changes made by the Coder.',
  ]

  if (env) {
    parts.push('', '## Environment', env.summary)
  }

  parts.push('', '## User Spec', spec.text)

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
    'Analyze the spec and identify essential questions — things that, if assumed wrong,',
    'would lead to building the wrong thing or require significant rework.',
    '',
    'Guidelines for questions:',
    '- Do NOT pad with generic or obvious questions.',
    '- Every question MUST include your recommended answer in parentheses, e.g.:',
    '  "What database should we use? (Recommended: PostgreSQL, since the spec mentions relational data)"',
    '- Focus on functionality assumptions: if the spec says "authentication" but doesn\'t say how,',
    '  that\'s essential. If the spec says "use JWT", don\'t ask about JWT — it\'s already decided.',
    '- Do NOT ask about things you can infer from the codebase or house rules.',
    '- Do NOT ask about implementation details the Coder can figure out (file structure, naming, etc.).',
    '',
    'If the spec + codebase + house rules leave no critical ambiguities, say so and proceed.',
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

export function buildExecutionSystemPrompt(plan: Plan, completedPhases: Phase[], env?: EnvironmentInfo): string {
  const parts: string[] = [
    'You are the Director of cestDone, an AI-orchestrated development system.',
    'Your role is to review code quality, verify functionality, and guide implementation.',
  ]

  if (env) {
    parts.push('', '## Environment', env.summary)
  }

  parts.push(
    '',
    '## Project: ' + plan.title,
    '',
    '## Context',
    plan.context,
    '',
    '## Tech Stack',
    plan.techStack,
  )

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

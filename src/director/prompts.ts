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

export interface DirectorToolOptions {
  withBash?: boolean
  directorOnly?: boolean
}

export function buildDirectorTools(step: WorkflowStep, options?: DirectorToolOptions): string[] {
  const READ_ONLY = ['Read', 'Glob', 'Grep']
  const FULL_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep']
  const READ_BASH = ['Read', 'Glob', 'Grep', 'Bash']

  if (step === WorkflowStep.Execute && options?.directorOnly) {
    return FULL_TOOLS
  }

  switch (step) {
    case WorkflowStep.Review: {
      const includeBash = options?.withBash !== false // undefined (legacy) = true
      return includeBash ? READ_BASH : READ_ONLY
    }
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

export function buildInitialWorkerInstructions(plan: Plan, phase: Phase, completedPhases: Phase[], env?: EnvironmentInfo): string {
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

export function buildReviewPrompt(phaseNumber: number, phaseName: string, phaseSpec: string, workerReport: string, runDir: string, completedSubPhases: string[] = [], autoCommit: boolean = true): string {
  const parts: string[] = [
    `## You are reviewing: Phase ${phaseNumber} — ${phaseName}`,
    '',
    '## Phase Spec',
    phaseSpec,
    '',
    `## Worker Report (from ${runDir}/phase-${phaseNumber}-report.md)`,
    workerReport,
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
    'Review the Worker\'s work. The Worker already ran tests and type checks — do NOT re-run them.',
    'Focus on what the Worker cannot self-verify: code quality, spec compliance, and integration.',
    '',
    '### 1. Code Review (mandatory)',
    `Read the diff (\`${runDir}/cestdone-diff.txt\`) or changed files. Assess:`,
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
    'Skip this step entirely if the Worker\'s test results already cover the functionality.',
    '',
    '### 3. Spec Compliance (mandatory)',
    'Go through the phase spec point by point:',
    '- If the spec contains a #### Compliance Checklist, verify every item. A failed item is a `fix`.',
    '- If the spec names a #### Reference Component, compare the implementation against those patterns. Deviations are a `fix`.',
    '- Compare each stated requirement against delivered code. Spec deviations are a `fix`, not informational — only the human can approve deviations.',
    '- **External operations** (git push, deployments, merge scripts, API calls) that failed or timed out are NEVER acceptable as "done". Return `fix` with instructions to retry using longer timeouts. Environmental failures are still failures.',
    '',
    '### 4. Test Coverage',
    'Read the phase spec and the Worker\'s test files. Identify untested scenarios:',
    'edge cases, negative paths, accessibility, guard rails, and boundary conditions.',
    'If significant gaps exist (core spec requirements untested), respond with `fix` and list them.',
    '',
    ...(autoCommit
      ? [
        '## Git Commits',
        'If the work is correct, commit before responding:',
        '```',
        'git add -A',
        'git commit -m "cestDone: <concise description of what was built>"',
        '```',
        'Do NOT commit if the Worker reported test failures or the implementation is incomplete.',
      ]
      : [
        '## Git Policy',
        'Do NOT commit any changes — the user will commit manually.',
      ]),
    '',
    '## Response Actions',
    `Your scope is ONLY Phase ${phaseNumber} (${phaseName}). Do NOT plan or include work for subsequent phases.`,
    '',
    'IMPORTANT: You MUST use one of these three actions ONLY — no other action is valid for a review:',
    ...(autoCommit
      ? [
        '- **fix**: Issues found. Do NOT commit. Return specific fix instructions for the Worker.',
        '- **continue**: Current sub-phase correct and committed, but more sub-phases remain WITHIN THIS PHASE.',
        '  Do NOT use "continue" to advance to the next plan phase — that is handled automatically.',
        `- **done**: Phase ${phaseNumber} is complete — all deliverables verified and committed.`,
      ]
      : [
        '- **fix**: Issues found. Return specific fix instructions for the Worker.',
        '- **continue**: Current sub-phase correct, but more sub-phases remain WITHIN THIS PHASE.',
        '  Do NOT use "continue" to advance to the next plan phase — that is handled automatically.',
        `- **done**: Phase ${phaseNumber} is complete — all deliverables verified.`,
      ]),
    '',
    'Do NOT use "analyze", "approve", "ask_human", or any other action. Only "fix", "continue", or "done".',
  )

  return parts.join('\n')
}

export function buildDirectorExecutionPrompt(plan: Plan, phase: Phase, completedPhases: Phase[], env?: EnvironmentInfo): string {
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
    `## Execute Phase ${phase.number}: ${phase.name}`,
    '',
    '### Phase Spec',
    phase.spec,
    '',
    'Implement this phase directly. Use your full tools to read the codebase, write code, run tests, and verify.',
    'Run tests in non-interactive mode. Kill any servers or background processes when done.',
    '',
    '### Response',
    'When complete, respond with action "done" and a summary of what was implemented.',
    'If you encounter blocking issues you cannot resolve, respond with action "escalate".',
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

// === Planning Worker prompts ===

const PLAN_FORMAT_TEMPLATE = [
  '# Plan: <project title>',
  '',
  '## Context',
  '<description derived from spec and codebase analysis>',
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
  '',
  '#### Compliance Checklist',
  '- [ ] <prescriptive code from spec that must be followed exactly>',
  '- [ ] <mandated component/library choices>',
  '- [ ] <accessibility requirements>',
  '- [ ] <documentation obligations>',
  '',
  '#### Reference Component (when applicable)',
  '- Model: `<existing/component/path>` — replicate: <pattern1>, <pattern2>',
  '### Applicable Rules',
  '<only the house rules relevant to THIS phase>',
  '### Done',
  '_(to be filled)_',
].join('\n')

export function buildPlanningWorkerPrompt(spec: FreeFormSpec, env: EnvironmentInfo | undefined, planPath: string): string {
  const parts: string[] = [
    '## Spec',
    spec.text,
  ]

  if (spec.houseRulesContent) {
    parts.push('', '## House Rules', spec.houseRulesContent)
  }

  if (env) {
    parts.push('', '## Environment', env.summary)
  }

  parts.push(
    '',
    '## Task',
    'Create a structured implementation plan for the spec above.',
    '',
    '1. Explore the codebase using Read/Glob/Grep/Bash to understand the existing code, architecture, and conventions.',
    '2. Analyze the spec and determine how to break it into phases.',
    '3. Write the plan to `' + planPath + '` using the Write tool.',
    '',
    'The plan must follow this exact format:',
    '',
    '```',
    PLAN_FORMAT_TEMPLATE,
    '```',
    '',
    'Guidelines:',
    '- Each phase should be a discrete, testable deliverable',
    '- Include only the relevant house rules in each phase\'s ### Applicable Rules',
    '- Number phases starting from 1',
    '- Each phase spec should be self-contained enough for a Worker to implement independently',
    '- Make reasonable assumptions when the spec is ambiguous — document them in the Context section',
    '- For each phase, include a #### Compliance Checklist inside ### Spec. Extract from the spec: code that must be followed verbatim (mark it), mandated component choices, accessibility requirements, and documentation obligations. The checklist is verified by both the Worker and the Director review',
    '- When a phase builds something similar to an existing component, include a #### Reference Component inside ### Spec naming the model component and the specific patterns (accessibility, event shape, error handling, test style) the Worker must replicate',
    '- If the spec contains tracking tables, changelogs, or documentation obligations, add a final lightweight phase for those — do not bury them in implementation phases where they get skipped',
    '',
    'Do NOT ask questions. Do NOT write code. Only explore the codebase and write the plan file.',
  )

  return parts.join('\n')
}

export function buildPlanRevisionWorkerPrompt(planPath: string, feedback: string): string {
  return [
    '## Task',
    `Read the current plan at \`${planPath}\`, fix the issues described below, and overwrite the file with the corrected plan.`,
    '',
    '## Feedback',
    feedback,
    '',
    '## Required Plan Format',
    '```',
    PLAN_FORMAT_TEMPLATE,
    '```',
    '',
    'Keep the same structure. Fix only what the feedback requires.',
  ].join('\n')
}

export function buildPlanningWorkerSystemPrompt(spec: FreeFormSpec, env?: EnvironmentInfo): string {
  const parts: string[] = [
    'You are a planning agent for cestDone, an AI-orchestrated development system.',
    'Your job is to analyze the codebase and create a structured implementation plan.',
  ]

  if (env) {
    parts.push('', '## Environment', env.summary)
  }

  if (spec.houseRulesContent) {
    parts.push('', '## House Rules', spec.houseRulesContent)
  }

  return parts.join('\n')
}

// === Director planning flow prompts (deprecated — used only by --no-with-worker mode) ===

export function buildPlanningSystemPrompt(spec: FreeFormSpec, env?: EnvironmentInfo): string {
  const parts: string[] = [
    'You are the Director of cestDone, an AI-orchestrated development system.',
    'Your role spans the full project lifecycle:',
    '1. Analyze specs and ask clarifying questions',
    '2. Create structured implementation plans',
    '3. Oversee Worker execution of each phase',
    '4. Review code quality and verify functionality',
    '5. Track progress and provide completion summaries',
    '',
    'This is a continuous session — you retain full context from prior steps.',
    'Do not re-read files you have already seen unless checking for changes made by the Worker.',
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
    '- Do NOT ask about implementation details the Worker can figure out (file structure, naming, etc.).',
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
    '- Each phase spec should be self-contained enough for a Worker to work on independently',
    '',
    'IMPORTANT:',
    '- Return the plan directly in your message field as markdown text.',
    '- Do NOT use any tools during this step — you already have all the information from the Analyze step.',
    '- Do NOT spawn subagents, write files, or use planning tools. Just produce the plan text.',
    '- Do NOT write code yet.',
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

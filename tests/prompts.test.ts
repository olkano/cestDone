// tests/prompts.test.ts
import { describe, it, expect } from 'vitest'
import {
  buildDirectorTools,
  buildClarifyPrompt,
  buildInitialCoderInstructions,
  buildReviewPrompt,
  buildCompletePrompt,
  buildPlanningSystemPrompt,
  buildFreeFormAnalyzePrompt,
  buildCreatePlanPrompt,
  buildRevisePlanPrompt,
  buildExecutionSystemPrompt,
  buildDirectorExecutionPrompt,
  DIRECTOR_RESPONSE_SCHEMA,
} from '../src/director/prompts.js'
import { WorkflowStep } from '../src/shared/types.js'
import type { Phase, FreeFormSpec, Plan } from '../src/shared/types.js'
import type { EnvironmentInfo } from '../src/shared/environment.js'

const TEST_ENV: EnvironmentInfo = {
  os: 'Linux',
  shell: '/bin/bash',
  killCommand: 'kill -9 <pid>',
  packageManager: 'npm',
  dependencies: ['express', 'vitest'],
  summary: 'OS: Linux\nShell: /bin/bash\nKill command: kill -9 <pid>\nPackage manager: npm\nDependencies: express, vitest',
}

const CURRENT_PHASE: Phase = {
  number: 1,
  name: 'Core features',
  status: 'pending',
  spec: 'Implement the parser and writer modules.',
  applicableRules: '',
  done: '_(to be filled)_',
}

describe('DIRECTOR_RESPONSE_SCHEMA', () => {
  // G3: Schema defines action enum with all action types
  it('defines action enum with all Director action types', () => {
    const props = DIRECTOR_RESPONSE_SCHEMA.properties as Record<string, { enum?: string[] }>
    expect(props.action.enum).toEqual(['analyze', 'ask_human', 'approve', 'fix', 'continue', 'done', 'escalate'])
  })

  it('requires action and message fields', () => {
    expect(DIRECTOR_RESPONSE_SCHEMA.required).toContain('action')
    expect(DIRECTOR_RESPONSE_SCHEMA.required).toContain('message')
  })
})

describe('buildDirectorTools', () => {
  it('returns read-only tools for most steps', () => {
    expect(buildDirectorTools(WorkflowStep.Analyze)).toEqual(['Read', 'Glob', 'Grep'])
    expect(buildDirectorTools(WorkflowStep.Execute)).toEqual(['Read', 'Glob', 'Grep'])
    expect(buildDirectorTools(WorkflowStep.Complete)).toEqual(['Read', 'Glob', 'Grep'])
  })

  it('returns read + Bash tools for Review step (legacy default)', () => {
    expect(buildDirectorTools(WorkflowStep.Review)).toEqual(['Read', 'Glob', 'Grep', 'Bash'])
  })

  // BDT1: Review with withBash: false → read-only
  it('returns read-only tools for Review when withBash is false', () => {
    expect(buildDirectorTools(WorkflowStep.Review, { withBash: false })).toEqual(['Read', 'Glob', 'Grep'])
  })

  // BDT2: Review with withBash: true → read + Bash
  it('returns read + Bash tools for Review when withBash is true', () => {
    expect(buildDirectorTools(WorkflowStep.Review, { withBash: true })).toEqual(['Read', 'Glob', 'Grep', 'Bash'])
  })

  // BDT3: Non-Review steps unaffected by withBash
  it('non-Review steps ignore withBash option', () => {
    expect(buildDirectorTools(WorkflowStep.Analyze, { withBash: true })).toEqual(['Read', 'Glob', 'Grep'])
  })

  // DX1: Execute step with directorOnly returns full tools
  it('returns full tools for Execute step when directorOnly is true', () => {
    expect(buildDirectorTools(WorkflowStep.Execute, { directorOnly: true }))
      .toEqual(['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep'])
  })

  // DX2: Execute step without directorOnly returns read-only (legacy)
  it('returns read-only tools for Execute step without directorOnly', () => {
    expect(buildDirectorTools(WorkflowStep.Execute)).toEqual(['Read', 'Glob', 'Grep'])
  })
})

describe('buildDirectorExecutionPrompt', () => {
  // DXP1: Includes phase spec and execution instructions
  it('includes phase spec and execution instructions', () => {
    const prompt = buildDirectorExecutionPrompt(TEST_PLAN, CURRENT_PHASE, [])
    expect(prompt).toContain('Phase 1: Core features')
    expect(prompt).toContain('Implement')
    expect(prompt).toContain(CURRENT_PHASE.spec)
  })

  // DXP2: Includes completed phases context
  it('includes completed phases context', () => {
    const completed = [{ ...CURRENT_PHASE, status: 'done' as const, done: 'Built the parser.' }]
    const nextPhase: Phase = { number: 2, name: 'Tests', status: 'pending', spec: 'Add tests.', applicableRules: '', done: '_(to be filled)_' }
    const prompt = buildDirectorExecutionPrompt(TEST_PLAN, nextPhase, completed)
    expect(prompt).toContain('Previously Completed')
    expect(prompt).toContain('Built the parser.')
  })

  // DXP3: Instructs Director to respond with done action
  it('instructs Director to respond with done action', () => {
    const prompt = buildDirectorExecutionPrompt(TEST_PLAN, CURRENT_PHASE, [])
    expect(prompt).toContain('"done"')
  })

  // DXP4: Includes environment info when provided
  it('includes environment info when provided', () => {
    const prompt = buildDirectorExecutionPrompt(TEST_PLAN, CURRENT_PHASE, [], TEST_ENV)
    expect(prompt).toContain('Environment')
    expect(prompt).toContain('Linux')
  })
})

describe('buildClarifyPrompt', () => {
  it('includes questions and answers', () => {
    const prompt = buildClarifyPrompt(['What DB?', 'Auth method?'], ['PostgreSQL', 'JWT'])

    expect(prompt).toContain('Q: What DB?')
    expect(prompt).toContain('A: PostgreSQL')
    expect(prompt).toContain('Q: Auth method?')
    expect(prompt).toContain('A: JWT')
  })

  it('instructs Director to ask follow-up questions or approve', () => {
    const prompt = buildClarifyPrompt(['What DB?'], ['PostgreSQL'])

    expect(prompt).toContain('NEW questions')
    expect(prompt).toContain('recommendation')
    expect(prompt).toContain('approve')
    expect(prompt).toContain('Do NOT repeat')
  })
})

describe('buildInitialCoderInstructions', () => {
  it('includes plan context and phase task', () => {
    const prompt = buildInitialCoderInstructions(TEST_PLAN, TEST_PLAN.phases[1], [])

    expect(prompt).toContain('Dashboard Project')
    expect(prompt).toContain('Express, Cheerio, EJS')
    expect(prompt).toContain('Phase 2: Dashboard')
  })

  it('includes completed phases when present', () => {
    const completedPhases = [TEST_PLAN.phases[0]]
    const prompt = buildInitialCoderInstructions(TEST_PLAN, TEST_PLAN.phases[1], completedPhases)

    expect(prompt).toContain('Previously Completed Phases')
    expect(prompt).toContain('Phase 1: Scraper')
    expect(prompt).toContain('Built scraper.')
  })

  it('omits completed phases section when none exist', () => {
    const prompt = buildInitialCoderInstructions(TEST_PLAN, TEST_PLAN.phases[0], [])

    expect(prompt).not.toContain('Previously Completed Phases')
  })

  it('includes environment info when provided', () => {
    const prompt = buildInitialCoderInstructions(TEST_PLAN, TEST_PLAN.phases[1], [], TEST_ENV)

    expect(prompt).toContain('## Environment')
    expect(prompt).toContain('OS: Linux')
    expect(prompt).toContain('kill -9 <pid>')
  })

  it('includes non-interactive test and kill instructions', () => {
    const prompt = buildInitialCoderInstructions(TEST_PLAN, TEST_PLAN.phases[0], [])

    expect(prompt).toContain('non-interactive mode')
    expect(prompt).toContain('no watch mode')
    expect(prompt).toContain('Kill any servers or background processes')
  })
})

describe('buildReviewPrompt', () => {
  it('includes phase identity, spec, and coder report', () => {
    const prompt = buildReviewPrompt(1, 'Setup', 'The phase spec', '{"status":"success"}')

    expect(prompt).toContain('Phase 1')
    expect(prompt).toContain('Setup')
    expect(prompt).toContain('The phase spec')
    expect(prompt).toContain('success')
  })

  it('does NOT instruct Director to re-run tests (Coder already did)', () => {
    const prompt = buildReviewPrompt(1, 'Setup', 'The phase spec', '{"status":"success"}')

    expect(prompt).not.toContain('npm test')
    expect(prompt).not.toContain('tsc --noEmit')
    expect(prompt).toContain('do NOT re-run them')
  })

  it('instructs Director to review code quality from diff', () => {
    const prompt = buildReviewPrompt(1, 'Setup', 'The phase spec', '{"status":"success"}')

    expect(prompt).toContain('Code Review (mandatory')
    expect(prompt).toContain('cestdone-diff.txt')
    expect(prompt).toContain('Correctness')
    expect(prompt).toContain('Completeness')
    expect(prompt).toContain('Quality')
    expect(prompt).toContain('Security')
    expect(prompt).toContain('Requirements Check')
  })

  it('limits functional testing to when unit tests cannot cover it', () => {
    const prompt = buildReviewPrompt(1, 'Setup', 'Plan', '{"status":"success"}')

    expect(prompt).toContain('only when needed')
    expect(prompt).toContain('unit tests cannot cover')
    expect(prompt).toContain('Kill all servers and background processes when done')
  })

  it('includes response action instructions for continue/done/fix', () => {
    const prompt = buildReviewPrompt(2, 'API', 'Plan', '{"status":"success"}')

    expect(prompt).toContain('continue')
    expect(prompt).toContain('done')
    expect(prompt).toContain('fix')
  })

  it('scopes response actions to the current phase only', () => {
    const prompt = buildReviewPrompt(2, 'API', 'Plan', '{"status":"success"}')

    expect(prompt).toContain('Your scope is ONLY Phase 2 (API)')
    expect(prompt).toContain('Do NOT use "continue" to advance to the next plan phase')
    expect(prompt).toContain('Phase 2 is complete')
  })

  it('includes completed sub-phases when provided', () => {
    const prompt = buildReviewPrompt(1, 'Setup', 'Plan', '{"status":"success"}', [
      'Created models and migrations',
      'Added API routes',
    ])

    expect(prompt).toContain('Previously Completed Sub-phases')
    expect(prompt).toContain('Sub-phase 1')
    expect(prompt).toContain('Created models and migrations')
    expect(prompt).toContain('Sub-phase 2')
    expect(prompt).toContain('Added API routes')
  })

  it('omits sub-phases section when none completed', () => {
    const prompt = buildReviewPrompt(1, 'Setup', 'Plan', '{"status":"success"}', [])

    expect(prompt).not.toContain('Previously Completed Sub-phases')
  })

  it('includes git commit instructions', () => {
    const prompt = buildReviewPrompt(1, 'Setup', 'Plan', '{"status":"success"}')

    expect(prompt).toContain('git add -A')
    expect(prompt).toContain('git commit')
    expect(prompt).toContain('Do NOT commit if the Coder reported test failures')
  })
})

describe('buildCompletePrompt', () => {
  it('requests done summary for phase', () => {
    const prompt = buildCompletePrompt(CURRENT_PHASE)

    expect(prompt).toContain('Phase 1: Core features')
    expect(prompt).toContain('Done summary')
  })
})

// === New planning flow prompt tests ===

const TEST_SPEC: FreeFormSpec = {
  text: 'Build a web dashboard that scrapes metrics. Use Express.',
  houseRulesContent: 'Use TDD. Update docs at the end.',
  specFilePath: '/tmp/spec.md',
}

const TEST_PLAN: Plan = {
  title: 'Dashboard Project',
  context: 'Build a web dashboard for metrics.',
  techStack: 'Express, Cheerio, EJS',
  houseRules: 'Use TDD. Update docs at the end.',
  phases: [
    { number: 1, name: 'Scraper', status: 'done', spec: '_See Done._', applicableRules: 'Use TDD.', done: 'Built scraper.' },
    { number: 2, name: 'Dashboard', status: 'pending', spec: 'Build UI.', applicableRules: 'Use TDD. Update docs.', done: '_(tbd)_' },
  ],
}

describe('buildPlanningSystemPrompt', () => {
  it('includes spec text and house rules', () => {
    const prompt = buildPlanningSystemPrompt(TEST_SPEC)

    expect(prompt).toContain('Build a web dashboard that scrapes metrics')
    expect(prompt).toContain('Use TDD. Update docs at the end.')
  })

  it('describes Director full lifecycle role', () => {
    const prompt = buildPlanningSystemPrompt(TEST_SPEC)

    expect(prompt).toContain('Director')
    expect(prompt).toContain('full project lifecycle')
    expect(prompt).toContain('continuous session')
  })

  it('omits house rules section when empty', () => {
    const noRules: FreeFormSpec = { text: 'Build something.', houseRulesContent: '', specFilePath: '/tmp/s.md' }

    const prompt = buildPlanningSystemPrompt(noRules)

    expect(prompt).not.toContain('House Rules')
  })

  it('includes environment info when provided', () => {
    const prompt = buildPlanningSystemPrompt(TEST_SPEC, TEST_ENV)

    expect(prompt).toContain('## Environment')
    expect(prompt).toContain('OS: Linux')
    expect(prompt).toContain('kill -9 <pid>')
    expect(prompt).toContain('npm')
  })

  it('omits environment section when not provided', () => {
    const prompt = buildPlanningSystemPrompt(TEST_SPEC)

    expect(prompt).not.toContain('## Environment')
  })
})

describe('buildFreeFormAnalyzePrompt', () => {
  it('includes spec text and instructs to explore codebase', () => {
    const prompt = buildFreeFormAnalyzePrompt(TEST_SPEC)

    expect(prompt).toContain('Build a web dashboard that scrapes metrics')
    expect(prompt).toContain('essential questions')
    expect(prompt).toContain('Do NOT make any file changes')
  })

  it('includes house rules for context', () => {
    const prompt = buildFreeFormAnalyzePrompt(TEST_SPEC)

    expect(prompt).toContain('Use TDD')
  })

  it('limits question count and requires recommendations', () => {
    const prompt = buildFreeFormAnalyzePrompt(TEST_SPEC)

    expect(prompt).toContain('recommended answer')
    expect(prompt).toContain('Do NOT pad')
  })
})

describe('buildCreatePlanPrompt', () => {
  it('includes spec and clarifications', () => {
    const prompt = buildCreatePlanPrompt(TEST_SPEC, 'Q: What DB?\nA: PostgreSQL')

    expect(prompt).toContain('Build a web dashboard')
    expect(prompt).toContain('Q: What DB?')
    expect(prompt).toContain('A: PostgreSQL')
  })

  it('instructs to produce plan in .plan.md format', () => {
    const prompt = buildCreatePlanPrompt(TEST_SPEC, '')

    expect(prompt).toContain('# Plan:')
    expect(prompt).toContain('## Phase')
    expect(prompt).toContain('### Applicable Rules')
  })

  it('handles empty clarifications', () => {
    const prompt = buildCreatePlanPrompt(TEST_SPEC, '')

    expect(prompt).toContain('Build a web dashboard')
    expect(prompt).not.toContain('Clarifications')
  })
})

describe('buildRevisePlanPrompt', () => {
  it('includes current plan and feedback', () => {
    const prompt = buildRevisePlanPrompt(
      '# Plan: Dashboard\n## Phase 1: Setup',
      'Split into 3 phases instead of 2'
    )

    expect(prompt).toContain('# Plan: Dashboard')
    expect(prompt).toContain('Split into 3 phases instead of 2')
  })

  it('instructs to return revised plan in message', () => {
    const prompt = buildRevisePlanPrompt('plan content', 'change this')

    expect(prompt).toContain('revised')
    expect(prompt).toContain('message')
  })
})

describe('buildExecutionSystemPrompt', () => {
  it('includes plan context and house rules', () => {
    const prompt = buildExecutionSystemPrompt(TEST_PLAN, [])

    expect(prompt).toContain('Dashboard Project')
    expect(prompt).toContain('Express, Cheerio, EJS')
    expect(prompt).toContain('Use TDD. Update docs at the end.')
  })

  it('includes completed phases', () => {
    const completedPhases = [TEST_PLAN.phases[0]]
    const prompt = buildExecutionSystemPrompt(TEST_PLAN, completedPhases)

    expect(prompt).toContain('Phase 1: Scraper')
    expect(prompt).toContain('Built scraper.')
  })

  it('omits completed phases section when none exist', () => {
    const prompt = buildExecutionSystemPrompt(TEST_PLAN, [])

    expect(prompt).not.toContain('Completed Phases')
  })

  it('includes output format instructions', () => {
    const prompt = buildExecutionSystemPrompt(TEST_PLAN, [])

    expect(prompt).toContain('Output Format')
    expect(prompt).toContain('JSON')
  })

  it('includes environment info when provided', () => {
    const prompt = buildExecutionSystemPrompt(TEST_PLAN, [], TEST_ENV)

    expect(prompt).toContain('## Environment')
    expect(prompt).toContain('OS: Linux')
    expect(prompt).toContain('kill -9 <pid>')
  })

  it('omits environment section when not provided', () => {
    const prompt = buildExecutionSystemPrompt(TEST_PLAN, [])

    expect(prompt).not.toContain('## Environment')
  })
})

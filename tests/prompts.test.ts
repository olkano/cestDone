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
  DIRECTOR_RESPONSE_SCHEMA,
} from '../src/director/prompts.js'
import { WorkflowStep } from '../src/shared/types.js'
import type { Phase, FreeFormSpec, Plan } from '../src/shared/types.js'

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

  it('returns read + Bash tools for Review step', () => {
    expect(buildDirectorTools(WorkflowStep.Review)).toEqual(['Read', 'Glob', 'Grep', 'Bash'])
  })
})

describe('buildClarifyPrompt', () => {
  it('includes questions and answers', () => {
    const prompt = buildClarifyPrompt(['What DB?', 'Auth method?'], ['PostgreSQL', 'JWT'])

    expect(prompt).toContain('Q: What DB?')
    expect(prompt).toContain('A: PostgreSQL')
    expect(prompt).toContain('Q: Auth method?')
    expect(prompt).toContain('A: JWT')
    expect(prompt).toContain('remaining ambiguities')
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
})

describe('buildReviewPrompt', () => {
  it('includes phase spec and coder report', () => {
    const prompt = buildReviewPrompt('The phase spec', '{"status":"success"}')

    expect(prompt).toContain('The phase spec')
    expect(prompt).toContain('success')
    expect(prompt).toContain('npm test')
    expect(prompt).toContain('tsc --noEmit')
  })

  it('includes response action instructions for continue/done/fix', () => {
    const prompt = buildReviewPrompt('Plan', '{"status":"success"}')

    expect(prompt).toContain('continue')
    expect(prompt).toContain('done')
    expect(prompt).toContain('fix')
  })

  it('includes completed sub-phases when provided', () => {
    const prompt = buildReviewPrompt('Plan', '{"status":"success"}', [
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
    const prompt = buildReviewPrompt('Plan', '{"status":"success"}', [])

    expect(prompt).not.toContain('Previously Completed Sub-phases')
  })

  it('includes git commit instructions for verified work', () => {
    const prompt = buildReviewPrompt('Plan', '{"status":"success"}')

    expect(prompt).toContain('git add -A')
    expect(prompt).toContain('git commit')
    expect(prompt).toContain('Do NOT commit if tests fail')
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

  it('describes Director planning role', () => {
    const prompt = buildPlanningSystemPrompt(TEST_SPEC)

    expect(prompt).toContain('Director')
    expect(prompt).toContain('plan')
  })

  it('omits house rules section when empty', () => {
    const noRules: FreeFormSpec = { text: 'Build something.', houseRulesContent: '', specFilePath: '/tmp/s.md' }

    const prompt = buildPlanningSystemPrompt(noRules)

    expect(prompt).not.toContain('House Rules')
  })
})

describe('buildFreeFormAnalyzePrompt', () => {
  it('includes spec text and instructs to explore codebase', () => {
    const prompt = buildFreeFormAnalyzePrompt(TEST_SPEC)

    expect(prompt).toContain('Build a web dashboard that scrapes metrics')
    expect(prompt).toContain('clarifying questions')
    expect(prompt).toContain('Do NOT make any file changes')
  })

  it('includes house rules for context', () => {
    const prompt = buildFreeFormAnalyzePrompt(TEST_SPEC)

    expect(prompt).toContain('Use TDD')
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
})

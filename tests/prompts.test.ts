// tests/prompts.test.ts
import { describe, it, expect } from 'vitest'
import {
  buildDirectorSystemPrompt,
  buildDirectorTools,
  buildAnalyzePrompt,
  buildClarifyPrompt,
  buildUpdateSpecPrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  buildCompletePrompt,
  DIRECTOR_RESPONSE_SCHEMA,
} from '../src/director/prompts.js'
import type { Phase, SpecMetadata } from '../src/shared/types.js'

const METADATA: SpecMetadata = {
  context: 'A CLI tool built with TypeScript and Node.js.',
  houseRulesRef: 'See `house-rules.md`.',
  houseRulesContent: '# Rules\nUse TDD. No console.log.',
}

const COMPLETED_PHASE: Phase = {
  number: 0,
  name: 'Setup',
  status: 'done',
  spec: '_See Done summary below._',
  done: 'Created scaffold. All tests pass.',
}

const CURRENT_PHASE: Phase = {
  number: 1,
  name: 'Core features',
  status: 'pending',
  spec: 'Implement the parser and writer modules.',
  done: '_(to be filled)_',
}

describe('buildDirectorSystemPrompt', () => {
  // G1: Includes context and house-rules content
  it('includes project context and house rules', () => {
    const prompt = buildDirectorSystemPrompt(METADATA, [])

    expect(prompt).toContain('A CLI tool built with TypeScript and Node.js.')
    expect(prompt).toContain('Use TDD. No console.log.')
  })

  // G2: Includes Done summaries of completed phases
  it('includes done summaries of completed phases', () => {
    const prompt = buildDirectorSystemPrompt(METADATA, [COMPLETED_PHASE])

    expect(prompt).toContain('Phase 0: Setup')
    expect(prompt).toContain('Created scaffold. All tests pass.')
  })

  it('omits completed phases section when none exist', () => {
    const prompt = buildDirectorSystemPrompt(METADATA, [])

    expect(prompt).not.toContain('Completed Phases')
  })

  it('omits house rules section when content is not available', () => {
    const noRules: SpecMetadata = { context: 'ctx', houseRulesRef: '' }

    const prompt = buildDirectorSystemPrompt(noRules, [])

    expect(prompt).not.toContain('House Rules')
  })

  it('includes output format instructions', () => {
    const prompt = buildDirectorSystemPrompt(METADATA, [])

    expect(prompt).toContain('Output Format')
    expect(prompt).toContain('JSON')
  })
})

describe('DIRECTOR_RESPONSE_SCHEMA', () => {
  // G3: Schema defines action enum with all action types
  it('defines action enum with all Director action types', () => {
    const props = DIRECTOR_RESPONSE_SCHEMA.properties as Record<string, { enum?: string[] }>
    expect(props.action.enum).toEqual(['analyze', 'ask_human', 'approve', 'fix', 'done', 'escalate'])
  })

  it('requires action and message fields', () => {
    expect(DIRECTOR_RESPONSE_SCHEMA.required).toContain('action')
    expect(DIRECTOR_RESPONSE_SCHEMA.required).toContain('message')
  })
})

describe('buildDirectorTools', () => {
  it('returns read-only tools for most steps', () => {
    expect(buildDirectorTools(1)).toEqual(['Read', 'Glob', 'Grep'])
    expect(buildDirectorTools(4)).toEqual(['Read', 'Glob', 'Grep'])
    expect(buildDirectorTools(8)).toEqual(['Read', 'Glob', 'Grep'])
  })

  it('returns read + Bash tools for Review step', () => {
    expect(buildDirectorTools(7)).toEqual(['Read', 'Glob', 'Grep', 'Bash'])
  })
})

describe('buildAnalyzePrompt', () => {
  it('includes phase spec and analysis instructions', () => {
    const prompt = buildAnalyzePrompt(CURRENT_PHASE, 'Full spec content here')

    expect(prompt).toContain('Phase 1: Core features')
    expect(prompt).toContain('Implement the parser and writer modules.')
    expect(prompt).toContain('Full spec content here')
    expect(prompt).toContain('clarifying questions')
    expect(prompt).toContain('Do NOT make any file changes')
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

describe('buildUpdateSpecPrompt', () => {
  it('includes original spec and clarifications', () => {
    const prompt = buildUpdateSpecPrompt('Original spec text', 'Q: What DB?\nA: PostgreSQL')

    expect(prompt).toContain('Original spec text')
    expect(prompt).toContain('Q: What DB?')
    expect(prompt).toContain('Do NOT modify any files')
  })
})

describe('buildPlanPrompt', () => {
  it('includes phase info and planning instructions', () => {
    const prompt = buildPlanPrompt(CURRENT_PHASE, 'Updated spec content')

    expect(prompt).toContain('Updated spec content')
    expect(prompt).toContain('Phase 1: Core features')
    expect(prompt).toContain('implementation plan')
    expect(prompt).toContain('TDD')
    expect(prompt).toContain('Do NOT write code')
  })
})

describe('buildReviewPrompt', () => {
  it('includes plan and coder report', () => {
    const prompt = buildReviewPrompt('The plan', '{"status":"success"}')

    expect(prompt).toContain('The plan')
    expect(prompt).toContain('success')
    expect(prompt).toContain('npm test')
    expect(prompt).toContain('tsc --noEmit')
  })
})

describe('buildCompletePrompt', () => {
  it('requests done summary for phase', () => {
    const prompt = buildCompletePrompt(CURRENT_PHASE)

    expect(prompt).toContain('Phase 1: Core features')
    expect(prompt).toContain('Done summary')
  })
})

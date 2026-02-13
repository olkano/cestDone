// tests/prompt-builder.test.ts
import { describe, it, expect } from 'vitest'
import {
  buildSystemPrompt,
  buildStepMessage,
  getDirectorTools,
} from '../src/director/prompt-builder.js'
import { WorkflowStep } from '../src/shared/types.js'
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

describe('buildSystemPrompt', () => {
  // G1: Includes context and house-rules content
  it('includes project context and house rules', () => {
    const prompt = buildSystemPrompt(METADATA, [])

    expect(prompt).toContain('A CLI tool built with TypeScript and Node.js.')
    expect(prompt).toContain('Use TDD. No console.log.')
  })

  // G2: Includes Done summaries of completed phases
  it('includes done summaries of completed phases', () => {
    const prompt = buildSystemPrompt(METADATA, [COMPLETED_PHASE])

    expect(prompt).toContain('Phase 0: Setup')
    expect(prompt).toContain('Created scaffold. All tests pass.')
  })

  it('omits completed phases section when none exist', () => {
    const prompt = buildSystemPrompt(METADATA, [])

    expect(prompt).not.toContain('Completed Phases')
  })

  it('omits house rules section when content is not available', () => {
    const noRules: SpecMetadata = { context: 'ctx', houseRulesRef: '', }

    const prompt = buildSystemPrompt(noRules, [])

    expect(prompt).not.toContain('House Rules')
  })
})

describe('getDirectorTools', () => {
  // G3: Defines tool_use schema for action envelope
  it('returns a director_action tool with correct schema', () => {
    const tools = getDirectorTools()

    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('director_action')

    const schema = tools[0].input_schema
    expect(schema.required).toContain('action')
    expect(schema.required).toContain('message')

    const props = schema.properties as Record<string, { enum?: string[] }>
    expect(props.action.enum).toEqual(['approve', 'ask_human', 'fix', 'complete'])
  })
})

describe('buildStepMessage', () => {
  // G4: Different steps produce different prompts
  it('builds Analyze prompt with phase spec and analysis instructions', () => {
    const msg = buildStepMessage(WorkflowStep.Analyze, CURRENT_PHASE)

    expect(msg).toContain('Phase 1: Core features')
    expect(msg).toContain('Implement the parser and writer modules.')
    expect(msg).toContain('clarifying questions')
  })

  it('builds Plan prompt with planning instructions', () => {
    const msg = buildStepMessage(WorkflowStep.Plan, CURRENT_PHASE)

    expect(msg).toContain('implementation plan')
    expect(msg).toContain('TDD')
    expect(msg).toContain('Do NOT write code')
  })

  it('Analyze and Plan prompts are different', () => {
    const analyze = buildStepMessage(WorkflowStep.Analyze, CURRENT_PHASE)
    const plan = buildStepMessage(WorkflowStep.Plan, CURRENT_PHASE)

    expect(analyze).not.toBe(plan)
  })

  // G5: Complete step asks for phase summary
  it('builds Complete prompt requesting a Done summary', () => {
    const msg = buildStepMessage(WorkflowStep.Complete, CURRENT_PHASE)

    expect(msg).toContain('Done summary')
    expect(msg).toContain('Phase 1')
  })

  it('returns a generic message for steps without a template', () => {
    const msg = buildStepMessage(WorkflowStep.Clarify, CURRENT_PHASE)

    expect(msg).toContain('Phase 1')
  })
})

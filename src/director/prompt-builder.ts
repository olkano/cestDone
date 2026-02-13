// src/director/prompt-builder.ts
import { WorkflowStep } from '../shared/types.js'
import type { Phase, SpecMetadata } from '../shared/types.js'

export interface DirectorTool {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
  }
}

export function buildSystemPrompt(metadata: SpecMetadata, completedPhases: Phase[]): string {
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
    '## Instructions',
    'Always respond using the director_action tool.',
    'Use natural language in the message field for plans, feedback, and summaries.',
    'Use the questions field only with the ask_human action.',
  )

  return parts.join('\n')
}

export function buildStepMessage(step: WorkflowStep, phase: Phase): string {
  switch (step) {
    case WorkflowStep.Analyze:
      return [
        `## Phase ${phase.number}: ${phase.name}`,
        '',
        '### Spec',
        phase.spec,
        '',
        'Analyze this phase spec. List any clarifying questions about requirements,',
        'ambiguities, or assumptions that need resolving before implementation.',
        'Do NOT touch any files.',
      ].join('\n')

    case WorkflowStep.Plan:
      return [
        `Create an implementation plan for Phase ${phase.number}: ${phase.name}.`,
        'Include: file structure, TDD sequence (which tests first), and a TODO checklist.',
        'Do NOT write code yet.',
      ].join('\n')

    case WorkflowStep.Complete:
      return [
        `Phase ${phase.number}: ${phase.name} is complete.`,
        'Write a concise Done summary (under 10 lines) covering:',
        'what was built, key files changed, and any spec deviations.',
      ].join('\n')

    default:
      return `Continue with step ${step} for Phase ${phase.number}: ${phase.name}.`
  }
}

export function getDirectorTools(): DirectorTool[] {
  return [
    {
      name: 'director_action',
      description:
        'Structured response from the Director indicating the next action to take.',
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['approve', 'ask_human', 'fix', 'complete'],
            description: 'The action the Director wants to take.',
          },
          message: {
            type: 'string',
            description:
              'Natural language content: plan, feedback, questions summary, or completion summary.',
          },
          questions: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Questions to escalate to the human (only used with ask_human action).',
          },
        },
        required: ['action', 'message'],
      },
    },
  ]
}

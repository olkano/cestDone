// src/shared/types.ts
import type { SessionLogger } from './logger.js'

export type PhaseStatus = 'pending' | 'in-progress' | 'done'

export interface Phase {
  number: number
  name: string
  status: PhaseStatus
  spec: string
  applicableRules: string
  done: string
}


export interface Config {
  defaultModel: string
  targetRepoPath: string
  maxTurns: number
  maxBudgetUsd?: number
}

export interface ResolvedConfig extends Config {
  apiKey: string
}

export enum WorkflowStep {
  Analyze = 1,
  Clarify = 2,
  CreatePlan = 3,
  Execute = 4,
  Review = 5,
  Complete = 6,
}

export type DirectorActionType = 'analyze' | 'ask_human' | 'approve' | 'fix' | 'continue' | 'done' | 'escalate'

export interface DirectorResponse {
  action: DirectorActionType
  message: string
  questions?: string[]
}

export type Complexity = 'low' | 'high'

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

export interface CoderReport {
  status: 'success' | 'partial' | 'failed'
  summary: string
  filesChanged?: string[]
  testsRun?: { passed: number; failed: number; skipped: number }
  issues?: string[]
}

export interface CoderResult {
  status: 'success' | 'partial' | 'failed'
  message: string
  filesChanged?: string[]
  cost: number
  numTurns: number
  durationMs: number
  usage: TokenUsage
  report: CoderReport | null
}

export interface CoderOptions {
  step: WorkflowStep
  phase: Phase
  model: string
  targetRepoPath: string
  houseRulesContent: string
  instructions: string
  maxTurns: number
  maxBudgetUsd?: number
  apiKey: string
  logger: SessionLogger
  completedSubPhases?: string[]
}

export interface FreeFormSpec {
  text: string
  houseRulesContent: string
  specFilePath: string
}

export interface Plan {
  title: string
  context: string
  techStack: string
  houseRules: string
  phases: Phase[]
}

const ZERO_TOKEN_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }

/** Maps SDK snake_case usage to our camelCase TokenUsage. Handles both formats. */
export function mapSdkUsage(raw: unknown): TokenUsage {
  if (!raw || typeof raw !== 'object') return { ...ZERO_TOKEN_USAGE }
  const r = raw as Record<string, unknown>
  return {
    inputTokens: (r.input_tokens ?? r.inputTokens ?? 0) as number,
    outputTokens: (r.output_tokens ?? r.outputTokens ?? 0) as number,
    cacheReadInputTokens: (r.cache_read_input_tokens ?? r.cacheReadInputTokens ?? 0) as number,
    cacheCreationInputTokens: (r.cache_creation_input_tokens ?? r.cacheCreationInputTokens ?? 0) as number,
  }
}

/** Formats a tool call for logging — shows meaningful details per tool type. */
export function formatToolCall(name: string, input: unknown): string {
  const params = input as Record<string, unknown> | undefined
  if (!params) return name
  switch (name) {
    case 'Bash':
      return `Bash: ${String(params.command ?? '').slice(0, 200)}`
    case 'Read':
      return `Read(${params.file_path ?? ''})`
    case 'Write':
      return `Write(${params.file_path ?? ''})`
    case 'Edit':
      return `Edit(${params.file_path ?? ''})`
    case 'Glob':
      return `Glob(${params.pattern ?? ''})`
    case 'Grep':
      return `Grep(${params.pattern ?? ''})`
    default:
      return `${name}(${Object.keys(params).join(', ')})`
  }
}

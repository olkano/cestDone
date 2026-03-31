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


export type BackendType = 'agent-sdk' | 'claude-cli'
export type ModelAlias = 'haiku' | 'sonnet' | 'opus'

export interface Config {
  targetRepoPath: string
  runDir: string // relative to targetRepoPath, e.g. ".cestdone/spec-name_2026-03-20_144513"
  maxTurns: number
  directorMaxTurns?: number
  maxBudgetUsd?: number
  directorModel?: string
  workerModel?: string
  withWorker?: boolean
  withReviews?: boolean
  withBashReviews?: boolean
  withHumanValidation?: boolean
  directorBackend?: BackendType
  workerBackend?: BackendType
  claudeCliPath?: string
  nonInteractive?: boolean
  autoCommit?: boolean
  houseRules?: string       // Default path to house rules file (CLI --house-rules overrides)
  centralLogDir?: string // e.g. ~/.cestdone/logs — dual-write all session logs here
  daemon?: import('../daemon/types.js').DaemonConfig
}


export enum WorkflowStep {
  Analyze = 1,
  Clarify = 2,
  CreatePlan = 3,
  Execute = 4,
  Review = 5,
  Complete = 6,
  Plan = 7,
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

export interface WorkerReport {
  status: 'success' | 'partial' | 'failed'
  summary: string
  filesChanged?: string[]
  testsRun?: { passed: number; failed: number; skipped: number }
  issues?: string[]
}

export interface WorkerResult {
  status: 'success' | 'partial' | 'failed'
  message: string
  filesChanged?: string[]
  cost: number
  numTurns: number
  durationMs: number
  usage: TokenUsage
  report: WorkerReport | null
}

export interface WorkerOptions {
  step: WorkflowStep
  phase: Phase
  model: string
  targetRepoPath: string
  runDir: string
  houseRulesContent: string
  instructions: string
  rawPrompt?: string
  maxTurns: number
  maxBudgetUsd?: number
  logger: SessionLogger
  completedSubPhases?: string[]
  backend: Backend
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

/** Formats milliseconds into a human-readable duration (e.g. "200 ms", "45 s", "7m 45s", "1h 4m 42s"). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const totalSeconds = Math.floor(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export interface BackendInvocation {
  prompt: string
  systemPrompt?: string
  model: string
  tools?: string[]
  outputSchema?: object
  cwd: string
  maxTurns?: number
  maxBudgetUsd?: number
  resumeSessionId?: string
  env?: Record<string, string | undefined>
  logger: SessionLogger
}

export interface BackendResult {
  output: unknown
  rawText?: string
  sessionId?: string
  costUsd: number | null
  numTurns: number
  durationMs: number
  usage: TokenUsage
  success: boolean
  errorMessage?: string
}

export interface Backend {
  invoke(params: BackendInvocation): Promise<BackendResult>
  preflight(): Promise<{ ok: boolean; error?: string }>
  name: BackendType
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

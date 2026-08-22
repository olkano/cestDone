import type { BackendType, InvocationType } from '../shared/types.js'

export interface UsageCallRecordV1 {
  callId: string
  completedAt: string
  role: 'director' | 'worker'
  workflowStep: number
  phaseNumber?: number
  backend: BackendType
  model: string
  success: boolean
  durationMs: number
  numTurns: number
  inputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
  totalProcessedTokens: number
  actualCostUsd: number | null
}

export interface UsageTotalsV1 {
  calls: number
  successfulCalls: number
  failedCalls: number
  inputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
  totalProcessedTokens: number
  actualCostUsd: number | null
  callsWithActualCost: number
}

export interface UsageRunRecordV1 {
  schemaVersion: 1
  runId: string
  startedAt: string
  completedAt?: string
  status: 'running' | 'completed' | 'failed'
  errorCategory?: string
  application: string
  invocation: {
    type: InvocationType
    triggerName?: string
    daemonJobId?: string
    attempt?: number
  }
  originalSpecPath: string
  targetRepoPath: string
  runDir: string
  calls: UsageCallRecordV1[]
  totals: UsageTotalsV1
}

export interface UsageBreakdownV1 extends UsageTotalsV1 {
  key: string
  runs: number
  failedRuns: number
}

export interface UsageRunSummaryV1 {
  runId: string
  startedAt: string
  completedAt?: string
  application: string
  invocationType: InvocationType
  triggerName?: string
  specPath: string
  status: UsageRunRecordV1['status']
  totalProcessedTokens: number
  outputTokens: number
  actualCostUsd: number | null
}

export interface UsagePeriodSnapshotV1 {
  schemaVersion: 1
  generatedAt: string
  period: {
    startUtc: string
    endUtc: string
    timezone: string
    startLocal: string
    endLocal: string
    tokenAttribution: 'call-completed-at'
    runAttribution: 'run-started-at'
  }
  totals: UsageTotalsV1 & {
    runs: number
    completedRuns: number
    failedRuns: number
    runningRuns: number
    retries: number
    successRate: number | null
  }
  byApplication: UsageBreakdownV1[]
  byInvocationType: UsageBreakdownV1[]
  byRole: UsageBreakdownV1[]
  byBackend: UsageBreakdownV1[]
  byModel: UsageBreakdownV1[]
  topRuns: UsageRunSummaryV1[]
  dataQuality: {
    filesRead: number
    invalidFiles: number
    unsupportedSchemaFiles: number
  }
}

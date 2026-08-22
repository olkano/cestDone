import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Backend, BackendInvocation, BackendResult, BackendType, RunInvocationContext } from '../shared/types.js'
import type { SessionLogger } from '../shared/logger.js'
import type { UsageCallRecordV1, UsageRunRecordV1, UsageTotalsV1 } from './types.js'

const EMPTY_TOTALS: UsageTotalsV1 = {
  calls: 0,
  successfulCalls: 0,
  failedCalls: 0,
  inputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
  totalProcessedTokens: 0,
  actualCostUsd: null,
  callsWithActualCost: 0,
}

export interface UsageRecorderOptions {
  usageDir: string
  application: string
  invocation: RunInvocationContext
  originalSpecPath: string
  targetRepoPath: string
  runDir: string
  logger: SessionLogger
  now?: () => Date
  randomUUID?: () => string
}

export function normalizeApplication(value: string): string {
  const normalized = value.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'unknown'
}

export function totalProcessedTokens(usage: {
  inputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
}): number {
  return usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens + usage.outputTokens
}

export function calculateUsageTotals(calls: readonly UsageCallRecordV1[]): UsageTotalsV1 {
  const totals = { ...EMPTY_TOTALS }
  let knownCost = 0
  for (const call of calls) {
    totals.calls++
    if (call.success) totals.successfulCalls++
    else totals.failedCalls++
    totals.inputTokens += call.inputTokens
    totals.cacheCreationInputTokens += call.cacheCreationInputTokens
    totals.cacheReadInputTokens += call.cacheReadInputTokens
    totals.outputTokens += call.outputTokens
    totals.totalProcessedTokens += call.totalProcessedTokens
    if (call.actualCostUsd !== null) {
      totals.callsWithActualCost++
      knownCost += call.actualCostUsd
    }
  }
  totals.actualCostUsd = totals.callsWithActualCost > 0 ? knownCost : null
  return totals
}

export class UsageRecorder {
  readonly runId: string
  readonly recordPath: string
  private readonly now: () => Date
  private active = true
  private record: UsageRunRecordV1

  constructor(private readonly options: UsageRecorderOptions) {
    this.now = options.now ?? (() => new Date())
    this.runId = (options.randomUUID ?? crypto.randomUUID)()
    const startedAt = this.now().toISOString()
    const recordsDir = path.join(
      options.usageDir,
      'runs',
      startedAt.slice(0, 4),
      startedAt.slice(5, 7),
    )
    this.recordPath = path.join(recordsDir, `${this.runId}.json`)
    this.record = {
      schemaVersion: 1,
      runId: this.runId,
      startedAt,
      status: 'running',
      application: normalizeApplication(options.application),
      invocation: {
        type: options.invocation.type,
        ...(options.invocation.triggerName ? { triggerName: options.invocation.triggerName } : {}),
        ...(options.invocation.daemonJobId ? { daemonJobId: options.invocation.daemonJobId } : {}),
        ...(options.invocation.attempt !== undefined ? { attempt: options.invocation.attempt } : {}),
      },
      originalSpecPath: path.resolve(options.originalSpecPath),
      targetRepoPath: path.resolve(options.targetRepoPath),
      runDir: options.runDir,
      calls: [],
      totals: { ...EMPTY_TOTALS },
    }
    this.persist('initialize')
  }

  recordCall(backend: BackendType, invocation: BackendInvocation, result: BackendResult): void {
    if (!this.active || !invocation.usageContext) return
    const usage = result.usage
    const call: UsageCallRecordV1 = {
      callId: crypto.randomUUID(),
      completedAt: this.now().toISOString(),
      role: invocation.usageContext.role,
      workflowStep: invocation.usageContext.workflowStep,
      ...(invocation.usageContext.phaseNumber !== undefined
        ? { phaseNumber: invocation.usageContext.phaseNumber }
        : {}),
      backend,
      model: invocation.model,
      success: result.success,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
      inputTokens: usage.inputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      outputTokens: usage.outputTokens,
      totalProcessedTokens: totalProcessedTokens(usage),
      actualCostUsd: result.costUsd,
    }
    this.record.calls.push(call)
    this.record.totals = calculateUsageTotals(this.record.calls)
    this.persist('record model call')
  }

  finalize(status: 'completed' | 'failed', error?: unknown): void {
    if (!this.active) return
    this.record.status = status
    this.record.completedAt = this.now().toISOString()
    if (status === 'failed') {
      this.record.errorCategory = error instanceof Error && error.name ? error.name : 'Error'
    }
    this.record.totals = calculateUsageTotals(this.record.calls)
    this.persist('finalize')
  }

  getRecord(): UsageRunRecordV1 {
    return structuredClone(this.record)
  }

  private persist(action: string): void {
    try {
      const dir = path.dirname(this.recordPath)
      fs.mkdirSync(dir, { recursive: true })
      const tempPath = path.join(dir, `.${this.runId}.${process.pid}.tmp`)
      fs.writeFileSync(tempPath, JSON.stringify(this.record, null, 2) + '\n', 'utf-8')
      fs.renameSync(tempPath, this.recordPath)
    } catch (error) {
      this.active = false
      const message = error instanceof Error ? error.message : String(error)
      this.options.logger.log('Usage', `Failed to ${action} usage record: ${message}`)
    }
  }
}

export class UsageTrackingBackend implements Backend {
  readonly name: BackendType

  constructor(
    private readonly backend: Backend,
    private readonly recorder: UsageRecorder,
  ) {
    this.name = backend.name
  }

  async invoke(params: BackendInvocation): Promise<BackendResult> {
    const result = await this.backend.invoke(params)
    this.recorder.recordCall(this.name, params, result)
    return result
  }

  preflight(): Promise<{ ok: boolean; error?: string }> {
    return this.backend.preflight()
  }
}

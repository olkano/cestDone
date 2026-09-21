// src/worker/result-parser.ts
import type { WorkerResult, WorkerReport, BackendResult } from '../shared/types.js'
import { mapSdkUsage } from '../shared/types.js'
import { isWorkerWire, normalizeWorkerWire } from '../shared/output-schemas.js'

export interface SDKResultLike {
  type: 'result'
  subtype: string
  duration_ms: number
  num_turns: number
  total_cost_usd: number
  result?: string
  structured_output?: unknown
  errors?: string[]
  usage?: unknown
}

export function parseResult(msg: SDKResultLike): WorkerResult {
  const base = {
    cost: msg.total_cost_usd,
    actualCostUsd: msg.total_cost_usd,
    numTurns: msg.num_turns,
    durationMs: msg.duration_ms,
    usage: mapSdkUsage(msg.usage),
    billingMode: 'metered' as const,
    usageStatus: 'reported' as const,
  }

  if (msg.subtype !== 'success') {
    const errorLabel = msg.subtype.replace('error_', '')
    const errorDetail = msg.errors?.join('; ') ?? 'unknown error'
    return {
      ...base,
      status: 'failed',
      message: `Worker failed: ${errorLabel} — ${errorDetail}`,
      report: null,
    }
  }

  const report = extractReport(msg)
  return {
    ...base,
    status: report.status === 'success' ? 'success' : report.status === 'failed' ? 'failed' : 'partial',
    message: report.summary,
    filesChanged: report.filesChanged,
    report,
  }
}

export function parseWorkerResult(result: BackendResult): WorkerResult {
  const base = {
    cost: result.costUsd ?? 0,
    actualCostUsd: result.costUsd,
    numTurns: result.numTurns,
    durationMs: result.durationMs,
    usage: result.usage,
    billingMode: result.billingMode,
    usageStatus: result.usageStatus,
    reasoningOutputTokens: result.reasoningOutputTokens,
    errorCategory: result.errorCategory,
    toolCalls: result.toolCalls,
  }

  if (!result.success) {
    const msg = result.errorMessage ?? 'Worker failed'
    return {
      ...base,
      status: 'failed',
      message: msg,
      report: { status: 'failed', summary: msg },
    }
  }

  const report = extractReportFromOutput(result.output)
  return {
    ...base,
    status: report.status === 'success' ? 'success' : report.status === 'failed' ? 'failed' : 'partial',
    message: report.summary,
    filesChanged: report.filesChanged,
    report,
  }
}

function extractReportFromOutput(output: unknown): WorkerReport {
  const normalized = normalizeWorkerWire(output)
  if (isWorkerWire(normalized)) return fromWire(normalized as Record<string, unknown>)
  if (typeof output === 'string') {
    return { status: 'partial', summary: output }
  }
  return { status: 'partial', summary: '(no output)' }
}

function extractReport(msg: SDKResultLike): WorkerReport {
  if (msg.structured_output && typeof msg.structured_output === 'object') {
    const normalized = normalizeWorkerWire(msg.structured_output)
    if (isWorkerWire(normalized)) return fromWire(normalized as Record<string, unknown>)
    return { status: 'failed', summary: 'Worker returned invalid structured output' }
  }

  if (msg.result) {
    try {
      const parsed = JSON.parse(msg.result) as WorkerReport
      const normalized = normalizeWorkerWire(parsed)
      if (isWorkerWire(normalized)) return fromWire(normalized as Record<string, unknown>)
    } catch {
      // Not JSON — fall through to raw text
    }

    return {
      status: 'partial',
      summary: msg.result,
    }
  }

  return {
    status: 'partial',
    summary: '(no output)',
  }
}

function fromWire(value: Record<string, unknown>): WorkerReport {
  return {
    status: value.status as WorkerReport['status'],
    summary: value.summary as string,
    ...(value.filesChanged !== null ? { filesChanged: value.filesChanged as string[] } : {}),
    ...(value.testsRun !== null ? { testsRun: value.testsRun as WorkerReport['testsRun'] } : {}),
    ...(value.issues !== null ? { issues: value.issues as string[] } : {}),
  }
}

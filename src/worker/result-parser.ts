// src/worker/result-parser.ts
import type { WorkerResult, WorkerReport, BackendResult } from '../shared/types.js'
import { mapSdkUsage } from '../shared/types.js'

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
    numTurns: msg.num_turns,
    durationMs: msg.duration_ms,
    usage: mapSdkUsage(msg.usage),
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
    numTurns: result.numTurns,
    durationMs: result.durationMs,
    usage: result.usage,
  }

  if (!result.success) {
    const msg = result.errorMessage ?? 'Worker failed'
    return {
      ...base,
      status: 'failed',
      message: msg,
      report: result.output
        ? extractReportFromOutput(result.output)
        : { status: 'failed', summary: msg },
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
  if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>
    if (obj.status && obj.summary) return output as WorkerReport
  }
  if (typeof output === 'string') {
    return { status: 'partial', summary: output }
  }
  return { status: 'partial', summary: '(no output)' }
}

function extractReport(msg: SDKResultLike): WorkerReport {
  if (msg.structured_output && typeof msg.structured_output === 'object') {
    return msg.structured_output as WorkerReport
  }

  if (msg.result) {
    try {
      const parsed = JSON.parse(msg.result) as WorkerReport
      if (parsed.status && parsed.summary) {
        return parsed
      }
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

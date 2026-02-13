// src/coder/result-parser.ts
import type { CoderResult, CoderReport } from '../shared/types.js'

export interface SDKResultLike {
  type: 'result'
  subtype: string
  duration_ms: number
  num_turns: number
  total_cost_usd: number
  result?: string
  structured_output?: unknown
  errors?: string[]
}

export function parseResult(msg: SDKResultLike): CoderResult {
  const base = {
    cost: msg.total_cost_usd,
    numTurns: msg.num_turns,
    durationMs: msg.duration_ms,
  }

  if (msg.subtype !== 'success') {
    const errorLabel = msg.subtype.replace('error_', '')
    const errorDetail = msg.errors?.join('; ') ?? 'unknown error'
    return {
      ...base,
      status: 'failed',
      message: `Coder failed: ${errorLabel} — ${errorDetail}`,
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

function extractReport(msg: SDKResultLike): CoderReport {
  if (msg.structured_output && typeof msg.structured_output === 'object') {
    return msg.structured_output as CoderReport
  }

  if (msg.result) {
    try {
      const parsed = JSON.parse(msg.result) as CoderReport
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

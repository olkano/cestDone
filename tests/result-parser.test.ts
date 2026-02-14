// tests/result-parser.test.ts
import { describe, it, expect } from 'vitest'
import { parseResult } from '../src/coder/result-parser.js'

// Minimal SDKResultMessage shapes matching the SDK types

function makeSuccessResult(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result' as const,
    subtype: 'success' as const,
    uuid: 'uuid-1',
    session_id: 'sess-1',
    duration_ms: 5000,
    duration_api_ms: 4500,
    is_error: false,
    num_turns: 10,
    result: '',
    total_cost_usd: 0.25,
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    modelUsage: {},
    permission_denials: [],
    ...overrides,
  }
}

function makeErrorResult(subtype: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'result' as const,
    subtype,
    uuid: 'uuid-1',
    session_id: 'sess-1',
    duration_ms: 3000,
    duration_api_ms: 2500,
    is_error: true,
    num_turns: 5,
    total_cost_usd: 0.10,
    usage: { inputTokens: 500, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    modelUsage: {},
    permission_denials: [],
    errors: ['Something went wrong'],
    ...overrides,
  }
}

describe('parseResult', () => {
  // P1: Parses structured_output from successful SDKResultMessage into CoderReport
  it('parses structured_output into CoderReport', () => {
    const msg = makeSuccessResult({
      structured_output: {
        status: 'success',
        summary: 'Implemented login endpoint',
        filesChanged: ['src/auth.ts', 'tests/auth.test.ts'],
        testsRun: { passed: 10, failed: 0, skipped: 0 },
      },
    })

    const result = parseResult(msg)

    expect(result.status).toBe('success')
    expect(result.report).not.toBeNull()
    expect(result.report!.status).toBe('success')
    expect(result.report!.summary).toBe('Implemented login endpoint')
    expect(result.report!.filesChanged).toEqual(['src/auth.ts', 'tests/auth.test.ts'])
    expect(result.report!.testsRun).toEqual({ passed: 10, failed: 0, skipped: 0 })
  })

  // P2: Falls back to extracting from result text when structured_output is missing
  it('falls back to JSON parsing result text when structured_output is absent', () => {
    const report = { status: 'success', summary: 'Done via text', filesChanged: ['a.ts'] }
    const msg = makeSuccessResult({
      result: JSON.stringify(report),
    })

    const result = parseResult(msg)

    expect(result.status).toBe('success')
    expect(result.report!.summary).toBe('Done via text')
    expect(result.report!.filesChanged).toEqual(['a.ts'])
  })

  // P3: Returns failed result for error_max_turns subtype
  it('returns failed result for error_max_turns', () => {
    const msg = makeErrorResult('error_max_turns')

    const result = parseResult(msg)

    expect(result.status).toBe('failed')
    expect(result.message).toContain('max_turns')
    expect(result.cost).toBe(0.10)
    expect(result.numTurns).toBe(5)
  })

  // P4: Returns failed result for error_during_execution
  it('returns failed result for error_during_execution', () => {
    const msg = makeErrorResult('error_during_execution')

    const result = parseResult(msg)

    expect(result.status).toBe('failed')
    expect(result.message).toContain('during_execution')
  })

  // P5: Returns failed result for error_max_budget_usd
  it('returns failed result for error_max_budget_usd', () => {
    const msg = makeErrorResult('error_max_budget_usd')

    const result = parseResult(msg)

    expect(result.status).toBe('failed')
    expect(result.message).toContain('max_budget')
  })

  // P6: Extracts total_cost_usd, num_turns, duration_ms into CoderResult fields
  it('extracts cost, turns, and duration from result message', () => {
    const msg = makeSuccessResult({
      structured_output: { status: 'success', summary: 'OK' },
      total_cost_usd: 1.50,
      num_turns: 42,
      duration_ms: 120000,
    })

    const result = parseResult(msg)

    expect(result.cost).toBe(1.50)
    expect(result.numTurns).toBe(42)
    expect(result.durationMs).toBe(120000)
  })

  // P7: Raw text fallback produces CoderReport with status 'partial'
  it('wraps raw text into partial report when JSON parsing fails', () => {
    const msg = makeSuccessResult({
      result: 'I implemented the feature but tests are flaky.',
    })

    const result = parseResult(msg)

    expect(result.status).toBe('partial')
    expect(result.report).not.toBeNull()
    expect(result.report!.status).toBe('partial')
    expect(result.report!.summary).toBe('I implemented the feature but tests are flaky.')
  })

  // P6 edge case: error subtypes also extract cost/turns/duration
  it('extracts cost and turns from error results too', () => {
    const msg = makeErrorResult('error_max_turns', {
      total_cost_usd: 0.55,
      num_turns: 100,
      duration_ms: 90000,
    })

    const result = parseResult(msg)

    expect(result.cost).toBe(0.55)
    expect(result.numTurns).toBe(100)
    expect(result.durationMs).toBe(90000)
  })

  // Usage extraction
  it('extracts usage tokens from result message', () => {
    const msg = makeSuccessResult({
      structured_output: { status: 'success', summary: 'OK' },
      usage: { inputTokens: 2000, outputTokens: 800, cacheReadInputTokens: 500, cacheCreationInputTokens: 100 },
    })

    const result = parseResult(msg)

    expect(result.usage.inputTokens).toBe(2000)
    expect(result.usage.outputTokens).toBe(800)
    expect(result.usage.cacheReadInputTokens).toBe(500)
    expect(result.usage.cacheCreationInputTokens).toBe(100)
  })

  it('defaults usage to zeros when missing from result', () => {
    const msg = makeSuccessResult({
      structured_output: { status: 'success', summary: 'OK' },
      usage: undefined,
    })

    const result = parseResult(msg)

    expect(result.usage.inputTokens).toBe(0)
    expect(result.usage.outputTokens).toBe(0)
    expect(result.usage.cacheReadInputTokens).toBe(0)
    expect(result.usage.cacheCreationInputTokens).toBe(0)
  })
})

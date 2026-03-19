// tests/worker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeWorker } from '../src/worker/worker.js'
import { WorkflowStep } from '../src/shared/types.js'
import type { WorkerOptions, Backend, BackendResult } from '../src/shared/types.js'

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }

function makeBackendResult(overrides: Partial<BackendResult> = {}): BackendResult {
  return {
    output: { status: 'success', summary: 'Done' },
    rawText: '{"status":"success","summary":"Done"}',
    sessionId: 'sess-1',
    costUsd: 0.25,
    numTurns: 10,
    durationMs: 5000,
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    success: true,
    ...overrides,
  }
}

function makeMockBackend(): Backend & { invoke: ReturnType<typeof vi.fn> } {
  return {
    name: 'agent-sdk',
    invoke: vi.fn().mockResolvedValue(makeBackendResult()),
    preflight: vi.fn().mockResolvedValue({ ok: true }),
  }
}

function makeOptions(overrides: Partial<WorkerOptions> = {}): WorkerOptions {
  return {
    step: WorkflowStep.Execute,
    phase: { number: 1, name: 'Test Phase', status: 'in-progress', spec: 'Do stuff.', applicableRules: '', done: '' },
    model: 'claude-opus-4-6',
    targetRepoPath: '/tmp/repo',
    houseRulesContent: 'Use TDD.',
    instructions: 'Implement the feature.',
    maxTurns: 100,
    logger: { log: vi.fn(), logVerbose: vi.fn() },
    backend: makeMockBackend(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('executeWorker', () => {
  // Q1: Calls backend.invoke() with correct prompt, cwd, model, maxTurns
  it('calls backend.invoke() with correct prompt, cwd, model, maxTurns', async () => {
    const backend = makeMockBackend()
    await executeWorker(makeOptions({ backend }))

    expect(backend.invoke).toHaveBeenCalledTimes(1)
    const params = backend.invoke.mock.calls[0][0]
    expect(params.prompt).toContain('Implement the feature.')
    expect(params.cwd).toContain('tmp')
    expect(params.cwd).toContain('repo')
    expect(params.model).toBe('claude-opus-4-6')
    expect(params.maxTurns).toBe(100)
  })

  // Q3: Sets tools from getTools(step)
  it('passes tools based on step', async () => {
    const backend = makeMockBackend()
    await executeWorker(makeOptions({ backend, step: WorkflowStep.Analyze }))

    const params = backend.invoke.mock.calls[0][0]
    expect(params.tools).toEqual(['Read', 'Glob', 'Grep'])
  })

  it('passes full tools for Execute step', async () => {
    const backend = makeMockBackend()
    await executeWorker(makeOptions({ backend, step: WorkflowStep.Execute }))

    const params = backend.invoke.mock.calls[0][0]
    expect(params.tools).toEqual(['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep'])
  })

  // Q4: Passes house rules as systemPrompt
  it('passes house rules as systemPrompt', async () => {
    const backend = makeMockBackend()
    await executeWorker(makeOptions({ backend, houseRulesContent: 'Always use TDD.' }))

    const params = backend.invoke.mock.calls[0][0]
    expect(params.systemPrompt).toBe('Always use TDD.')
  })

  // Q5: Passes outputSchema
  it('passes outputSchema', async () => {
    const backend = makeMockBackend()
    await executeWorker(makeOptions({ backend }))

    const params = backend.invoke.mock.calls[0][0]
    expect(params.outputSchema).toEqual(expect.objectContaining({
      type: 'object',
      properties: expect.objectContaining({
        status: expect.any(Object),
        summary: expect.any(Object),
      }),
      required: ['status', 'summary'],
    }))
  })

  // Q6: Passes maxBudgetUsd
  it('passes maxBudgetUsd when defined', async () => {
    const backend = makeMockBackend()
    await executeWorker(makeOptions({ backend, maxBudgetUsd: 5.0 }))

    const params = backend.invoke.mock.calls[0][0]
    expect(params.maxBudgetUsd).toBe(5.0)
  })

  it('omits maxBudgetUsd when undefined', async () => {
    const backend = makeMockBackend()
    await executeWorker(makeOptions({ backend, maxBudgetUsd: undefined }))

    const params = backend.invoke.mock.calls[0][0]
    expect(params.maxBudgetUsd).toBeUndefined()
  })

  // Q9: Extracts cost, turns, duration from result
  it('extracts cost, turns, duration from result', async () => {
    const backend = makeMockBackend()
    backend.invoke.mockResolvedValue(makeBackendResult({
      costUsd: 1.50,
      numTurns: 42,
      durationMs: 120000,
      usage: { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    }))

    const result = await executeWorker(makeOptions({ backend }))

    expect(result.cost).toBe(1.50)
    expect(result.numTurns).toBe(42)
    expect(result.durationMs).toBe(120000)
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
  })

  // Q10: Returns parsed structured report
  it('returns parsed structured report', async () => {
    const backend = makeMockBackend()
    backend.invoke.mockResolvedValue(makeBackendResult({
      output: {
        status: 'success',
        summary: 'Implemented login endpoint',
        filesChanged: ['src/auth.ts'],
        testsRun: { passed: 5, failed: 0, skipped: 0 },
      },
    }))

    const result = await executeWorker(makeOptions({ backend }))

    expect(result.status).toBe('success')
    expect(result.report).not.toBeNull()
    expect(result.report!.summary).toBe('Implemented login endpoint')
    expect(result.report!.filesChanged).toEqual(['src/auth.ts'])
    expect(result.report!.testsRun).toEqual({ passed: 5, failed: 0, skipped: 0 })
  })

  // Q11: Backend returns failure — returns failed WorkerResult
  it('returns failed when backend returns failure', async () => {
    const backend = makeMockBackend()
    backend.invoke.mockResolvedValue(makeBackendResult({
      success: false,
      output: null,
      rawText: undefined,
      costUsd: null,
      numTurns: 0,
      durationMs: 0,
      usage: ZERO_USAGE,
      errorMessage: 'CLI error: something failed',
    }))

    const result = await executeWorker(makeOptions({ backend }))

    expect(result.status).toBe('failed')
    expect(result.cost).toBe(0)
    expect(result.usage).toEqual(ZERO_USAGE)
    expect(result.report).not.toBeNull()
    expect(result.report!.status).toBe('failed')
  })

  // Q12: backend.invoke() throws — catches and returns failed WorkerResult
  it('catches backend.invoke() exception and returns failed result', async () => {
    const backend = makeMockBackend()
    backend.invoke.mockRejectedValue(new Error('Network connection failed'))

    const result = await executeWorker(makeOptions({ backend }))

    expect(result.status).toBe('failed')
    expect(result.message).toContain('Network connection failed')
    expect(result.cost).toBe(0)
    expect(result.numTurns).toBe(0)
    expect(result.durationMs).toBe(0)
    expect(result.usage).toEqual(ZERO_USAGE)
    expect(result.report).not.toBeNull()
    expect(result.report!.status).toBe('failed')
    expect(result.report!.summary).toContain('Network connection failed')
  })

  // Q13: Passes env to backend
  it('passes env to backend', async () => {
    const backend = makeMockBackend()
    await executeWorker(makeOptions({ backend }))

    const params = backend.invoke.mock.calls[0][0]
    expect(params.env).toBeDefined()
  })
})

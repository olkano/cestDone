// tests/agent-sdk-backend.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BackendInvocation, BackendResult, TokenUsage } from '../src/shared/types.js'

const mockQuery = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

async function* generateMessages(...messages: unknown[]) {
  for (const msg of messages) yield msg
}

function createMockQuery(...messages: unknown[]) {
  return Object.assign(generateMessages(...messages), { close: vi.fn() })
}

function makeSystemMessage(sessionId = 'sess-1') {
  return { type: 'system', session_id: sessionId }
}

function makeAssistantMessage(content: Array<{ type: string; text?: string; name?: string; input?: unknown }>) {
  return { type: 'assistant', message: { content } }
}

function makeResultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0.05,
    num_turns: 3,
    duration_ms: 2000,
    usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
    structured_output: { action: 'done', message: 'ok' },
    result: '{"action":"done","message":"ok"}',
    ...overrides,
  }
}

function makeInvocation(overrides: Partial<BackendInvocation> = {}): BackendInvocation {
  return {
    prompt: 'test prompt',
    systemPrompt: 'test system prompt',
    model: 'claude-sonnet-4-6',
    tools: ['Read', 'Glob', 'Grep'],
    outputSchema: { type: 'object', properties: { action: { type: 'string' } } },
    cwd: '/test/repo',
    maxTurns: 15,
    env: { PATH: '/usr/bin', OTHER: 'value' },
    logger: { log: vi.fn(), logVerbose: vi.fn(), logFilePath: '' },
    ...overrides,
  }
}

describe('AgentSdkBackend', () => {
  let AgentSdkBackend: typeof import('../src/backends/agent-sdk.js').AgentSdkBackend

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../src/backends/agent-sdk.js')
    AgentSdkBackend = mod.AgentSdkBackend
  })

  describe('name', () => {
    it('returns agent-sdk', () => {
      const backend = new AgentSdkBackend()
      expect(backend.name).toBe('agent-sdk')
    })
  })

  describe('invoke()', () => {
    it('calls query() with correct options for non-resume call', async () => {
      mockQuery.mockReturnValue(createMockQuery(makeSystemMessage(), makeResultMessage()))
      const backend = new AgentSdkBackend()
      const params = makeInvocation()

      await backend.invoke(params)

      expect(mockQuery).toHaveBeenCalledTimes(1)
      const callArgs = mockQuery.mock.calls[0][0]
      expect(callArgs.prompt).toBe('test prompt')
      expect(callArgs.options.model).toBe('claude-sonnet-4-6')
      expect(callArgs.options.cwd).toBe('/test/repo')
      expect(callArgs.options.maxTurns).toBe(15)
      expect(callArgs.options.tools).toEqual(['Read', 'Glob', 'Grep'])
      expect(callArgs.options.permissionMode).toBe('bypassPermissions')
      expect(callArgs.options.allowDangerouslySkipPermissions).toBe(true)
      expect(callArgs.options.systemPrompt).toEqual({
        type: 'preset',
        preset: 'claude_code',
        append: 'test system prompt',
      })
      expect(callArgs.options.outputFormat).toEqual({
        type: 'json_schema',
        schema: params.outputSchema,
      })
    })

    it('uses resume instead of systemPrompt when resumeSessionId provided', async () => {
      mockQuery.mockReturnValue(createMockQuery(makeSystemMessage(), makeResultMessage()))
      const backend = new AgentSdkBackend()

      await backend.invoke(makeInvocation({ resumeSessionId: 'sess-123' }))

      const callArgs = mockQuery.mock.calls[0][0]
      expect(callArgs.options.resume).toBe('sess-123')
      expect(callArgs.options.systemPrompt).toBeUndefined()
    })

    it('includes maxBudgetUsd when provided', async () => {
      mockQuery.mockReturnValue(createMockQuery(makeSystemMessage(), makeResultMessage()))
      const backend = new AgentSdkBackend()

      await backend.invoke(makeInvocation({ maxBudgetUsd: 5.0 }))

      const callArgs = mockQuery.mock.calls[0][0]
      expect(callArgs.options.maxBudgetUsd).toBe(5.0)
    })

    it('omits maxBudgetUsd when not provided', async () => {
      mockQuery.mockReturnValue(createMockQuery(makeSystemMessage(), makeResultMessage()))
      const backend = new AgentSdkBackend()

      await backend.invoke(makeInvocation({ maxBudgetUsd: undefined }))

      const callArgs = mockQuery.mock.calls[0][0]
      expect(callArgs.options.maxBudgetUsd).toBeUndefined()
    })

    it('strips CLAUDECODE from env', async () => {
      mockQuery.mockReturnValue(createMockQuery(makeSystemMessage(), makeResultMessage()))
      const backend = new AgentSdkBackend()

      await backend.invoke(makeInvocation({ env: { CLAUDECODE: 'true', PATH: '/usr/bin' } }))

      const callArgs = mockQuery.mock.calls[0][0]
      expect(callArgs.options.env.CLAUDECODE).toBeUndefined()
      expect(callArgs.options.env.PATH).toBe('/usr/bin')
    })

    it('returns BackendResult from structured_output', async () => {
      const structured = { action: 'done', message: 'all good' }
      mockQuery.mockReturnValue(createMockQuery(
        makeSystemMessage('sess-42'),
        makeResultMessage({ structured_output: structured }),
      ))
      const backend = new AgentSdkBackend()

      const result = await backend.invoke(makeInvocation())

      expect(result.output).toEqual(structured)
      expect(result.sessionId).toBe('sess-42')
      expect(result.costUsd).toBe(0.05)
      expect(result.numTurns).toBe(3)
      expect(result.durationMs).toBe(2000)
      expect(result.success).toBe(true)
      expect(result.usage).toEqual({
        inputTokens: 500,
        outputTokens: 200,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 50,
      })
    })

    it('parses result text as JSON when no structured_output', async () => {
      mockQuery.mockReturnValue(createMockQuery(
        makeSystemMessage(),
        makeResultMessage({ structured_output: undefined, result: '{"action":"analyze","message":"parsed"}' }),
      ))
      const backend = new AgentSdkBackend()

      const result = await backend.invoke(makeInvocation())

      expect(result.output).toEqual({ action: 'analyze', message: 'parsed' })
      expect(result.rawText).toBe('{"action":"analyze","message":"parsed"}')
    })

    it('returns raw text when no schema and result is not JSON', async () => {
      mockQuery.mockReturnValue(createMockQuery(
        makeSystemMessage(),
        makeResultMessage({ structured_output: undefined, result: 'plain text response' }),
      ))
      const backend = new AgentSdkBackend()

      const result = await backend.invoke(makeInvocation({ outputSchema: undefined }))

      expect(result.output).toBe('plain text response')
      expect(result.rawText).toBe('plain text response')
    })

    it('returns success:false for error subtypes', async () => {
      mockQuery.mockReturnValue(createMockQuery(
        makeSystemMessage(),
        makeResultMessage({ subtype: 'error_max_turns', structured_output: undefined, result: 'hit max turns' }),
      ))
      const backend = new AgentSdkBackend()

      const result = await backend.invoke(makeInvocation())

      expect(result.success).toBe(false)
      expect(result.errorMessage).toBeDefined()
    })

    it('calls q.close() in finally block', async () => {
      const mq = createMockQuery(makeSystemMessage(), makeResultMessage())
      mockQuery.mockReturnValue(mq)
      const backend = new AgentSdkBackend()

      await backend.invoke(makeInvocation())

      expect(mq.close).toHaveBeenCalled()
    })

    it('handles query() throwing an error', async () => {
      mockQuery.mockImplementation(() => { throw new Error('SDK connection failed') })
      const backend = new AgentSdkBackend()

      const result = await backend.invoke(makeInvocation())

      expect(result.success).toBe(false)
      expect(result.errorMessage).toContain('SDK connection failed')
    })

    it('logs assistant text and tool_use blocks', async () => {
      mockQuery.mockReturnValue(createMockQuery(
        makeSystemMessage(),
        makeAssistantMessage([
          { type: 'text', text: 'Analyzing the code...' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/test/file.ts' } },
        ]),
        makeResultMessage(),
      ))
      const backend = new AgentSdkBackend()
      const logger = { log: vi.fn(), logVerbose: vi.fn(), logFilePath: '' }

      await backend.invoke(makeInvocation({ logger }))

      const logCalls = logger.log.mock.calls.map((c: unknown[]) => c[1])
      expect(logCalls.some((msg: string) => msg.includes('Analyzing the code'))).toBe(true)
      expect(logCalls.some((msg: string) => msg.includes('Read'))).toBe(true)
    })

    it('omits outputFormat when no outputSchema', async () => {
      mockQuery.mockReturnValue(createMockQuery(makeSystemMessage(), makeResultMessage()))
      const backend = new AgentSdkBackend()

      await backend.invoke(makeInvocation({ outputSchema: undefined }))

      const callArgs = mockQuery.mock.calls[0][0]
      expect(callArgs.options.outputFormat).toBeUndefined()
    })

    it('omits tools when not provided', async () => {
      mockQuery.mockReturnValue(createMockQuery(makeSystemMessage(), makeResultMessage()))
      const backend = new AgentSdkBackend()

      await backend.invoke(makeInvocation({ tools: undefined }))

      const callArgs = mockQuery.mock.calls[0][0]
      expect(callArgs.options.tools).toBeUndefined()
    })

    it('returns empty session when no system message received', async () => {
      mockQuery.mockReturnValue(createMockQuery(makeResultMessage()))
      const backend = new AgentSdkBackend()

      const result = await backend.invoke(makeInvocation())

      expect(result.sessionId).toBe('')
    })
  })

  describe('preflight()', () => {
    const originalEnv = process.env

    afterEach(() => {
      process.env = originalEnv
    })

    it('returns ok:true when ANTHROPIC_API_KEY is set', async () => {
      process.env = { ...originalEnv, ANTHROPIC_API_KEY: 'sk-test' }
      const backend = new AgentSdkBackend()

      const result = await backend.preflight()

      expect(result).toEqual({ ok: true })
    })

    it('returns error when ANTHROPIC_API_KEY is missing', async () => {
      process.env = { ...originalEnv }
      delete process.env.ANTHROPIC_API_KEY
      const backend = new AgentSdkBackend()

      const result = await backend.preflight()

      expect(result.ok).toBe(false)
      expect(result.error).toContain('ANTHROPIC_API_KEY')
    })
  })
})

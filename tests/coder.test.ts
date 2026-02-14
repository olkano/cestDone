// tests/coder.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeCoder } from '../src/coder/coder.js'
import { WorkflowStep } from '../src/shared/types.js'
import type { CoderOptions } from '../src/shared/types.js'

const mockQuery = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

function makeOptions(overrides: Partial<CoderOptions> = {}): CoderOptions {
  return {
    step: WorkflowStep.Execute,
    phase: { number: 1, name: 'Test Phase', status: 'in-progress', spec: 'Do stuff.', done: '' },
    model: 'claude-opus-4-20250514',
    targetRepoPath: '/tmp/repo',
    houseRulesContent: 'Use TDD.',
    instructions: 'Implement the feature.',
    maxTurns: 100,
    apiKey: 'sk-test',
    logger: { log: vi.fn(), logVerbose: vi.fn() },
    ...overrides,
  }
}

function makeSystemMessage() {
  return {
    type: 'system' as const,
    subtype: 'init' as const,
    uuid: 'uuid-sys',
    session_id: 'sess-1',
    apiKeySource: 'env' as const,
    cwd: '/tmp/repo',
    tools: ['Read', 'Write', 'Edit'],
    mcp_servers: [],
    model: 'claude-opus-4-20250514',
    permissionMode: 'bypassPermissions',
    slash_commands: [],
    output_style: 'concise',
    claude_code_version: '1.0.0',
  }
}

function makeAssistantMessage(text: string) {
  return {
    type: 'assistant' as const,
    uuid: 'uuid-asst',
    session_id: 'sess-1',
    parent_tool_use_id: null,
    message: {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text }],
    },
  }
}

function makeToolCallMessage(toolName: string, input: Record<string, unknown>) {
  return {
    type: 'assistant' as const,
    uuid: 'uuid-tool',
    session_id: 'sess-1',
    parent_tool_use_id: null,
    message: {
      role: 'assistant' as const,
      content: [{ type: 'tool_use' as const, id: 'tool-1', name: toolName, input }],
    },
  }
}

function makeResultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result' as const,
    subtype: 'success' as const,
    uuid: 'uuid-res',
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

async function* generateMessages(...messages: unknown[]) {
  for (const msg of messages) {
    yield msg
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('executeCoder', () => {
  // Q1: Calls query() with correct prompt, cwd, model, maxTurns
  it('calls query() with correct prompt, cwd, model, maxTurns', async () => {
    mockQuery.mockReturnValue(generateMessages(
      makeSystemMessage(),
      makeResultMessage({ structured_output: { status: 'success', summary: 'Done' } }),
    ))

    await executeCoder(makeOptions())

    expect(mockQuery).toHaveBeenCalledTimes(1)
    const params = mockQuery.mock.calls[0][0]
    expect(params.prompt).toContain('Implement the feature.')
    expect(params.options.cwd).toContain('tmp')
    expect(params.options.cwd).toContain('repo')
    expect(params.options.model).toBe('claude-opus-4-20250514')
    expect(params.options.maxTurns).toBe(100)
  })

  // Q2: Sets permissionMode and allowDangerouslySkipPermissions
  it('sets bypassPermissions and allowDangerouslySkipPermissions', async () => {
    mockQuery.mockReturnValue(generateMessages(
      makeSystemMessage(),
      makeResultMessage({ structured_output: { status: 'success', summary: 'Done' } }),
    ))

    await executeCoder(makeOptions())

    const opts = mockQuery.mock.calls[0][0].options
    expect(opts.permissionMode).toBe('bypassPermissions')
    expect(opts.allowDangerouslySkipPermissions).toBe(true)
  })

  // Q3: Sets tools from getTools(step) — actual restriction mechanism
  it('sets tools based on step', async () => {
    mockQuery.mockReturnValue(generateMessages(
      makeSystemMessage(),
      makeResultMessage({ structured_output: { status: 'success', summary: 'Done' } }),
    ))

    await executeCoder(makeOptions({ step: WorkflowStep.Analyze }))

    const opts = mockQuery.mock.calls[0][0].options
    expect(opts.tools).toEqual(['Read', 'Glob', 'Grep'])
  })

  it('sets full tools for Execute step', async () => {
    mockQuery.mockReturnValue(generateMessages(
      makeSystemMessage(),
      makeResultMessage({ structured_output: { status: 'success', summary: 'Done' } }),
    ))

    await executeCoder(makeOptions({ step: WorkflowStep.Execute }))

    const opts = mockQuery.mock.calls[0][0].options
    expect(opts.tools).toEqual(['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep'])
  })

  // Q4: Sets systemPrompt with preset and appended house-rules
  it('sets systemPrompt with claude_code preset and house-rules in append', async () => {
    mockQuery.mockReturnValue(generateMessages(
      makeSystemMessage(),
      makeResultMessage({ structured_output: { status: 'success', summary: 'Done' } }),
    ))

    await executeCoder(makeOptions({ houseRulesContent: 'Always use TDD.' }))

    const opts = mockQuery.mock.calls[0][0].options
    expect(opts.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Always use TDD.',
    })
  })

  // Q5: Sets outputFormat with CoderReport JSON schema
  it('sets outputFormat with JSON schema', async () => {
    mockQuery.mockReturnValue(generateMessages(
      makeSystemMessage(),
      makeResultMessage({ structured_output: { status: 'success', summary: 'Done' } }),
    ))

    await executeCoder(makeOptions())

    const opts = mockQuery.mock.calls[0][0].options
    expect(opts.outputFormat).toEqual({
      type: 'json_schema',
      schema: expect.objectContaining({
        type: 'object',
        properties: expect.objectContaining({
          status: expect.any(Object),
          summary: expect.any(Object),
        }),
        required: ['status', 'summary'],
      }),
    })
  })

  // Q6: Sets maxBudgetUsd from config when defined
  it('sets maxBudgetUsd when defined', async () => {
    mockQuery.mockReturnValue(generateMessages(
      makeSystemMessage(),
      makeResultMessage({ structured_output: { status: 'success', summary: 'Done' } }),
    ))

    await executeCoder(makeOptions({ maxBudgetUsd: 5.0 }))

    const opts = mockQuery.mock.calls[0][0].options
    expect(opts.maxBudgetUsd).toBe(5.0)
  })

  it('omits maxBudgetUsd when undefined', async () => {
    mockQuery.mockReturnValue(generateMessages(
      makeSystemMessage(),
      makeResultMessage({ structured_output: { status: 'success', summary: 'Done' } }),
    ))

    await executeCoder(makeOptions({ maxBudgetUsd: undefined }))

    const opts = mockQuery.mock.calls[0][0].options
    expect(opts.maxBudgetUsd).toBeUndefined()
  })

  // Q7: Iterates async generator, logs SDKSystemMessage at debug
  it('processes system init message from generator', async () => {
    mockQuery.mockReturnValue(generateMessages(
      makeSystemMessage(),
      makeResultMessage({ structured_output: { status: 'success', summary: 'Done' } }),
    ))

    const result = await executeCoder(makeOptions())

    expect(result.status).toBe('success')
  })

  // Q8: Logs SDKAssistantMessage content blocks (text + tool calls)
  it('processes assistant messages with text and tool calls', async () => {
    mockQuery.mockReturnValue(generateMessages(
      makeSystemMessage(),
      makeAssistantMessage('I will implement the feature.'),
      makeToolCallMessage('Edit', { file: 'src/foo.ts' }),
      makeResultMessage({ structured_output: { status: 'success', summary: 'Done' } }),
    ))

    const result = await executeCoder(makeOptions())

    expect(result.status).toBe('success')
  })

  // Q9: Logs SDKResultMessage at info (cost, turns, duration, subtype)
  it('extracts cost, turns, duration from result', async () => {
    mockQuery.mockReturnValue(generateMessages(
      makeSystemMessage(),
      makeResultMessage({
        structured_output: { status: 'success', summary: 'Done' },
        total_cost_usd: 1.50,
        num_turns: 42,
        duration_ms: 120000,
      }),
    ))

    const result = await executeCoder(makeOptions())

    expect(result.cost).toBe(1.50)
    expect(result.numTurns).toBe(42)
    expect(result.durationMs).toBe(120000)
  })

  // Q10: Returns parsed CoderResult from result-parser
  it('returns parsed structured report', async () => {
    mockQuery.mockReturnValue(generateMessages(
      makeSystemMessage(),
      makeResultMessage({
        structured_output: {
          status: 'success',
          summary: 'Implemented login endpoint',
          filesChanged: ['src/auth.ts'],
          testsRun: { passed: 5, failed: 0, skipped: 0 },
        },
      }),
    ))

    const result = await executeCoder(makeOptions())

    expect(result.status).toBe('success')
    expect(result.report).not.toBeNull()
    expect(result.report!.summary).toBe('Implemented login endpoint')
    expect(result.report!.filesChanged).toEqual(['src/auth.ts'])
    expect(result.report!.testsRun).toEqual({ passed: 5, failed: 0, skipped: 0 })
  })

  // Q11: Handles generator yielding no result message — returns failed
  it('returns failed when no result message is yielded', async () => {
    mockQuery.mockReturnValue(generateMessages(
      makeSystemMessage(),
      makeAssistantMessage('Working on it...'),
    ))

    const result = await executeCoder(makeOptions())

    expect(result.status).toBe('failed')
    expect(result.message).toContain('no result')
    expect(result.cost).toBe(0)
    expect(result.report).toBeNull()
  })

  // Q12: query() throws exception — catches and returns failed CoderResult
  it('catches query() exception and returns failed result', async () => {
    mockQuery.mockReturnValue({
      async next() { throw new Error('Network connection failed') },
      [Symbol.asyncIterator]() { return this },
    })

    const result = await executeCoder(makeOptions())

    expect(result.status).toBe('failed')
    expect(result.message).toContain('Network connection failed')
    expect(result.cost).toBe(0)
    expect(result.numTurns).toBe(0)
    expect(result.durationMs).toBe(0)
    expect(result.report).not.toBeNull()
    expect(result.report!.status).toBe('failed')
    expect(result.report!.summary).toContain('Network connection failed')
  })

  it('catches when query() itself throws before iteration', async () => {
    mockQuery.mockImplementation(() => { throw new Error('SDK initialization failed') })

    const result = await executeCoder(makeOptions())

    expect(result.status).toBe('failed')
    expect(result.message).toContain('SDK initialization failed')
    expect(result.cost).toBe(0)
    expect(result.report!.status).toBe('failed')
  })

  // Q13: Strips CLAUDECODE env var before passing to query
  it('strips CLAUDECODE env var from query options', async () => {
    process.env.CLAUDECODE = '1'
    mockQuery.mockReturnValue(generateMessages(
      makeSystemMessage(),
      makeResultMessage({ structured_output: { status: 'success', summary: 'Done' } }),
    ))

    await executeCoder(makeOptions())

    const opts = mockQuery.mock.calls[0][0].options
    expect(opts.env.CLAUDECODE).toBeUndefined()
    delete process.env.CLAUDECODE
  })
})

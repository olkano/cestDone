// tests/integration.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let callId = 0

function makeToolResponse(action: string, message: string) {
  callId++
  return {
    content: [{
      type: 'tool_use',
      id: `toolu_integ_${callId}`,
      name: 'director_action',
      input: { action, message },
    }],
    stop_reason: 'tool_use',
  }
}

const mockCreate = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({
    messages: { create: mockCreate }
  }))
}))

const mockQuery = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

vi.mock('../src/cli/prompt.js')
vi.mock('../src/shared/config.js')

import { ensureTTY, askApproval, askInput } from '../src/cli/prompt.js'
import { loadConfig, resolveConfig } from '../src/shared/config.js'
import { handleRun } from '../src/cli/index.js'

const SPEC_CONTENT = `# Integration Test

## Context
An integration test project.

## House rules

## Phase 0: Setup

### Status: pending

### Spec
Set up the project structure.

### Done
_(to be filled)_
`

function makeCoderResultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result' as const,
    subtype: 'success' as const,
    uuid: 'uuid-integ',
    session_id: 'sess-integ',
    duration_ms: 5000,
    duration_api_ms: 4500,
    is_error: false,
    num_turns: 10,
    result: '',
    total_cost_usd: 0.25,
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    modelUsage: {},
    permission_denials: [],
    structured_output: { status: 'success', summary: 'Implementation complete' },
    ...overrides,
  }
}

async function* generateCoderMessages(result: Record<string, unknown> = {}) {
  yield {
    type: 'system' as const,
    subtype: 'init' as const,
    uuid: 'uuid-sys-integ',
    session_id: 'sess-integ',
    apiKeySource: 'env' as const,
    cwd: '/tmp/repo',
    tools: ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep'],
    mcp_servers: [],
    model: 'claude-opus-4-20250514',
    permissionMode: 'bypassPermissions',
    slash_commands: [],
    output_style: 'concise',
    claude_code_version: '1.0.0',
  }
  yield makeCoderResultMessage(result)
}

let tmpDir: string
let savedApiKey: string | undefined

beforeEach(() => {
  callId = 0
  vi.clearAllMocks()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-integ-'))
  savedApiKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'sk-test-integration'

  vi.mocked(ensureTTY).mockReturnValue(undefined)
  vi.mocked(askApproval).mockResolvedValue({ approved: true })
  vi.mocked(askInput).mockResolvedValue('done')
  vi.mocked(loadConfig).mockReturnValue({
    defaultModel: 'claude-opus-4-20250514',
    targetRepoPath: '.',
    logLevel: 'silent',
    maxTurns: 100,
  })
  vi.mocked(resolveConfig).mockReturnValue({
    defaultModel: 'claude-opus-4-20250514',
    targetRepoPath: '.',
    logLevel: 'silent',
    maxTurns: 100,
    apiKey: 'sk-test-integration',
  })

  mockCreate
    .mockResolvedValueOnce(makeToolResponse('approve', 'Analysis complete. No questions.'))
    .mockResolvedValueOnce(makeToolResponse('approve', 'Plan:\n1. Create files\n2. Write tests'))
    .mockResolvedValueOnce(makeToolResponse('complete', 'Phase done. Created scaffold.'))

  mockQuery.mockReturnValue(generateCoderMessages())
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  if (savedApiKey !== undefined) {
    process.env.ANTHROPIC_API_KEY = savedApiKey
  } else {
    delete process.env.ANTHROPIC_API_KEY
  }
})

describe('integration', () => {
  // S3: Full Director→Coder→Director flow
  it('runs full workflow: analyze → plan → approve → execute(coder) → complete', async () => {
    const specPath = path.join(tmpDir, 'spec.md')
    fs.writeFileSync(specPath, SPEC_CONTENT, 'utf-8')

    await handleRun(specPath)

    const result = fs.readFileSync(specPath, 'utf-8')

    // Phase status should be 'done'
    expect(result).toContain('### Status: done')
    expect(result).not.toContain('### Status: pending')
    expect(result).not.toContain('### Status: in-progress')

    // Done summary should be written
    expect(result).toContain('Phase done. Created scaffold.')

    // Director API was called 3 times (analyze, plan, complete)
    expect(mockCreate).toHaveBeenCalledTimes(3)

    // Coder was called once (execute step)
    expect(mockQuery).toHaveBeenCalledTimes(1)

    // Approval was requested
    expect(askApproval).toHaveBeenCalledTimes(1)
  })

  // S4: Coder receives correct allowedTools for Execute step
  it('passes correct allowedTools to Coder for Execute step', async () => {
    const specPath = path.join(tmpDir, 'spec.md')
    fs.writeFileSync(specPath, SPEC_CONTENT, 'utf-8')

    await handleRun(specPath)

    expect(mockQuery).toHaveBeenCalledTimes(1)
    const queryParams = mockQuery.mock.calls[0][0]
    expect(queryParams.options.allowedTools).toEqual(
      ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep']
    )
  })

  it('throws when ANTHROPIC_API_KEY is not set', async () => {
    vi.mocked(resolveConfig).mockImplementation(() => {
      throw new Error('CESTDONE_CLAUDE_API_KEY or ANTHROPIC_API_KEY environment variable is required.')
    })
    const specPath = path.join(tmpDir, 'spec.md')
    fs.writeFileSync(specPath, SPEC_CONTENT, 'utf-8')

    await expect(handleRun(specPath)).rejects.toThrow('ANTHROPIC_API_KEY')
  })

  it('exits cleanly when all phases are done', async () => {
    const doneSpec = `# Done Project

## Context
Already done.

## House rules

## Phase 0: Setup

### Status: done

### Spec
_See Done summary below._

### Done
Already completed.
`
    const specPath = path.join(tmpDir, 'spec.md')
    fs.writeFileSync(specPath, doneSpec, 'utf-8')

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await handleRun(specPath)

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No pending'))
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()

    consoleSpy.mockRestore()
  })
})

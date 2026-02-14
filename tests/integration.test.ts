// tests/integration.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mockQuery = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

vi.mock('../src/cli/prompt.js')
vi.mock('../src/shared/config.js')
vi.mock('../src/shared/git.js')

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

function makeDirectorResult(action: string, message: string) {
  return {
    type: 'result' as const,
    subtype: 'success' as const,
    total_cost_usd: 0.05,
    num_turns: 3,
    duration_ms: 2000,
    structured_output: { action, message },
  }
}

function makeCoderResult(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result' as const,
    subtype: 'success' as const,
    total_cost_usd: 0.25,
    num_turns: 10,
    duration_ms: 5000,
    structured_output: { status: 'success', summary: 'Implementation complete' },
    ...overrides,
  }
}

async function* generateMessages(result: Record<string, unknown>) {
  yield { type: 'system', session_id: 'sess-1' }
  yield result
}

let queryCallIndex = 0

let tmpDir: string
let savedApiKey: string | undefined

beforeEach(() => {
  queryCallIndex = 0
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

  // Both Director and Coder use Agent SDK query() now.
  // Order: Director(analyze), Director(plan), Coder(execute), Director(review), Director(complete)
  const responses = [
    makeDirectorResult('approve', 'Analysis complete. No questions.'),
    makeDirectorResult('approve', 'Plan:\n1. Create files\n2. Write tests'),
    makeCoderResult(),
    makeDirectorResult('done', 'All verified.'),
    makeDirectorResult('done', 'Phase done. Created scaffold.'),
  ]

  mockQuery.mockImplementation(() => {
    const idx = queryCallIndex++
    return generateMessages(responses[idx])
  })
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
  // S3: Full Director→Coder→Director flow (all via Agent SDK)
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

    // Agent SDK query() called 5 times: Director(analyze), Director(plan), Coder(execute), Director(review), Director(complete)
    expect(mockQuery).toHaveBeenCalledTimes(5)

    // Approval was requested
    expect(askApproval).toHaveBeenCalledTimes(1)
  })

  // S4: Coder receives correct tools for Execute step
  it('passes correct tools to Coder for Execute step', async () => {
    const specPath = path.join(tmpDir, 'spec.md')
    fs.writeFileSync(specPath, SPEC_CONTENT, 'utf-8')

    await handleRun(specPath)

    // The 3rd query() call is the Coder (execute step)
    expect(mockQuery).toHaveBeenCalledTimes(5)
    const coderParams = mockQuery.mock.calls[2][0]
    expect(coderParams.options.tools).toEqual(
      ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep']
    )
  })

  it('throws when ANTHROPIC_API_KEY is not set', async () => {
    vi.mocked(resolveConfig).mockImplementation(() => {
      throw new Error('ANTHROPIC_API_KEY environment variable is required.')
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
    expect(mockQuery).not.toHaveBeenCalled()

    consoleSpy.mockRestore()
  })
})

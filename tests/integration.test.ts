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
vi.mock('../src/shared/logger.js', () => ({
  createSessionLogger: () => ({ log: vi.fn(), logVerbose: vi.fn() }),
}))

import { ensureTTY, askApproval, askInput } from '../src/cli/prompt.js'
import { loadConfig, resolveConfig } from '../src/shared/config.js'
import { handleRun, handleResume } from '../src/cli/index.js'

const VALID_PLAN_CONTENT = [
  '# Plan: Integration Test',
  '',
  '## Context',
  'An integration test project.',
  '',
  '## Tech Stack',
  'TypeScript, Node.js',
  '',
  '## House Rules',
  'Use TDD.',
  '',
  '## Phase 1: Setup',
  '### Status: pending',
  '### Spec',
  'Set up the project structure.',
  '### Applicable Rules',
  'Use TDD.',
  '### Done',
  '_(to be filled)_',
].join('\n')

function makeDirectorResult(action: string, message: string) {
  return {
    type: 'result' as const,
    subtype: 'success' as const,
    total_cost_usd: 0.05,
    num_turns: 3,
    duration_ms: 2000,
    usage: { inputTokens: 500, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
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
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    structured_output: { status: 'success', summary: 'Implementation complete' },
    ...overrides,
  }
}

async function* generateMessages(result: Record<string, unknown>) {
  yield { type: 'system', session_id: 'sess-1' }
  yield result
}

function createMockQuery(result: Record<string, unknown>) {
  return Object.assign(generateMessages(result), { close: vi.fn() })
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
    maxTurns: 100,
  })
  vi.mocked(resolveConfig).mockReturnValue({
    defaultModel: 'claude-opus-4-20250514',
    targetRepoPath: '.',
    maxTurns: 100,
    apiKey: 'sk-test-integration',
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
  // I1: Full flow — no plan exists → planning flow → phase execution
  it('runs full workflow: planning → phase execution → completion', async () => {
    // Planning flow: Director(analyze), Director(createPlan)
    // Phase execution: Coder(execute), Director(review), Director(complete)
    const responses = [
      makeDirectorResult('analyze', 'Spec is clear. No questions.'),
      makeDirectorResult('done', VALID_PLAN_CONTENT),
      makeCoderResult(),
      makeDirectorResult('done', 'All verified.'),
      makeDirectorResult('done', 'Phase done. Created scaffold.'),
    ]

    mockQuery.mockImplementation(() => {
      const idx = queryCallIndex++
      return createMockQuery(responses[idx])
    })

    const specPath = path.join(tmpDir, 'spec.md')
    fs.writeFileSync(specPath, 'Build a simple project with tests.', 'utf-8')

    await handleRun(specPath)

    // Plan file created
    const planPath = specPath.replace('.md', '.plan.md')
    expect(fs.existsSync(planPath)).toBe(true)
    const planContent = fs.readFileSync(planPath, 'utf-8')
    expect(planContent).toContain('# Plan: Integration Test')

    // Phase completed in plan file
    expect(planContent).toContain('### Status: done')
    expect(planContent).toContain('Phase done. Created scaffold.')

    // Original spec file unchanged
    const specContent = fs.readFileSync(specPath, 'utf-8')
    expect(specContent).toBe('Build a simple project with tests.')

    // 5 query() calls: 2 planning + 3 execution
    expect(mockQuery).toHaveBeenCalledTimes(5)

    // askApproval called once: for plan approval only (no sub-plan approval)
    expect(askApproval).toHaveBeenCalledTimes(1)
  })

  // I2: Coder receives correct tools for Execute step
  it('passes correct tools to Coder for Execute step', async () => {
    const responses = [
      makeDirectorResult('analyze', 'Spec is clear.'),
      makeDirectorResult('done', VALID_PLAN_CONTENT),
      makeCoderResult(),
      makeDirectorResult('done', 'All verified.'),
      makeDirectorResult('done', 'Done.'),
    ]

    mockQuery.mockImplementation(() => {
      const idx = queryCallIndex++
      return createMockQuery(responses[idx])
    })

    const specPath = path.join(tmpDir, 'spec.md')
    fs.writeFileSync(specPath, 'Build something.', 'utf-8')

    await handleRun(specPath)

    // The 3rd query() call (index 2) is the Coder (execute step)
    expect(mockQuery).toHaveBeenCalledTimes(5)
    const coderParams = mockQuery.mock.calls[2][0]
    expect(coderParams.options.tools).toEqual(
      ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep']
    )
  })

  // I3: Resume with existing plan — skips planning, continues execution
  it('resumes from existing plan without re-planning', async () => {
    // Write plan file directly
    const specPath = path.join(tmpDir, 'spec.md')
    const planPath = specPath.replace('.md', '.plan.md')
    fs.writeFileSync(specPath, 'Original spec.', 'utf-8')
    fs.writeFileSync(planPath, VALID_PLAN_CONTENT, 'utf-8')

    // Phase execution only: Coder(execute), Director(review), Director(complete)
    const responses = [
      makeCoderResult(),
      makeDirectorResult('done', 'All verified.'),
      makeDirectorResult('done', 'Resumed and done.'),
    ]

    mockQuery.mockImplementation(() => {
      const idx = queryCallIndex++
      return createMockQuery(responses[idx])
    })

    await handleResume(specPath)

    // Only 3 calls — no planning flow, no sub-plan
    expect(mockQuery).toHaveBeenCalledTimes(3)

    // Plan file updated with completion
    const updated = fs.readFileSync(planPath, 'utf-8')
    expect(updated).toContain('### Status: done')
    expect(updated).toContain('Resumed and done.')
  })

  it('throws when ANTHROPIC_API_KEY is not set', async () => {
    vi.mocked(resolveConfig).mockImplementation(() => {
      throw new Error('ANTHROPIC_API_KEY environment variable is required.')
    })
    const specPath = path.join(tmpDir, 'spec.md')
    fs.writeFileSync(specPath, 'Some spec.', 'utf-8')

    await expect(handleRun(specPath)).rejects.toThrow('ANTHROPIC_API_KEY')
  })

  it('exits cleanly when all phases are done in existing plan', async () => {
    const donePlan = VALID_PLAN_CONTENT
      .replace('### Status: pending', '### Status: done')
      .replace('_(to be filled)_', 'Already completed.')

    const specPath = path.join(tmpDir, 'spec.md')
    const planPath = specPath.replace('.md', '.plan.md')
    fs.writeFileSync(specPath, 'Done spec.', 'utf-8')
    fs.writeFileSync(planPath, donePlan, 'utf-8')

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await handleRun(specPath)

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('All phases complete'))
    expect(mockQuery).not.toHaveBeenCalled()

    consoleSpy.mockRestore()
  })
})

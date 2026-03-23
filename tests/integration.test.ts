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
  createSessionLogger: () => ({ log: vi.fn(), logVerbose: vi.fn(), logFilePath: '' }),
}))

import { ensureTTY, askApproval, askInput } from '../src/cli/prompt.js'
import { loadConfig } from '../src/shared/config.js'
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

function makeWorkerResult(overrides: Record<string, unknown> = {}) {
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

beforeEach(() => {
  queryCallIndex = 0
  vi.clearAllMocks()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-integ-'))
  process.env.CESTDONE_DIRECTOR_MODEL = 'claude-sonnet-4-6'
  process.env.CESTDONE_WORKER_MODEL = 'claude-haiku-4-5'

  vi.mocked(ensureTTY).mockReturnValue(undefined)
  vi.mocked(askApproval).mockResolvedValue({ approved: true })
  vi.mocked(askInput).mockResolvedValue('done')
  vi.mocked(loadConfig).mockReturnValue({
    targetRepoPath: '.',
    runDir: '.cestdone/test_2026-03-20_120000',
    maxTurns: 100,
    directorBackend: 'agent-sdk',
    workerBackend: 'agent-sdk',
  })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('integration', () => {
  // I1: Full flow — no plan exists → planning Worker → phase execution
  it('runs full workflow: planning → phase execution → completion', async () => {
    // Planning flow: Worker(plan) writes .plan.md directly
    // Phase execution: Worker(execute), Director(review), Director(complete)
    const responses = [
      makeWorkerResult({ structured_output: { status: 'success', summary: 'Plan created' } }),
      makeWorkerResult(),
      makeDirectorResult('done', 'All verified.'),
      makeDirectorResult('done', 'Phase done. Created scaffold.'),
    ]

    mockQuery.mockImplementation(() => {
      const idx = queryCallIndex++
      // Planning Worker writes the plan file as a side effect
      if (idx === 0) {
        const specPath = path.join(tmpDir, 'spec.md')
        const planPath = path.join(tmpDir, '.cestdone', 'spec.plan.md')
        fs.mkdirSync(path.dirname(planPath), { recursive: true })
        fs.writeFileSync(planPath, VALID_PLAN_CONTENT, 'utf-8')
      }
      return createMockQuery(responses[idx])
    })

    const specPath = path.join(tmpDir, 'spec.md')
    fs.writeFileSync(specPath, 'Build a simple project with tests.', 'utf-8')

    await handleRun(specPath, { target: tmpDir, withWorker: true, withReviews: true, withHumanValidation: true })

    // Plan file created by Planning Worker
    const planPath = path.join(tmpDir, '.cestdone', 'spec.plan.md')
    expect(fs.existsSync(planPath)).toBe(true)
    const planContent = fs.readFileSync(planPath, 'utf-8')
    expect(planContent).toContain('# Plan: Integration Test')

    // Phase completed in plan file
    expect(planContent).toContain('### Status: done')
    expect(planContent).toContain('Phase done. Created scaffold.')

    // Original spec file unchanged
    const specContent = fs.readFileSync(specPath, 'utf-8')
    expect(specContent).toBe('Build a simple project with tests.')

    // 4 query() calls: 1 planning Worker + 3 execution (Worker + Review + Complete)
    expect(mockQuery).toHaveBeenCalledTimes(4)

    // askApproval called once: for plan approval only
    expect(askApproval).toHaveBeenCalledTimes(1)
  })

  // I2: Worker receives correct tools for Execute step
  it('passes correct tools to Worker for Execute step', async () => {
    const responses = [
      makeWorkerResult({ structured_output: { status: 'success', summary: 'Plan created' } }),
      makeWorkerResult(),
      makeDirectorResult('done', 'All verified.'),
      makeDirectorResult('done', 'Done.'),
    ]

    mockQuery.mockImplementation(() => {
      const idx = queryCallIndex++
      if (idx === 0) {
        const planPath = path.join(tmpDir, '.cestdone', 'spec.plan.md')
        fs.mkdirSync(path.dirname(planPath), { recursive: true })
        fs.writeFileSync(planPath, VALID_PLAN_CONTENT, 'utf-8')
      }
      return createMockQuery(responses[idx])
    })

    const specPath = path.join(tmpDir, 'spec.md')
    fs.writeFileSync(specPath, 'Build something.', 'utf-8')

    await handleRun(specPath, { target: tmpDir, withWorker: true, withReviews: true })

    // 4 query() calls: planning Worker + execution Worker + review + complete
    expect(mockQuery).toHaveBeenCalledTimes(4)
    // The 2nd call (index 1) is the phase execution Worker
    const workerParams = mockQuery.mock.calls[1][0]
    expect(workerParams.options.tools).toEqual(
      ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep']
    )
  })

  // I3: Resume with existing plan — skips planning, continues execution
  it('resumes from existing plan without re-planning', async () => {
    // Write plan file directly
    const specPath = path.join(tmpDir, 'spec.md')
    const planPath = path.join(tmpDir, '.cestdone', 'spec.plan.md')
    fs.writeFileSync(specPath, 'Original spec.', 'utf-8')
    fs.mkdirSync(path.join(tmpDir, '.cestdone'), { recursive: true })
    fs.writeFileSync(planPath, VALID_PLAN_CONTENT, 'utf-8')

    // Phase execution only: Worker(execute), Director(review), Director(complete)
    const responses = [
      makeWorkerResult(),
      makeDirectorResult('done', 'All verified.'),
      makeDirectorResult('done', 'Resumed and done.'),
    ]

    mockQuery.mockImplementation(() => {
      const idx = queryCallIndex++
      return createMockQuery(responses[idx])
    })

    await handleResume(specPath, { target: tmpDir, withWorker: true, withReviews: true })

    // Only 3 calls — no planning flow, no sub-plan
    expect(mockQuery).toHaveBeenCalledTimes(3)

    // Plan file updated with completion
    const updated = fs.readFileSync(planPath, 'utf-8')
    expect(updated).toContain('### Status: done')
    expect(updated).toContain('Resumed and done.')
  })

  // I4: Director session — no planning session, fresh Director at Review
  it('starts fresh Director session at Review (no planning session)', async () => {
    const responses = [
      makeWorkerResult({ structured_output: { status: 'success', summary: 'Plan created' } }),
      makeWorkerResult(),
      makeDirectorResult('done', 'All verified.'),
      makeDirectorResult('done', 'Phase done. Created scaffold.'),
    ]

    mockQuery.mockImplementation(() => {
      const idx = queryCallIndex++
      if (idx === 0) {
        const planPath = path.join(tmpDir, '.cestdone', 'spec.plan.md')
        fs.mkdirSync(path.dirname(planPath), { recursive: true })
        fs.writeFileSync(planPath, VALID_PLAN_CONTENT, 'utf-8')
      }
      return createMockQuery(responses[idx])
    })

    const specPath = path.join(tmpDir, 'spec.md')
    fs.writeFileSync(specPath, 'Build a simple project with tests.', 'utf-8')

    await handleRun(specPath, { target: tmpDir, withWorker: true, withReviews: true, withHumanValidation: true })

    expect(mockQuery).toHaveBeenCalledTimes(4)

    // Call 0 (Planning Worker): fresh session
    expect(mockQuery.mock.calls[0][0].options.resume).toBeUndefined()

    // Call 1 (Phase Worker): fresh session — Workers never resume
    expect(mockQuery.mock.calls[1][0].options.resume).toBeUndefined()

    // Call 2 (Review): fresh Director session — no planning session to resume from
    expect(mockQuery.mock.calls[2][0].options.resume).toBeUndefined()
    expect(mockQuery.mock.calls[2][0].options.systemPrompt).toBeDefined()

    // Call 3 (Complete): resumes from Review session
    expect(mockQuery.mock.calls[3][0].options.resume).toBe('sess-1')
    expect(mockQuery.mock.calls[3][0].options.systemPrompt).toBeUndefined()
  })

  // I5: Resume starts a fresh Director session (no planning history)
  it('resume starts fresh Director session without planning history', async () => {
    const specPath = path.join(tmpDir, 'spec.md')
    const planPath = path.join(tmpDir, '.cestdone', 'spec.plan.md')
    fs.writeFileSync(specPath, 'Original spec.', 'utf-8')
    fs.mkdirSync(path.join(tmpDir, '.cestdone'), { recursive: true })
    fs.writeFileSync(planPath, VALID_PLAN_CONTENT, 'utf-8')

    const responses = [
      makeWorkerResult(),
      makeDirectorResult('done', 'All verified.'),
      makeDirectorResult('done', 'Resumed and done.'),
    ]

    mockQuery.mockImplementation(() => {
      const idx = queryCallIndex++
      return createMockQuery(responses[idx])
    })

    await handleResume(specPath, { target: tmpDir, withWorker: true, withReviews: true })

    // Call 0 (Worker): fresh session (Worker always fresh)
    // Call 1 (Review): fresh Director session — no resume (first Director call in resume flow)
    expect(mockQuery.mock.calls[1][0].options.resume).toBeUndefined()
    expect(mockQuery.mock.calls[1][0].options.systemPrompt).toBeDefined()

    // Call 2 (Complete): resumes from Review session
    expect(mockQuery.mock.calls[2][0].options.resume).toBe('sess-1')
  })

  it('exits cleanly when all phases are done in existing plan', async () => {
    const donePlan = VALID_PLAN_CONTENT
      .replace('### Status: pending', '### Status: done')
      .replace('_(to be filled)_', 'Already completed.')

    const specPath = path.join(tmpDir, 'spec.md')
    const planPath = path.join(tmpDir, '.cestdone', 'spec.plan.md')
    fs.writeFileSync(specPath, 'Done spec.', 'utf-8')
    fs.mkdirSync(path.join(tmpDir, '.cestdone'), { recursive: true })
    fs.writeFileSync(planPath, donePlan, 'utf-8')

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await handleRun(specPath, { target: tmpDir })

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('All phases complete'))
    expect(mockQuery).not.toHaveBeenCalled()

    consoleSpy.mockRestore()
  })
})

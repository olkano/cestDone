// tests/cli.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Phase, Plan, ResolvedConfig, FreeFormSpec } from '../src/shared/types.js'

vi.mock('node:fs')
vi.mock('../src/shared/config.js')
vi.mock('../src/shared/plan-parser.js')
vi.mock('../src/shared/spec-writer.js')
vi.mock('../src/director/director.js')
vi.mock('../src/cli/prompt.js')
vi.mock('../src/coder/coder.js')
vi.mock('../src/shared/git.js')
vi.mock('../src/shared/logger.js', () => ({
  createSessionLogger: () => ({ log: vi.fn(), logVerbose: vi.fn(), logFilePath: '' }),
}))

import fs from 'node:fs'
import { loadConfig, resolveConfig } from '../src/shared/config.js'
import { parsePlan, getPlanPath } from '../src/shared/plan-parser.js'
import { runPhase, runPlanningFlow } from '../src/director/director.js'
import { ensureTTY, askInput } from '../src/cli/prompt.js'
import { handleRun, handleResume } from '../src/cli/index.js'

const PENDING_PHASE: Phase = {
  number: 1, name: 'Setup', status: 'pending',
  spec: 'Set up project.', applicableRules: '', done: '_(tbd)_',
}

const IN_PROGRESS_PHASE: Phase = {
  number: 2, name: 'Build', status: 'in-progress',
  spec: 'Build it.', applicableRules: '', done: '_(tbd)_',
}

const DONE_PHASE: Phase = {
  number: 1, name: 'Init', status: 'done',
  spec: '_See Done._', applicableRules: '', done: 'Done.',
}

const MOCK_RESOLVED: ResolvedConfig = {
  defaultModel: 'claude-opus-4-20250514',
  targetRepoPath: '.',
  apiKey: 'sk-test',
  maxTurns: 100,
}

function makeMockPlan(phases: Phase[]): Plan {
  return {
    title: 'Test',
    context: 'A test project.',
    techStack: 'TypeScript',
    houseRules: 'Use TDD.',
    phases,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fs.readFileSync).mockReturnValue('Free form spec text')
  vi.mocked(loadConfig).mockReturnValue({
    defaultModel: 'claude-opus-4-20250514',
    targetRepoPath: '.',
    maxTurns: 100,
  })
  vi.mocked(resolveConfig).mockReturnValue(MOCK_RESOLVED)
  vi.mocked(ensureTTY).mockReturnValue(undefined)
  vi.mocked(runPhase).mockResolvedValue('sess-mock')
  vi.mocked(getPlanPath).mockReturnValue('/tmp/spec.plan.md')
})

describe('handleRun', () => {
  // K1: When plan exists, parses it and runs all pending phases
  it('runs first pending phase from existing plan', async () => {
    const plan = makeMockPlan([PENDING_PHASE])
    const donePlan = makeMockPlan([{ ...PENDING_PHASE, status: 'done' as const, done: 'Done.' }])
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(parsePlan)
      .mockReturnValueOnce(plan)     // handleRun initial read
      .mockReturnValueOnce(plan)     // executeAllPhases loop 1 → finds pending
      .mockReturnValueOnce(donePlan) // executeAllPhases loop 2 → exits

    await handleRun('spec.md')

    expect(ensureTTY).toHaveBeenCalled()
    expect(fs.existsSync).toHaveBeenCalled()
    expect(parsePlan).toHaveBeenCalled()
    expect(runPhase).toHaveBeenCalledWith(
      plan,
      PENDING_PHASE,
      MOCK_RESOLVED,
      '/tmp/spec.plan.md',
      expect.objectContaining({
        askApproval: expect.any(Function),
        askInput: expect.any(Function),
        createPlanFile: expect.any(Function),
      }),
      undefined, // no sessionId — existing plan, no planning flow
    )
  })

  // K2: When no plan exists, runs planning flow first, then executes all phases
  it('runs planning flow when no plan exists', async () => {
    const plan = makeMockPlan([PENDING_PHASE])
    const donePlan = makeMockPlan([{ ...PENDING_PHASE, status: 'done' as const, done: 'Done.' }])
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(runPlanningFlow).mockResolvedValue({
      planPath: '/tmp/spec.plan.md',
      plan,
      sessionId: 'sess-planning',
    })
    vi.mocked(parsePlan)
      .mockReturnValueOnce(plan)     // executeAllPhases loop 1 → finds pending
      .mockReturnValueOnce(donePlan) // executeAllPhases loop 2 → exits

    await handleRun('spec.md')

    expect(runPlanningFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Free form spec text',
        houseRulesContent: '',
      }),
      MOCK_RESOLVED,
      expect.anything()
    )
    expect(runPhase).toHaveBeenCalledWith(
      plan,
      PENDING_PHASE,
      MOCK_RESOLVED,
      '/tmp/spec.plan.md',
      expect.anything(),
      'sess-planning', // sessionId flows from planning to execution
    )
  })

  // K3: Loads house rules file when --house-rules provided
  it('loads house rules file into FreeFormSpec', async () => {
    const plan = makeMockPlan([PENDING_PHASE])
    const donePlan = makeMockPlan([{ ...PENDING_PHASE, status: 'done' as const, done: 'Done.' }])
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce('Free form spec text')
      .mockReturnValueOnce('Always use TDD.')
    vi.mocked(runPlanningFlow).mockResolvedValue({
      planPath: '/tmp/spec.plan.md',
      plan,
      sessionId: 'sess-planning',
    })
    vi.mocked(parsePlan)
      .mockReturnValueOnce(plan)
      .mockReturnValueOnce(donePlan)

    await handleRun('spec.md', { houseRules: 'rules.md' })

    expect(runPlanningFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        houseRulesContent: 'Always use TDD.',
      }),
      MOCK_RESOLVED,
      expect.anything()
    )
  })

  // K4: Prompts about in-progress phase and continues it
  it('prompts about in-progress phase and continues it', async () => {
    const plan = makeMockPlan([IN_PROGRESS_PHASE, PENDING_PHASE])
    const afterFirst = makeMockPlan([{ ...IN_PROGRESS_PHASE, status: 'done' as const, done: 'Done.' }, PENDING_PHASE])
    const allDone = makeMockPlan([{ ...IN_PROGRESS_PHASE, status: 'done' as const, done: 'Done.' }, { ...PENDING_PHASE, status: 'done' as const, done: 'Done.' }])
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(parsePlan)
      .mockReturnValueOnce(plan)       // handleRun initial read
      .mockReturnValueOnce(plan)       // executeAllPhases loop 1 → in-progress
      .mockReturnValueOnce(afterFirst) // executeAllPhases loop 2 → pending
      .mockReturnValueOnce(allDone)    // executeAllPhases loop 3 → exits
    vi.mocked(askInput).mockResolvedValue('continue')

    await handleRun('spec.md')

    expect(askInput).toHaveBeenCalledWith(
      expect.stringContaining('in-progress')
    )
    expect(runPhase).toHaveBeenCalledWith(
      plan,
      IN_PROGRESS_PHASE,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined, // no sessionId — existing plan
    )
  })
})

describe('handleResume', () => {
  // K5: Resume finds first non-done phase from existing plan
  it('finds first non-done phase from plan and calls runPhase', async () => {
    const plan = makeMockPlan([DONE_PHASE, IN_PROGRESS_PHASE])
    const allDone = makeMockPlan([DONE_PHASE, { ...IN_PROGRESS_PHASE, status: 'done' as const, done: 'Done.' }])
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(parsePlan)
      .mockReturnValueOnce(plan)    // executeAllPhases loop 1 → in-progress
      .mockReturnValueOnce(allDone) // executeAllPhases loop 2 → exits

    await handleResume('spec.md')

    expect(ensureTTY).toHaveBeenCalled()
    expect(runPhase).toHaveBeenCalledWith(
      plan,
      IN_PROGRESS_PHASE,
      MOCK_RESOLVED,
      '/tmp/spec.plan.md',
      expect.objectContaining({
        askApproval: expect.any(Function),
      }),
      undefined, // no sessionId — resume starts fresh
    )
    // No prompt about in-progress — resume doesn't ask
    expect(askInput).not.toHaveBeenCalled()
  })

  // K6: Resume throws when no plan file exists
  it('throws when no plan file exists', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    await expect(handleResume('spec.md')).rejects.toThrow('No plan file found')
  })
})

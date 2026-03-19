// tests/cli.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Phase, Plan, Config, FreeFormSpec } from '../src/shared/types.js'

vi.mock('node:fs')
vi.mock('../src/shared/config.js')
vi.mock('../src/shared/plan-parser.js')
vi.mock('../src/shared/spec-writer.js')
vi.mock('../src/director/director.js')
vi.mock('../src/cli/prompt.js')
vi.mock('../src/worker/worker.js')
vi.mock('../src/shared/git.js')
vi.mock('../src/shared/logger.js', () => ({
  createSessionLogger: () => ({ log: vi.fn(), logVerbose: vi.fn(), logFilePath: '' }),
}))
vi.mock('../src/backends/index.js', () => ({
  createBackend: () => ({
    name: 'agent-sdk',
    invoke: vi.fn(),
    preflight: vi.fn().mockResolvedValue({ ok: true }),
  }),
}))

import fs from 'node:fs'
import { loadConfig } from '../src/shared/config.js'
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

const MOCK_CONFIG: Config = {
  targetRepoPath: '.',
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
  vi.mocked(loadConfig).mockReturnValue(MOCK_CONFIG)
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
      MOCK_CONFIG,
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
      MOCK_CONFIG,
      expect.anything()
    )
    expect(runPhase).toHaveBeenCalledWith(
      plan,
      PENDING_PHASE,
      MOCK_CONFIG,
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
      MOCK_CONFIG,
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
      MOCK_CONFIG,
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

  // KF1: Resume passes flags to config
  it('passes flags from options to config', async () => {
    const plan = makeMockPlan([PENDING_PHASE])
    const donePlan = makeMockPlan([{ ...PENDING_PHASE, status: 'done' as const, done: 'Done.' }])
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(parsePlan)
      .mockReturnValueOnce(plan)
      .mockReturnValueOnce(donePlan)

    await handleResume('spec.md', {
      directorModel: 'opus',
      withWorker: true,
      withReviews: true,
    })

    const configPassed = vi.mocked(runPhase).mock.calls[0][2]
    expect(configPassed.directorModel).toBe('opus')
    expect(configPassed.withWorker).toBe(true)
    expect(configPassed.withReviews).toBe(true)
  })
})

describe('CLI flag wiring', () => {
  // KF2: handleRun applies CLI flag defaults
  it('applies CLI default flags to config', async () => {
    const plan = makeMockPlan([PENDING_PHASE])
    const donePlan = makeMockPlan([{ ...PENDING_PHASE, status: 'done' as const, done: 'Done.' }])
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(runPlanningFlow).mockResolvedValue({
      planPath: '/tmp/spec.plan.md',
      plan,
      sessionId: 'sess-planning',
    })
    vi.mocked(parsePlan)
      .mockReturnValueOnce(plan)
      .mockReturnValueOnce(donePlan)

    await handleRun('spec.md', {})

    const configPassed = vi.mocked(runPlanningFlow).mock.calls[0][1]
    expect(configPassed.withWorker).toBe(true)
    expect(configPassed.withReviews).toBe(true)
    expect(configPassed.withBashReviews).toBe(true)
    expect(configPassed.withHumanValidation).toBe(false)
  })

  // KF3: handleRun passes model overrides
  it('passes model overrides to config', async () => {
    const plan = makeMockPlan([PENDING_PHASE])
    const donePlan = makeMockPlan([{ ...PENDING_PHASE, status: 'done' as const, done: 'Done.' }])
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(runPlanningFlow).mockResolvedValue({
      planPath: '/tmp/spec.plan.md',
      plan,
      sessionId: 'sess-planning',
    })
    vi.mocked(parsePlan)
      .mockReturnValueOnce(plan)
      .mockReturnValueOnce(donePlan)

    await handleRun('spec.md', { directorModel: 'opus', workerModel: 'sonnet' })

    const configPassed = vi.mocked(runPlanningFlow).mock.calls[0][1]
    expect(configPassed.directorModel).toBe('opus')
    expect(configPassed.workerModel).toBe('sonnet')
  })

  // KF4: --with-bash-reviews implies --with-reviews
  it('withBashReviews implies withReviews', async () => {
    const plan = makeMockPlan([PENDING_PHASE])
    const donePlan = makeMockPlan([{ ...PENDING_PHASE, status: 'done' as const, done: 'Done.' }])
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(runPlanningFlow).mockResolvedValue({
      planPath: '/tmp/spec.plan.md',
      plan,
      sessionId: 'sess-planning',
    })
    vi.mocked(parsePlan)
      .mockReturnValueOnce(plan)
      .mockReturnValueOnce(donePlan)

    await handleRun('spec.md', { withWorker: true, withBashReviews: true })

    const configPassed = vi.mocked(runPlanningFlow).mock.calls[0][1]
    expect(configPassed.withReviews).toBe(true)
    expect(configPassed.withBashReviews).toBe(true)
  })

  // KF6: --backend sets both director and worker backends
  it('--backend sets both backends on config', async () => {
    const plan = makeMockPlan([PENDING_PHASE])
    const donePlan = makeMockPlan([{ ...PENDING_PHASE, status: 'done' as const, done: 'Done.' }])
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(runPlanningFlow).mockResolvedValue({
      planPath: '/tmp/spec.plan.md',
      plan,
      sessionId: 'sess-planning',
    })
    vi.mocked(parsePlan)
      .mockReturnValueOnce(plan)
      .mockReturnValueOnce(donePlan)

    await handleRun('spec.md', { backend: 'claude-cli' })

    const configPassed = vi.mocked(runPlanningFlow).mock.calls[0][1]
    expect(configPassed.directorBackend).toBe('claude-cli')
    expect(configPassed.workerBackend).toBe('claude-cli')
  })

  // KF7: --director-backend overrides --backend
  it('--director-backend overrides --backend', async () => {
    const plan = makeMockPlan([PENDING_PHASE])
    const donePlan = makeMockPlan([{ ...PENDING_PHASE, status: 'done' as const, done: 'Done.' }])
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(runPlanningFlow).mockResolvedValue({
      planPath: '/tmp/spec.plan.md',
      plan,
      sessionId: 'sess-planning',
    })
    vi.mocked(parsePlan)
      .mockReturnValueOnce(plan)
      .mockReturnValueOnce(donePlan)

    await handleRun('spec.md', { backend: 'claude-cli', directorBackend: 'agent-sdk' })

    const configPassed = vi.mocked(runPlanningFlow).mock.calls[0][1]
    expect(configPassed.directorBackend).toBe('agent-sdk')
    expect(configPassed.workerBackend).toBe('claude-cli')
  })

  // KF8: --claude-cli-path sets config field
  it('--claude-cli-path sets config field', async () => {
    const plan = makeMockPlan([PENDING_PHASE])
    const donePlan = makeMockPlan([{ ...PENDING_PHASE, status: 'done' as const, done: 'Done.' }])
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(runPlanningFlow).mockResolvedValue({
      planPath: '/tmp/spec.plan.md',
      plan,
      sessionId: 'sess-planning',
    })
    vi.mocked(parsePlan)
      .mockReturnValueOnce(plan)
      .mockReturnValueOnce(donePlan)

    await handleRun('spec.md', { claudeCliPath: '/opt/claude' })

    const configPassed = vi.mocked(runPlanningFlow).mock.calls[0][1]
    expect(configPassed.claudeCliPath).toBe('/opt/claude')
  })

  // KF5: --with-reviews without --with-worker warns and disables reviews
  it('warns when withReviews is set without withWorker', async () => {
    const plan = makeMockPlan([PENDING_PHASE])
    const donePlan = makeMockPlan([{ ...PENDING_PHASE, status: 'done' as const, done: 'Done.' }])
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(runPlanningFlow).mockResolvedValue({
      planPath: '/tmp/spec.plan.md',
      plan,
      sessionId: 'sess-planning',
    })
    vi.mocked(parsePlan)
      .mockReturnValueOnce(plan)
      .mockReturnValueOnce(donePlan)
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await handleRun('spec.md', { withWorker: false, withReviews: true })

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('--with-reviews'))
    const configPassed = vi.mocked(runPlanningFlow).mock.calls[0][1]
    expect(configPassed.withReviews).toBe(false)
    consoleSpy.mockRestore()
  })
})

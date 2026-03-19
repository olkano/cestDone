// tests/non-interactive.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Phase, Plan, Config } from '../src/shared/types.js'
import { NonInteractiveEscalationError } from '../src/daemon/errors.js'

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
import { ensureTTY, askInput, askApproval } from '../src/cli/prompt.js'
import { handleRun, handleResume } from '../src/cli/index.js'

const PENDING_PHASE: Phase = {
  number: 1, name: 'Setup', status: 'pending',
  spec: 'Set up project.', applicableRules: '', done: '_(tbd)_',
}

const IN_PROGRESS_PHASE: Phase = {
  number: 2, name: 'Build', status: 'in-progress',
  spec: 'Build it.', applicableRules: '', done: '_(tbd)_',
}

const NI_CONFIG: Config = {
  targetRepoPath: '.',
  maxTurns: 100,
  nonInteractive: true,
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
  vi.mocked(loadConfig).mockReturnValue(NI_CONFIG)
  vi.mocked(ensureTTY).mockReturnValue(undefined)
  vi.mocked(runPhase).mockResolvedValue('sess-mock')
  vi.mocked(getPlanPath).mockReturnValue('/tmp/spec.plan.md')
})

describe('non-interactive mode', () => {
  // NI-1: handleRun with nonInteractive does NOT call ensureTTY
  it('handleRun skips ensureTTY when nonInteractive', async () => {
    const plan = makeMockPlan([PENDING_PHASE])
    const donePlan = makeMockPlan([{ ...PENDING_PHASE, status: 'done' as const, done: 'Done.' }])
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(parsePlan)
      .mockReturnValueOnce(plan)
      .mockReturnValueOnce(plan)
      .mockReturnValueOnce(donePlan)

    await handleRun('spec.md', { nonInteractive: true })

    expect(ensureTTY).not.toHaveBeenCalled()
  })

  // NI-2: Auto-approves plans (askApproval wired to return { approved: true })
  it('auto-approves plans in non-interactive mode', async () => {
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

    await handleRun('spec.md', { nonInteractive: true })

    // askApproval from prompt.ts should NOT be called
    expect(askApproval).not.toHaveBeenCalled()

    // Verify deps were wired with auto-approve by checking runPlanningFlow was called
    expect(runPlanningFlow).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        askApproval: expect.any(Function),
      })
    )

    // Verify the injected askApproval returns { approved: true }
    const deps = vi.mocked(runPlanningFlow).mock.calls[0][2]
    const result = await deps.askApproval()
    expect(result).toEqual({ approved: true })
  })

  // NI-3: In-progress phase auto-continues without prompting
  it('auto-continues in-progress phase without prompting', async () => {
    const plan = makeMockPlan([IN_PROGRESS_PHASE, PENDING_PHASE])
    const afterFirst = makeMockPlan([{ ...IN_PROGRESS_PHASE, status: 'done' as const, done: 'Done.' }, PENDING_PHASE])
    const allDone = makeMockPlan([{ ...IN_PROGRESS_PHASE, status: 'done' as const, done: 'Done.' }, { ...PENDING_PHASE, status: 'done' as const, done: 'Done.' }])
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(parsePlan)
      .mockReturnValueOnce(plan)
      .mockReturnValueOnce(plan)
      .mockReturnValueOnce(afterFirst)
      .mockReturnValueOnce(allDone)

    await handleRun('spec.md', { nonInteractive: true })

    // Should NOT call the interactive askInput
    expect(askInput).not.toHaveBeenCalled()
    // Should still run the in-progress phase
    expect(runPhase).toHaveBeenCalled()
  })

  // NI-4: Clarification questions are skipped (askInput returns '')
  it('skips clarification questions with empty answer', async () => {
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

    await handleRun('spec.md', { nonInteractive: true })

    // Get the askInput function injected into deps
    const deps = vi.mocked(runPlanningFlow).mock.calls[0][2]
    const answer = await deps.askInput('Director asks: What framework?\nYour answer: ')
    expect(answer).toBe('')
  })

  // NI-5: Escalation throws NonInteractiveEscalationError
  it('throws NonInteractiveEscalationError on escalation prompts', async () => {
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

    await handleRun('spec.md', { nonInteractive: true })

    const deps = vi.mocked(runPlanningFlow).mock.calls[0][2]

    // Escalation prompt contains 'guidance'
    await expect(
      deps.askInput('I\'m stuck after 3 plan rejections. Please provide guidance on how to proceed: ')
    ).rejects.toThrow(NonInteractiveEscalationError)
  })

  // NI-6: handleResume skips ensureTTY in non-interactive mode
  it('handleResume skips ensureTTY when nonInteractive', async () => {
    const plan = makeMockPlan([PENDING_PHASE])
    const donePlan = makeMockPlan([{ ...PENDING_PHASE, status: 'done' as const, done: 'Done.' }])
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(parsePlan)
      .mockReturnValueOnce(plan)
      .mockReturnValueOnce(donePlan)

    await handleResume('spec.md', { nonInteractive: true })

    expect(ensureTTY).not.toHaveBeenCalled()
  })

  // NI-7: Config loads nonInteractive from .cestdonerc.json
  it('config loads nonInteractive from file', async () => {
    vi.mocked(loadConfig).mockReturnValue({
      targetRepoPath: '.',
      maxTurns: 100,
      nonInteractive: true,
    })
    const plan = makeMockPlan([PENDING_PHASE])
    const donePlan = makeMockPlan([{ ...PENDING_PHASE, status: 'done' as const, done: 'Done.' }])
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(parsePlan)
      .mockReturnValueOnce(plan)
      .mockReturnValueOnce(plan)
      .mockReturnValueOnce(donePlan)

    // No nonInteractive option — should pick it up from config
    await handleRun('spec.md')

    expect(ensureTTY).not.toHaveBeenCalled()
  })

  // NI-8: CLI flag --non-interactive sets config correctly
  it('CLI flag sets nonInteractive on config', async () => {
    vi.mocked(loadConfig).mockReturnValue({
      targetRepoPath: '.',
      maxTurns: 100,
      // nonInteractive not set in config
    })
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

    await handleRun('spec.md', { nonInteractive: true })

    // Verify config passed to runPlanningFlow has nonInteractive set
    const configPassed = vi.mocked(runPlanningFlow).mock.calls[0][1]
    expect(configPassed.nonInteractive).toBe(true)
  })
})

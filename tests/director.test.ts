// tests/director.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runPhase, runPlanningFlow } from '../src/director/director.js'
import type { DirectorDeps } from '../src/director/director.js'
import { WorkflowStep } from '../src/shared/types.js'
import type { ResolvedConfig, Phase, CoderResult, CoderOptions, FreeFormSpec, Plan } from '../src/shared/types.js'

const mockQuery = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

let directorCallCount = 0

beforeEach(() => {
  directorCallCount = 0
  vi.clearAllMocks()
})

function makeDirectorResult(action: string, message: string, questions?: string[]) {
  return {
    type: 'result' as const,
    subtype: 'success' as const,
    total_cost_usd: 0.05,
    num_turns: 3,
    duration_ms: 2000,
    structured_output: { action, message, ...(questions ? { questions } : {}) },
  }
}

async function* generateDirectorMessages(result: Record<string, unknown>) {
  yield { type: 'system', session_id: 'sess-dir' }
  yield result
}

const TEST_PHASE: Phase = {
  number: 1,
  name: 'Setup',
  status: 'pending',
  spec: 'Set up the project structure.',
  applicableRules: 'Use TDD.',
  done: '_(to be filled)_',
}

const TEST_PLAN: Plan = {
  title: 'Test Project',
  context: 'A test project.',
  techStack: 'TypeScript, Node.js',
  houseRules: 'Use TDD.',
  phases: [TEST_PHASE],
}

const TEST_CONFIG: ResolvedConfig = {
  apiKey: 'sk-test',
  defaultModel: 'claude-opus-4-20250514',
  targetRepoPath: '/tmp/repo',
  maxTurns: 100,
}

function makeCoderSuccess(overrides: Partial<CoderResult> = {}): CoderResult {
  return {
    status: 'success',
    message: 'Implementation complete',
    cost: 0.25,
    numTurns: 10,
    durationMs: 5000,
    report: { status: 'success', summary: 'Implementation complete' },
    ...overrides,
  }
}

function makeCoderError(overrides: Partial<CoderResult> = {}): CoderResult {
  return {
    status: 'failed',
    message: 'Tests failing',
    cost: 0.10,
    numTurns: 5,
    durationMs: 3000,
    report: { status: 'failed', summary: 'Tests failing' },
    ...overrides,
  }
}

function setupDirectorResponses(...responses: Array<{ action: string; message: string; questions?: string[] }>) {
  mockQuery.mockImplementation(() => {
    const idx = directorCallCount++
    const r = responses[idx] ?? { action: 'done', message: 'fallback' }
    return generateDirectorMessages(makeDirectorResult(r.action, r.message, r.questions))
  })
}

function createHappyPathDeps(): DirectorDeps {
  return {
    askApproval: vi.fn().mockResolvedValue({ approved: true }),
    askInput: vi.fn().mockResolvedValue('done'),
    createPlanFile: vi.fn(),
    updatePhaseStatus: vi.fn(),
    writePhaseCompletion: vi.fn(),
    coderExecute: vi.fn().mockResolvedValue(makeCoderSuccess()),
    display: vi.fn(),
    logger: { log: vi.fn(), logVerbose: vi.fn() },
  }
}

// Happy path flow: plan(0) → approve → coder(execute) → review(1) → complete(2)
// Director calls: 3 (plan, review, complete)

describe('runPhase', () => {
  // J1: Sets phase to in-progress and calls Director for sub-planning
  it('sets phase to in-progress and calls Director for planning', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan:\n1. Create files\n2. Write tests' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Phase done. Created scaffold.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.updatePhaseStatus).toHaveBeenCalledWith('plan.md', 1, 'in-progress')
    expect(mockQuery).toHaveBeenCalled()
    // First call is the sub-planning prompt
    const firstPrompt = mockQuery.mock.calls[0][0].prompt
    expect(firstPrompt).toContain('implementation plan')
  })

  // J3: Director uses read-only tools for Plan step
  it('passes read-only tools to Director for Plan step', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    const firstOpts = mockQuery.mock.calls[0][0].options
    expect(firstOpts.tools).toEqual(['Read', 'Glob', 'Grep'])
  })

  // J4: Receives plan and displays it to human
  it('receives plan and displays it to human', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan:\n1. Create files\n2. Write tests' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.display).toHaveBeenCalledWith(
      expect.stringContaining('Create files')
    )
  })

  // J5: Presents plan, proceeds on approval
  it('presents plan and proceeds on approval', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.askApproval).toHaveBeenCalledTimes(1)
  })

  // J5b: Re-plans on rejection
  it('sends feedback to Director and re-plans on rejection', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan v1' },
      { action: 'approve', message: 'Plan v2 with test detail' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.askApproval = vi.fn()
      .mockResolvedValueOnce({ approved: false, feedback: 'Need more detail on tests' })
      .mockResolvedValueOnce({ approved: true })

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.askApproval).toHaveBeenCalledTimes(2)
    // Director called 4 times: plan, re-plan, review, complete
    expect(mockQuery).toHaveBeenCalledTimes(4)
    // Re-plan prompt contains feedback
    const rePlanPrompt = mockQuery.mock.calls[1][0].prompt
    expect(rePlanPrompt).toContain('Need more detail on tests')
  })

  // R1: Calls coderExecute with instructions from approved plan
  it('calls coderExecute with plan instructions at Step 6 (R1)', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan:\n1. Create files\n2. Write tests' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.coderExecute).toHaveBeenCalledTimes(1)
    const opts = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls[0][0] as CoderOptions
    expect(opts.instructions).toContain('Create files')
    expect(opts.step).toBe(WorkflowStep.Execute)
  })

  // R2: Passes correct model from selectModel()
  it('passes model from selectModel() to coderExecute (R2)', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    const opts = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls[0][0] as CoderOptions
    expect(opts.model).toBeTruthy()
    expect(typeof opts.model).toBe('string')
  })

  // R3: Success → review verifies → proceeds to Step 8
  it('proceeds to Step 8 after review confirms Coder success (R3)', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan: do things' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Phase done. Created scaffold.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.writePhaseCompletion).toHaveBeenCalledWith(
      'plan.md', 1, 'Phase done. Created scaffold.'
    )
    // Director called 3 times: plan, review, complete
    expect(mockQuery).toHaveBeenCalledTimes(3)
  })

  // R4: Error → Director formulates fix → retry Coder
  it('retries Coder with fix instructions on error (R4)', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan: do things' },
      { action: 'fix', message: 'Fix the failing test by updating the assertion' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.coderExecute = vi.fn()
      .mockResolvedValueOnce(makeCoderError())
      .mockResolvedValueOnce(makeCoderSuccess())

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.coderExecute).toHaveBeenCalledTimes(2)
    const secondOpts = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls[1][0] as CoderOptions
    expect(secondOpts.instructions).toContain('Fix the failing test')
  })

  // R5: 3 failures → escalate to human
  it('escalates to human after 3 Coder failures (R5)', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan: do things' },
      { action: 'fix', message: 'Fix attempt 1' },
      { action: 'fix', message: 'Fix attempt 2' },
      { action: 'fix', message: 'Fix attempt 3' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.coderExecute = vi.fn()
      .mockResolvedValueOnce(makeCoderError({ message: 'Fail 1' }))
      .mockResolvedValueOnce(makeCoderError({ message: 'Fail 2' }))
      .mockResolvedValueOnce(makeCoderError({ message: 'Fail 3' }))
      .mockResolvedValueOnce(makeCoderSuccess())
    deps.askInput = vi.fn().mockResolvedValue('Try a different approach')

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.coderExecute).toHaveBeenCalledTimes(4)
    const askInputCalls = (deps.askInput as ReturnType<typeof vi.fn>).mock.calls
    const escalationCall = askInputCalls.find((c: string[]) => c[0].includes('3'))
    expect(escalationCall).toBeTruthy()
  })

  // R6: Displays Coder summary
  it('displays Coder summary to human (R6)', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.coderExecute = vi.fn().mockResolvedValue(
      makeCoderSuccess({ report: { status: 'success', summary: 'Built login form with tests' } })
    )

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.display).toHaveBeenCalledWith(
      expect.stringContaining('Built login form with tests')
    )
  })

  // R7: CoderOptions has all required fields — houseRulesContent from phase.applicableRules
  it('passes complete CoderOptions to coderExecute (R7)', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    const opts = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls[0][0] as CoderOptions
    expect(opts.step).toBe(WorkflowStep.Execute)
    expect(opts.phase).toEqual(TEST_PHASE)
    expect(opts.targetRepoPath).toBe('/tmp/repo')
    expect(opts.houseRulesContent).toBe('Use TDD.')
    expect(opts.maxTurns).toBe(100)
    expect(opts.apiKey).toBe('sk-test')
    expect(opts.logger).toBeDefined()
    expect(typeof opts.logger.log).toBe('function')
  })

  // R7b: Falls back to plan.houseRules when phase.applicableRules is empty
  it('uses plan.houseRules when phase.applicableRules is empty', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    const phaseNoRules: Phase = { ...TEST_PHASE, applicableRules: '' }
    const plan: Plan = { ...TEST_PLAN, phases: [phaseNoRules] }

    await runPhase(plan, phaseNoRules, TEST_CONFIG, 'plan.md', deps)

    const opts = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls[0][0] as CoderOptions
    expect(opts.houseRulesContent).toBe('Use TDD.')
  })

  // R8: Cost accumulation across retries
  it('displays accumulated Coder cost (R8)', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan: do things' },
      { action: 'fix', message: 'Fix it' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.coderExecute = vi.fn()
      .mockResolvedValueOnce(makeCoderError({ cost: 0.50 }))
      .mockResolvedValueOnce(makeCoderSuccess({ cost: 0.75 }))

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.coderExecute).toHaveBeenCalledTimes(2)
    const allDisplayText = (deps.display as ReturnType<typeof vi.fn>).mock.calls.map((c: string[]) => c[0]).join('\n')
    expect(allDisplayText).toContain('1.25')
  })

  // J7: Writes phase completion with done summary
  it('writes phase completion with done summary at Step 8', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Phase done. Created scaffold.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.writePhaseCompletion).toHaveBeenCalledWith(
      'plan.md', 1, 'Phase done. Created scaffold.'
    )
  })

  // J8: 3 rejections → escalation with "I'm stuck" message
  it('escalates to human after 3 plan rejections', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan v1' },
      { action: 'approve', message: 'Plan v2' },
      { action: 'approve', message: 'Plan v3' },
      { action: 'approve', message: 'Plan v4' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.askApproval = vi.fn()
      .mockResolvedValueOnce({ approved: false, feedback: 'F1' })
      .mockResolvedValueOnce({ approved: false, feedback: 'F2' })
      .mockResolvedValueOnce({ approved: false, feedback: 'F3' })
      .mockResolvedValueOnce({ approved: true })
    deps.askInput = vi.fn().mockResolvedValue('try simpler approach')

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    const askInputCalls = (deps.askInput as ReturnType<typeof vi.fn>).mock.calls
    const escalationCall = askInputCalls.find((c: string[]) => c[0].includes("I'm stuck"))
    expect(escalationCall).toBeTruthy()
    expect(escalationCall![0]).toContain('3 plan rejections')
  })

  // J9: Each Director call is a fresh Agent SDK session
  it('makes independent Agent SDK query() calls per step', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan: do things' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    // 3 calls: plan, review, complete
    expect(mockQuery).toHaveBeenCalledTimes(3)
    for (const call of mockQuery.mock.calls) {
      expect(typeof call[0].prompt).toBe('string')
    }
  })

  // J10: Director uses outputFormat for structured JSON
  it('Director uses outputFormat for structured JSON responses', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    const firstOpts = mockQuery.mock.calls[0][0].options
    expect(firstOpts.outputFormat).toEqual({
      type: 'json_schema',
      schema: expect.objectContaining({
        type: 'object',
        required: ['action', 'message'],
      }),
    })
  })

  // J11: Director strips CLAUDECODE env var
  it('Director strips CLAUDECODE env var', async () => {
    process.env.CLAUDECODE = '1'
    setupDirectorResponses(
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    const firstOpts = mockQuery.mock.calls[0][0].options
    expect(firstOpts.env.CLAUDECODE).toBeUndefined()
    delete process.env.CLAUDECODE
  })

  // J12: Review step gives Director Bash tool
  it('Review step gives Director Bash tool', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan: do things' },
      { action: 'fix', message: 'Fix it' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.coderExecute = vi.fn()
      .mockResolvedValueOnce(makeCoderError())
      .mockResolvedValueOnce(makeCoderSuccess())

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    // 4 Director calls: plan, review(fix), review(done), complete
    expect(mockQuery).toHaveBeenCalledTimes(4)
    const reviewOpts = mockQuery.mock.calls[1][0].options
    expect(reviewOpts.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash'])
  })

  // J13: Sub-phase iteration — Director returns 'continue'
  it('iterates through sub-phases when Director returns continue', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan:\nSub-phase A: Create models\nSub-phase B: Add routes' },
      { action: 'continue', message: 'Sub-phase A complete. Now implement Sub-phase B: Add routes' },
      { action: 'done', message: 'All sub-phases verified.' },
      { action: 'done', message: 'Both sub-phases complete.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.coderExecute).toHaveBeenCalledTimes(2)
    const secondOpts = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls[1][0] as CoderOptions
    expect(secondOpts.instructions).toContain('Sub-phase B')
    expect(deps.display).toHaveBeenCalledWith(
      expect.stringContaining('Sub-phase 1 complete')
    )
  })

  // J14: Sub-phase context is passed to Coder
  it('passes completedSubPhases to Coder on subsequent sub-phases', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan with sub-phases' },
      { action: 'continue', message: 'Next sub-phase instructions' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    const firstOpts = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls[0][0] as CoderOptions
    expect(firstOpts.completedSubPhases).toEqual([])

    const secondOpts = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls[1][0] as CoderOptions
    expect(secondOpts.completedSubPhases).toHaveLength(1)
    expect(secondOpts.completedSubPhases![0]).toBe('Implementation complete')
  })

  // J15: Sub-phase retries are scoped per sub-phase
  it('resets retry count when moving to next sub-phase', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan with sub-phases' },
      { action: 'fix', message: 'Fix sub-phase A' },
      { action: 'continue', message: 'Sub-phase B instructions' },
      { action: 'fix', message: 'Fix sub-phase B' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.coderExecute = vi.fn()
      .mockResolvedValueOnce(makeCoderError({ message: 'Sub-phase A fail' }))
      .mockResolvedValueOnce(makeCoderSuccess({ message: 'Sub-phase A done' }))
      .mockResolvedValueOnce(makeCoderError({ message: 'Sub-phase B fail' }))
      .mockResolvedValueOnce(makeCoderSuccess({ message: 'Sub-phase B done' }))

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.coderExecute).toHaveBeenCalledTimes(4)
    const askInputCalls = (deps.askInput as ReturnType<typeof vi.fn>).mock.calls
    const escalationCall = askInputCalls.find((c: string[]) => c[0].includes('failed'))
    expect(escalationCall).toBeUndefined()
  })

  // J16: Review prompt includes completedSubPhases context
  it('passes completedSubPhases to review prompt', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan with sub-phases' },
      { action: 'continue', message: 'Next sub-phase' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    // Second review call (index 2) should have the sub-phase context
    const secondReviewPrompt = mockQuery.mock.calls[2][0].prompt
    expect(secondReviewPrompt).toContain('Previously Completed Sub-phases')
  })

  // J17: Review always runs — even on Coder success
  it('always runs review after Coder execution', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    // 3 calls: plan(0), review(1), complete(2)
    expect(mockQuery).toHaveBeenCalledTimes(3)
    const reviewOpts = mockQuery.mock.calls[1][0].options
    expect(reviewOpts.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash'])
  })

  // J18: System prompt uses buildExecutionSystemPrompt with plan context
  it('uses execution system prompt with plan context', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    const firstOpts = mockQuery.mock.calls[0][0].options
    expect(firstOpts.systemPrompt.append).toContain('Test Project')
    expect(firstOpts.systemPrompt.append).toContain('A test project.')
    expect(firstOpts.systemPrompt.append).toContain('TypeScript, Node.js')
  })
})

// === runPlanningFlow tests ===

const VALID_PLAN_CONTENT = [
  '# Plan: Test Project',
  '',
  '## Context',
  'A test project for widgets.',
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

const TEST_FREE_FORM_SPEC: FreeFormSpec = {
  text: 'Build a widget app with login and dashboard.',
  houseRulesContent: 'Use TDD. Follow REST conventions.',
  specFilePath: '/tmp/spec.md',
}

describe('runPlanningFlow', () => {
  // P1: Happy path — no questions, plan approved on first try
  it('creates a plan file when spec is clear and plan is approved', async () => {
    setupDirectorResponses(
      { action: 'analyze', message: 'Spec is clear. No questions.' },
      { action: 'done', message: VALID_PLAN_CONTENT },
    )
    const deps = createHappyPathDeps()

    const result = await runPlanningFlow(TEST_FREE_FORM_SPEC, TEST_CONFIG, deps)

    expect(result.planPath).toBe('/tmp/spec.plan.md')
    expect(result.plan.title).toBe('Test Project')
    expect(result.plan.phases).toHaveLength(1)
    expect(deps.createPlanFile).toHaveBeenCalledWith('/tmp/spec.plan.md', VALID_PLAN_CONTENT)
  })

  // P2: Director asks clarifying questions
  it('handles clarifying questions via askInput', async () => {
    setupDirectorResponses(
      { action: 'ask_human', message: 'Need info', questions: ['What DB?', 'Auth method?'] },
      { action: 'approve', message: 'Understood.' },
      { action: 'done', message: VALID_PLAN_CONTENT },
    )
    const deps = createHappyPathDeps()
    deps.askInput = vi.fn()
      .mockResolvedValueOnce('PostgreSQL')
      .mockResolvedValueOnce('JWT')
      .mockResolvedValue('done')

    const result = await runPlanningFlow(TEST_FREE_FORM_SPEC, TEST_CONFIG, deps)

    const askInputCalls = (deps.askInput as ReturnType<typeof vi.fn>).mock.calls
    expect(askInputCalls[0][0]).toContain('What DB?')
    expect(askInputCalls[1][0]).toContain('Auth method?')
    expect(result.plan.title).toBe('Test Project')
  })

  // P3: Plan revision — human provides feedback, Director revises
  it('revises plan when human provides feedback', async () => {
    setupDirectorResponses(
      { action: 'analyze', message: 'Spec is clear.' },
      { action: 'done', message: VALID_PLAN_CONTENT },
      { action: 'done', message: VALID_PLAN_CONTENT },
    )
    const deps = createHappyPathDeps()
    deps.askApproval = vi.fn()
      .mockResolvedValueOnce({ approved: false, feedback: 'Add a testing phase' })
      .mockResolvedValueOnce({ approved: true })

    await runPlanningFlow(TEST_FREE_FORM_SPEC, TEST_CONFIG, deps)

    expect(deps.askApproval).toHaveBeenCalledTimes(2)
    expect(mockQuery).toHaveBeenCalledTimes(3)
    const revisionPrompt = mockQuery.mock.calls[2][0].prompt
    expect(revisionPrompt).toContain('Add a testing phase')
  })

  // P4: Plan validation — Director produces invalid plan, gets asked to fix
  it('asks Director to fix invalid plan format', async () => {
    setupDirectorResponses(
      { action: 'analyze', message: 'Spec is clear.' },
      { action: 'done', message: 'This is not a valid plan' },
      { action: 'done', message: VALID_PLAN_CONTENT },
    )
    const deps = createHappyPathDeps()

    const result = await runPlanningFlow(TEST_FREE_FORM_SPEC, TEST_CONFIG, deps)

    expect(mockQuery).toHaveBeenCalledTimes(3)
    const fixPrompt = mockQuery.mock.calls[2][0].prompt
    expect(fixPrompt).toContain('format error')
    expect(result.plan.title).toBe('Test Project')
  })

  // P5: Escalation after 3 plan rejections
  it('escalates to human after 3 plan rejections', async () => {
    setupDirectorResponses(
      { action: 'analyze', message: 'Spec is clear.' },
      { action: 'done', message: VALID_PLAN_CONTENT },
      { action: 'done', message: VALID_PLAN_CONTENT },
      { action: 'done', message: VALID_PLAN_CONTENT },
      { action: 'done', message: VALID_PLAN_CONTENT },
    )
    const deps = createHappyPathDeps()
    deps.askApproval = vi.fn()
      .mockResolvedValueOnce({ approved: false, feedback: 'F1' })
      .mockResolvedValueOnce({ approved: false, feedback: 'F2' })
      .mockResolvedValueOnce({ approved: false, feedback: 'F3' })
      .mockResolvedValueOnce({ approved: true })
    deps.askInput = vi.fn().mockResolvedValue('Try a simpler approach')

    await runPlanningFlow(TEST_FREE_FORM_SPEC, TEST_CONFIG, deps)

    const askInputCalls = (deps.askInput as ReturnType<typeof vi.fn>).mock.calls
    const escalationCall = askInputCalls.find((c: string[]) => c[0].includes("I'm stuck"))
    expect(escalationCall).toBeTruthy()
    expect(escalationCall![0]).toContain('3 plan rejections')
  })

  // P6: Plan is displayed to human before approval
  it('displays plan to human for approval', async () => {
    setupDirectorResponses(
      { action: 'analyze', message: 'Spec is clear.' },
      { action: 'done', message: VALID_PLAN_CONTENT },
    )
    const deps = createHappyPathDeps()

    await runPlanningFlow(TEST_FREE_FORM_SPEC, TEST_CONFIG, deps)

    expect(deps.display).toHaveBeenCalledWith(
      expect.stringContaining('Test Project')
    )
  })

  // P7: System prompt includes spec text and house rules
  it('includes spec text and house rules in system prompt', async () => {
    setupDirectorResponses(
      { action: 'analyze', message: 'Spec is clear.' },
      { action: 'done', message: VALID_PLAN_CONTENT },
    )
    const deps = createHappyPathDeps()

    await runPlanningFlow(TEST_FREE_FORM_SPEC, TEST_CONFIG, deps)

    const firstOpts = mockQuery.mock.calls[0][0].options
    expect(firstOpts.systemPrompt.append).toContain('Build a widget app')
    expect(firstOpts.systemPrompt.append).toContain('Use TDD')
  })

  // P8: createPlanFile is called with correct path derived from spec file path
  it('derives plan path from spec file path', async () => {
    setupDirectorResponses(
      { action: 'analyze', message: 'Spec is clear.' },
      { action: 'done', message: VALID_PLAN_CONTENT },
    )
    const deps = createHappyPathDeps()
    const spec: FreeFormSpec = { ...TEST_FREE_FORM_SPEC, specFilePath: '/project/my-spec.md' }

    const result = await runPlanningFlow(spec, TEST_CONFIG, deps)

    expect(result.planPath).toBe('/project/my-spec.plan.md')
    expect(deps.createPlanFile).toHaveBeenCalledWith('/project/my-spec.plan.md', VALID_PLAN_CONTENT)
  })
})

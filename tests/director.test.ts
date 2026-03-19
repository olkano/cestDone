// tests/director.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runPhase, runPlanningFlow, executeDirector } from '../src/director/director.js'
import type { DirectorDeps } from '../src/director/director.js'
import { WorkflowStep } from '../src/shared/types.js'
import type { Config, Phase, WorkerResult, WorkerOptions, FreeFormSpec, Plan, Backend, BackendResult } from '../src/shared/types.js'
import { CostTracker } from '../src/shared/cost-tracker.js'

let directorCallCount = 0

const mockBackend: Backend = {
  name: 'agent-sdk',
  invoke: vi.fn(),
  preflight: vi.fn().mockResolvedValue({ ok: true }),
}

beforeEach(() => {
  directorCallCount = 0
  vi.clearAllMocks()
  process.env.CESTDONE_DIRECTOR_MODEL = 'claude-sonnet-4-6'
  process.env.CESTDONE_WORKER_MODEL = 'claude-haiku-4-5'
})

function makeBackendResult(action: string, message: string, questions?: string[]): BackendResult {
  return {
    output: { action, message, ...(questions ? { questions } : {}) },
    rawText: JSON.stringify({ action, message, ...(questions ? { questions } : {}) }),
    sessionId: 'sess-dir',
    costUsd: 0.05,
    numTurns: 3,
    durationMs: 2000,
    usage: { inputTokens: 500, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    success: true,
  }
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

const TEST_CONFIG: Config = {
  targetRepoPath: '/tmp/repo',
  maxTurns: 100,
}

function makeWorkerSuccess(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    status: 'success',
    message: 'Implementation complete',
    cost: 0.25,
    numTurns: 10,
    durationMs: 5000,
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    report: { status: 'success', summary: 'Implementation complete' },
    ...overrides,
  }
}

function makeWorkerError(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    status: 'failed',
    message: 'Tests failing',
    cost: 0.10,
    numTurns: 5,
    durationMs: 3000,
    usage: { inputTokens: 500, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    report: { status: 'failed', summary: 'Tests failing' },
    ...overrides,
  }
}

function setupDirectorResponses(...responses: Array<{ action: string; message: string; questions?: string[] }>) {
  ;(mockBackend.invoke as ReturnType<typeof vi.fn>).mockImplementation(() => {
    const idx = directorCallCount++
    const r = responses[idx] ?? { action: 'done', message: 'fallback' }
    return Promise.resolve(makeBackendResult(r.action, r.message, r.questions))
  })
}

function createHappyPathDeps(): DirectorDeps {
  return {
    askApproval: vi.fn().mockResolvedValue({ approved: true }),
    askInput: vi.fn().mockResolvedValue('done'),
    createPlanFile: vi.fn(),
    updatePhaseStatus: vi.fn(),
    writePhaseCompletion: vi.fn(),
    workerExecute: vi.fn().mockResolvedValue(makeWorkerSuccess()),
    display: vi.fn(),
    logger: { log: vi.fn(), logVerbose: vi.fn(), logFilePath: '' },
    costTracker: new CostTracker(),
    backend: mockBackend,
    workerBackend: mockBackend,
  }
}

// Happy path flow: worker(execute) → review(0) → complete(1)
// Director calls: 2 (review, complete)

describe('runPhase', () => {
  // J1: Sets phase to in-progress and sends Worker directly
  it('sets phase to in-progress and calls Worker directly', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Phase done. Created scaffold.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.updatePhaseStatus).toHaveBeenCalledWith('plan.md', 1, 'in-progress')
    expect(deps.workerExecute).toHaveBeenCalledTimes(1)
    // First Director call is Review, not sub-planning
    const firstPrompt = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt
    expect(firstPrompt).toContain('Worker Report')
  })

  // R1: Calls workerExecute with plan context (title, tech stack)
  it('calls workerExecute with plan context at Step 6 (R1)', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.workerExecute).toHaveBeenCalledTimes(1)
    const opts = (deps.workerExecute as ReturnType<typeof vi.fn>).mock.calls[0][0] as WorkerOptions
    expect(opts.instructions).toContain('Test Project')
    expect(opts.instructions).toContain('TypeScript, Node.js')
    expect(opts.step).toBe(WorkflowStep.Execute)
  })

  // R2: Passes worker model from getWorkerModel()
  it('passes worker model from getWorkerModel() to workerExecute (R2)', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    const opts = (deps.workerExecute as ReturnType<typeof vi.fn>).mock.calls[0][0] as WorkerOptions
    expect(opts.model).toBeTruthy()
    expect(typeof opts.model).toBe('string')
  })

  // R3: Success → review verifies → proceeds to Complete
  it('proceeds to Complete after review confirms Worker success (R3)', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Phase done. Created scaffold.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.writePhaseCompletion).toHaveBeenCalledWith(
      'plan.md', 1, 'Phase done. Created scaffold.'
    )
    // Director called 2 times: review, complete
    expect(mockBackend.invoke).toHaveBeenCalledTimes(2)
  })

  // R4: Error → Director formulates fix → retry Worker
  it('retries Worker with fix instructions on error (R4)', async () => {
    setupDirectorResponses(
      { action: 'fix', message: 'Fix the failing test by updating the assertion' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.workerExecute = vi.fn()
      .mockResolvedValueOnce(makeWorkerError())
      .mockResolvedValueOnce(makeWorkerSuccess())

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.workerExecute).toHaveBeenCalledTimes(2)
    const secondOpts = (deps.workerExecute as ReturnType<typeof vi.fn>).mock.calls[1][0] as WorkerOptions
    expect(secondOpts.instructions).toContain('Fix the failing test')
  })

  // R5: 3 failures → escalate to human
  it('escalates to human after 3 Worker failures (R5)', async () => {
    setupDirectorResponses(
      { action: 'fix', message: 'Fix attempt 1' },
      { action: 'fix', message: 'Fix attempt 2' },
      { action: 'fix', message: 'Fix attempt 3' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.workerExecute = vi.fn()
      .mockResolvedValueOnce(makeWorkerError({ message: 'Fail 1' }))
      .mockResolvedValueOnce(makeWorkerError({ message: 'Fail 2' }))
      .mockResolvedValueOnce(makeWorkerError({ message: 'Fail 3' }))
      .mockResolvedValueOnce(makeWorkerSuccess())
    deps.askInput = vi.fn().mockResolvedValue('Try a different approach')

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.workerExecute).toHaveBeenCalledTimes(4)
    const askInputCalls = (deps.askInput as ReturnType<typeof vi.fn>).mock.calls
    const escalationCall = askInputCalls.find((c: string[]) => c[0].includes('3'))
    expect(escalationCall).toBeTruthy()
  })

  // R6: Displays Worker summary
  it('displays Worker summary to human (R6)', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.workerExecute = vi.fn().mockResolvedValue(
      makeWorkerSuccess({ report: { status: 'success', summary: 'Built login form with tests' } })
    )

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.display).toHaveBeenCalledWith(
      expect.stringContaining('Built login form with tests')
    )
  })

  // R7: WorkerOptions has all required fields — houseRulesContent from phase.applicableRules
  it('passes complete WorkerOptions to workerExecute (R7)', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    const opts = (deps.workerExecute as ReturnType<typeof vi.fn>).mock.calls[0][0] as WorkerOptions
    expect(opts.step).toBe(WorkflowStep.Execute)
    expect(opts.phase).toEqual(TEST_PHASE)
    expect(opts.targetRepoPath).toBe('/tmp/repo')
    expect(opts.houseRulesContent).toBe('Use TDD.')
    expect(opts.maxTurns).toBe(100)
    expect(opts.logger).toBeDefined()
    expect(typeof opts.logger.log).toBe('function')
  })

  // R7b: Falls back to plan.houseRules when phase.applicableRules is empty
  it('uses plan.houseRules when phase.applicableRules is empty', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    const phaseNoRules: Phase = { ...TEST_PHASE, applicableRules: '' }
    const plan: Plan = { ...TEST_PLAN, phases: [phaseNoRules] }

    await runPhase(plan, phaseNoRules, TEST_CONFIG, 'plan.md', deps)

    const opts = (deps.workerExecute as ReturnType<typeof vi.fn>).mock.calls[0][0] as WorkerOptions
    expect(opts.houseRulesContent).toBe('Use TDD.')
  })

  // R8: Cost accumulation across retries
  it('displays accumulated Worker cost (R8)', async () => {
    setupDirectorResponses(
      { action: 'fix', message: 'Fix it' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.workerExecute = vi.fn()
      .mockResolvedValueOnce(makeWorkerError({ cost: 0.50 }))
      .mockResolvedValueOnce(makeWorkerSuccess({ cost: 0.75 }))

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.workerExecute).toHaveBeenCalledTimes(2)
    const allDisplayText = (deps.display as ReturnType<typeof vi.fn>).mock.calls.map((c: string[]) => c[0]).join('\n')
    expect(allDisplayText).toContain('1.25')
  })

  // J7: Writes phase completion with done summary
  it('writes phase completion with done summary', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Phase done. Created scaffold.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.writePhaseCompletion).toHaveBeenCalledWith(
      'plan.md', 1, 'Phase done. Created scaffold.'
    )
  })

  // J9: Each Director call is a fresh Agent SDK session
  it('makes independent Agent SDK query() calls per step', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    // 2 calls: review, complete
    expect(mockBackend.invoke).toHaveBeenCalledTimes(2)
    for (const call of (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls) {
      expect(typeof call[0].prompt).toBe('string')
    }
  })

  // J10: Director uses outputFormat for structured JSON
  it('Director uses outputFormat for structured JSON responses', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    const firstOpts = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(firstOpts.outputSchema).toEqual(
      expect.objectContaining({
        type: 'object',
        required: ['action', 'message'],
      }),
    )
  })

  // J11: Director passes env to backend (backend handles stripping)
  it('Director passes env to backend', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    const firstOpts = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(firstOpts.env).toBeDefined()
    expect(typeof firstOpts.env).toBe('object')
  })

  // J12: Review step gives Director Bash tool
  it('Review step gives Director Bash tool', async () => {
    setupDirectorResponses(
      { action: 'fix', message: 'Fix it' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.workerExecute = vi.fn()
      .mockResolvedValueOnce(makeWorkerError())
      .mockResolvedValueOnce(makeWorkerSuccess())

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    // 3 Director calls: review(fix), review(done), complete
    expect(mockBackend.invoke).toHaveBeenCalledTimes(3)
    const reviewOpts = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(reviewOpts.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash'])
  })

  // J13: Sub-phase iteration — Director returns 'continue'
  it('iterates through sub-phases when Director returns continue', async () => {
    setupDirectorResponses(
      { action: 'continue', message: 'Sub-phase A complete. Now implement Sub-phase B: Add routes' },
      { action: 'done', message: 'All sub-phases verified.' },
      { action: 'done', message: 'Both sub-phases complete.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.workerExecute).toHaveBeenCalledTimes(2)
    const secondOpts = (deps.workerExecute as ReturnType<typeof vi.fn>).mock.calls[1][0] as WorkerOptions
    expect(secondOpts.instructions).toContain('Sub-phase B')
    expect(deps.display).toHaveBeenCalledWith(
      expect.stringContaining('Sub-phase 1 complete')
    )
  })

  // J14: Sub-phase context is passed to Worker
  it('passes completedSubPhases to Worker on subsequent sub-phases', async () => {
    setupDirectorResponses(
      { action: 'continue', message: 'Next sub-phase instructions' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    const firstOpts = (deps.workerExecute as ReturnType<typeof vi.fn>).mock.calls[0][0] as WorkerOptions
    expect(firstOpts.completedSubPhases).toEqual([])

    const secondOpts = (deps.workerExecute as ReturnType<typeof vi.fn>).mock.calls[1][0] as WorkerOptions
    expect(secondOpts.completedSubPhases).toHaveLength(1)
    expect(secondOpts.completedSubPhases![0]).toBe('Implementation complete')
  })

  // J15: Sub-phase retries are scoped per sub-phase
  it('resets retry count when moving to next sub-phase', async () => {
    setupDirectorResponses(
      { action: 'fix', message: 'Fix sub-phase A' },
      { action: 'continue', message: 'Sub-phase B instructions' },
      { action: 'fix', message: 'Fix sub-phase B' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.workerExecute = vi.fn()
      .mockResolvedValueOnce(makeWorkerError({ message: 'Sub-phase A fail' }))
      .mockResolvedValueOnce(makeWorkerSuccess({ message: 'Sub-phase A done' }))
      .mockResolvedValueOnce(makeWorkerError({ message: 'Sub-phase B fail' }))
      .mockResolvedValueOnce(makeWorkerSuccess({ message: 'Sub-phase B done' }))

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.workerExecute).toHaveBeenCalledTimes(4)
    const askInputCalls = (deps.askInput as ReturnType<typeof vi.fn>).mock.calls
    const escalationCall = askInputCalls.find((c: string[]) => c[0].includes('failed'))
    expect(escalationCall).toBeUndefined()
  })

  // J16: Review prompt includes completedSubPhases context
  it('passes completedSubPhases to review prompt', async () => {
    setupDirectorResponses(
      { action: 'continue', message: 'Next sub-phase' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    // Second review call (index 1) should have the sub-phase context
    const secondReviewPrompt = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[1][0].prompt
    expect(secondReviewPrompt).toContain('Previously Completed Sub-phases')
  })

  // J17: Review always runs — even on Worker success
  it('always runs review after Worker execution', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    // 2 calls: review(0), complete(1)
    expect(mockBackend.invoke).toHaveBeenCalledTimes(2)
    const reviewOpts = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(reviewOpts.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash'])
  })

  // J18: System prompt uses buildExecutionSystemPrompt with plan context
  it('uses execution system prompt with plan context', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    const firstOpts = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(firstOpts.systemPrompt).toContain('Test Project')
    expect(firstOpts.systemPrompt).toContain('A test project.')
    expect(firstOpts.systemPrompt).toContain('TypeScript, Node.js')
  })

  // J19: runPhase resumes Director session when sessionId provided
  it('resumes Director session when sessionId is provided', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Phase done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps, 'sess-existing')

    // First Director call resumes from provided sessionId
    expect(mockBackend.invoke).toHaveBeenCalledTimes(2)
    expect((mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0].resumeSessionId).toBe('sess-existing')
    // Subsequent calls use sessionId from SDK response (mock returns 'sess-dir')
    expect((mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[1][0].resumeSessionId).toBe('sess-dir')
  })

  // J20: runPhase creates fresh session when no sessionId provided
  it('creates fresh Director session when no sessionId provided', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Phase done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    // First call should be fresh (no resume)
    expect((mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0].resumeSessionId).toBeUndefined()
    // Second call should resume from first call's session
    expect((mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[1][0].resumeSessionId).toBe('sess-dir')
  })

  // J21: runPhase returns sessionId for cross-phase continuity
  it('returns sessionId for cross-phase continuity', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Phase done.' },
    )
    const deps = createHappyPathDeps()

    const returnedSessionId = await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps, 'sess-existing')

    expect(returnedSessionId).toBe('sess-dir')
  })

  // RV1: Skips review when config.withReviews is false
  it('skips review when config.withReviews is false', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'Phase done.' },
    )
    const deps = createHappyPathDeps()
    const config = { ...TEST_CONFIG, withReviews: false }

    await runPhase(TEST_PLAN, TEST_PHASE, config, 'plan.md', deps)

    expect(deps.workerExecute).toHaveBeenCalledTimes(1)
    // Only 1 Director call: complete (no review)
    expect(mockBackend.invoke).toHaveBeenCalledTimes(1)
    expect(deps.writePhaseCompletion).toHaveBeenCalled()
  })

  // RV2: Review runs when config.withReviews is undefined (legacy)
  it('runs review when config.withReviews is undefined (legacy)', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Phase done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    // 2 Director calls: review + complete
    expect(mockBackend.invoke).toHaveBeenCalledTimes(2)
  })

  // RV3: Review runs when config.withReviews is true
  it('runs review when config.withReviews is true', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Phase done.' },
    )
    const deps = createHappyPathDeps()
    const config = { ...TEST_CONFIG, withReviews: true }

    await runPhase(TEST_PLAN, TEST_PHASE, config, 'plan.md', deps)

    expect(mockBackend.invoke).toHaveBeenCalledTimes(2)
  })

  // RV4: Without reviews, Worker runs exactly once (no retry loop)
  it('without reviews, Worker runs exactly once per phase', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'Phase done.' },
    )
    const deps = createHappyPathDeps()
    deps.workerExecute = vi.fn().mockResolvedValueOnce(makeWorkerError())
    const config = { ...TEST_CONFIG, withReviews: false }

    await runPhase(TEST_PLAN, TEST_PHASE, config, 'plan.md', deps)

    expect(deps.workerExecute).toHaveBeenCalledTimes(1)
  })

  // RV5: Review tools exclude Bash when withBashReviews is false
  it('review uses read-only tools when withBashReviews is false', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Phase done.' },
    )
    const deps = createHappyPathDeps()
    const config = { ...TEST_CONFIG, withReviews: true, withBashReviews: false }

    await runPhase(TEST_PLAN, TEST_PHASE, config, 'plan.md', deps)

    const reviewOpts = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(reviewOpts.tools).toEqual(['Read', 'Glob', 'Grep'])
  })

  // RV6: Review tools include Bash when withBashReviews is true
  it('review includes Bash when withBashReviews is true', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Phase done.' },
    )
    const deps = createHappyPathDeps()
    const config = { ...TEST_CONFIG, withReviews: true, withBashReviews: true }

    await runPhase(TEST_PLAN, TEST_PHASE, config, 'plan.md', deps)

    const reviewOpts = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(reviewOpts.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash'])
  })

  // RV7: Review includes Bash when withBashReviews is undefined (legacy)
  it('review includes Bash when withBashReviews is undefined (legacy)', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Phase done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    const reviewOpts = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(reviewOpts.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash'])
  })

  // DO1: Director-only mode does NOT call workerExecute
  it('does not call workerExecute when withWorker is false', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'Phase executed and complete.' },
      { action: 'done', message: 'Summary.' },
    )
    const deps = createHappyPathDeps()
    const config = { ...TEST_CONFIG, withWorker: false }

    await runPhase(TEST_PLAN, TEST_PHASE, config, 'plan.md', deps)

    expect(deps.workerExecute).not.toHaveBeenCalled()
  })

  // DO2: Director gets full tools in director-only mode
  it('gives Director full tools in director-only mode', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'Done.' },
      { action: 'done', message: 'Summary.' },
    )
    const deps = createHappyPathDeps()
    const config = { ...TEST_CONFIG, withWorker: false }

    await runPhase(TEST_PLAN, TEST_PHASE, config, 'plan.md', deps)

    const execOpts = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(execOpts.tools).toEqual(['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep'])
  })

  // DO3: Director-only uses execution prompt (not review)
  it('uses execution prompt for Director-only mode', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'Implemented everything.' },
      { action: 'done', message: 'Summary.' },
    )
    const deps = createHappyPathDeps()
    const config = { ...TEST_CONFIG, withWorker: false }

    await runPhase(TEST_PLAN, TEST_PHASE, config, 'plan.md', deps)

    const execPrompt = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt
    expect(execPrompt).toContain('Phase 1')
    expect(execPrompt).toContain('Setup')
    expect(execPrompt).not.toContain('Worker Report')
  })

  // DO4: No review step in director-only mode (2 calls: execute + complete)
  it('skips review in director-only mode', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All done.' },
      { action: 'done', message: 'Summary.' },
    )
    const deps = createHappyPathDeps()
    const config = { ...TEST_CONFIG, withWorker: false }

    await runPhase(TEST_PLAN, TEST_PHASE, config, 'plan.md', deps)

    expect(mockBackend.invoke).toHaveBeenCalledTimes(2)
  })

  // DO5: Director-only completes phase with summary
  it('completes phase when Director returns done', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'Implementation complete.' },
      { action: 'done', message: 'Built the scaffold.' },
    )
    const deps = createHappyPathDeps()
    const config = { ...TEST_CONFIG, withWorker: false }

    await runPhase(TEST_PLAN, TEST_PHASE, config, 'plan.md', deps)

    expect(deps.writePhaseCompletion).toHaveBeenCalledWith('plan.md', 1, 'Built the scaffold.')
  })

  // DO6: withWorker undefined (legacy) uses Worker
  it('uses Worker when withWorker is undefined (legacy)', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Phase done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_PLAN, TEST_PHASE, TEST_CONFIG, 'plan.md', deps)

    expect(deps.workerExecute).toHaveBeenCalledTimes(1)
  })

  // DO7: Director-only uses director model for execution
  it('uses director model (not worker model) in director-only mode', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'Done.' },
      { action: 'done', message: 'Summary.' },
    )
    const deps = createHappyPathDeps()
    const config = { ...TEST_CONFIG, withWorker: false }

    await runPhase(TEST_PLAN, TEST_PHASE, config, 'plan.md', deps)

    const execOpts = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(execOpts.model).toBe('claude-sonnet-4-6')
  })

  // DO8: Director-only gets generous maxTurns for execution
  it('uses higher maxTurns for Director execution step', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'Done.' },
      { action: 'done', message: 'Summary.' },
    )
    const deps = createHappyPathDeps()
    const config = { ...TEST_CONFIG, withWorker: false }

    await runPhase(TEST_PLAN, TEST_PHASE, config, 'plan.md', deps)

    const execOpts = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(execOpts.maxTurns).toBeGreaterThanOrEqual(50)
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

  // P2b: Director asks follow-up questions after initial clarification
  it('handles follow-up questions triggered by answers', async () => {
    setupDirectorResponses(
      // Analyze: initial questions
      { action: 'ask_human', message: 'Need info', questions: ['Want polling?'] },
      // Clarify round 1: answer triggers follow-up
      { action: 'ask_human', message: 'Follow-up needed', questions: ['Polling interval? (Recommended: 30s)'] },
      // Clarify round 2: satisfied
      { action: 'approve', message: 'All clear.' },
      // CreatePlan
      { action: 'done', message: VALID_PLAN_CONTENT },
    )
    const deps = createHappyPathDeps()
    deps.askInput = vi.fn()
      .mockResolvedValueOnce('Yes')       // round 1: Want polling?
      .mockResolvedValueOnce('30 seconds') // round 2: Polling interval?
      .mockResolvedValue('done')

    await runPlanningFlow(TEST_FREE_FORM_SPEC, TEST_CONFIG, deps)

    // 2 rounds of questions answered
    const askInputCalls = (deps.askInput as ReturnType<typeof vi.fn>).mock.calls
    expect(askInputCalls[0][0]).toContain('Want polling?')
    expect(askInputCalls[1][0]).toContain('Polling interval?')
    // 4 Director calls: analyze, clarify round 1, clarify round 2, createPlan
    expect(mockBackend.invoke).toHaveBeenCalledTimes(4)
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
    expect(mockBackend.invoke).toHaveBeenCalledTimes(3)
    const revisionPrompt = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[2][0].prompt
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

    expect(mockBackend.invoke).toHaveBeenCalledTimes(3)
    const fixPrompt = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[2][0].prompt
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

    const firstOpts = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(firstOpts.systemPrompt).toContain('Build a widget app')
    expect(firstOpts.systemPrompt).toContain('Use TDD')
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

  // P9: First Director call has no resume, subsequent calls resume session
  it('uses continuous session — first call fresh, subsequent calls resume', async () => {
    setupDirectorResponses(
      { action: 'ask_human', message: 'Need info', questions: ['What DB?'] },
      { action: 'approve', message: 'Understood.' },
      { action: 'done', message: VALID_PLAN_CONTENT },
    )
    const deps = createHappyPathDeps()
    deps.askInput = vi.fn().mockResolvedValueOnce('PostgreSQL').mockResolvedValue('done')

    await runPlanningFlow(TEST_FREE_FORM_SPEC, TEST_CONFIG, deps)

    // 3 calls: analyze, clarify, createPlan
    expect(mockBackend.invoke).toHaveBeenCalledTimes(3)
    // First call: no resume
    expect((mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0].resumeSessionId).toBeUndefined()
    // Second call: resumes from first session
    expect((mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[1][0].resumeSessionId).toBe('sess-dir')
    // Third call: also resumes
    expect((mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[2][0].resumeSessionId).toBe('sess-dir')
  })

  // P10: Returns sessionId for execution flow to continue
  it('returns sessionId for execution flow to continue', async () => {
    setupDirectorResponses(
      { action: 'analyze', message: 'Spec is clear.' },
      { action: 'done', message: VALID_PLAN_CONTENT },
    )
    const deps = createHappyPathDeps()

    const result = await runPlanningFlow(TEST_FREE_FORM_SPEC, TEST_CONFIG, deps)

    expect(result.sessionId).toBe('sess-dir')
  })

  // PV1: Auto-approves plan when withHumanValidation is false
  it('auto-approves plan when config.withHumanValidation is false', async () => {
    setupDirectorResponses(
      { action: 'analyze', message: 'Spec is clear.' },
      { action: 'done', message: VALID_PLAN_CONTENT },
    )
    const deps = createHappyPathDeps()
    const config = { ...TEST_CONFIG, withHumanValidation: false }

    await runPlanningFlow(TEST_FREE_FORM_SPEC, config, deps)

    expect(deps.askApproval).not.toHaveBeenCalled()
    expect(deps.createPlanFile).toHaveBeenCalledWith('/tmp/spec.plan.md', VALID_PLAN_CONTENT)
  })

  // PV2: Asks for approval when withHumanValidation is true
  it('asks for plan approval when config.withHumanValidation is true', async () => {
    setupDirectorResponses(
      { action: 'analyze', message: 'Spec is clear.' },
      { action: 'done', message: VALID_PLAN_CONTENT },
    )
    const deps = createHappyPathDeps()
    const config = { ...TEST_CONFIG, withHumanValidation: true }

    await runPlanningFlow(TEST_FREE_FORM_SPEC, config, deps)

    expect(deps.askApproval).toHaveBeenCalledTimes(1)
    expect(deps.display).toHaveBeenCalledWith(expect.stringContaining('Test Project'))
  })

  // PV3: Still fixes invalid plan format even without human validation
  it('fixes invalid plan format even when withHumanValidation is false', async () => {
    setupDirectorResponses(
      { action: 'analyze', message: 'Spec is clear.' },
      { action: 'done', message: 'Not a valid plan' },
      { action: 'done', message: VALID_PLAN_CONTENT },
    )
    const deps = createHappyPathDeps()
    const config = { ...TEST_CONFIG, withHumanValidation: false }

    const result = await runPlanningFlow(TEST_FREE_FORM_SPEC, config, deps)

    expect(deps.askApproval).not.toHaveBeenCalled()
    expect(result.plan.title).toBe('Test Project')
    // 3 calls: analyze, createPlan(invalid), fix
    expect(mockBackend.invoke).toHaveBeenCalledTimes(3)
  })

  // PV4: Plan revision loop works when withHumanValidation is true
  it('handles plan revision when withHumanValidation is true', async () => {
    setupDirectorResponses(
      { action: 'analyze', message: 'Spec is clear.' },
      { action: 'done', message: VALID_PLAN_CONTENT },
      { action: 'done', message: VALID_PLAN_CONTENT },
    )
    const deps = createHappyPathDeps()
    deps.askApproval = vi.fn()
      .mockResolvedValueOnce({ approved: false, feedback: 'Add tests' })
      .mockResolvedValueOnce({ approved: true })
    const config = { ...TEST_CONFIG, withHumanValidation: true }

    await runPlanningFlow(TEST_FREE_FORM_SPEC, config, deps)

    expect(deps.askApproval).toHaveBeenCalledTimes(2)
  })
})

// === executeDirector session tracking tests ===

describe('executeDirector', () => {
  const mockLogger = { log: vi.fn(), logVerbose: vi.fn(), logFilePath: '' }

  function setupBackendResult(action: string, message: string) {
    ;(mockBackend.invoke as ReturnType<typeof vi.fn>).mockResolvedValue(makeBackendResult(action, message))
  }

  // S1: Captures session_id from system init message
  it('captures session_id from system init message', async () => {
    setupBackendResult('done', 'test')

    const result = await executeDirector({
      prompt: 'test',
      step: WorkflowStep.Analyze,
      systemPromptText: 'system prompt',
      config: TEST_CONFIG,
      logger: mockLogger,
      backend: mockBackend,
    })

    expect(result.sessionId).toBe('sess-dir')
  })

  // S2: Passes resume option to backend when provided
  it('passes resume option to backend when provided', async () => {
    setupBackendResult('done', 'test')

    await executeDirector({
      prompt: 'test',
      step: WorkflowStep.Analyze,
      systemPromptText: 'system prompt',
      config: TEST_CONFIG,
      logger: mockLogger,
      backend: mockBackend,
      resume: 'sess-123',
    })

    const invocation = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(invocation.resumeSessionId).toBe('sess-123')
  })

  // S3: Does not include resume option when not provided
  it('does not include resume option when not provided', async () => {
    setupBackendResult('done', 'test')

    await executeDirector({
      prompt: 'test',
      step: WorkflowStep.Analyze,
      systemPromptText: 'system prompt',
      config: TEST_CONFIG,
      logger: mockLogger,
      backend: mockBackend,
    })

    const invocation = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(invocation.resumeSessionId).toBeUndefined()
  })

  // S4: Omits systemPrompt when resuming (session retains original)
  it('omits systemPrompt when resuming', async () => {
    setupBackendResult('done', 'test')

    await executeDirector({
      prompt: 'test',
      step: WorkflowStep.Analyze,
      systemPromptText: 'system prompt',
      config: TEST_CONFIG,
      logger: mockLogger,
      backend: mockBackend,
      resume: 'sess-123',
    })

    const invocation = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(invocation.systemPrompt).toBeUndefined()
  })

  // S5: Includes systemPrompt on fresh session (no resume)
  it('includes systemPrompt on fresh session', async () => {
    setupBackendResult('done', 'test')

    await executeDirector({
      prompt: 'test',
      step: WorkflowStep.Analyze,
      systemPromptText: 'my system prompt',
      config: TEST_CONFIG,
      logger: mockLogger,
      backend: mockBackend,
    })

    const invocation = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(invocation.systemPrompt).toBe('my system prompt')
  })

  // MO1: Uses config.directorModel override when set
  it('uses directorModel from config when set', async () => {
    setupBackendResult('done', 'test')
    const config = { ...TEST_CONFIG, directorModel: 'opus' }

    await executeDirector({
      prompt: 'test',
      step: WorkflowStep.Analyze,
      systemPromptText: 'system',
      config,
      logger: mockLogger,
      backend: mockBackend,
    })

    const invocation = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(invocation.model).toBe('claude-opus-4-6')
  })

  // MO2: Falls back to env var when no directorModel override
  it('falls back to env var when directorModel not in config', async () => {
    process.env.CESTDONE_DIRECTOR_MODEL = 'claude-haiku-4-5'
    setupBackendResult('done', 'test')

    await executeDirector({
      prompt: 'test',
      step: WorkflowStep.Analyze,
      systemPromptText: 'system',
      config: TEST_CONFIG,
      logger: mockLogger,
      backend: mockBackend,
    })

    const invocation = (mockBackend.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(invocation.model).toBe('claude-haiku-4-5')
  })

  // MO3: buildWorkerOptions uses config.workerModel override
  it('passes workerModel from config to Worker', async () => {
    setupDirectorResponses(
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    const config = { ...TEST_CONFIG, workerModel: 'sonnet' }

    await runPhase(TEST_PLAN, TEST_PHASE, config, 'plan.md', deps)

    const opts = (deps.workerExecute as ReturnType<typeof vi.fn>).mock.calls[0][0] as WorkerOptions
    expect(opts.model).toBe('claude-sonnet-4-6')
  })
})

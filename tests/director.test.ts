// tests/director.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runPhase } from '../src/director/director.js'
import type { DirectorDeps } from '../src/director/director.js'
import { WorkflowStep } from '../src/shared/types.js'
import type { ParsedSpec, ResolvedConfig, Phase, CoderResult, CoderOptions } from '../src/shared/types.js'

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
  number: 0,
  name: 'Setup',
  status: 'pending',
  spec: 'Set up the project structure.',
  done: '_(to be filled)_',
}

const TEST_SPEC: ParsedSpec = {
  title: 'Test Project',
  metadata: { context: 'A test project.', houseRulesRef: 'See house-rules.md.', houseRulesContent: 'Use TDD.' },
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
    updatePhaseStatus: vi.fn(),
    updatePhaseSpec: vi.fn(),
    writePhaseCompletion: vi.fn(),
    coderExecute: vi.fn().mockResolvedValue(makeCoderSuccess()),
    display: vi.fn(),
    logger: { log: vi.fn(), logVerbose: vi.fn() },
  }
}

// Happy path flow: analyze(0) → plan(1) → coder(execute) → review(2) → complete(3)
// Director calls: 4 (analyze, plan, review, complete)

describe('runPhase', () => {
  // J1: Step 1 — sends Analyze prompt via Agent SDK, sets phase to in-progress
  it('calls Director via Agent SDK and sets phase to in-progress', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis complete. No questions.' },
      { action: 'approve', message: 'Plan:\n1. Create files\n2. Write tests' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Phase done. Created scaffold.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.updatePhaseStatus).toHaveBeenCalledWith('spec.md', 0, 'in-progress')
    // Director called via Agent SDK query()
    expect(mockQuery).toHaveBeenCalled()
    // First call prompt should contain analysis instructions
    const firstPrompt = mockQuery.mock.calls[0][0].prompt
    expect(firstPrompt).toContain('clarifying questions')
  })

  // J2: Step 2 — escalates questions to human via askInput
  it('escalates questions to human via askInput at Step 2', async () => {
    setupDirectorResponses(
      { action: 'ask_human', message: 'Need info', questions: ['What DB?', 'Auth method?'] },
      { action: 'approve', message: 'Understood.' },
      { action: 'approve', message: 'Update spec with answers' },
      { action: 'approve', message: 'Plan: ...' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.askInput = vi.fn()
      .mockResolvedValueOnce('PostgreSQL')
      .mockResolvedValueOnce('JWT')
      .mockResolvedValue('done')

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    const askInputCalls = (deps.askInput as ReturnType<typeof vi.fn>).mock.calls
    expect(askInputCalls[0][0]).toContain('What DB?')
    expect(askInputCalls[1][0]).toContain('Auth method?')
  })

  // J3: Director uses read-only tools for Analyze step
  it('passes read-only tools to Director for Analyze step', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    const firstOpts = mockQuery.mock.calls[0][0].options
    expect(firstOpts.tools).toEqual(['Read', 'Glob', 'Grep'])
  })

  // J4: Step 4 — receives plan and displays it to human
  it('receives plan and displays it to human', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis complete' },
      { action: 'approve', message: 'Plan:\n1. Create files\n2. Write tests' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.display).toHaveBeenCalledWith(
      expect.stringContaining('Create files')
    )
  })

  // J5: Step 5 — presents plan, proceeds on approval
  it('presents plan and proceeds on approval', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.askApproval).toHaveBeenCalledTimes(1)
  })

  // J5b: Step 5 — re-plans on rejection
  it('sends feedback to Director and re-plans on rejection', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
      { action: 'approve', message: 'Plan v1' },
      { action: 'approve', message: 'Plan v2 with test detail' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.askApproval = vi.fn()
      .mockResolvedValueOnce({ approved: false, feedback: 'Need more detail on tests' })
      .mockResolvedValueOnce({ approved: true })

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.askApproval).toHaveBeenCalledTimes(2)
    // Director called 5 times: analyze, plan, re-plan, review, complete
    expect(mockQuery).toHaveBeenCalledTimes(5)
    // Re-plan prompt contains feedback
    const rePlanPrompt = mockQuery.mock.calls[2][0].prompt
    expect(rePlanPrompt).toContain('Need more detail on tests')
  })

  // R1: Step 6 calls coderExecute with instructions from approved plan
  it('calls coderExecute with plan instructions at Step 6 (R1)', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
      { action: 'approve', message: 'Plan:\n1. Create files\n2. Write tests' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.coderExecute).toHaveBeenCalledTimes(1)
    const opts = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls[0][0] as CoderOptions
    expect(opts.instructions).toContain('Create files')
    expect(opts.step).toBe(WorkflowStep.Execute)
  })

  // R2: Step 6 passes correct model from selectModel()
  it('passes model from selectModel() to coderExecute (R2)', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    const opts = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls[0][0] as CoderOptions
    expect(opts.model).toBeTruthy()
    expect(typeof opts.model).toBe('string')
  })

  // R3: Success → review verifies → proceeds to Step 8
  it('proceeds to Step 8 after review confirms Coder success (R3)', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
      { action: 'approve', message: 'Plan: do things' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Phase done. Created scaffold.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.writePhaseCompletion).toHaveBeenCalledWith(
      'spec.md', 0, 'Phase done. Created scaffold.'
    )
    // Director called 4 times: analyze, plan, review, complete
    expect(mockQuery).toHaveBeenCalledTimes(4)
  })

  // R4: Error → Director formulates fix → retry Coder
  it('retries Coder with fix instructions on error (R4)', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
      { action: 'approve', message: 'Plan: do things' },
      { action: 'fix', message: 'Fix the failing test by updating the assertion' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.coderExecute = vi.fn()
      .mockResolvedValueOnce(makeCoderError())
      .mockResolvedValueOnce(makeCoderSuccess())

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.coderExecute).toHaveBeenCalledTimes(2)
    const secondOpts = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls[1][0] as CoderOptions
    expect(secondOpts.instructions).toContain('Fix the failing test')
  })

  // R5: 3 failures → escalate to human
  it('escalates to human after 3 Coder failures (R5)', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
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

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.coderExecute).toHaveBeenCalledTimes(4)
    const askInputCalls = (deps.askInput as ReturnType<typeof vi.fn>).mock.calls
    const escalationCall = askInputCalls.find((c: string[]) => c[0].includes('3'))
    expect(escalationCall).toBeTruthy()
  })

  // R6: Displays Coder summary
  it('displays Coder summary to human (R6)', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.coderExecute = vi.fn().mockResolvedValue(
      makeCoderSuccess({ report: { status: 'success', summary: 'Built login form with tests' } })
    )

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.display).toHaveBeenCalledWith(
      expect.stringContaining('Built login form with tests')
    )
  })

  // R7: CoderOptions has all required fields
  it('passes complete CoderOptions to coderExecute (R7)', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

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

  // R8: Cost accumulation across retries
  it('displays accumulated Coder cost (R8)', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
      { action: 'approve', message: 'Plan: do things' },
      { action: 'fix', message: 'Fix it' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.coderExecute = vi.fn()
      .mockResolvedValueOnce(makeCoderError({ cost: 0.50 }))
      .mockResolvedValueOnce(makeCoderSuccess({ cost: 0.75 }))

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.coderExecute).toHaveBeenCalledTimes(2)
    const allDisplayText = (deps.display as ReturnType<typeof vi.fn>).mock.calls.map((c: string[]) => c[0]).join('\n')
    expect(allDisplayText).toContain('1.25')
  })

  // R9: Step 3 writes spec directly after clarifications (no Coder involved)
  it('updates spec file directly after clarifications (R9)', async () => {
    setupDirectorResponses(
      { action: 'ask_human', message: 'Need info', questions: ['What DB?'] },
      { action: 'approve', message: 'Understood.' },
      { action: 'approve', message: 'Updated spec with PostgreSQL' },
      { action: 'approve', message: 'Plan: set up DB' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.askInput = vi.fn()
      .mockResolvedValueOnce('PostgreSQL')
      .mockResolvedValue('done')

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    // Spec updated directly by orchestrator, not via Coder
    expect(deps.updatePhaseSpec).toHaveBeenCalledWith('spec.md', 0, 'Updated spec with PostgreSQL')
    // Coder only called once for Execute step, not for UpdateSpec
    const coderCalls = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls
    expect(coderCalls).toHaveLength(1)
    expect(coderCalls[0][0].step).toBe(WorkflowStep.Execute)
  })

  // J7: Step 8 — writes phase completion with done summary
  it('writes phase completion with done summary at Step 8', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Phase done. Created scaffold.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.writePhaseCompletion).toHaveBeenCalledWith(
      'spec.md', 0, 'Phase done. Created scaffold.'
    )
  })

  // J8: 3 rejections → escalation with "I'm stuck" message
  it('escalates to human after 3 plan rejections', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
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

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    const askInputCalls = (deps.askInput as ReturnType<typeof vi.fn>).mock.calls
    const escalationCall = askInputCalls.find((c: string[]) => c[0].includes("I'm stuck"))
    expect(escalationCall).toBeTruthy()
    expect(escalationCall![0]).toContain('3 plan rejections')
  })

  // J9: Each Director call is a fresh Agent SDK session (no message accumulation)
  it('makes independent Agent SDK query() calls per step', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
      { action: 'approve', message: 'Plan: do things' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    // 4 calls: analyze, plan, review, complete
    expect(mockQuery).toHaveBeenCalledTimes(4)
    // Each call is independent — prompt is a string, not accumulated messages
    for (const call of mockQuery.mock.calls) {
      expect(typeof call[0].prompt).toBe('string')
    }
  })

  // J10: Director uses outputFormat for structured JSON
  it('Director uses outputFormat for structured JSON responses', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'OK' },
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

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
      { action: 'approve', message: 'OK' },
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    const firstOpts = mockQuery.mock.calls[0][0].options
    expect(firstOpts.env.CLAUDECODE).toBeUndefined()
    delete process.env.CLAUDECODE
  })

  // J12: Review step gives Director Bash tool
  it('Review step gives Director Bash tool', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
      { action: 'approve', message: 'Plan: do things' },
      { action: 'fix', message: 'Fix it' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()
    deps.coderExecute = vi.fn()
      .mockResolvedValueOnce(makeCoderError())
      .mockResolvedValueOnce(makeCoderSuccess())

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    // 5 Director calls: analyze, plan, review(fix), review(done), complete
    expect(mockQuery).toHaveBeenCalledTimes(5)
    const reviewOpts = mockQuery.mock.calls[2][0].options
    expect(reviewOpts.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash'])
  })

  // J13: Sub-phase iteration — Director returns 'continue' to advance sub-phases
  it('iterates through sub-phases when Director returns continue', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
      { action: 'approve', message: 'Plan:\nSub-phase A: Create models\nSub-phase B: Add routes' },
      { action: 'continue', message: 'Sub-phase A complete. Now implement Sub-phase B: Add routes' },
      { action: 'done', message: 'All sub-phases verified.' },
      { action: 'done', message: 'Both sub-phases complete.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    // Coder called twice: once per sub-phase
    expect(deps.coderExecute).toHaveBeenCalledTimes(2)
    // Second Coder call gets the next sub-phase instructions from Director's 'continue'
    const secondOpts = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls[1][0] as CoderOptions
    expect(secondOpts.instructions).toContain('Sub-phase B')
    // Display shows sub-phase progress
    expect(deps.display).toHaveBeenCalledWith(
      expect.stringContaining('Sub-phase 1 complete')
    )
  })

  // J14: Sub-phase context is passed to Coder
  it('passes completedSubPhases to Coder on subsequent sub-phases', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
      { action: 'approve', message: 'Plan with sub-phases' },
      { action: 'continue', message: 'Next sub-phase instructions' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    // First Coder call has no completed sub-phases
    const firstOpts = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls[0][0] as CoderOptions
    expect(firstOpts.completedSubPhases).toEqual([])

    // Second Coder call has the first sub-phase summary
    const secondOpts = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls[1][0] as CoderOptions
    expect(secondOpts.completedSubPhases).toHaveLength(1)
    expect(secondOpts.completedSubPhases![0]).toBe('Implementation complete')
  })

  // J15: Sub-phase retries are scoped per sub-phase
  it('resets retry count when moving to next sub-phase', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
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

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    // 4 Coder calls: A fail, A success, B fail, B success
    expect(deps.coderExecute).toHaveBeenCalledTimes(4)
    // No human escalation needed (retries reset between sub-phases)
    const askInputCalls = (deps.askInput as ReturnType<typeof vi.fn>).mock.calls
    const escalationCall = askInputCalls.find((c: string[]) => c[0].includes('failed'))
    expect(escalationCall).toBeUndefined()
  })

  // J16: Review prompt includes completedSubPhases context
  it('passes completedSubPhases to review prompt', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
      { action: 'approve', message: 'Plan with sub-phases' },
      { action: 'continue', message: 'Next sub-phase' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    // Second review call (index 3) should have the sub-phase context in its prompt
    const secondReviewPrompt = mockQuery.mock.calls[3][0].prompt
    expect(secondReviewPrompt).toContain('Previously Completed Sub-phases')
  })

  // J17: Review always runs — even on Coder success
  it('always runs review after Coder execution', async () => {
    setupDirectorResponses(
      { action: 'approve', message: 'Analysis OK' },
      { action: 'approve', message: 'Plan' },
      { action: 'done', message: 'All verified.' },
      { action: 'done', message: 'Done.' },
    )
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    // Review runs even on success: analyze(0), plan(1), review(2), complete(3)
    expect(mockQuery).toHaveBeenCalledTimes(4)
    // The review call (index 2) uses Review step tools
    const reviewOpts = mockQuery.mock.calls[2][0].options
    expect(reviewOpts.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash'])
  })
})

// tests/director.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runPhase } from '../src/director/director.js'
import type { DirectorDeps, ApiResponse } from '../src/director/director.js'
import { WorkflowStep } from '../src/shared/types.js'
import type { ParsedSpec, ResolvedConfig, Phase, CoderResult, CoderOptions } from '../src/shared/types.js'

let callId = 0

beforeEach(() => { callId = 0 })

function makeToolResponse(action: string, message: string, questions?: string[]): ApiResponse {
  callId++
  return {
    content: [{
      type: 'tool_use',
      id: `toolu_${callId}`,
      name: 'director_action',
      input: { action, message, ...(questions ? { questions } : {}) },
    }],
    stop_reason: 'tool_use',
  }
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
  logLevel: 'silent',
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
    status: 'error',
    message: 'Tests failing',
    cost: 0.10,
    numTurns: 5,
    durationMs: 3000,
    report: { status: 'error', summary: 'Tests failing' },
    ...overrides,
  }
}

function createHappyPathDeps(): DirectorDeps {
  return {
    createMessage: vi.fn()
      .mockResolvedValueOnce(makeToolResponse('approve', 'Analysis complete. No questions.'))
      .mockResolvedValueOnce(makeToolResponse('approve', 'Plan:\n1. Create files\n2. Write tests'))
      .mockResolvedValueOnce(makeToolResponse('complete', 'Phase done. Created scaffold.')),
    askApproval: vi.fn().mockResolvedValue({ approved: true }),
    askInput: vi.fn().mockResolvedValue('done'),
    updatePhaseStatus: vi.fn(),
    writePhaseCompletion: vi.fn(),
    coderExecute: vi.fn().mockResolvedValue(makeCoderSuccess()),
    display: vi.fn(),
  }
}

describe('runPhase', () => {
  // J1: Step 1 — sends Analyze prompt via API, sets phase to in-progress
  it('sends analyze prompt to API and sets phase to in-progress', async () => {
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.updatePhaseStatus).toHaveBeenCalledWith('spec.md', 0, 'in-progress')
    const firstCall = (deps.createMessage as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(firstCall.system).toContain('A test project.')
    expect(firstCall.messages[0].content).toContain('clarifying questions')
  })

  // J2: Step 2 — escalates questions to human via askInput
  it('escalates questions to human via askInput at Step 2', async () => {
    const deps = createHappyPathDeps()
    deps.createMessage = vi.fn()
      .mockResolvedValueOnce(makeToolResponse('ask_human', 'Need info', ['What DB?', 'Auth method?']))
      .mockResolvedValueOnce(makeToolResponse('approve', 'Understood.'))
      .mockResolvedValueOnce(makeToolResponse('approve', 'Update spec with answers'))
      .mockResolvedValueOnce(makeToolResponse('approve', 'Plan: ...'))
      .mockResolvedValueOnce(makeToolResponse('complete', 'Done.'))
    deps.askInput = vi.fn()
      .mockResolvedValueOnce('PostgreSQL')
      .mockResolvedValueOnce('JWT')
      .mockResolvedValue('done')

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    const askInputCalls = (deps.askInput as ReturnType<typeof vi.fn>).mock.calls
    expect(askInputCalls[0][0]).toContain('What DB?')
    expect(askInputCalls[1][0]).toContain('Auth method?')
  })

  // J3: Step 3 — proceeds past clarifications to Step 4
  it('proceeds from clarifications to Plan step', async () => {
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    const planCallMsgs = (deps.createMessage as ReturnType<typeof vi.fn>).mock.calls[1][0].messages
    const planMsg = planCallMsgs[2]
    const textContent = typeof planMsg.content === 'string'
      ? planMsg.content
      : (planMsg.content as Array<{ type: string; text?: string }>)
          .find(b => b.type === 'text')?.text ?? ''
    expect(textContent).toContain('implementation plan')
  })

  // J4: Step 4 — receives plan and displays it to human
  it('receives plan and displays it to human', async () => {
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.display).toHaveBeenCalledWith(
      expect.stringContaining('Create files')
    )
  })

  // J5: Step 5 — presents plan, proceeds on approval
  it('presents plan and proceeds on approval', async () => {
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.askApproval).toHaveBeenCalledTimes(1)
  })

  // J5b: Step 5 — re-plans on rejection
  it('sends feedback to API and re-plans on rejection', async () => {
    const deps = createHappyPathDeps()
    deps.askApproval = vi.fn()
      .mockResolvedValueOnce({ approved: false, feedback: 'Need more detail on tests' })
      .mockResolvedValueOnce({ approved: true })
    deps.createMessage = vi.fn()
      .mockResolvedValueOnce(makeToolResponse('approve', 'Analysis OK'))
      .mockResolvedValueOnce(makeToolResponse('approve', 'Plan v1'))
      .mockResolvedValueOnce(makeToolResponse('approve', 'Plan v2 with test detail'))
      .mockResolvedValueOnce(makeToolResponse('complete', 'Done.'))

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.askApproval).toHaveBeenCalledTimes(2)
    expect(deps.createMessage).toHaveBeenCalledTimes(4)
    const retryCallArgs = (deps.createMessage as ReturnType<typeof vi.fn>).mock.calls[2][0]
    const allContent = JSON.stringify(retryCallArgs.messages)
    expect(allContent).toContain('Need more detail on tests')
  })

  // R1: Step 6 calls coderExecute with instructions from approved plan
  it('calls coderExecute with plan instructions at Step 6 (R1)', async () => {
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.coderExecute).toHaveBeenCalledTimes(1)
    const opts = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls[0][0] as CoderOptions
    expect(opts.instructions).toContain('Create files')
    expect(opts.step).toBe(WorkflowStep.Execute)
  })

  // R2: Step 6 passes correct model from selectModel()
  it('passes model from selectModel() to coderExecute (R2)', async () => {
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    const opts = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls[0][0] as CoderOptions
    expect(opts.model).toBeTruthy()
    expect(typeof opts.model).toBe('string')
  })

  // R3: Success → proceeds to Step 8
  it('proceeds to Step 8 on Coder success (R3)', async () => {
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.writePhaseCompletion).toHaveBeenCalledWith(
      'spec.md', 0, 'Phase done. Created scaffold.'
    )
    // createMessage called exactly 3 times (analyze, plan, complete — no review)
    expect(deps.createMessage).toHaveBeenCalledTimes(3)
  })

  // R4: Error → Director formulates fix → retry Coder
  it('retries Coder with fix instructions on error (R4)', async () => {
    const deps = createHappyPathDeps()
    deps.coderExecute = vi.fn()
      .mockResolvedValueOnce(makeCoderError())
      .mockResolvedValueOnce(makeCoderSuccess())
    // createMessage: analyze, plan, review(fix), complete
    deps.createMessage = vi.fn()
      .mockResolvedValueOnce(makeToolResponse('approve', 'Analysis OK'))
      .mockResolvedValueOnce(makeToolResponse('approve', 'Plan: do things'))
      .mockResolvedValueOnce(makeToolResponse('fix', 'Fix the failing test by updating the assertion'))
      .mockResolvedValueOnce(makeToolResponse('complete', 'Done.'))

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.coderExecute).toHaveBeenCalledTimes(2)
    const secondOpts = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls[1][0] as CoderOptions
    expect(secondOpts.instructions).toContain('Fix the failing test')
  })

  // R5: 3 failures → escalate to human
  it('escalates to human after 3 Coder failures (R5)', async () => {
    const deps = createHappyPathDeps()
    deps.coderExecute = vi.fn()
      .mockResolvedValueOnce(makeCoderError({ message: 'Fail 1' }))
      .mockResolvedValueOnce(makeCoderError({ message: 'Fail 2' }))
      .mockResolvedValueOnce(makeCoderError({ message: 'Fail 3' }))
      .mockResolvedValueOnce(makeCoderSuccess())
    deps.askInput = vi.fn().mockResolvedValue('Try a different approach')
    // createMessage: analyze, plan, review1(fix), review2(fix), complete
    deps.createMessage = vi.fn()
      .mockResolvedValueOnce(makeToolResponse('approve', 'Analysis OK'))
      .mockResolvedValueOnce(makeToolResponse('approve', 'Plan: do things'))
      .mockResolvedValueOnce(makeToolResponse('fix', 'Fix attempt 1'))
      .mockResolvedValueOnce(makeToolResponse('fix', 'Fix attempt 2'))
      .mockResolvedValueOnce(makeToolResponse('complete', 'Done.'))

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.coderExecute).toHaveBeenCalledTimes(4)
    const askInputCalls = (deps.askInput as ReturnType<typeof vi.fn>).mock.calls
    const escalationCall = askInputCalls.find((c: string[]) => c[0].includes('3'))
    expect(escalationCall).toBeTruthy()
  })

  // R6: Displays Coder summary
  it('displays Coder summary to human (R6)', async () => {
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
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    const opts = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls[0][0] as CoderOptions
    expect(opts.step).toBe(WorkflowStep.Execute)
    expect(opts.phase).toEqual(TEST_PHASE)
    expect(opts.targetRepoPath).toBe('/tmp/repo')
    expect(opts.houseRulesContent).toBe('Use TDD.')
    expect(opts.maxTurns).toBe(100)
    expect(opts.apiKey).toBe('sk-test')
    expect(opts.logLevel).toBe('silent')
  })

  // R8: Cost accumulation across retries
  it('displays accumulated Coder cost (R8)', async () => {
    const deps = createHappyPathDeps()
    deps.coderExecute = vi.fn()
      .mockResolvedValueOnce(makeCoderError({ cost: 0.50 }))
      .mockResolvedValueOnce(makeCoderSuccess({ cost: 0.75 }))
    deps.createMessage = vi.fn()
      .mockResolvedValueOnce(makeToolResponse('approve', 'Analysis OK'))
      .mockResolvedValueOnce(makeToolResponse('approve', 'Plan: do things'))
      .mockResolvedValueOnce(makeToolResponse('fix', 'Fix it'))
      .mockResolvedValueOnce(makeToolResponse('complete', 'Done.'))

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.coderExecute).toHaveBeenCalledTimes(2)
    const allDisplayText = (deps.display as ReturnType<typeof vi.fn>).mock.calls.map((c: string[]) => c[0]).join('\n')
    expect(allDisplayText).toContain('1.25')
  })

  // R9: Step 3 calls Coder with spec-editing permissions after clarifications
  it('calls Coder for spec update after clarifications (R9)', async () => {
    const deps = createHappyPathDeps()
    deps.createMessage = vi.fn()
      .mockResolvedValueOnce(makeToolResponse('ask_human', 'Need info', ['What DB?']))
      .mockResolvedValueOnce(makeToolResponse('approve', 'Understood.'))
      .mockResolvedValueOnce(makeToolResponse('approve', 'Update the spec to mention PostgreSQL'))
      .mockResolvedValueOnce(makeToolResponse('approve', 'Plan: set up DB'))
      .mockResolvedValueOnce(makeToolResponse('complete', 'Done.'))
    deps.askInput = vi.fn()
      .mockResolvedValueOnce('PostgreSQL')
      .mockResolvedValue('done')

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    const coderCalls = (deps.coderExecute as ReturnType<typeof vi.fn>).mock.calls
    expect(coderCalls.length).toBeGreaterThanOrEqual(2)
    const specUpdateCall = coderCalls.find((c: CoderOptions[]) => c[0].step === WorkflowStep.UpdateSpec)
    expect(specUpdateCall).toBeTruthy()
  })

  // J7: Step 8 — writes phase completion with done summary
  it('writes phase completion with done summary at Step 8', async () => {
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.writePhaseCompletion).toHaveBeenCalledWith(
      'spec.md', 0, 'Phase done. Created scaffold.'
    )
  })

  // J8: 3 rejections → escalation with "I'm stuck" message
  it('escalates to human after 3 plan rejections', async () => {
    const deps = createHappyPathDeps()
    deps.askApproval = vi.fn()
      .mockResolvedValueOnce({ approved: false, feedback: 'F1' })
      .mockResolvedValueOnce({ approved: false, feedback: 'F2' })
      .mockResolvedValueOnce({ approved: false, feedback: 'F3' })
      .mockResolvedValueOnce({ approved: true })
    deps.askInput = vi.fn().mockResolvedValue('try simpler approach')
    deps.createMessage = vi.fn()
      .mockResolvedValueOnce(makeToolResponse('approve', 'Analysis OK'))
      .mockResolvedValueOnce(makeToolResponse('approve', 'Plan v1'))
      .mockResolvedValueOnce(makeToolResponse('approve', 'Plan v2'))
      .mockResolvedValueOnce(makeToolResponse('approve', 'Plan v3'))
      .mockResolvedValueOnce(makeToolResponse('approve', 'Plan v4'))
      .mockResolvedValueOnce(makeToolResponse('complete', 'Done.'))

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    const askInputCalls = (deps.askInput as ReturnType<typeof vi.fn>).mock.calls
    const escalationCall = askInputCalls.find((c: string[]) => c[0].includes("I'm stuck"))
    expect(escalationCall).toBeTruthy()
    expect(escalationCall![0]).toContain('3 plan rejections')
  })

  // J9: Message history accumulates across steps
  it('accumulates message history across API calls', async () => {
    const messageCounts: number[] = []
    const responses = [
      makeToolResponse('approve', 'Analysis OK'),
      makeToolResponse('approve', 'Plan: do things'),
      makeToolResponse('complete', 'Done.'),
    ]

    const deps: DirectorDeps = {
      createMessage: vi.fn().mockImplementation(async (params: { messages: unknown[] }) => {
        messageCounts.push(params.messages.length)
        return responses[messageCounts.length - 1]
      }),
      askApproval: vi.fn().mockResolvedValue({ approved: true }),
      askInput: vi.fn().mockResolvedValue('done'),
      updatePhaseStatus: vi.fn(),
      writePhaseCompletion: vi.fn(),
      coderExecute: vi.fn().mockResolvedValue(makeCoderSuccess()),
      display: vi.fn(),
    }

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(messageCounts.length).toBe(3)
    expect(messageCounts[1]).toBeGreaterThan(messageCounts[0])
    expect(messageCounts[2]).toBeGreaterThan(messageCounts[1])
  })
})

// tests/director.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runPhase } from '../src/director/director.js'
import type { DirectorDeps, ApiResponse } from '../src/director/director.js'
import type { ParsedSpec, ResolvedConfig, Phase } from '../src/shared/types.js'

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
  metadata: { context: 'A test project.', houseRulesRef: 'See house-rules.md.' },
  phases: [TEST_PHASE],
}

const TEST_CONFIG: ResolvedConfig = {
  apiKey: 'sk-test',
  defaultModel: 'claude-opus-4-20250514',
  targetRepoPath: '.',
  logLevel: 'silent',
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
    coderExecute: vi.fn().mockReturnValue({ status: 'manual', message: 'manual' }),
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

    // Step 4 call (second createMessage): user message at index 2
    // messages array is shared by reference, so use fixed index not length-1
    // [0]=user(analyze), [1]=assistant(step1), [2]=user(plan)
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
    // Verify feedback was sent
    const retryCallArgs = (deps.createMessage as ReturnType<typeof vi.fn>).mock.calls[2][0]
    const allContent = JSON.stringify(retryCallArgs.messages)
    expect(allContent).toContain('Need more detail on tests')
  })

  // J6: Steps 6-7 — calls coder stub, waits for manual confirmation
  it('calls coder stub and waits for manual confirmation', async () => {
    const deps = createHappyPathDeps()

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(deps.coderExecute).toHaveBeenCalledTimes(1)
    const askInputCalls = (deps.askInput as ReturnType<typeof vi.fn>).mock.calls
    const manualCall = askInputCalls.find((c: string[]) => c[0].includes('manual execution'))
    expect(manualCall).toBeTruthy()
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
      coderExecute: vi.fn().mockReturnValue({ status: 'manual', message: 'manual' }),
      display: vi.fn(),
    }

    await runPhase(TEST_SPEC, TEST_PHASE, TEST_CONFIG, 'spec.md', deps)

    expect(messageCounts.length).toBe(3)
    expect(messageCounts[1]).toBeGreaterThan(messageCounts[0])
    expect(messageCounts[2]).toBeGreaterThan(messageCounts[1])
  })
})

// src/director/director.ts
import type { ParsedSpec, Phase, PhaseStatus, ResolvedConfig, DirectorAction, CoderResult } from '../shared/types.js'
import { WorkflowStep } from '../shared/types.js'
import { buildSystemPrompt, buildStepMessage, getDirectorTools, type DirectorTool } from './prompt-builder.js'
import { selectModel } from './model-selector.js'
import { createLogger } from '../shared/logger.js'

export interface ContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

export interface ApiResponse {
  content: ContentBlock[]
  stop_reason: string
}

export type CreateMessageFn = (params: {
  model: string
  system: string
  messages: Array<{ role: string; content: unknown }>
  tools: DirectorTool[]
  max_tokens: number
}) => Promise<ApiResponse>

export interface DirectorDeps {
  createMessage: CreateMessageFn
  askApproval: () => Promise<{ approved: boolean; feedback?: string }>
  askInput: (prompt: string) => Promise<string>
  updatePhaseStatus: (filePath: string, phaseNumber: number, status: PhaseStatus) => void
  writePhaseCompletion: (filePath: string, phaseNumber: number, doneSummary: string) => void
  coderExecute: () => CoderResult
  display: (text: string) => void
}

type Message = { role: 'user' | 'assistant'; content: unknown }

const MAX_REJECTIONS = 3

export async function runPhase(
  parsedSpec: ParsedSpec,
  phase: Phase,
  config: ResolvedConfig,
  specFilePath: string,
  deps: DirectorDeps
): Promise<void> {
  const logger = createLogger(config.logLevel)
  const completedPhases = parsedSpec.phases.filter(p => p.status === 'done')
  const system = buildSystemPrompt(parsedSpec.metadata, completedPhases)
  const tools = getDirectorTools()
  const messages: Message[] = []

  deps.updatePhaseStatus(specFilePath, phase.number, 'in-progress')

  // Step 1: Analyze
  logger.info({ phase: phase.number }, 'Step 1: Analyzing phase spec')
  const analyzeAction = await sendStep(
    messages, system, tools, deps,
    buildStepMessage(WorkflowStep.Analyze, phase),
    WorkflowStep.Analyze
  )

  // Step 2: Clarify
  if (analyzeAction.action === 'ask_human' && analyzeAction.questions?.length) {
    logger.info({ count: analyzeAction.questions.length }, 'Step 2: Clarifying with human')
    const answers: string[] = []
    for (const q of analyzeAction.questions) {
      answers.push(await deps.askInput(`Director asks: ${q}\nYour answer: `))
    }
    const clarification = analyzeAction.questions
      .map((q, i) => `Q: ${q}\nA: ${answers[i]}`)
      .join('\n\n')
    await sendStep(
      messages, system, tools, deps,
      `Human provided these clarifications:\n\n${clarification}`,
      WorkflowStep.Clarify
    )
  }

  // Step 3: Clarifications captured in conversation context (Phase 0: no Coder to edit files)
  logger.info('Step 3: Clarifications captured in conversation context')

  // Step 4: Plan
  logger.info('Step 4: Requesting implementation plan')
  const planAction = await sendStep(
    messages, system, tools, deps,
    buildStepMessage(WorkflowStep.Plan, phase),
    WorkflowStep.Plan
  )

  // Step 5: Approve plan (with rejection loop)
  let rejectionCount = 0
  let currentPlan = planAction.message
  while (true) {
    deps.display(`\n=== Director's Plan ===\n${currentPlan}\n======================`)
    const { approved, feedback } = await deps.askApproval()
    if (approved) break

    rejectionCount++
    if (rejectionCount >= MAX_REJECTIONS) {
      logger.warn({ rejectionCount }, 'Escalating after repeated rejections')
      const guidance = await deps.askInput(
        `I'm stuck after ${rejectionCount} plan rejections. Latest feedback: "${feedback}"\n` +
        'Please provide guidance on how to proceed: '
      )
      rejectionCount = 0
      const fixAction = await sendStep(
        messages, system, tools, deps,
        `Human escalation. Guidance: ${guidance}\nPlease revise the plan.`,
        WorkflowStep.ApprovePlan
      )
      currentPlan = fixAction.message
    } else {
      const fixAction = await sendStep(
        messages, system, tools, deps,
        `Plan rejected. Feedback: ${feedback}\nPlease revise the plan.`,
        WorkflowStep.ApprovePlan
      )
      currentPlan = fixAction.message
    }
  }

  // Steps 6-7: Manual execution (Phase 0 stub)
  logger.info('Steps 6-7: Coder integration not yet available')
  deps.coderExecute()
  await deps.askInput(
    'Coder integration not yet available — manual execution required.\n' +
    'Implement the plan, then press Enter to continue: '
  )

  // Step 8: Complete
  logger.info('Step 8: Completing phase')
  const completeAction = await sendStep(
    messages, system, tools, deps,
    buildStepMessage(WorkflowStep.Complete, phase),
    WorkflowStep.Complete
  )
  deps.writePhaseCompletion(specFilePath, phase.number, completeAction.message)
}

async function sendStep(
  messages: Message[],
  system: string,
  tools: DirectorTool[],
  deps: DirectorDeps,
  userContent: string,
  step: WorkflowStep
): Promise<DirectorAction> {
  const model = selectModel(step, 'high')

  const lastMsg = messages[messages.length - 1]
  if (lastMsg?.role === 'assistant' && Array.isArray(lastMsg.content)) {
    const toolUse = (lastMsg.content as ContentBlock[]).find(b => b.type === 'tool_use')
    if (toolUse?.id) {
      messages.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUse.id, content: 'Acknowledged.' },
          { type: 'text', text: userContent },
        ]
      })
    } else {
      messages.push({ role: 'user', content: userContent })
    }
  } else {
    messages.push({ role: 'user', content: userContent })
  }

  const response = await deps.createMessage({
    model,
    system,
    messages,
    tools,
    max_tokens: 4096,
  })

  messages.push({ role: 'assistant', content: response.content })
  return extractAction(response)
}

function extractAction(response: ApiResponse): DirectorAction {
  const toolUse = response.content.find(
    b => b.type === 'tool_use' && b.name === 'director_action'
  )
  if (!toolUse?.input) {
    throw new Error('Director did not respond with a director_action tool use')
  }
  return toolUse.input as unknown as DirectorAction
}

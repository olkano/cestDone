// src/director/director.ts
import type { ParsedSpec, Phase, PhaseStatus, ResolvedConfig, DirectorAction, CoderResult, CoderOptions } from '../shared/types.js'
import { WorkflowStep } from '../shared/types.js'
import { buildSystemPrompt, buildStepMessage, getDirectorTools, type DirectorTool } from './prompt-builder.js'
import { selectModel } from './model-selector.js'
import { createLogger } from '../shared/logger.js'
import type pino from 'pino'

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
  coderExecute: (options: CoderOptions) => Promise<CoderResult>
  display: (text: string) => void
}

type Message = { role: 'user' | 'assistant'; content: unknown }

const MAX_REJECTIONS = 3
const MAX_CODER_RETRIES = 3

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
    WorkflowStep.Analyze, logger
  )

  // Step 2: Clarify
  let hadClarifications = false
  if (analyzeAction.action === 'ask_human' && analyzeAction.questions?.length) {
    hadClarifications = true
    logger.info({ questions: analyzeAction.questions }, 'Escalating to human')
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
      WorkflowStep.Clarify, logger
    )
  }

  // Step 3: Update spec via Coder (if there were clarifications)
  if (hadClarifications) {
    logger.info('Step 3: Updating spec with clarifications via Coder')
    const updateAction = await sendStep(
      messages, system, tools, deps,
      buildStepMessage(WorkflowStep.UpdateSpec, phase),
      WorkflowStep.UpdateSpec, logger
    )
    await deps.coderExecute(buildCoderOptions({
      step: WorkflowStep.UpdateSpec,
      phase,
      config,
      parsedSpec,
      instructions: updateAction.message,
    }))
  } else {
    logger.info('Step 3: No clarifications — skipping spec update')
  }

  // Step 4: Plan
  logger.info('Step 4: Requesting implementation plan')
  const planAction = await sendStep(
    messages, system, tools, deps,
    buildStepMessage(WorkflowStep.Plan, phase),
    WorkflowStep.Plan, logger
  )

  // Step 5: Approve plan (with rejection loop)
  let rejectionCount = 0
  let currentPlan = planAction.message
  while (true) {
    deps.display(`\n=== Director's Plan ===\n${currentPlan}\n======================`)
    const { approved, feedback } = await deps.askApproval()
    logger.info({ approved, feedback }, 'Human approval result')
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
        WorkflowStep.ApprovePlan, logger
      )
      currentPlan = fixAction.message
    } else {
      const fixAction = await sendStep(
        messages, system, tools, deps,
        `Plan rejected. Feedback: ${feedback}\nPlease revise the plan.`,
        WorkflowStep.ApprovePlan, logger
      )
      currentPlan = fixAction.message
    }
  }

  // Steps 6-7: Execute → Review loop
  let coderRetries = 0
  let totalCoderCost = 0
  let instructions = currentPlan

  while (true) {
    // Step 6: Execute
    logger.info({ attempt: coderRetries + 1 }, 'Step 6: Executing via Coder')
    const coderResult = await deps.coderExecute(buildCoderOptions({
      step: WorkflowStep.Execute,
      phase,
      config,
      parsedSpec,
      instructions,
    }))
    totalCoderCost += coderResult.cost

    // Display Coder summary
    const summary = coderResult.report?.summary ?? coderResult.message
    deps.display(`\nCoder: ${summary} (cost: $${coderResult.cost.toFixed(2)})`)
    logger.info({ status: coderResult.status, cost: coderResult.cost, totalCost: totalCoderCost }, 'Coder result')

    // Step 7: Review
    if (coderResult.status === 'success') {
      deps.display(`\nTotal Coder cost: $${totalCoderCost.toFixed(2)}`)
      logger.info({ totalCost: totalCoderCost }, 'Coder succeeded')
      break
    }

    coderRetries++
    if (coderRetries >= MAX_CODER_RETRIES) {
      logger.warn({ coderRetries }, 'Escalating after repeated Coder failures')
      const guidance = await deps.askInput(
        `Coder has failed ${coderRetries} times. Latest error: "${coderResult.message}"\n` +
        'Please provide guidance on how to proceed: '
      )
      coderRetries = 0
      instructions = `Human guidance: ${guidance}\nPrevious error: ${coderResult.message}\nPlease fix the issues and try again.`
    } else {
      // Ask Director to review and formulate fix instructions
      const reviewAction = await sendStep(
        messages, system, tools, deps,
        `Coder returned status: ${coderResult.status}.\nError: ${coderResult.message}\n` +
        `Test results: ${coderResult.report?.testResults ?? 'N/A'}\n` +
        'Please provide fix instructions for the next attempt.',
        WorkflowStep.Review, logger
      )
      instructions = reviewAction.message
    }
  }

  // Step 8: Complete
  logger.info('Step 8: Completing phase')
  const completeAction = await sendStep(
    messages, system, tools, deps,
    buildStepMessage(WorkflowStep.Complete, phase),
    WorkflowStep.Complete, logger
  )
  deps.writePhaseCompletion(specFilePath, phase.number, completeAction.message)
}

function buildCoderOptions(params: {
  step: WorkflowStep
  phase: Phase
  config: ResolvedConfig
  parsedSpec: ParsedSpec
  instructions: string
}): CoderOptions {
  return {
    step: params.step,
    phase: params.phase,
    model: selectModel(params.step, 'high'),
    targetRepoPath: params.config.targetRepoPath,
    houseRulesContent: params.parsedSpec.metadata.houseRulesContent ?? '',
    instructions: params.instructions,
    maxTurns: params.config.maxTurns,
    maxBudgetUsd: params.config.maxBudgetUsd,
    apiKey: params.config.apiKey,
    logLevel: params.config.logLevel,
  }
}

async function sendStep(
  messages: Message[],
  system: string,
  tools: DirectorTool[],
  deps: DirectorDeps,
  userContent: string,
  step: WorkflowStep,
  logger: pino.Logger
): Promise<DirectorAction> {
  const model = selectModel(step, 'high')

  logger.debug({ userContent }, 'User message to Director')

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

  logger.debug({ step, model, messageCount: messages.length }, 'Sending to Claude API')

  const response = await deps.createMessage({
    model,
    system,
    messages,
    tools,
    max_tokens: 4096,
  })

  messages.push({ role: 'assistant', content: response.content })
  const action = extractAction(response)

  logger.debug({ action, stopReason: response.stop_reason }, 'Director response')

  return action
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

// src/director/director.ts
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { ParsedSpec, Phase, PhaseStatus, ResolvedConfig, DirectorResponse, CoderResult, CoderOptions, SpecMetadata } from '../shared/types.js'
import { WorkflowStep } from '../shared/types.js'
import {
  buildDirectorSystemPrompt,
  buildDirectorTools,
  buildAnalyzePrompt,
  buildClarifyPrompt,
  buildUpdateSpecPrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  buildCompletePrompt,
  DIRECTOR_RESPONSE_SCHEMA,
} from './prompts.js'
import { selectModel } from './model-selector.js'
import { createLogger } from '../shared/logger.js'
import type pino from 'pino'

export interface DirectorDeps {
  askApproval: () => Promise<{ approved: boolean; feedback?: string }>
  askInput: (prompt: string) => Promise<string>
  updatePhaseStatus: (filePath: string, phaseNumber: number, status: PhaseStatus) => void
  writePhaseCompletion: (filePath: string, phaseNumber: number, doneSummary: string) => void
  coderExecute: (options: CoderOptions) => Promise<CoderResult>
  display: (text: string) => void
}

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
  const specContent = phase.spec

  deps.updatePhaseStatus(specFilePath, phase.number, 'in-progress')

  // Step 1: Analyze
  logger.info({ phase: phase.number }, 'Step 1: Analyzing phase spec')
  const analyzeResult = await executeDirector({
    prompt: buildAnalyzePrompt(phase, specContent),
    step: WorkflowStep.Analyze,
    metadata: parsedSpec.metadata,
    completedPhases,
    config,
    logger,
  })

  // Step 2: Clarify
  let hadClarifications = false
  let clarificationsText = ''
  if (analyzeResult.action === 'ask_human' && analyzeResult.questions?.length) {
    hadClarifications = true
    logger.info({ questions: analyzeResult.questions }, 'Escalating to human')
    const answers: string[] = []
    for (const q of analyzeResult.questions) {
      answers.push(await deps.askInput(`Director asks: ${q}\nYour answer: `))
    }
    clarificationsText = analyzeResult.questions
      .map((q, i) => `Q: ${q}\nA: ${answers[i]}`)
      .join('\n\n')

    await executeDirector({
      prompt: buildClarifyPrompt(analyzeResult.questions, answers),
      step: WorkflowStep.Clarify,
      metadata: parsedSpec.metadata,
      completedPhases,
      config,
      logger,
    })
  }

  // Step 3: Update spec via Coder (if there were clarifications)
  if (hadClarifications) {
    logger.info('Step 3: Updating spec with clarifications via Coder')
    const updateResult = await executeDirector({
      prompt: buildUpdateSpecPrompt(specContent, clarificationsText),
      step: WorkflowStep.UpdateSpec,
      metadata: parsedSpec.metadata,
      completedPhases,
      config,
      logger,
    })
    await deps.coderExecute(buildCoderOptions({
      step: WorkflowStep.UpdateSpec,
      phase,
      config,
      parsedSpec,
      instructions: updateResult.message,
    }))
  } else {
    logger.info('Step 3: No clarifications — skipping spec update')
  }

  // Step 4: Plan
  logger.info('Step 4: Requesting implementation plan')
  const planResult = await executeDirector({
    prompt: buildPlanPrompt(phase, specContent),
    step: WorkflowStep.Plan,
    metadata: parsedSpec.metadata,
    completedPhases,
    config,
    logger,
  })

  // Step 5: Approve plan (with rejection loop)
  let rejectionCount = 0
  let currentPlan = planResult.message
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
      const fixResult = await executeDirector({
        prompt: `Human escalation. Guidance: ${guidance}\nPrevious plan:\n${currentPlan}\nPlease revise the plan.`,
        step: WorkflowStep.ApprovePlan,
        metadata: parsedSpec.metadata,
        completedPhases,
        config,
        logger,
      })
      currentPlan = fixResult.message
    } else {
      const fixResult = await executeDirector({
        prompt: `Plan rejected. Feedback: ${feedback}\nPrevious plan:\n${currentPlan}\nPlease revise the plan.`,
        step: WorkflowStep.ApprovePlan,
        metadata: parsedSpec.metadata,
        completedPhases,
        config,
        logger,
      })
      currentPlan = fixResult.message
    }
  }

  // Steps 6-7: Execute → Review loop (with sub-phase iteration)
  let coderRetries = 0
  let totalCoderCost = 0
  let instructions = currentPlan
  const completedSubPhases: string[] = []

  while (true) {
    // Step 6: Execute
    logger.info({ attempt: coderRetries + 1, subPhase: completedSubPhases.length + 1 }, 'Step 6: Executing via Coder')
    const coderResult = await deps.coderExecute(buildCoderOptions({
      step: WorkflowStep.Execute,
      phase,
      config,
      parsedSpec,
      instructions,
      completedSubPhases: [...completedSubPhases],
    }))
    totalCoderCost += coderResult.cost

    const summary = coderResult.report?.summary ?? coderResult.message
    deps.display(`\nCoder: ${summary} (cost: $${coderResult.cost.toFixed(2)})`)
    logger.info({ status: coderResult.status, cost: coderResult.cost, totalCost: totalCoderCost }, 'Coder result')

    // Step 7: Review — always runs, Director verifies and decides next action
    logger.info('Step 7: Director reviewing Coder output')
    const reviewResult = await executeDirector({
      prompt: buildReviewPrompt(
        currentPlan,
        JSON.stringify(coderResult.report ?? { status: coderResult.status, message: coderResult.message }),
        completedSubPhases,
      ),
      step: WorkflowStep.Review,
      metadata: parsedSpec.metadata,
      completedPhases,
      config,
      logger,
    })

    if (reviewResult.action === 'done') {
      deps.display(`\nTotal Coder cost: $${totalCoderCost.toFixed(2)}`)
      logger.info({ totalCost: totalCoderCost, subPhasesCompleted: completedSubPhases.length + 1 }, 'All sub-phases complete')
      break
    }

    if (reviewResult.action === 'continue') {
      completedSubPhases.push(summary)
      coderRetries = 0
      instructions = reviewResult.message
      logger.info({ subPhasesCompleted: completedSubPhases.length }, 'Sub-phase complete, moving to next')
      deps.display(`\nSub-phase ${completedSubPhases.length} complete. Continuing...`)
      continue
    }

    // action === 'fix' (or any other) — retry with fix instructions
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
      instructions = reviewResult.message
    }
  }

  // Step 8: Complete
  logger.info('Step 8: Completing phase')
  const completeResult = await executeDirector({
    prompt: buildCompletePrompt(phase),
    step: WorkflowStep.Complete,
    metadata: parsedSpec.metadata,
    completedPhases,
    config,
    logger,
  })
  deps.writePhaseCompletion(specFilePath, phase.number, completeResult.message)
}

function buildCoderOptions(params: {
  step: WorkflowStep
  phase: Phase
  config: ResolvedConfig
  parsedSpec: ParsedSpec
  instructions: string
  completedSubPhases?: string[]
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
    completedSubPhases: params.completedSubPhases,
  }
}

interface ExecuteDirectorParams {
  prompt: string
  step: WorkflowStep
  metadata: SpecMetadata
  completedPhases: Phase[]
  config: ResolvedConfig
  logger: pino.Logger
}

export async function executeDirector(params: ExecuteDirectorParams): Promise<DirectorResponse> {
  const { prompt, step, metadata, completedPhases, config, logger } = params
  const model = selectModel(step, 'high')
  const tools = buildDirectorTools(step)

  logger.debug({ step, model, tools }, 'Director call starting')

  const env = { ...process.env }
  delete env.CLAUDECODE

  const queryOptions: Record<string, unknown> = {
    model,
    cwd: config.targetRepoPath,
    maxTurns: 15,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    tools,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: buildDirectorSystemPrompt(metadata, completedPhases),
    },
    outputFormat: {
      type: 'json_schema',
      schema: DIRECTOR_RESPONSE_SCHEMA,
    },
    env,
  }

  let response: DirectorResponse | null = null

  const q = query({ prompt, options: queryOptions as Parameters<typeof query>[0]['options'] })

  for await (const message of q) {
    const msg = message as { type: string; subtype?: string; total_cost_usd?: number; num_turns?: number; structured_output?: unknown; result?: string }

    if (msg.type === 'result') {
      logger.info(
        { subtype: msg.subtype, cost: msg.total_cost_usd, turns: msg.num_turns },
        'Director call completed'
      )
      response = extractDirectorResponse(msg)
    }
  }

  if (!response) {
    throw new Error('Director session ended with no result')
  }

  logger.debug({ action: response.action }, 'Director response')
  return response
}

function extractDirectorResponse(msg: { structured_output?: unknown; result?: string }): DirectorResponse {
  if (msg.structured_output && typeof msg.structured_output === 'object') {
    return msg.structured_output as DirectorResponse
  }

  if (msg.result) {
    try {
      const parsed = JSON.parse(msg.result) as DirectorResponse
      if (parsed.action && parsed.message) {
        return parsed
      }
    } catch {
      // Not JSON — fall through
    }

    return { action: 'analyze', message: msg.result }
  }

  throw new Error('Director produced no structured output')
}

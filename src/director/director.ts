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
import type { SessionLogger } from '../shared/logger.js'

export interface DirectorDeps {
  askApproval: () => Promise<{ approved: boolean; feedback?: string }>
  askInput: (prompt: string) => Promise<string>
  updatePhaseStatus: (filePath: string, phaseNumber: number, status: PhaseStatus) => void
  updatePhaseSpec: (filePath: string, phaseNumber: number, updatedSpec: string) => void
  writePhaseCompletion: (filePath: string, phaseNumber: number, doneSummary: string) => void
  coderExecute: (options: CoderOptions) => Promise<CoderResult>
  display: (text: string) => void
  logger: SessionLogger
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
  const { logger } = deps
  const completedPhases = parsedSpec.phases.filter(p => p.status === 'done')
  const specContent = phase.spec

  deps.updatePhaseStatus(specFilePath, phase.number, 'in-progress')

  // Step 1: Analyze
  logger.log('Director', `Step 1: Analyzing phase spec (Phase ${phase.number})`)
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
    logger.log('Director', `Escalating to human: ${analyzeResult.questions.join(', ')}`)
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

  // Step 3: Update spec (if there were clarifications)
  if (hadClarifications) {
    logger.log('Director', 'Step 3: Updating spec with clarifications')
    const updateResult = await executeDirector({
      prompt: buildUpdateSpecPrompt(specContent, clarificationsText),
      step: WorkflowStep.UpdateSpec,
      metadata: parsedSpec.metadata,
      completedPhases,
      config,
      logger,
    })
    deps.updatePhaseSpec(specFilePath, phase.number, updateResult.message)
  } else {
    logger.log('Director', 'Step 3: No clarifications — skipping spec update')
  }

  // Step 4: Plan
  logger.log('Director', 'Step 4: Requesting implementation plan')
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
    logger.log('Director', `Human approval: ${approved ? 'approved' : 'rejected'}${feedback ? ' — ' + feedback : ''}`)
    if (approved) break

    rejectionCount++
    if (rejectionCount >= MAX_REJECTIONS) {
      logger.log('Director', `Escalating after ${rejectionCount} rejections`)
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
    logger.log('Director', `Step 6: Executing via Coder (attempt ${coderRetries + 1}, sub-phase ${completedSubPhases.length + 1})`)
    const coderResult = await deps.coderExecute(buildCoderOptions({
      step: WorkflowStep.Execute,
      phase,
      config,
      parsedSpec,
      instructions,
      completedSubPhases: [...completedSubPhases],
      logger,
    }))
    totalCoderCost += coderResult.cost

    const summary = coderResult.report?.summary ?? coderResult.message
    deps.display(`\nCoder: ${summary} (cost: $${coderResult.cost.toFixed(2)})`)
    logger.log('Director', `Coder result: ${coderResult.status} (cost: $${coderResult.cost.toFixed(2)}, total: $${totalCoderCost.toFixed(2)})`)

    // Step 7: Review — always runs, Director verifies and decides next action
    logger.log('Director', 'Step 7: Reviewing Coder output')
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
      logger.log('Director', `All sub-phases complete (total cost: $${totalCoderCost.toFixed(2)}, sub-phases: ${completedSubPhases.length + 1})`)
      break
    }

    if (reviewResult.action === 'continue') {
      completedSubPhases.push(summary)
      coderRetries = 0
      instructions = reviewResult.message
      logger.log('Director', `Sub-phase ${completedSubPhases.length} complete, continuing`)
      deps.display(`\nSub-phase ${completedSubPhases.length} complete. Continuing...`)
      continue
    }

    // action === 'fix' (or any other) — retry with fix instructions
    coderRetries++
    if (coderRetries >= MAX_CODER_RETRIES) {
      logger.log('Director', `Escalating after ${coderRetries} Coder failures`)
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
  logger.log('Director', 'Step 8: Completing phase')
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
  logger: SessionLogger
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
    logger: params.logger,
    completedSubPhases: params.completedSubPhases,
  }
}

interface ExecuteDirectorParams {
  prompt: string
  step: WorkflowStep
  metadata: SpecMetadata
  completedPhases: Phase[]
  config: ResolvedConfig
  logger: SessionLogger
}

export async function executeDirector(params: ExecuteDirectorParams): Promise<DirectorResponse> {
  const { prompt, step, metadata, completedPhases, config, logger } = params
  const model = selectModel(step, 'high')
  const tools = buildDirectorTools(step)

  logger.log('Director', `Call starting (step: ${step}, model: ${model})`)
  logger.logVerbose('Director', `Prompt:\n${prompt}`)

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
    const msg = message as { type: string; subtype?: string; total_cost_usd?: number; num_turns?: number; structured_output?: unknown; result?: string; message?: { content?: Array<{ type: string; text?: string }> } }

    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          logger.log('Director', block.text.slice(0, 500))
        }
      }
    }

    if (msg.type === 'result') {
      logger.log('Director', `Call completed (cost: $${msg.total_cost_usd?.toFixed(2)}, turns: ${msg.num_turns})`)
      response = extractDirectorResponse(msg)
    }
  }

  if (!response) {
    throw new Error('Director session ended with no result')
  }

  logger.log('Director', `Response action: ${response.action}`)
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

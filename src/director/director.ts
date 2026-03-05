// src/director/director.ts
import type { Phase, PhaseStatus, Config, DirectorResponse, CoderResult, CoderOptions, FreeFormSpec, Plan, TokenUsage, Backend, BackendResult } from '../shared/types.js'
import { WorkflowStep } from '../shared/types.js'
import { CostTracker, formatTotals } from '../shared/cost-tracker.js'
import {
  buildDirectorTools,
  buildClarifyPrompt,
  buildInitialCoderInstructions,
  buildReviewPrompt,
  buildCompletePrompt,
  buildDirectorExecutionPrompt,
  buildPlanningSystemPrompt,
  buildFreeFormAnalyzePrompt,
  buildCreatePlanPrompt,
  buildRevisePlanPrompt,
  buildExecutionSystemPrompt,
  DIRECTOR_RESPONSE_SCHEMA,
} from './prompts.js'
import { getDirectorModel, getCoderModel } from './model-selector.js'
import { parsePlan, getPlanPath } from '../shared/plan-parser.js'
import { detectEnvironment } from '../shared/environment.js'
import { DEFAULTS } from '../shared/config.js'
import type { SessionLogger } from '../shared/logger.js'

export interface DirectorDeps {
  askApproval: () => Promise<{ approved: boolean; feedback?: string }>
  askInput: (prompt: string) => Promise<string>
  createPlanFile: (planPath: string, content: string) => void
  updatePhaseStatus: (filePath: string, phaseNumber: number, status: PhaseStatus) => void
  writePhaseCompletion: (filePath: string, phaseNumber: number, doneSummary: string) => void
  coderExecute: (options: CoderOptions) => Promise<CoderResult>
  display: (text: string) => void
  logger: SessionLogger
  costTracker: CostTracker
  backend: Backend
  coderBackend: Backend
}

const MAX_REJECTIONS = DEFAULTS.maxRejections
const MAX_CODER_RETRIES = DEFAULTS.maxCoderRetries

export interface DirectorCallResult {
  response: DirectorResponse
  costUsd: number
  numTurns: number
  durationMs: number
  usage: TokenUsage
  sessionId: string
}

function recordDirectorCall(deps: DirectorDeps, result: DirectorCallResult): DirectorResponse {
  deps.costTracker.recordDirector({
    costUsd: result.costUsd,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadInputTokens: result.usage.cacheReadInputTokens,
    cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
  })
  deps.logger.log('Session', formatTotals(deps.costTracker))
  return result.response
}

// === Planning flow ===

export async function runPlanningFlow(
  spec: FreeFormSpec,
  config: Config,
  deps: DirectorDeps
): Promise<{ planPath: string; plan: Plan; sessionId: string }> {
  const { logger } = deps
  const env = detectEnvironment(config.targetRepoPath)
  const systemPromptText = buildPlanningSystemPrompt(spec, env)

  // Step 1: Analyze free-form spec — first call creates the Director session
  logger.log('Director', 'Planning: Analyzing free-form spec')
  const analyzeCallResult = await executeDirector({
    prompt: buildFreeFormAnalyzePrompt(spec),
    step: WorkflowStep.Analyze,
    systemPromptText,
    config,
    logger,
    backend: deps.backend,
  })
  const analyzeResult = recordDirectorCall(deps, analyzeCallResult)
  let sessionId = analyzeCallResult.sessionId

  // Step 2: Clarify (iterative — ask follow-ups until Director is satisfied)
  let clarificationsText = ''
  let pendingQuestions = analyzeResult.action === 'ask_human' ? (analyzeResult.questions ?? []) : []
  const MAX_CLARIFY_ROUNDS = DEFAULTS.maxClarifyRounds

  for (let round = 0; round < MAX_CLARIFY_ROUNDS && pendingQuestions.length > 0; round++) {
    logger.log('Director', `Planning: Clarify round ${round + 1} — ${pendingQuestions.length} questions`)
    const answers: string[] = []
    for (const q of pendingQuestions) {
      answers.push(await deps.askInput(`Director asks: ${q}\nYour answer: `))
    }
    clarificationsText += (clarificationsText ? '\n\n' : '') +
      pendingQuestions.map((q, i) => `Q: ${q}\nA: ${answers[i]}`).join('\n\n')

    const clarifyCallResult = await executeDirector({
      prompt: buildClarifyPrompt(pendingQuestions, answers),
      step: WorkflowStep.Clarify,
      systemPromptText,
      config,
      logger,
      backend: deps.backend,
      resume: sessionId,
    })
    const clarifyResult = recordDirectorCall(deps, clarifyCallResult)
    sessionId = clarifyCallResult.sessionId || sessionId

    // If Director has follow-up questions, loop; otherwise proceed
    if (clarifyResult.action === 'ask_human' && clarifyResult.questions?.length) {
      pendingQuestions = clarifyResult.questions
    } else {
      pendingQuestions = []
    }
  }

  // Step 3: Create plan
  logger.log('Director', 'Planning: Creating structured plan')
  const createCallResult = await executeDirector({
    prompt: buildCreatePlanPrompt(spec, clarificationsText),
    step: WorkflowStep.CreatePlan,
    systemPromptText,
    config,
    logger,
    backend: deps.backend,
    resume: sessionId,
  })
  const createResult = recordDirectorCall(deps, createCallResult)
  sessionId = createCallResult.sessionId || sessionId

  // Validate plan format + optional human approval
  const needsApproval = config.withHumanValidation !== false
  let rejectionCount = 0
  let currentPlanContent = createResult.message

  while (true) {
    // Validate plan parses correctly (always — even without human validation)
    try {
      parsePlan(currentPlanContent)
    } catch (err) {
      logger.log('Director', `Plan format invalid: ${(err as Error).message}. Asking Director to fix.`)
      const fixCallResult = await executeDirector({
        prompt: `The plan you produced has a format error: ${(err as Error).message}\n\nPlease fix it and return the corrected plan in your message field.\n\nOriginal plan:\n${currentPlanContent}`,
        step: WorkflowStep.CreatePlan,
        systemPromptText,
        config,
        logger,
        backend: deps.backend,
        resume: sessionId,
      })
      const fixResult = recordDirectorCall(deps, fixCallResult)
      sessionId = fixCallResult.sessionId || sessionId
      currentPlanContent = fixResult.message
      continue
    }

    // Plan format is valid — skip human approval if not requested
    if (!needsApproval) break

    deps.display(`\n=== Director's Plan ===\n${currentPlanContent}\n======================`)
    const { approved, feedback } = await deps.askApproval()
    logger.log('Director', `Plan approval: ${approved ? 'approved' : 'feedback received'}${feedback ? ' — ' + feedback : ''}`)
    if (approved) break

    rejectionCount++
    if (rejectionCount >= MAX_REJECTIONS) {
      logger.log('Director', `Escalating after ${rejectionCount} plan rejections`)
      const guidance = await deps.askInput(
        `I'm stuck after ${rejectionCount} plan rejections. Latest feedback: "${feedback}"\n` +
        'Please provide guidance on how to proceed: '
      )
      rejectionCount = 0
      const escCallResult = await executeDirector({
        prompt: `Human escalation. Guidance: ${guidance}\nPrevious plan:\n${currentPlanContent}\nPlease revise the plan.`,
        step: WorkflowStep.CreatePlan,
        systemPromptText,
        config,
        logger,
        backend: deps.backend,
        resume: sessionId,
      })
      const escResult = recordDirectorCall(deps, escCallResult)
      sessionId = escCallResult.sessionId || sessionId
      currentPlanContent = escResult.message
    } else {
      const revCallResult = await executeDirector({
        prompt: buildRevisePlanPrompt(currentPlanContent, feedback ?? ''),
        step: WorkflowStep.CreatePlan,
        systemPromptText,
        config,
        logger,
        backend: deps.backend,
        resume: sessionId,
      })
      const revResult = recordDirectorCall(deps, revCallResult)
      sessionId = revCallResult.sessionId || sessionId
      currentPlanContent = revResult.message
    }
  }

  // Write plan file
  const planPath = getPlanPath(spec.specFilePath)
  deps.createPlanFile(planPath, currentPlanContent)
  const plan = parsePlan(currentPlanContent)
  logger.log('Director', `Plan written to ${planPath} with ${plan.phases.length} phases`)

  return { planPath, plan, sessionId }
}

// === Phase execution flow ===

export async function runPhase(
  plan: Plan,
  phase: Phase,
  config: Config,
  planFilePath: string,
  deps: DirectorDeps,
  sessionId?: string
): Promise<string> {
  const { logger } = deps
  const completedPhases = plan.phases.filter(p => p.status === 'done')
  const env = detectEnvironment(config.targetRepoPath)
  const systemPromptText = buildExecutionSystemPrompt(plan, completedPhases, env)

  deps.updatePhaseStatus(planFilePath, phase.number, 'in-progress')

  const usesCoder = config.withCoder !== false // undefined (legacy) = true

  if (usesCoder) {
    sessionId = await executeTwoAgentPhase(plan, phase, config, systemPromptText, env, deps, completedPhases, sessionId)
  } else {
    sessionId = await executeDirectorOnlyPhase(plan, phase, config, systemPromptText, env, deps, completedPhases, sessionId)
  }

  // Step 8: Complete
  logger.log('Director', 'Step 8: Completing phase')
  const completeCallResult = await executeDirector({
    prompt: buildCompletePrompt(phase),
    step: WorkflowStep.Complete,
    systemPromptText,
    config,
    logger,
    backend: deps.backend,
    resume: sessionId,
  })
  const completeResult = recordDirectorCall(deps, completeCallResult)
  sessionId = completeCallResult.sessionId || sessionId
  deps.writePhaseCompletion(planFilePath, phase.number, completeResult.message)

  return sessionId!
}

async function executeTwoAgentPhase(
  plan: Plan, phase: Phase, config: Config, systemPromptText: string,
  env: ReturnType<typeof detectEnvironment>, deps: DirectorDeps,
  completedPhases: Phase[], sessionId?: string,
): Promise<string> {
  const { logger } = deps
  const shouldReview = config.withReviews !== false
  const reviewTools = buildDirectorTools(WorkflowStep.Review, { withBash: config.withBashReviews !== false })
  let instructions = buildInitialCoderInstructions(plan, phase, completedPhases, env)
  let coderRetries = 0
  let totalCoderCost = 0
  const completedSubPhases: string[] = []

  while (true) {
    logger.log('Director', `Executing via Coder (attempt ${coderRetries + 1}, sub-phase ${completedSubPhases.length + 1})`)
    const coderResult = await deps.coderExecute(buildCoderOptions({
      step: WorkflowStep.Execute,
      phase,
      config,
      houseRulesContent: phase.applicableRules || plan.houseRules,
      instructions,
      completedSubPhases: [...completedSubPhases],
      logger,
      backend: deps.coderBackend,
    }))
    totalCoderCost += coderResult.cost
    deps.costTracker.recordCoder({
      costUsd: coderResult.cost,
      inputTokens: coderResult.usage.inputTokens,
      outputTokens: coderResult.usage.outputTokens,
      cacheReadInputTokens: coderResult.usage.cacheReadInputTokens,
      cacheCreationInputTokens: coderResult.usage.cacheCreationInputTokens,
    })
    logger.log('Session', formatTotals(deps.costTracker))

    const summary = coderResult.report?.summary ?? coderResult.message
    deps.display(`\nCoder: ${summary} (cost: $${coderResult.cost.toFixed(2)})`)
    logger.log('Director', `Coder result: ${coderResult.status} (cost: $${coderResult.cost.toFixed(2)}, total: $${totalCoderCost.toFixed(2)})`)
    logger.logVerbose('Director', `Coder report: ${JSON.stringify(coderResult.report)}`)

    if (!shouldReview) {
      deps.display(`\nTotal Coder cost: $${totalCoderCost.toFixed(2)}`)
      break
    }

    logger.log('Director', `Reviewing Coder output for Phase ${phase.number} (${phase.name})`)
    logger.logVerbose('Director', `Review state: completedSubPhases=${completedSubPhases.length}, coderRetries=${coderRetries}`)
    const reviewPrompt = buildReviewPrompt(
      phase.number, phase.name, phase.spec,
      JSON.stringify(coderResult.report ?? { status: coderResult.status, message: coderResult.message }),
      completedSubPhases,
    )

    let reviewResult: DirectorResponse
    try {
      const reviewCallResult = await executeDirector({
        prompt: reviewPrompt,
        step: WorkflowStep.Review,
        systemPromptText,
        config,
        logger,
        backend: deps.backend,
        resume: sessionId,
        toolsOverride: reviewTools,
      })
      reviewResult = recordDirectorCall(deps, reviewCallResult)
      sessionId = reviewCallResult.sessionId || sessionId
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      logger.log('Director', `Review call crashed: ${errorMessage}`)
      throw err
    }

    logger.log('Director', `Review decision: action=${reviewResult.action}`)

    if (reviewResult.action === 'continue') {
      completedSubPhases.push(summary)
      coderRetries = 0
      instructions = reviewResult.message
      logger.log('Director', `Sub-phase ${completedSubPhases.length} complete within Phase ${phase.number}, continuing`)
      deps.display(`\nSub-phase ${completedSubPhases.length} complete. Continuing...`)
      continue
    }

    if (reviewResult.action === 'fix') {
      logger.log('Director', `Review returned 'fix' (retry ${coderRetries + 1}/${MAX_CODER_RETRIES})`)
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
      continue
    }

    // Any other action (done, analyze, approve, etc.) means phase is complete
    if (reviewResult.action !== 'done') {
      logger.log('Director', `Review returned '${reviewResult.action}' — treating as done`)
    }
    deps.display(`\nTotal Coder cost: $${totalCoderCost.toFixed(2)}`)
    logger.log('Director', `Phase ${phase.number} done (total cost: $${totalCoderCost.toFixed(2)}, sub-phases: ${completedSubPhases.length + 1})`)
    break
  }

  return sessionId!
}

async function executeDirectorOnlyPhase(
  plan: Plan, phase: Phase, config: Config, systemPromptText: string,
  env: ReturnType<typeof detectEnvironment>, deps: DirectorDeps,
  completedPhases: Phase[], sessionId?: string,
): Promise<string> {
  const { logger } = deps
  const execPrompt = buildDirectorExecutionPrompt(plan, phase, completedPhases, env)
  const execTools = buildDirectorTools(WorkflowStep.Execute, { directorOnly: true })

  logger.log('Director', `Executing Phase ${phase.number} directly (director-only mode)`)
  const execResult = await executeDirector({
    prompt: execPrompt,
    step: WorkflowStep.Execute,
    systemPromptText,
    config,
    logger,
    backend: deps.backend,
    resume: sessionId,
    toolsOverride: execTools,
    maxTurnsOverride: config.maxTurns,
  })
  const directorResult = recordDirectorCall(deps, execResult)
  sessionId = execResult.sessionId || sessionId
  deps.display(`\nDirector: ${directorResult.message.slice(0, 200)}`)

  return sessionId!
}

function buildCoderOptions(params: {
  step: WorkflowStep
  phase: Phase
  config: Config
  houseRulesContent: string
  instructions: string
  completedSubPhases?: string[]
  logger: SessionLogger
  backend: Backend
}): CoderOptions {
  return {
    step: params.step,
    phase: params.phase,
    model: getCoderModel(params.config.coderModel),
    targetRepoPath: params.config.targetRepoPath,
    houseRulesContent: params.houseRulesContent,
    instructions: params.instructions,
    maxTurns: params.config.maxTurns,
    maxBudgetUsd: params.config.maxBudgetUsd,
    logger: params.logger,
    completedSubPhases: params.completedSubPhases,
    backend: params.backend,
  }
}

function getDirectorMaxTurns(step: WorkflowStep): number {
  if (step === WorkflowStep.Review) return DEFAULTS.directorMaxTurnsReview
  return DEFAULTS.directorMaxTurnsDefault
}

interface ExecuteDirectorParams {
  prompt: string
  step: WorkflowStep
  systemPromptText: string
  config: Config
  logger: SessionLogger
  backend: Backend
  resume?: string
  toolsOverride?: string[]
  maxTurnsOverride?: number
}

export async function executeDirector(params: ExecuteDirectorParams): Promise<DirectorCallResult> {
  const { prompt, step, systemPromptText, config, logger, backend } = params
  const model = getDirectorModel(config.directorModel)
  const tools = params.toolsOverride ?? buildDirectorTools(step)
  const maxTurns = params.maxTurnsOverride ?? getDirectorMaxTurns(step)

  logger.log('Director', `Call starting (step: ${step}, model: ${model}, maxTurns: ${maxTurns})`)
  logger.logVerbose('Director', `Prompt:\n${prompt}`)

  const result = await backend.invoke({
    prompt,
    systemPrompt: params.resume ? undefined : systemPromptText,
    model,
    tools,
    outputSchema: DIRECTOR_RESPONSE_SCHEMA,
    cwd: config.targetRepoPath,
    maxTurns,
    resumeSessionId: params.resume,
    env: { ...process.env },
    logger,
  })

  logger.log('Director', `Call completed (cost: $${(result.costUsd ?? 0).toFixed(2)}, turns: ${result.numTurns}, success: ${result.success})`)
  logger.log('Director', `Tokens: in:${result.usage.inputTokens} out:${result.usage.outputTokens} cache-r:${result.usage.cacheReadInputTokens} cache-w:${result.usage.cacheCreationInputTokens}`)

  if (!result.success) {
    throw new Error(result.errorMessage ?? `Director session failed: ${result.rawText?.slice(0, 200) ?? 'no output'}`)
  }

  const response = extractDirectorResponse(result, logger)
  logger.log('Director', `Response action: ${response.action}`)

  return {
    response,
    costUsd: result.costUsd ?? 0,
    numTurns: result.numTurns,
    durationMs: result.durationMs,
    usage: result.usage,
    sessionId: result.sessionId ?? '',
  }
}

function extractDirectorResponse(result: BackendResult, logger: SessionLogger): DirectorResponse {
  const hasOutput = result.output !== undefined && result.output !== null
  logger.logVerbose('Director', `extractDirectorResponse: success=${result.success}, has_output=${hasOutput}, has_rawText=${!!result.rawText}`)

  if (hasOutput && typeof result.output === 'object') {
    const so = result.output as Record<string, unknown>
    if (so.action && so.message) {
      logger.logVerbose('Director', `Using output: action=${so.action}, message_length=${(so.message as string)?.length ?? 0}`)
      return result.output as DirectorResponse
    }
  }

  if (result.rawText) {
    try {
      const parsed = JSON.parse(result.rawText) as DirectorResponse
      if (parsed.action && parsed.message) {
        logger.logVerbose('Director', `Parsed rawText as JSON: action=${parsed.action}`)
        return parsed
      }
    } catch {
      // Not JSON — fall through
    }

    return { action: 'analyze', message: result.rawText }
  }

  const reason = result.errorMessage ?? 'unknown'
  logger.log('Director', `WARNING: No structured output produced (reason: ${reason}). Defaulting to 'done'.`)
  return {
    action: 'done',
    message: `Director review completed without structured response (reason: ${reason}). Proceeding based on Coder self-report.`,
  }
}

// src/director/director.ts
import path from 'node:path'
import type { Phase, PhaseStatus, Config, DirectorResponse, WorkerResult, WorkerOptions, FreeFormSpec, Plan, TokenUsage, Backend, BackendResult } from '../shared/types.js'
import { WorkflowStep } from '../shared/types.js'
import { CostTracker, formatTotals } from '../shared/cost-tracker.js'
import {
  buildDirectorTools,
  buildInitialWorkerInstructions,
  buildReviewPrompt,
  buildCompletePrompt,
  buildDirectorExecutionPrompt,
  buildPlanningWorkerPrompt,
  buildPlanRevisionWorkerPrompt,
  buildExecutionSystemPrompt,
  DIRECTOR_RESPONSE_SCHEMA,
} from './prompts.js'
import { getDirectorModel, getWorkerModel } from './model-selector.js'
import { parsePlan, getPlanPath } from '../shared/plan-parser.js'
import { detectEnvironment } from '../shared/environment.js'
import { DEFAULTS } from '../shared/config.js'
import type { SessionLogger } from '../shared/logger.js'

export interface DirectorDeps {
  askApproval: () => Promise<{ approved: boolean; feedback?: string }>
  askInput: (prompt: string) => Promise<string>
  createPlanFile: (planPath: string, content: string) => void
  readFile: (path: string) => string
  updatePhaseStatus: (filePath: string, phaseNumber: number, status: PhaseStatus) => void
  writePhaseCompletion: (filePath: string, phaseNumber: number, doneSummary: string) => void
  workerExecute: (options: WorkerOptions) => Promise<WorkerResult>
  display: (text: string) => void
  logger: SessionLogger
  costTracker: CostTracker
  backend: Backend
  workerBackend: Backend
}

const MAX_REJECTIONS = DEFAULTS.maxRejections
const MAX_WORKER_RETRIES = DEFAULTS.maxWorkerRetries

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
): Promise<{ planPath: string; plan: Plan }> {
  const { logger } = deps
  const planPath = getPlanPath(spec.specFilePath)
  const env = detectEnvironment(config.targetRepoPath)

  // Delegate planning to a Worker
  logger.log('Director', 'Planning: Spawning Planning Worker')
  const rawPrompt = buildPlanningWorkerPrompt(spec, env, planPath)
  const syntheticPhase: Phase = { number: 0, name: 'Planning', status: 'in-progress', spec: spec.text, applicableRules: '', done: '' }

  const planningResult = await deps.workerExecute({
    step: WorkflowStep.Plan,
    phase: syntheticPhase,
    model: getWorkerModel(config.workerModel),
    targetRepoPath: config.targetRepoPath,
    houseRulesContent: spec.houseRulesContent,
    instructions: '',
    rawPrompt,
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    logger,
    backend: deps.workerBackend,
  })

  deps.costTracker.recordWorker({
    costUsd: planningResult.cost,
    inputTokens: planningResult.usage.inputTokens,
    outputTokens: planningResult.usage.outputTokens,
    cacheReadInputTokens: planningResult.usage.cacheReadInputTokens,
    cacheCreationInputTokens: planningResult.usage.cacheCreationInputTokens,
  })
  logger.log('Session', formatTotals(deps.costTracker))
  logger.log('Director', `Planning Worker completed (cost: $${planningResult.cost.toFixed(2)})`)

  // Read plan from disk — Worker should have written it
  let currentPlanContent: string
  try {
    currentPlanContent = deps.readFile(planPath)
  } catch {
    throw new Error(`Planning Worker did not write plan file at ${planPath}`)
  }

  // Validate plan format, retry with Revision Worker if invalid
  const MAX_PLAN_FIX_ATTEMPTS = 3
  let planFixAttempts = 0

  while (true) {
    try {
      parsePlan(currentPlanContent)
      break
    } catch (err) {
      planFixAttempts++
      if (planFixAttempts > MAX_PLAN_FIX_ATTEMPTS) {
        throw new Error(`Plan format still invalid after ${MAX_PLAN_FIX_ATTEMPTS} fix attempts: ${(err as Error).message}\n\nLast plan content:\n${currentPlanContent.slice(0, 500)}`)
      }
      logger.log('Director', `Plan format invalid (attempt ${planFixAttempts}/${MAX_PLAN_FIX_ATTEMPTS}): ${(err as Error).message}. Spawning Revision Worker.`)

      const revisionPrompt = buildPlanRevisionWorkerPrompt(planPath, (err as Error).message)
      await deps.workerExecute({
        step: WorkflowStep.Plan,
        phase: syntheticPhase,
        model: getWorkerModel(config.workerModel),
        targetRepoPath: config.targetRepoPath,
        houseRulesContent: spec.houseRulesContent,
        instructions: '',
        rawPrompt: revisionPrompt,
        maxTurns: config.maxTurns,
        logger,
        backend: deps.workerBackend,
      })

      currentPlanContent = deps.readFile(planPath)
    }
  }

  // Optional human approval
  const needsApproval = config.withHumanValidation !== false
  let rejectionCount = 0

  if (needsApproval) {
    while (true) {
      deps.display(`\n=== Plan ===\n${currentPlanContent}\n======================`)
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
        const escPrompt = buildPlanRevisionWorkerPrompt(planPath, `Human escalation. Guidance: ${guidance}`)
        await deps.workerExecute({
          step: WorkflowStep.Plan,
          phase: syntheticPhase,
          model: getWorkerModel(config.workerModel),
          targetRepoPath: config.targetRepoPath,
          houseRulesContent: spec.houseRulesContent,
          instructions: '',
          rawPrompt: escPrompt,
          maxTurns: config.maxTurns,
          logger,
          backend: deps.workerBackend,
        })
      } else {
        const revPrompt = buildPlanRevisionWorkerPrompt(planPath, feedback ?? '')
        await deps.workerExecute({
          step: WorkflowStep.Plan,
          phase: syntheticPhase,
          model: getWorkerModel(config.workerModel),
          targetRepoPath: config.targetRepoPath,
          houseRulesContent: spec.houseRulesContent,
          instructions: '',
          rawPrompt: revPrompt,
          maxTurns: config.maxTurns,
          logger,
          backend: deps.workerBackend,
        })
      }

      currentPlanContent = deps.readFile(planPath)
    }
  }

  const plan = parsePlan(currentPlanContent)
  logger.log('Director', `Plan at ${planPath} with ${plan.phases.length} phases`)

  return { planPath, plan }
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

  const usesWorker = config.withWorker !== false // undefined (legacy) = true

  if (usesWorker) {
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
  let instructions = buildInitialWorkerInstructions(plan, phase, completedPhases, env)
  let workerRetries = 0
  let totalWorkerCost = 0
  const completedSubPhases: string[] = []

  while (true) {
    logger.log('Director', `Executing via Worker (attempt ${workerRetries + 1}, sub-phase ${completedSubPhases.length + 1})`)
    const workerResult = await deps.workerExecute(buildWorkerOptions({
      step: WorkflowStep.Execute,
      phase,
      config,
      houseRulesContent: phase.applicableRules || plan.houseRules,
      instructions,
      completedSubPhases: [...completedSubPhases],
      logger,
      backend: deps.workerBackend,
    }))
    totalWorkerCost += workerResult.cost
    deps.costTracker.recordWorker({
      costUsd: workerResult.cost,
      inputTokens: workerResult.usage.inputTokens,
      outputTokens: workerResult.usage.outputTokens,
      cacheReadInputTokens: workerResult.usage.cacheReadInputTokens,
      cacheCreationInputTokens: workerResult.usage.cacheCreationInputTokens,
    })
    logger.log('Session', formatTotals(deps.costTracker))

    const summary = workerResult.report?.summary ?? workerResult.message
    deps.display(`\nWorker: ${summary} (cost: $${workerResult.cost.toFixed(2)})`)
    logger.log('Director', `Worker result: ${workerResult.status} (cost: $${workerResult.cost.toFixed(2)}, total: $${totalWorkerCost.toFixed(2)})`)
    logger.logVerbose('Director', `Worker report: ${JSON.stringify(workerResult.report)}`)

    if (!shouldReview) {
      deps.display(`\nTotal Worker cost: $${totalWorkerCost.toFixed(2)}`)
      break
    }

    logger.log('Director', `Reviewing Worker output for Phase ${phase.number} (${phase.name})`)
    logger.logVerbose('Director', `Review state: completedSubPhases=${completedSubPhases.length}, workerRetries=${workerRetries}`)

    // Read Worker report from file if available, fall back to in-memory report
    const reportPath = path.join(config.targetRepoPath, '.cestdone', 'reports', `phase-${phase.number}-report.md`)
    let reportContent: string
    try {
      reportContent = deps.readFile(reportPath)
    } catch {
      reportContent = JSON.stringify(workerResult.report ?? { status: workerResult.status, message: workerResult.message })
    }

    const reviewPrompt = buildReviewPrompt(
      phase.number, phase.name, phase.spec,
      reportContent,
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
      workerRetries = 0
      instructions = reviewResult.message
      logger.log('Director', `Sub-phase ${completedSubPhases.length} complete within Phase ${phase.number}, continuing`)
      deps.display(`\nSub-phase ${completedSubPhases.length} complete. Continuing...`)
      continue
    }

    if (reviewResult.action === 'fix') {
      logger.log('Director', `Review returned 'fix' (retry ${workerRetries + 1}/${MAX_WORKER_RETRIES})`)
      workerRetries++
      if (workerRetries >= MAX_WORKER_RETRIES) {
        logger.log('Director', `Escalating after ${workerRetries} Worker failures`)
        const guidance = await deps.askInput(
          `Worker has failed ${workerRetries} times. Latest error: "${workerResult.message}"\n` +
          'Please provide guidance on how to proceed: '
        )
        workerRetries = 0
        instructions = `Human guidance: ${guidance}\nPrevious error: ${workerResult.message}\nPlease fix the issues and try again.`
      } else {
        instructions = reviewResult.message
      }
      continue
    }

    // Any other action (done, analyze, approve, etc.) means phase is complete
    if (reviewResult.action !== 'done') {
      logger.log('Director', `Review returned '${reviewResult.action}' — treating as done`)
    }
    deps.display(`\nTotal Worker cost: $${totalWorkerCost.toFixed(2)}`)
    logger.log('Director', `Phase ${phase.number} done (total cost: $${totalWorkerCost.toFixed(2)}, sub-phases: ${completedSubPhases.length + 1})`)
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

function buildWorkerOptions(params: {
  step: WorkflowStep
  phase: Phase
  config: Config
  houseRulesContent: string
  instructions: string
  completedSubPhases?: string[]
  logger: SessionLogger
  backend: Backend
}): WorkerOptions {
  return {
    step: params.step,
    phase: params.phase,
    model: getWorkerModel(params.config.workerModel),
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

function getDirectorMaxTurns(step: WorkflowStep, config?: Config): number {
  if (step === WorkflowStep.Review) return config?.directorMaxTurns ?? DEFAULTS.directorMaxTurnsReview
  return config?.directorMaxTurns ?? DEFAULTS.directorMaxTurnsDefault
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
  const maxTurns = params.maxTurnsOverride ?? getDirectorMaxTurns(step, config)

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
    message: `Director review completed without structured response (reason: ${reason}). Proceeding based on Worker self-report.`,
  }
}

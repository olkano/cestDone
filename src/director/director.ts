// src/director/director.ts
import path from 'node:path'
import type { Phase, PhaseStatus, Config, DirectorResponse, WorkerResult, WorkerOptions, FreeFormSpec, Plan, TokenUsage, Backend, BackendResult, BillingMode, UsageStatus, BackendErrorCategory } from '../shared/types.js'
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
} from './prompts.js'
import { DIRECTOR_RESPONSE_SCHEMA, isDirectorWire, normalizeDirectorWire } from '../shared/output-schemas.js'
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
  writeFile: (path: string, content: string) => void
  updatePhaseStatus: (filePath: string, phaseNumber: number, status: PhaseStatus) => void
  writePhaseCompletion: (filePath: string, phaseNumber: number, doneSummary: string) => void
  workerExecute: (options: WorkerOptions) => Promise<WorkerResult>
  display: (text: string) => void
  logger: SessionLogger
  costTracker: CostTracker
  backend: Backend
  workerBackend: Backend
  now?: () => Date
}

const MAX_REJECTIONS = DEFAULTS.maxRejections
const MAX_WORKER_RETRIES = DEFAULTS.maxWorkerRetries
// Reviewer-gated direct runs need two Worker calls (work, then publish); the cap stops a reviewer
// that keeps returning continue from running an unattended job indefinitely.
const MAX_DIRECT_SUB_PHASES = 3

export interface DirectorCallResult {
  response: DirectorResponse
  costUsd: number
  actualCostUsd: number | null
  numTurns: number
  durationMs: number
  usage: TokenUsage
  billingMode: BillingMode
  usageStatus: UsageStatus
  reasoningOutputTokens?: number
  errorCategory?: BackendErrorCategory
  sessionId: string
}

function recordDirectorCall(deps: DirectorDeps, result: DirectorCallResult): DirectorResponse {
  deps.costTracker.recordDirector({
    costUsd: result.actualCostUsd,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadInputTokens: result.usage.cacheReadInputTokens,
    cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
    billingMode: result.billingMode,
  })
  deps.logger.log('Session', formatTotals(deps.costTracker))
  return result.response
}

function actualWorkerCost(result: WorkerResult): number | null {
  // Backward-compatible with injected/test WorkerResult objects created before
  // actualCostUsd was added. Runtime results always provide the field.
  return result.actualCostUsd === undefined ? result.cost : result.actualCostUsd
}

function recordWorkerUsage(deps: DirectorDeps, result: WorkerResult): void {
  deps.costTracker.recordWorker({
    costUsd: actualWorkerCost(result),
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadInputTokens: result.usage.cacheReadInputTokens,
    cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
    billingMode: result.billingMode,
  })
  deps.logger.log('Session', formatTotals(deps.costTracker))
}

function formatWorkerCost(result: WorkerResult): string {
  const cost = actualWorkerCost(result)
  if (cost !== null) return `$${cost.toFixed(2)}`
  return result.billingMode === 'subscription' ? 'n/a (subscription)' : `n/a (${result.billingMode ?? 'unknown'} billing)`
}

function formatAccumulatedWorkerCost(deps: DirectorDeps, fallback: number): string {
  const total = deps.costTracker.getWorkerTotal()
  if (total.unknownBillingCalls > 0) return total.meteredCalls > 0 ? `$${total.costUsd.toFixed(2)} known metered + unknown billing` : 'n/a (unknown billing)'
  if (total.subscriptionCalls > 0 && total.meteredCalls === 0) return 'n/a (subscription)'
  if (total.subscriptionCalls > 0) return `$${total.costUsd.toFixed(2)} metered + subscription`
  return `$${fallback.toFixed(2)}`
}

// === Planning flow ===

export async function runPlanningFlow(
  spec: FreeFormSpec,
  config: Config,
  deps: DirectorDeps
): Promise<{ planPath: string; plan: Plan }> {
  const { logger } = deps
  const planPath = getPlanPath(spec.specFilePath, config.targetRepoPath)
  const env = detectEnvironment(config.targetRepoPath)

  // Delegate planning to a Worker
  logger.log('Director', 'Planning: Spawning Planning Worker')
  const rawPrompt = buildPlanningWorkerPrompt(spec, env, planPath)
  const syntheticPhase: Phase = { number: 0, name: 'Planning', status: 'in-progress', spec: spec.text, applicableRules: '', done: '' }

  // Write prompt file for traceability
  const promptPath = path.join(config.targetRepoPath, config.runDir, 'phase-0-prompt.md')
  try { deps.writeFile(promptPath, rawPrompt) } catch { /* best-effort */ }

  const planningResult = await deps.workerExecute(buildWorkerOptions({
    step: WorkflowStep.Plan,
    phase: syntheticPhase,
    config,
    houseRulesContent: spec.houseRulesContent,
    instructions: '',
    rawPrompt,
    logger,
    backend: deps.workerBackend,
  }))

  deps.costTracker.recordWorker({
    costUsd: actualWorkerCost(planningResult),
    inputTokens: planningResult.usage.inputTokens,
    outputTokens: planningResult.usage.outputTokens,
    cacheReadInputTokens: planningResult.usage.cacheReadInputTokens,
    cacheCreationInputTokens: planningResult.usage.cacheCreationInputTokens,
    billingMode: planningResult.billingMode,
  })
  logger.log('Session', formatTotals(deps.costTracker))
  logger.log('Director', `Planning Worker completed (cost: ${formatWorkerCost(planningResult)})`)
  assertWorkerSucceeded(planningResult, 'Planning Worker')

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
      const revisionResult = await deps.workerExecute(buildWorkerOptions({
        step: WorkflowStep.Plan,
        phase: syntheticPhase,
        config,
        houseRulesContent: spec.houseRulesContent,
        instructions: '',
        rawPrompt: revisionPrompt,
        logger,
        backend: deps.workerBackend,
      }))
      recordWorkerUsage(deps, revisionResult)
      assertWorkerSucceeded(revisionResult, 'Plan Revision Worker')

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
        const revisionResult = await deps.workerExecute(buildWorkerOptions({
          step: WorkflowStep.Plan,
          phase: syntheticPhase,
          config,
          houseRulesContent: spec.houseRulesContent,
          instructions: '',
          rawPrompt: escPrompt,
          logger,
          backend: deps.workerBackend,
        }))
        recordWorkerUsage(deps, revisionResult)
        assertWorkerSucceeded(revisionResult, 'Plan Revision Worker')
      } else {
        const revPrompt = buildPlanRevisionWorkerPrompt(planPath, feedback ?? '')
        const revisionResult = await deps.workerExecute(buildWorkerOptions({
          step: WorkflowStep.Plan,
          phase: syntheticPhase,
          config,
          houseRulesContent: spec.houseRulesContent,
          instructions: '',
          rawPrompt: revPrompt,
          logger,
          backend: deps.workerBackend,
        }))
        recordWorkerUsage(deps, revisionResult)
        assertWorkerSucceeded(revisionResult, 'Plan Revision Worker')
      }

      currentPlanContent = deps.readFile(planPath)
    }
  }

  const plan = parsePlan(currentPlanContent)
  logger.log('Director', `Plan at ${planPath} with ${plan.phases.length} phases`)

  return { planPath, plan }
}

function assertWorkerSucceeded(result: WorkerResult, label: string): void {
  if (result.status !== 'failed') return
  throw new Error(`${label} failed: ${result.message}`)
}

// === Direct execution flow ===

export async function runDirectExecution(
  spec: FreeFormSpec,
  config: Config,
  deps: DirectorDeps,
): Promise<void> {
  if (config.withWorker === false) {
    throw new Error('--skip-planning requires Worker mode; remove --no-with-worker')
  }

  const { logger } = deps
  const env = detectEnvironment(config.targetRepoPath)
  const phase: Phase = {
    number: 1,
    name: 'Direct execution',
    status: 'in-progress',
    spec: spec.text,
    applicableRules: spec.houseRulesContent,
    done: '',
  }
  const plan: Plan = {
    title: path.basename(spec.specFilePath, path.extname(spec.specFilePath)),
    context: 'Execute the complete specification directly without generating a plan.',
    techStack: env.summary,
    houseRules: spec.houseRulesContent,
    phases: [phase],
  }
  const runTime = deps.now?.() ?? new Date()
  const utcDate = runTime.toISOString().slice(0, 10)
  const utcWeekday = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(runTime)
  const instructions = [
    `Authoritative UTC run context: ${utcDate} (${utcWeekday}).`,
    'Do not recalculate or override this date or weekday; use it for all date-dependent requirements.',
    'Execute the complete specification as one job. Do not create a plan or split the work into phases.',
    'Complete every required step before reporting success.',
    'If the specification defines a reviewer gate, complete every step up to that gate, report success, and wait for the reviewer\'s instructions for the remaining steps.',
    'If any requirement remains incomplete, return status "partial" or "failed" and explain why.',
  ].join('\n')

  logger.log('Director', 'Skip planning: executing complete specification via one Worker call')
  let workerInstructions = instructions
  let fixRetries = 0
  const completedSubPhases: string[] = []

  while (true) {
    const workerResult = await deps.workerExecute(buildWorkerOptions({
      step: WorkflowStep.Execute,
      phase,
      config,
      houseRulesContent: spec.houseRulesContent,
      instructions: workerInstructions,
      completedSubPhases: [...completedSubPhases],
      writeArtifacts: false,
      logger,
      backend: deps.workerBackend,
    }))
    deps.costTracker.recordWorker({
      costUsd: actualWorkerCost(workerResult),
      inputTokens: workerResult.usage.inputTokens,
      outputTokens: workerResult.usage.outputTokens,
      cacheReadInputTokens: workerResult.usage.cacheReadInputTokens,
      cacheCreationInputTokens: workerResult.usage.cacheCreationInputTokens,
      billingMode: workerResult.billingMode,
    })
    logger.log('Session', formatTotals(deps.costTracker))

    const summary = workerResult.report?.summary ?? workerResult.message
    deps.display(`\nWorker: ${summary} (cost: ${formatWorkerCost(workerResult)})`)
    if (workerResult.status === 'failed') {
      throw new Error(`Direct Worker failed: ${workerResult.message}`)
    }
    if (workerResult.status === 'partial') {
      throw new Error(`Direct Worker incomplete: ${workerResult.message}`)
    }

    if (config.withReviews === false) {
      logger.log('Director', 'Direct execution complete without review')
      return
    }

    const reportPath = path.join(config.targetRepoPath, config.runDir, 'phase-1-report.md')
    let reportContent: string
    try {
      reportContent = deps.readFile(reportPath)
    } catch {
      reportContent = JSON.stringify(workerResult.report ?? { status: workerResult.status, message: workerResult.message })
    }

    logger.log('Director', 'Reviewing direct execution result')
    const reviewCallResult = await executeDirector({
      prompt: buildReviewPrompt(
        phase.number,
        phase.name,
        phase.spec,
        reportContent,
        config.runDir,
        completedSubPhases,
        config.autoCommit !== false,
        false,
      ),
      step: WorkflowStep.Review,
      systemPromptText: buildExecutionSystemPrompt(plan, [], env),
      config,
      logger,
      backend: deps.backend,
      toolsOverride: buildDirectorTools(WorkflowStep.Review, { withBash: config.withBashReviews !== false }),
    })
    const reviewResult = recordDirectorCall(deps, reviewCallResult)

    // A reviewer gate: the spec stops the Worker before an external write, the review decides,
    // and the Worker resumes with the reviewer's instructions as the next sub-phase.
    if (reviewResult.action === 'continue') {
      if (completedSubPhases.length >= MAX_DIRECT_SUB_PHASES) {
        throw new Error(`Direct review returned continue after ${MAX_DIRECT_SUB_PHASES} sub-phases: ${reviewResult.message}`)
      }
      completedSubPhases.push(summary)
      fixRetries = 0
      logger.log('Director', `Sub-phase ${completedSubPhases.length} accepted, continuing with reviewer instructions`)
      deps.display(`\nSub-phase ${completedSubPhases.length} accepted. Continuing...`)
      workerInstructions = [
        instructions,
        '',
        'The reviewer accepted the previous sub-phase and issued the instructions below for the remaining steps.',
        'Do not redo accepted work and do not repeat side effects that already happened.',
        '',
        `Reviewer instructions:\n${reviewResult.message}`,
      ].join('\n')
      continue
    }
    if (reviewResult.action === 'fix' && fixRetries < MAX_WORKER_RETRIES) {
      fixRetries++
      logger.log('Director', `Review returned 'fix' (fix pass ${fixRetries}/${MAX_WORKER_RETRIES})`)
      deps.display(`\nReview requires fixes (pass ${fixRetries}/${MAX_WORKER_RETRIES}). Re-running Worker...`)
      workerInstructions = [
        instructions,
        '',
        'A reviewer checked your completed work and requires corrections before the job can be accepted.',
        'Apply ONLY what the review asks for. Work already done and verified stands: do not redo it, and do not repeat side effects that already happened (emails sent, commits pushed, external records created) unless the review explicitly asks for it.',
        '',
        `Review feedback:\n${reviewResult.message}`,
      ].join('\n')
      continue
    }
    if (reviewResult.action !== 'done') {
      throw new Error(`Direct review returned ${reviewResult.action}: ${reviewResult.message}`)
    }

    logger.log('Director', 'Direct execution reviewed successfully')
    return
  }
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
  // Keep developer instructions stable for the lifetime of a resumable Director
  // thread. Completed-phase context is already included in each execution prompt.
  const systemPromptText = buildExecutionSystemPrompt(plan, [], env)

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
  if (completeResult.action !== 'done') {
    throw new Error(`Complete step returned ${completeResult.action}: ${completeResult.message}`)
  }
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

    // Write prompt file for traceability
    const promptPath = path.join(config.targetRepoPath, config.runDir, `phase-${phase.number}-prompt.md`)
    try { deps.writeFile(promptPath, instructions) } catch { /* best-effort */ }

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
      costUsd: actualWorkerCost(workerResult),
      inputTokens: workerResult.usage.inputTokens,
      outputTokens: workerResult.usage.outputTokens,
      cacheReadInputTokens: workerResult.usage.cacheReadInputTokens,
      cacheCreationInputTokens: workerResult.usage.cacheCreationInputTokens,
      billingMode: workerResult.billingMode,
    })
    logger.log('Session', formatTotals(deps.costTracker))

    const summary = workerResult.report?.summary ?? workerResult.message
    deps.display(`\nWorker: ${summary} (cost: ${formatWorkerCost(workerResult)})`)
    logger.log('Director', `Worker result: ${workerResult.status} (cost: ${formatWorkerCost(workerResult)}, total: ${formatAccumulatedWorkerCost(deps, totalWorkerCost)})`)
    logger.logVerbose('Director', `Worker report: ${JSON.stringify(workerResult.report)}`)

    if (!shouldReview) {
      if (workerResult.status !== 'success') {
        throw new Error(`Worker did not complete phase ${phase.number}: ${workerResult.message}`)
      }
      deps.display(`\nTotal Worker cost: ${formatAccumulatedWorkerCost(deps, totalWorkerCost)}`)
      break
    }

    logger.log('Director', `Reviewing Worker output for Phase ${phase.number} (${phase.name})`)
    logger.logVerbose('Director', `Review state: completedSubPhases=${completedSubPhases.length}, workerRetries=${workerRetries}`)

    // Read Worker report from file if available, fall back to in-memory report
    const reportPath = path.join(config.targetRepoPath, config.runDir, `phase-${phase.number}-report.md`)
    let reportContent: string
    try {
      reportContent = deps.readFile(reportPath)
    } catch {
      reportContent = JSON.stringify(workerResult.report ?? { status: workerResult.status, message: workerResult.message })
    }

    const reviewPrompt = buildReviewPrompt(
      phase.number, phase.name, phase.spec,
      reportContent,
      config.runDir,
      completedSubPhases,
      config.autoCommit !== false,
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

    if (reviewResult.action !== 'done') {
      throw new Error(`Review returned invalid action ${reviewResult.action}: ${reviewResult.message}`)
    }
    deps.display(`\nTotal Worker cost: ${formatAccumulatedWorkerCost(deps, totalWorkerCost)}`)
    logger.log('Director', `Phase ${phase.number} done (total cost: ${formatAccumulatedWorkerCost(deps, totalWorkerCost)}, sub-phases: ${completedSubPhases.length + 1})`)
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
  rawPrompt?: string
  completedSubPhases?: string[]
  writeArtifacts?: boolean
  logger: SessionLogger
  backend: Backend
}): WorkerOptions {
  return {
    step: params.step,
    phase: params.phase,
    model: getWorkerModel(params.config.workerModel),
    targetRepoPath: params.config.targetRepoPath,
    runDir: params.config.runDir,
    houseRulesContent: params.houseRulesContent,
    instructions: params.instructions,
    rawPrompt: params.rawPrompt,
    maxTurns: params.config.maxTurns,
    maxBudgetUsd: params.config.maxBudgetUsd,
    logger: params.logger,
    completedSubPhases: params.completedSubPhases,
    writeArtifacts: params.writeArtifacts,
    mcpConfig: params.config.mcpConfig,
    accessMode: params.step === WorkflowStep.Analyze ? 'read-only' : 'unrestricted',
    reasoningEffort: params.config.resolvedAgents?.worker.reasoningEffort,
    timeoutMs: params.config.resolvedAgents?.worker.callTimeoutMs,
    profileName: params.config.resolvedAgents?.worker.profileName,
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
    systemPrompt: backend.provider === 'codex' || !params.resume ? systemPromptText : undefined,
    model,
    tools,
    outputSchema: DIRECTOR_RESPONSE_SCHEMA,
    cwd: config.targetRepoPath,
    maxTurns,
    resumeSessionId: params.resume,
    env: { ...process.env },
    usageContext: {
      role: 'director',
      workflowStep: step,
    },
    accessMode: directorAccessMode(step, config),
    reasoningEffort: config.resolvedAgents?.director.reasoningEffort,
    timeoutMs: config.resolvedAgents?.director.callTimeoutMs,
    profileName: config.resolvedAgents?.director.profileName,
    logger,
  })

  const costLabel = result.costUsd !== null
    ? `$${result.costUsd.toFixed(2)}`
    : result.billingMode === 'subscription' ? 'n/a (subscription)' : `n/a (${result.billingMode} billing)`
  logger.log('Director', `Call completed (cost: ${costLabel}, turns: ${result.numTurns}, success: ${result.success})`)
  logger.log('Director', `Tokens: in:${result.usage.inputTokens} out:${result.usage.outputTokens} cache-r:${result.usage.cacheReadInputTokens} cache-w:${result.usage.cacheCreationInputTokens}`)

  if (!result.success) {
    throw new Error(result.errorMessage ?? `Director session failed: ${result.rawText?.slice(0, 200) ?? 'no output'}`)
  }

  const response = extractDirectorResponse(result, logger)
  logger.log('Director', `Response action: ${response.action}`)

  return {
    response,
    costUsd: result.costUsd ?? 0,
    actualCostUsd: result.costUsd,
    numTurns: result.numTurns,
    durationMs: result.durationMs,
    usage: result.usage,
    billingMode: result.billingMode,
    usageStatus: result.usageStatus,
    reasoningOutputTokens: result.reasoningOutputTokens,
    errorCategory: result.errorCategory,
    sessionId: result.sessionId ?? '',
  }
}

function extractDirectorResponse(result: BackendResult, logger: SessionLogger): DirectorResponse {
  const hasOutput = result.output !== undefined && result.output !== null
  logger.logVerbose('Director', `extractDirectorResponse: success=${result.success}, has_output=${hasOutput}, has_rawText=${!!result.rawText}`)

  if (hasOutput && typeof result.output === 'object') {
    const normalized = normalizeDirectorWire(result.output)
    if (isDirectorWire(normalized)) {
      const wire = normalized as { action: DirectorResponse['action']; message: string; questions: string[] | null }
      logger.logVerbose('Director', `Using output: action=${wire.action}, message_length=${wire.message.length}`)
      return { action: wire.action, message: wire.message, ...(wire.questions ? { questions: wire.questions } : {}) }
    }
  }

  if (result.rawText) {
    try {
      const normalized = normalizeDirectorWire(JSON.parse(result.rawText))
      if (isDirectorWire(normalized)) {
        const parsed = normalized as { action: DirectorResponse['action']; message: string; questions: string[] | null }
        logger.logVerbose('Director', `Parsed rawText as JSON: action=${parsed.action}`)
        return { action: parsed.action, message: parsed.message, ...(parsed.questions ? { questions: parsed.questions } : {}) }
      }
    } catch {
      // Not JSON — fall through
    }

    throw new Error('Director returned invalid structured output')
  }

  throw new Error(`Director returned no structured output: ${result.errorMessage ?? 'unknown reason'}`)
}

function directorAccessMode(step: WorkflowStep, config: Config): 'read-only' | 'unrestricted' {
  if (step === WorkflowStep.Execute) return 'unrestricted'
  if (step === WorkflowStep.Review && config.autoCommit !== false) return 'unrestricted'
  return 'read-only'
}

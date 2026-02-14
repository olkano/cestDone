// src/director/director.ts
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Phase, PhaseStatus, ResolvedConfig, DirectorResponse, CoderResult, CoderOptions, FreeFormSpec, Plan, TokenUsage } from '../shared/types.js'
import { WorkflowStep, mapSdkUsage, formatToolCall } from '../shared/types.js'
import { CostTracker, formatTotals } from '../shared/cost-tracker.js'
import type { UsageSnapshot } from '../shared/cost-tracker.js'
import {
  buildDirectorTools,
  buildClarifyPrompt,
  buildInitialCoderInstructions,
  buildReviewPrompt,
  buildCompletePrompt,
  buildPlanningSystemPrompt,
  buildFreeFormAnalyzePrompt,
  buildCreatePlanPrompt,
  buildRevisePlanPrompt,
  buildExecutionSystemPrompt,
  DIRECTOR_RESPONSE_SCHEMA,
} from './prompts.js'
import { selectModel } from './model-selector.js'
import { parsePlan, getPlanPath } from '../shared/plan-parser.js'
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
}

const MAX_REJECTIONS = 3
const MAX_CODER_RETRIES = 3

export interface DirectorCallResult {
  response: DirectorResponse
  costUsd: number
  numTurns: number
  durationMs: number
  usage: TokenUsage
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
  config: ResolvedConfig,
  deps: DirectorDeps
): Promise<{ planPath: string; plan: Plan }> {
  const { logger } = deps
  const systemPromptText = buildPlanningSystemPrompt(spec)

  // Step 1: Analyze free-form spec
  logger.log('Director', 'Planning: Analyzing free-form spec')
  const analyzeResult = recordDirectorCall(deps, await executeDirector({
    prompt: buildFreeFormAnalyzePrompt(spec),
    step: WorkflowStep.Analyze,
    systemPromptText,
    config,
    logger,
  }))

  // Step 2: Clarify (iterative — ask follow-ups until Director is satisfied)
  let clarificationsText = ''
  let pendingQuestions = analyzeResult.action === 'ask_human' ? (analyzeResult.questions ?? []) : []
  const MAX_CLARIFY_ROUNDS = 3

  for (let round = 0; round < MAX_CLARIFY_ROUNDS && pendingQuestions.length > 0; round++) {
    logger.log('Director', `Planning: Clarify round ${round + 1} — ${pendingQuestions.length} questions`)
    const answers: string[] = []
    for (const q of pendingQuestions) {
      answers.push(await deps.askInput(`Director asks: ${q}\nYour answer: `))
    }
    clarificationsText += (clarificationsText ? '\n\n' : '') +
      pendingQuestions.map((q, i) => `Q: ${q}\nA: ${answers[i]}`).join('\n\n')

    const clarifyResult = recordDirectorCall(deps, await executeDirector({
      prompt: buildClarifyPrompt(pendingQuestions, answers),
      step: WorkflowStep.Clarify,
      systemPromptText,
      config,
      logger,
    }))

    // If Director has follow-up questions, loop; otherwise proceed
    if (clarifyResult.action === 'ask_human' && clarifyResult.questions?.length) {
      pendingQuestions = clarifyResult.questions
    } else {
      pendingQuestions = []
    }
  }

  // Step 3: Create plan
  logger.log('Director', 'Planning: Creating structured plan')
  const createResult = recordDirectorCall(deps, await executeDirector({
    prompt: buildCreatePlanPrompt(spec, clarificationsText),
    step: WorkflowStep.CreatePlan,
    systemPromptText,
    config,
    logger,
  }))

  // Validate + approve loop
  let rejectionCount = 0
  let currentPlanContent = createResult.message

  while (true) {
    // Validate plan parses correctly
    try {
      parsePlan(currentPlanContent)
    } catch (err) {
      logger.log('Director', `Plan format invalid: ${(err as Error).message}. Asking Director to fix.`)
      const fixResult = recordDirectorCall(deps, await executeDirector({
        prompt: `The plan you produced has a format error: ${(err as Error).message}\n\nPlease fix it and return the corrected plan in your message field.\n\nOriginal plan:\n${currentPlanContent}`,
        step: WorkflowStep.CreatePlan,
        systemPromptText,
        config,
        logger,
      }))
      currentPlanContent = fixResult.message
      continue
    }

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
      const fixResult = recordDirectorCall(deps, await executeDirector({
        prompt: `Human escalation. Guidance: ${guidance}\nPrevious plan:\n${currentPlanContent}\nPlease revise the plan.`,
        step: WorkflowStep.CreatePlan,
        systemPromptText,
        config,
        logger,
      }))
      currentPlanContent = fixResult.message
    } else {
      const fixResult = recordDirectorCall(deps, await executeDirector({
        prompt: buildRevisePlanPrompt(currentPlanContent, feedback ?? ''),
        step: WorkflowStep.CreatePlan,
        systemPromptText,
        config,
        logger,
      }))
      currentPlanContent = fixResult.message
    }
  }

  // Write plan file
  const planPath = getPlanPath(spec.specFilePath)
  deps.createPlanFile(planPath, currentPlanContent)
  const plan = parsePlan(currentPlanContent)
  logger.log('Director', `Plan written to ${planPath} with ${plan.phases.length} phases`)

  return { planPath, plan }
}

// === Phase execution flow ===

export async function runPhase(
  plan: Plan,
  phase: Phase,
  config: ResolvedConfig,
  planFilePath: string,
  deps: DirectorDeps
): Promise<void> {
  const { logger } = deps
  const completedPhases = plan.phases.filter(p => p.status === 'done')
  const systemPromptText = buildExecutionSystemPrompt(plan, completedPhases)

  deps.updatePhaseStatus(planFilePath, phase.number, 'in-progress')

  // Build initial instructions from phase spec + plan context
  let instructions = buildInitialCoderInstructions(plan, phase, completedPhases)

  // Execute → Review loop (with sub-phase iteration)
  let coderRetries = 0
  let totalCoderCost = 0
  const completedSubPhases: string[] = []

  while (true) {
    // Step 6: Execute
    logger.log('Director', `Step 6: Executing via Coder (attempt ${coderRetries + 1}, sub-phase ${completedSubPhases.length + 1})`)
    const coderResult = await deps.coderExecute(buildCoderOptions({
      step: WorkflowStep.Execute,
      phase,
      config,
      houseRulesContent: phase.applicableRules || plan.houseRules,
      instructions,
      completedSubPhases: [...completedSubPhases],
      logger,
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

    // Step 7: Review — always runs, Director verifies and decides next action
    logger.log('Director', `Step 7: Reviewing Coder output for Phase ${phase.number} (${phase.name})`)
    logger.logVerbose('Director', `Review state: completedSubPhases=${completedSubPhases.length}, coderRetries=${coderRetries}`)
    const reviewPrompt = buildReviewPrompt(
      phase.number,
      phase.name,
      phase.spec,
      JSON.stringify(coderResult.report ?? { status: coderResult.status, message: coderResult.message }),
      completedSubPhases,
    )
    logger.logVerbose('Director', `Review prompt length: ${reviewPrompt.length} chars`)

    let reviewResult: DirectorResponse
    try {
      reviewResult = recordDirectorCall(deps, await executeDirector({
        prompt: reviewPrompt,
        step: WorkflowStep.Review,
        systemPromptText,
        config,
        logger,
      }))
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      logger.log('Director', `Review call crashed: ${errorMessage}`)
      logger.logVerbose('Director', `Review crash stack: ${err instanceof Error ? err.stack : 'N/A'}`)
      throw err
    }

    logger.log('Director', `Review decision: action=${reviewResult.action}, message length=${reviewResult.message.length}`)
    logger.logVerbose('Director', `Review message: ${reviewResult.message.slice(0, 1000)}`)

    if (reviewResult.action === 'done') {
      deps.display(`\nTotal Coder cost: $${totalCoderCost.toFixed(2)}`)
      logger.log('Director', `Phase ${phase.number} done (total cost: $${totalCoderCost.toFixed(2)}, sub-phases: ${completedSubPhases.length + 1})`)
      break
    }

    if (reviewResult.action === 'continue') {
      completedSubPhases.push(summary)
      coderRetries = 0
      instructions = reviewResult.message
      logger.log('Director', `Sub-phase ${completedSubPhases.length} complete within Phase ${phase.number}, continuing`)
      logger.logVerbose('Director', `Next sub-phase instructions: ${instructions.slice(0, 500)}`)
      deps.display(`\nSub-phase ${completedSubPhases.length} complete. Continuing...`)
      continue
    }

    // action === 'fix' (or any other) — retry with fix instructions
    logger.log('Director', `Review returned '${reviewResult.action}' — treating as fix (retry ${coderRetries + 1}/${MAX_CODER_RETRIES})`)
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
  const completeResult = recordDirectorCall(deps, await executeDirector({
    prompt: buildCompletePrompt(phase),
    step: WorkflowStep.Complete,
    systemPromptText,
    config,
    logger,
  }))
  deps.writePhaseCompletion(planFilePath, phase.number, completeResult.message)
}

function buildCoderOptions(params: {
  step: WorkflowStep
  phase: Phase
  config: ResolvedConfig
  houseRulesContent: string
  instructions: string
  completedSubPhases?: string[]
  logger: SessionLogger
}): CoderOptions {
  return {
    step: params.step,
    phase: params.phase,
    model: selectModel(params.step, 'high'),
    targetRepoPath: params.config.targetRepoPath,
    houseRulesContent: params.houseRulesContent,
    instructions: params.instructions,
    maxTurns: params.config.maxTurns,
    maxBudgetUsd: params.config.maxBudgetUsd,
    apiKey: params.config.apiKey,
    logger: params.logger,
    completedSubPhases: params.completedSubPhases,
  }
}

function getDirectorMaxTurns(step: WorkflowStep): number {
  // Review step needs more turns: read files, run tests, start server, curl, git commit
  if (step === WorkflowStep.Review) return 30
  return 15
}

interface ExecuteDirectorParams {
  prompt: string
  step: WorkflowStep
  systemPromptText: string
  config: ResolvedConfig
  logger: SessionLogger
}

export async function executeDirector(params: ExecuteDirectorParams): Promise<DirectorCallResult> {
  const { prompt, step, systemPromptText, config, logger } = params
  const model = selectModel(step, 'high')
  const tools = buildDirectorTools(step)
  const maxTurns = getDirectorMaxTurns(step)

  logger.log('Director', `Call starting (step: ${step}, model: ${model}, maxTurns: ${maxTurns})`)
  logger.logVerbose('Director', `Prompt:\n${prompt}`)

  const env = { ...process.env }
  delete env.CLAUDECODE

  const queryOptions: Record<string, unknown> = {
    model,
    cwd: config.targetRepoPath,
    maxTurns,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    tools,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: systemPromptText,
    },
    outputFormat: {
      type: 'json_schema',
      schema: DIRECTOR_RESPONSE_SCHEMA,
    },
    env,
  }

  let callResult: DirectorCallResult | null = null

  const q = query({ prompt, options: queryOptions as Parameters<typeof query>[0]['options'] })

  for await (const message of q) {
    const msg = message as { type: string; subtype?: string; total_cost_usd?: number; num_turns?: number; duration_ms?: number; structured_output?: unknown; result?: string; message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> }; usage?: unknown }

    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          logger.log('Director', block.text.slice(0, 500))
        } else if (block.type === 'tool_use' && block.name) {
          logger.log('Director', `Tool: ${formatToolCall(block.name, block.input)}`)
        }
      }
    }

    if (msg.type === 'result') {
      const usage = mapSdkUsage(msg.usage)
      logger.log('Director', `Call completed (cost: $${msg.total_cost_usd?.toFixed(2)}, turns: ${msg.num_turns}, subtype: ${msg.subtype ?? 'unknown'})`)
      logger.log('Director', `Tokens: in:${usage.inputTokens} out:${usage.outputTokens} cache-r:${usage.cacheReadInputTokens} cache-w:${usage.cacheCreationInputTokens}`)
      callResult = {
        response: extractDirectorResponse(msg, logger),
        costUsd: msg.total_cost_usd ?? 0,
        numTurns: msg.num_turns ?? 0,
        durationMs: msg.duration_ms ?? 0,
        usage,
      }
      logger.logVerbose('Director', 'Result received, breaking out of SDK stream')
      break
    }
  }

  logger.logVerbose('Director', 'SDK stream iteration ended')

  if (!callResult) {
    throw new Error('Director session ended with no result')
  }

  logger.log('Director', `Response action: ${callResult.response.action}`)
  return callResult
}

function extractDirectorResponse(msg: { structured_output?: unknown; result?: string; subtype?: string }, logger: SessionLogger): DirectorResponse {
  logger.logVerbose('Director', `extractDirectorResponse: subtype=${msg.subtype}, has_structured_output=${!!msg.structured_output}, has_result=${!!msg.result}, result_length=${msg.result?.length ?? 0}`)

  if (msg.structured_output && typeof msg.structured_output === 'object') {
    const so = msg.structured_output as Record<string, unknown>
    logger.logVerbose('Director', `Using structured_output: action=${so.action}, message_length=${(so.message as string)?.length ?? 0}`)
    return msg.structured_output as DirectorResponse
  }

  if (msg.result) {
    try {
      const parsed = JSON.parse(msg.result) as DirectorResponse
      if (parsed.action && parsed.message) {
        logger.logVerbose('Director', `Parsed result text as JSON: action=${parsed.action}`)
        return parsed
      }
    } catch {
      // Not JSON — fall through
    }

    return { action: 'analyze', message: msg.result }
  }

  // No structured output and no result text — likely hit max turns or other SDK error.
  // Instead of crashing, return a safe default and let the workflow handle it.
  const reason = msg.subtype ?? 'unknown'
  logger.log('Director', `WARNING: No structured output produced (subtype: ${reason}). Defaulting to 'done'.`)
  return {
    action: 'done',
    message: `Director review completed without structured response (reason: ${reason}). Proceeding based on Coder self-report.`,
  }
}

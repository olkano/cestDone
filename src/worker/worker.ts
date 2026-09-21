// src/worker/worker.ts
import path from 'node:path'
import { getTools } from './permissions.js'
import { buildWorkerPrompt } from './worker-prompt.js'
import { parseWorkerResult } from './result-parser.js'
import type { WorkerOptions, WorkerResult } from '../shared/types.js'
import { formatDuration, WorkflowStep } from '../shared/types.js'
import { WORKER_REPORT_SCHEMA } from '../shared/output-schemas.js'
export { WORKER_REPORT_SCHEMA } from '../shared/output-schemas.js'

export async function executeWorker(options: WorkerOptions): Promise<WorkerResult> {
  const { logger, backend } = options
  const tools = getTools(options.step)

  logger.log('Worker', `Call starting (step: ${options.step}, model: ${options.model}, phase: ${options.phase.number})`)

  const prompt = options.rawPrompt ?? buildWorkerPrompt({
    instructions: options.instructions,
    phase: options.phase,
    step: options.step,
    runDir: options.runDir,
    completedSubPhases: options.completedSubPhases,
    writeArtifacts: options.writeArtifacts,
  })

  logger.logVerbose('Worker', `Full prompt:\n${prompt}`)

  let result
  try {
    result = await backend.invoke({
      prompt,
      systemPrompt: options.houseRulesContent,
      model: options.model,
      tools,
      outputSchema: options.rawPrompt ? undefined : WORKER_REPORT_SCHEMA,
      cwd: path.resolve(options.targetRepoPath),
      maxTurns: options.maxTurns,
      maxBudgetUsd: options.maxBudgetUsd,
      mcpConfig: options.mcpConfig,
      env: { ...process.env },
      usageContext: {
        role: 'worker',
        workflowStep: options.step,
        phaseNumber: options.phase.number,
      },
      accessMode: options.accessMode ?? (options.step === WorkflowStep.Analyze ? 'read-only' : 'unrestricted'),
      reasoningEffort: options.reasoningEffort,
      timeoutMs: options.timeoutMs,
      profileName: options.profileName,
      logger,
    })
  } catch (err) {
    const errorMsg = (err as Error).message ?? String(err)
    logger.log('Worker', `Backend error: ${errorMsg}`)
    return {
      status: 'failed',
      message: errorMsg,
      cost: 0,
      actualCostUsd: null,
      billingMode: 'unknown',
      usageStatus: 'unavailable',
      errorCategory: 'process_failed',
      numTurns: 0,
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      report: { status: 'failed', summary: errorMsg },
    }
  }

  const costLabel = result.costUsd !== null
    ? `$${result.costUsd.toFixed(2)}`
    : result.billingMode === 'subscription' ? 'n/a (subscription)' : `n/a (${result.billingMode} billing)`
  logger.log('Worker', `Call completed (cost: ${costLabel}, turns: ${result.numTurns}, duration: ${formatDuration(result.durationMs)})`)
  logger.log('Worker', `Tokens: in:${result.usage.inputTokens} out:${result.usage.outputTokens} cache-r:${result.usage.cacheReadInputTokens} cache-w:${result.usage.cacheCreationInputTokens}`)
  const toolSummary = Object.entries(result.toolCalls ?? {}).map(([name, count]) => `${name}:${count}`).join(' ')
  if (toolSummary) logger.log('Worker', `Tools: ${toolSummary}`)

  const workerResult = parseWorkerResult(result)

  const resultCostLabel = workerResult.actualCostUsd !== null
    ? `$${workerResult.actualCostUsd.toFixed(2)}`
    : workerResult.billingMode === 'subscription' ? 'n/a (subscription)' : `n/a (${workerResult.billingMode ?? 'unknown'} billing)`
  logger.log('Worker', `Result: ${workerResult.status} (cost: ${resultCostLabel}, turns: ${workerResult.numTurns})`)
  logger.logVerbose('Worker', `Parsed report: ${JSON.stringify(workerResult.report, null, 2)}`)

  return workerResult
}

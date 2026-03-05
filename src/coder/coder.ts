// src/coder/coder.ts
import path from 'node:path'
import { getTools } from './permissions.js'
import { buildCoderPrompt } from './coder-prompt.js'
import { parseCoderResult } from './result-parser.js'
import type { CoderOptions, CoderResult } from '../shared/types.js'
import { formatDuration } from '../shared/types.js'

export const CODER_REPORT_SCHEMA = {
  type: 'object' as const,
  properties: {
    status: { type: 'string', enum: ['success', 'partial', 'failed'] },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    testsRun: {
      type: 'object',
      properties: {
        passed: { type: 'number' },
        failed: { type: 'number' },
        skipped: { type: 'number' },
      },
    },
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary'],
}

export async function executeCoder(options: CoderOptions): Promise<CoderResult> {
  const { logger, backend } = options
  const tools = getTools(options.step)

  logger.log('Coder', `Call starting (step: ${options.step}, model: ${options.model}, phase: ${options.phase.number})`)

  const prompt = buildCoderPrompt({
    instructions: options.instructions,
    phase: options.phase,
    step: options.step,
    completedSubPhases: options.completedSubPhases,
  })

  logger.logVerbose('Coder', `Full prompt:\n${prompt}`)

  let result
  try {
    result = await backend.invoke({
      prompt,
      systemPrompt: options.houseRulesContent,
      model: options.model,
      tools,
      outputSchema: CODER_REPORT_SCHEMA,
      cwd: path.resolve(options.targetRepoPath),
      maxTurns: options.maxTurns,
      maxBudgetUsd: options.maxBudgetUsd,
      env: { ...process.env },
      logger,
    })
  } catch (err) {
    const errorMsg = (err as Error).message ?? String(err)
    logger.log('Coder', `Backend error: ${errorMsg}`)
    return {
      status: 'failed',
      message: errorMsg,
      cost: 0,
      numTurns: 0,
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      report: { status: 'failed', summary: errorMsg },
    }
  }

  logger.log('Coder', `Call completed (cost: $${(result.costUsd ?? 0).toFixed(2)}, turns: ${result.numTurns}, duration: ${formatDuration(result.durationMs)})`)
  logger.log('Coder', `Tokens: in:${result.usage.inputTokens} out:${result.usage.outputTokens} cache-r:${result.usage.cacheReadInputTokens} cache-w:${result.usage.cacheCreationInputTokens}`)

  const coderResult = parseCoderResult(result)

  logger.log('Coder', `Result: ${coderResult.status} (cost: $${coderResult.cost.toFixed(2)}, turns: ${coderResult.numTurns})`)
  logger.logVerbose('Coder', `Parsed report: ${JSON.stringify(coderResult.report, null, 2)}`)

  return coderResult
}

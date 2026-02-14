// src/coder/coder.ts
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { getTools } from './permissions.js'
import { buildCoderPrompt } from './coder-prompt.js'
import { parseResult, type SDKResultLike } from './result-parser.js'
import type { CoderOptions, CoderResult } from '../shared/types.js'
import { formatDuration, formatToolCall, mapSdkUsage } from '../shared/types.js'

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
  const { logger } = options
  const tools = getTools(options.step)

  logger.log('Coder', `Call starting (step: ${options.step}, model: ${options.model}, phase: ${options.phase.number})`)

  const prompt = buildCoderPrompt({
    instructions: options.instructions,
    phase: options.phase,
    step: options.step,
    completedSubPhases: options.completedSubPhases,
  })

  logger.logVerbose('Coder', `Full prompt:\n${prompt}`)

  const env = { ...process.env }
  delete env.CLAUDECODE

  const queryOptions: Record<string, unknown> = {
    model: options.model,
    cwd: path.resolve(options.targetRepoPath),
    maxTurns: options.maxTurns,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    tools,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: options.houseRulesContent,
    },
    outputFormat: {
      type: 'json_schema',
      schema: CODER_REPORT_SCHEMA,
    },
    env,
  }

  if (options.maxBudgetUsd !== undefined) {
    queryOptions.maxBudgetUsd = options.maxBudgetUsd
  }

  let resultMessage: SDKResultLike | null = null
  let q: ReturnType<typeof query> | null = null

  try {
    q = query({ prompt, options: queryOptions as Parameters<typeof query>[0]['options'] })

    for await (const message of q) {
      const msg = message as { type: string; subtype?: string; session_id?: string; model?: string; tools?: string[]; cwd?: string; message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> }; total_cost_usd?: number; num_turns?: number; duration_ms?: number }

      switch (msg.type) {
        case 'system':
          logger.log('Coder', `Session initialized (model: ${msg.model})`)
          break

        case 'assistant':
          if (msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) {
                logger.log('Coder', block.text.slice(0, 500))
              } else if (block.type === 'tool_use' && block.name) {
                logger.log('Coder', `Tool: ${formatToolCall(block.name, block.input)}`)
              }
            }
          }
          break

        case 'result':
          resultMessage = msg as unknown as SDKResultLike
          logger.log('Coder', `Call completed (cost: $${msg.total_cost_usd?.toFixed(2)}, turns: ${msg.num_turns}, duration: ${formatDuration(msg.duration_ms ?? 0)})`)
          logger.logVerbose('Coder', `Raw result message: subtype=${resultMessage.subtype}, has_structured_output=${!!resultMessage.structured_output}, has_result=${!!resultMessage.result}, has_usage=${!!resultMessage.usage}`)
          break
      }

      if (resultMessage) break
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    logger.log('Coder', `SDK stream error: ${errorMessage}`)
    logger.logVerbose('Coder', `SDK stream error stack: ${err instanceof Error ? err.stack : 'N/A'}`)
    return {
      status: 'failed',
      message: errorMessage,
      cost: 0,
      numTurns: 0,
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      report: { status: 'failed', summary: errorMessage },
    }
  } finally {
    if (q) q.close()
  }

  if (!resultMessage) {
    logger.log('Coder', 'Session ended with no result message')
    return {
      status: 'failed',
      message: 'Coder session ended with no result message',
      cost: 0,
      numTurns: 0,
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      report: null,
    }
  }

  logger.logVerbose('Coder', 'Parsing result...')
  let result: CoderResult
  try {
    result = parseResult(resultMessage)
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    logger.log('Coder', `parseResult crashed: ${errorMessage}`)
    logger.logVerbose('Coder', `parseResult stack: ${err instanceof Error ? err.stack : 'N/A'}`)
    logger.logVerbose('Coder', `Raw msg for crashed parse: ${JSON.stringify(resultMessage, null, 2)}`)
    return {
      status: 'failed',
      message: `parseResult error: ${errorMessage}`,
      cost: resultMessage.total_cost_usd ?? 0,
      numTurns: resultMessage.num_turns ?? 0,
      durationMs: resultMessage.duration_ms ?? 0,
      usage: mapSdkUsage(resultMessage.usage),
      report: null,
    }
  }

  logger.log('Coder', `Result: ${result.status} (cost: $${result.cost.toFixed(2)}, turns: ${result.numTurns})`)
  logger.log('Coder', `Tokens: in:${result.usage.inputTokens} out:${result.usage.outputTokens} cache-r:${result.usage.cacheReadInputTokens} cache-w:${result.usage.cacheCreationInputTokens}`)
  logger.logVerbose('Coder', `Parsed report: ${JSON.stringify(result.report, null, 2)}`)

  return result
}

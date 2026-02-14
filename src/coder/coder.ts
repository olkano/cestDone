// src/coder/coder.ts
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { getTools } from './permissions.js'
import { buildCoderPrompt } from './coder-prompt.js'
import { parseResult, type SDKResultLike } from './result-parser.js'
import type { CoderOptions, CoderResult } from '../shared/types.js'

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

  try {
    const q = query({ prompt, options: queryOptions as Parameters<typeof query>[0]['options'] })

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
                logger.log('Coder', `Tool: ${block.name}(${block.input ? Object.keys(block.input as Record<string, unknown>).join(', ') : ''})`)
              }
            }
          }
          break

        case 'result':
          resultMessage = msg as unknown as SDKResultLike
          logger.log('Coder', `Call completed (cost: $${msg.total_cost_usd?.toFixed(2)}, turns: ${msg.num_turns}, duration: ${msg.duration_ms}ms)`)
          break
      }
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    logger.log('Coder', `Call failed: ${errorMessage}`)
    return {
      status: 'failed',
      message: errorMessage,
      cost: 0,
      numTurns: 0,
      durationMs: 0,
      report: { status: 'failed', summary: errorMessage },
    }
  }

  if (!resultMessage) {
    logger.log('Coder', 'Session ended with no result message')
    return {
      status: 'failed',
      message: 'Coder session ended with no result message',
      cost: 0,
      numTurns: 0,
      durationMs: 0,
      report: null,
    }
  }

  const result = parseResult(resultMessage)

  logger.log('Coder', `Result: ${result.status} (cost: $${result.cost.toFixed(2)}, turns: ${result.numTurns})`)
  logger.logVerbose('Coder', `Full result:\n${JSON.stringify(result, null, 2)}`)

  return result
}

// src/coder/coder.ts
import path from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { createLogger } from '../shared/logger.js'
import { getAllowedTools } from './permissions.js'
import { buildCoderPrompt } from './coder-prompt.js'
import { parseResult, type SDKResultLike } from './result-parser.js'
import type { CoderOptions, CoderResult } from '../shared/types.js'

export const CODER_REPORT_SCHEMA = {
  type: 'object' as const,
  properties: {
    status: { type: 'string', enum: ['success', 'error', 'partial'] },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    testResults: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary'],
}

export async function executeCoder(options: CoderOptions): Promise<CoderResult> {
  const logger = createLogger(options.logLevel)

  logger.info(
    { step: options.step, model: options.model, phase: options.phase.number, allowedTools: getAllowedTools(options.step) },
    'Coder call starting'
  )

  const prompt = buildCoderPrompt({
    instructions: options.instructions,
    phase: options.phase,
    step: options.step,
  })

  const queryOptions: Record<string, unknown> = {
    model: options.model,
    cwd: path.resolve(options.targetRepoPath),
    maxTurns: options.maxTurns,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    allowedTools: getAllowedTools(options.step),
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: options.houseRulesContent,
    },
    outputFormat: {
      type: 'json_schema',
      schema: CODER_REPORT_SCHEMA,
    },
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
          logger.debug(
            { session_id: msg.session_id, model: msg.model, tools: msg.tools, cwd: msg.cwd },
            'Coder session initialized'
          )
          break

        case 'assistant':
          if (msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) {
                logger.debug({ text: block.text.slice(0, 500) }, 'Coder text')
              } else if (block.type === 'tool_use' && block.name) {
                logger.debug({ tool: block.name, inputKeys: block.input ? Object.keys(block.input as Record<string, unknown>) : [] }, 'Coder tool call')
              }
            }
          }
          break

        case 'result':
          resultMessage = msg as unknown as SDKResultLike
          logger.info(
            { subtype: msg.subtype, cost: msg.total_cost_usd, turns: msg.num_turns, duration: msg.duration_ms },
            'Coder call completed'
          )
          break
      }
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    logger.error({ error: errorMessage }, 'Coder call failed with exception')
    return {
      status: 'error',
      message: errorMessage,
      cost: 0,
      numTurns: 0,
      durationMs: 0,
      report: { status: 'error', summary: errorMessage },
    }
  }

  if (!resultMessage) {
    logger.warn('Coder session ended with no result message')
    return {
      status: 'error',
      message: 'Coder session ended with no result message',
      cost: 0,
      numTurns: 0,
      durationMs: 0,
      report: null,
    }
  }

  const result = parseResult(resultMessage)

  logger.info(
    { status: result.status, cost: result.cost, turns: result.numTurns },
    'Coder result parsed'
  )

  return result
}

/** @deprecated Phase 0 stub — used by CLI wiring until item 9 replaces it */
export function execute(): CoderResult {
  return { status: 'manual', message: 'Coder integration not yet available — manual execution required', cost: 0, numTurns: 0, durationMs: 0, report: null }
}

// src/backends/agent-sdk.ts
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Backend, BackendInvocation, BackendResult, BackendType } from '../shared/types.js'
import { mapSdkUsage, formatToolCall } from '../shared/types.js'

export class AgentSdkBackend implements Backend {
  readonly name: BackendType = 'agent-sdk'

  async invoke(params: BackendInvocation): Promise<BackendResult> {
    const { prompt, logger } = params

    const env = { ...(params.env ?? process.env) }
    delete env.CLAUDECODE

    const queryOptions: Record<string, unknown> = {
      model: params.model,
      cwd: params.cwd,
      maxTurns: params.maxTurns,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      env,
    }

    if (params.tools) queryOptions.tools = params.tools
    if (params.outputSchema) {
      queryOptions.outputFormat = { type: 'json_schema', schema: params.outputSchema }
    }
    if (params.maxBudgetUsd !== undefined) queryOptions.maxBudgetUsd = params.maxBudgetUsd

    if (params.resumeSessionId) {
      queryOptions.resume = params.resumeSessionId
    } else if (params.systemPrompt) {
      queryOptions.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: params.systemPrompt,
      }
    }

    let capturedSessionId = ''
    let q: ReturnType<typeof query> | null = null

    try {
      q = query({ prompt, options: queryOptions as Parameters<typeof query>[0]['options'] })

      for await (const message of q) {
        const msg = message as {
          type: string; subtype?: string; session_id?: string
          total_cost_usd?: number; num_turns?: number; duration_ms?: number
          structured_output?: unknown; result?: string; usage?: unknown
          message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> }
        }

        if (msg.type === 'system' && msg.session_id) {
          capturedSessionId = msg.session_id
        }

        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              logger.log('Backend', block.text.slice(0, 500))
            } else if (block.type === 'tool_use' && block.name) {
              logger.log('Backend', `Tool: ${formatToolCall(block.name, block.input)}`)
            }
          }
        }

        if (msg.type === 'result') {
          const usage = mapSdkUsage(msg.usage)
          const success = msg.subtype === 'success'
          const output = this.extractOutput(msg, params.outputSchema)

          return {
            output: output.value,
            rawText: msg.result,
            sessionId: capturedSessionId,
            costUsd: msg.total_cost_usd ?? 0,
            numTurns: msg.num_turns ?? 0,
            durationMs: msg.duration_ms ?? 0,
            usage,
            success,
            errorMessage: success ? undefined : (msg.result ?? msg.subtype),
          }
        }
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      return {
        output: undefined,
        sessionId: capturedSessionId,
        costUsd: 0,
        numTurns: 0,
        durationMs: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        success: false,
        errorMessage,
      }
    } finally {
      if (q) q.close()
    }

    return {
      output: undefined,
      sessionId: capturedSessionId,
      costUsd: 0,
      numTurns: 0,
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      success: false,
      errorMessage: 'Session ended with no result',
    }
  }

  async preflight(): Promise<{ ok: boolean; error?: string }> {
    if (!process.env.ANTHROPIC_API_KEY) {
      return { ok: false, error: 'ANTHROPIC_API_KEY not set' }
    }
    return { ok: true }
  }

  private extractOutput(msg: { structured_output?: unknown; result?: string }, outputSchema?: object): { value: unknown } {
    if (msg.structured_output && typeof msg.structured_output === 'object') {
      return { value: msg.structured_output }
    }

    if (msg.result) {
      try {
        const parsed = JSON.parse(msg.result)
        if (typeof parsed === 'object' && parsed !== null) {
          return { value: parsed }
        }
      } catch {
        // Not JSON
      }

      if (!outputSchema) {
        return { value: msg.result }
      }
    }

    return { value: msg.result }
  }
}

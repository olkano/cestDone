// src/backends/claude-cli.ts
import { spawn, execFile, execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { Backend, BackendInvocation, BackendResult, BackendType } from '../shared/types.js'
import { mapSdkUsage, formatToolCall } from '../shared/types.js'
import { DEFAULTS } from '../shared/config.js'

const ALL_CLAUDE_CODE_TOOLS = [
  'Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'TodoRead', 'TodoWrite', 'NotebookRead', 'NotebookEdit',
]

// Claude Code internal tools that must always be blocked.
// These are not in the standard tool list but are available inside Claude Code sessions.
// Without blocking these, the Director can escape its lane by spawning subagents,
// entering plan mode, or prompting the user directly.
const ALWAYS_DENIED_TOOLS = [
  'ExitPlanMode', 'EnterPlanMode', 'Task', 'Agent', 'AskUserQuestion',
]

export function toDenylist(allowedTools?: string[]): string[] {
  if (!allowedTools) return []
  const denied = ALL_CLAUDE_CODE_TOOLS.filter(t => !allowedTools.includes(t))
  for (const tool of ALWAYS_DENIED_TOOLS) {
    if (!denied.includes(tool)) denied.push(tool)
  }
  return denied
}

interface CliJsonOutput {
  type: string
  subtype: string
  is_error: boolean
  duration_ms: number
  duration_api_ms: number
  num_turns: number
  result: string
  session_id: string
  total_cost_usd: number
  usage: unknown
  permission_denials: unknown[]
  uuid: string
}

interface StreamEvent {
  type: string      // 'system' | 'assistant' | 'user' | 'result'
  subtype?: string   // 'init' for system, 'success'/'error' for result
  session_id?: string
  message?: {
    content?: Array<{
      type: string   // 'text' | 'tool_use'
      text?: string
      name?: string
      input?: unknown
    }>
  }
  // Result fields (same as CliJsonOutput)
  is_error?: boolean
  duration_ms?: number
  duration_api_ms?: number
  num_turns?: number
  result?: string
  total_cost_usd?: number
  usage?: unknown
}

export function parseCliResult(stdout: string, outputSchema?: object): BackendResult {
  const parsed: CliJsonOutput = JSON.parse(stdout)

  const success = parsed.subtype === 'success'
  const resultText = parsed.result ?? ''

  let output: unknown = resultText
  let rawText: string | undefined = resultText

  if (outputSchema) {
    // Try to parse as JSON
    try {
      output = JSON.parse(resultText)
    } catch {
      // Try extracting JSON from text with preamble
      const match = resultText.match(/\{[\s\S]*\}/)
      if (match) {
        try {
          output = JSON.parse(match[0])
        } catch {
          // Model returned non-JSON despite schema — pass raw text to caller
          output = resultText
        }
      }
      // If no JSON found at all, output stays as resultText (raw string)
    }
  }

  return {
    output,
    rawText,
    sessionId: parsed.session_id,
    costUsd: null,
    numTurns: parsed.num_turns,
    durationMs: parsed.duration_ms,
    usage: mapSdkUsage(parsed.usage),
    success,
    errorMessage: success ? undefined : `CLI error (${parsed.subtype}): ${resultText}`,
  }
}

/** Parse a result-type stream event into BackendResult. */
export function parseStreamResultEvent(event: StreamEvent, outputSchema?: object): BackendResult {
  const resultText = event.result ?? ''
  // CLI may report success but return a non-useful result like "Prompt is too long"
  const isPromptTooLong = resultText.trim() === 'Prompt is too long'
  const success = event.subtype === 'success' && !isPromptTooLong
  let output: unknown = resultText
  const rawText: string | undefined = resultText

  if (outputSchema) {
    try {
      output = JSON.parse(resultText)
    } catch {
      const match = resultText.match(/\{[\s\S]*\}/)
      if (match) {
        try { output = JSON.parse(match[0]) } catch { output = resultText }
      }
    }
  }

  return {
    output,
    rawText,
    sessionId: event.session_id,
    costUsd: null,
    numTurns: event.num_turns ?? 0,
    durationMs: event.duration_ms ?? 0,
    usage: mapSdkUsage(event.usage),
    success,
    errorMessage: success ? undefined
      : isPromptTooLong ? 'Session context too large — prompt is too long. Consider starting a fresh session.'
      : `CLI error (${event.subtype}): ${resultText}`,
  }
}

const IS_WINDOWS = process.platform === 'win32'
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }

/**
 * Resolve a .cmd wrapper to the underlying node + script path.
 * On Windows, .cmd wrappers just call `node <script.js> %*`.
 * Spawning through cmd.exe mangles multiline arguments, so we
 * extract the script path and invoke node directly.
 */
export function resolveCmd(cmdPath: string): { bin: string; prefix: string[] } {
  if (!IS_WINDOWS) {
    return { bin: cmdPath, prefix: [] }
  }

  // If the path doesn't end with .cmd, try to locate the .cmd wrapper via `where`
  let resolvedPath = cmdPath
  if (!cmdPath.toLowerCase().endsWith('.cmd')) {
    try {
      const whereOutput = execFileSync('where', [cmdPath], { encoding: 'utf-8' })
      const cmdLine = whereOutput.split(/\r?\n/).find(l => l.toLowerCase().endsWith('.cmd'))
      if (cmdLine) resolvedPath = cmdLine.trim()
    } catch {
      return { bin: cmdPath, prefix: [] }
    }
  }

  if (!resolvedPath.toLowerCase().endsWith('.cmd')) {
    return { bin: cmdPath, prefix: [] }
  }

  try {
    const content = fs.readFileSync(resolvedPath, 'utf-8')
    // Match the pattern: "%_prog%"  "path\to\script.js" %*
    // or: "node"  "path\to\script.js" %*
    const match = content.match(/"%_prog%"\s+"([^"]+)"\s+%\*/) ||
                  content.match(/"node"\s+"([^"]+)"\s+%\*/)
    if (match) {
      const scriptDir = path.dirname(resolvedPath)
      // Replace %dp0% (cmd.exe variable for script directory) with actual dir
      const rawPath = match[1].replace(/%dp0%/gi, scriptDir + path.sep)
      const scriptPath = path.resolve(rawPath)
      if (fs.existsSync(scriptPath)) {
        return { bin: process.execPath, prefix: [scriptPath] }
      }
    }
  } catch {
    // Fall through to shell-based spawn
  }

  return { bin: cmdPath, prefix: [] }
}

export class ClaudeCliBackend implements Backend {
  readonly name: BackendType = 'claude-cli'

  constructor(private readonly cliPath: string = DEFAULTS.claudeCliPath) {}

  async invoke(params: BackendInvocation): Promise<BackendResult> {
    const args = this.buildArgs(params)
    const env = this.buildEnv(params.env)

    const emptyMcpConfigPath = path.join(os.tmpdir(), 'cestdone-empty-mcp.json')
    fs.writeFileSync(emptyMcpConfigPath, '{"mcpServers":{}}')
    args.push('--mcp-config', emptyMcpConfigPath)

    // Resolve .cmd wrapper to avoid shell mangling of multiline args
    const { bin, prefix } = resolveCmd(this.cliPath)
    const spawnArgs = [...prefix, ...args]
    const useShell = bin === this.cliPath && IS_WINDOWS // only if we couldn't resolve

    // Log the command for debugging (truncate prompt + system prompt)
    const debugArgs = spawnArgs.map((a, i) => {
      const prev = spawnArgs[i - 1]
      if ((prev === '-p' || prev === '--append-system-prompt') && a.length > 100) {
        return a.slice(0, 100) + '...'
      }
      return a
    })
    params.logger.log('CLI', `Spawning: ${bin} ${debugArgs.join(' ')}`)

    return new Promise<BackendResult>((resolve) => {
      const startTime = Date.now()
      const child = spawn(bin, spawnArgs, {
        cwd: params.cwd,
        env,
        shell: useShell,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      params.logger.log('CLI', `Process spawned (PID: ${child.pid ?? 'pending'})`)

      // Close stdin immediately — CLI reads prompt from args, not stdin.
      // Without this, the CLI may wait for stdin EOF before proceeding.
      child.stdin.end()

      let stderrText = ''
      let stdoutBuffer = '' // Line buffer for NDJSON
      let resultEvent: StreamEvent | undefined
      let sessionId: string | undefined
      let turnCount = 0

      const heartbeat = setInterval(() => {
        if (!resultEvent) {
          const elapsed = Math.round((Date.now() - startTime) / 1000)
          params.logger.log('CLI', `Still waiting... (${elapsed}s elapsed, turns: ${turnCount})`)
        }
      }, DEFAULTS.cliHeartbeatMs)

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString()
        // Process complete NDJSON lines
        let newlineIdx: number
        while ((newlineIdx = stdoutBuffer.indexOf('\n')) !== -1) {
          const line = stdoutBuffer.slice(0, newlineIdx).trim()
          stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1)
          if (!line) continue

          try {
            const event: StreamEvent = JSON.parse(line)
            this.handleStreamEvent(event, params, () => { turnCount++ })
            if (event.type === 'system' && event.session_id) {
              sessionId = event.session_id
            }
            if (event.type === 'result') {
              resultEvent = event
            }
          } catch {
            params.logger.logVerbose('CLI', `Non-JSON stdout line: ${line.slice(0, 200)}`)
          }
        }
      })

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        stderrText += text
        for (const line of text.split('\n')) {
          const trimmed = line.trim()
          if (trimmed) {
            params.logger.logVerbose('CLI', trimmed)
          }
        }
      })

      function finish(result: BackendResult) {
        clearInterval(heartbeat)
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        params.logger.log('CLI', `Completed in ${elapsed}s (success=${result.success})`)
        resolve(result)
      }

      child.on('error', (err: NodeJS.ErrnoException) => {
        const errorMessage = err.code === 'ENOENT'
          ? `claude binary not found (ENOENT): ${err.message}`
          : `CLI error: ${err.message}`
        params.logger.log('CLI', `Spawn error: ${errorMessage}`)
        finish({ output: null, sessionId: undefined, costUsd: null, numTurns: 0, durationMs: 0, usage: ZERO_USAGE, success: false, errorMessage })
      })

      child.on('close', (code) => {
        if (resultEvent) {
          const result = parseStreamResultEvent(resultEvent, params.outputSchema)
          // Prefer session_id from init event if result doesn't have one
          if (!result.sessionId && sessionId) result.sessionId = sessionId
          finish(result)
          return
        }

        // No result event — fall back to error handling
        const errorMessage = `CLI exited with code ${code} without result event: ${stderrText.slice(0, 500)}`
        params.logger.log('CLI', errorMessage)
        finish({ output: null, rawText: stderrText, sessionId, costUsd: null, numTurns: 0, durationMs: 0, usage: ZERO_USAGE, success: false, errorMessage })
      })
    })
  }

  async preflight(): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      execFile(
        this.cliPath,
        ['--version'],
        { shell: IS_WINDOWS },
        (err) => {
          if (err) {
            resolve({ ok: false, error: `claude binary not found at '${this.cliPath}': ${err.message}` })
          } else {
            resolve({ ok: true })
          }
        },
      )
    })
  }

  private handleStreamEvent(
    event: StreamEvent,
    params: BackendInvocation,
    onTurn: () => void,
  ): void {
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && block.name) {
          params.logger.log('CLI', `Tool: ${formatToolCall(block.name, block.input)}`)
        } else if (block.type === 'text' && block.text) {
          params.logger.logVerbose('CLI', `Text: ${block.text.slice(0, 300)}`)
        }
      }
      onTurn()
    }
  }

  private buildArgs(params: BackendInvocation): string[] {
    const args: string[] = [
      '-p', params.prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--model', params.model,
      '--strict-mcp-config',
    ]

    if (!params.resumeSessionId && params.systemPrompt) {
      let sysPrompt = params.systemPrompt
      if (params.outputSchema) {
        sysPrompt += `\n\nYou MUST respond with valid JSON matching this schema:\n${JSON.stringify(params.outputSchema, null, 2)}`
      }
      args.push('--append-system-prompt', sysPrompt)
    }

    if (params.resumeSessionId) {
      args.push('--resume', params.resumeSessionId)
    }

    if (params.maxTurns != null) {
      args.push('--max-turns', String(params.maxTurns))
    }

    const denylist = toDenylist(params.tools)
    if (denylist.length > 0) {
      args.push('--disallowedTools', ...denylist)
    }

    return args
  }

  private buildEnv(env?: Record<string, string | undefined>): Record<string, string> {
    // Start with current process env so child inherits PATH, HOME, etc.
    const result: Record<string, string> = { ...process.env } as Record<string, string>

    // Overlay any custom env vars from params
    if (env) {
      for (const [k, v] of Object.entries(env)) {
        if (v !== undefined) result[k] = v
        else delete result[k]
      }
    }

    // Strip keys that would interfere with CLI subscription billing or cause recursion
    delete result.ANTHROPIC_API_KEY
    delete result.CLAUDECODE

    return result
  }
}

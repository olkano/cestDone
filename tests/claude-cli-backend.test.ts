// tests/claude-cli-backend.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { BackendInvocation } from '../src/shared/types.js'

vi.mock('node:child_process')

import { spawn, execFile } from 'node:child_process'

function makeInvocation(overrides: Partial<BackendInvocation> = {}): BackendInvocation {
  return {
    prompt: 'test prompt',
    systemPrompt: 'test system prompt',
    model: 'claude-sonnet-4-6',
    tools: ['Read', 'Glob', 'Grep'],
    outputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    cwd: '/test/repo',
    maxTurns: 15,
    env: { PATH: '/usr/bin', OTHER: 'value' },
    logger: { log: vi.fn(), logVerbose: vi.fn(), logFilePath: '' },
    ...overrides,
  }
}

function makeStreamOutput(resultOverrides: Record<string, unknown> = {}) {
  const initEvent = JSON.stringify({
    type: 'system', subtype: 'init', session_id: 'sess-cli-1',
    tools: ['Read', 'Glob', 'Grep'], model: 'claude-sonnet-4-6',
  })
  const resultEvent = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 2000,
    duration_api_ms: 1800,
    num_turns: 3,
    result: '{"action":"done","message":"ok"}',
    session_id: 'sess-cli-1',
    total_cost_usd: 0.05,
    usage: {
      input_tokens: 500,
      output_tokens: 200,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50,
    },
    permission_denials: [],
    uuid: 'uuid-1',
    ...resultOverrides,
  })
  return initEvent + '\n' + resultEvent + '\n'
}

// Legacy single-JSON format for parseCliResult tests
function makeCliOutput(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 2000,
    duration_api_ms: 1800,
    num_turns: 3,
    result: '{"action":"done","message":"ok"}',
    session_id: 'sess-cli-1',
    total_cost_usd: 0.05,
    usage: {
      input_tokens: 500,
      output_tokens: 200,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50,
    },
    permission_denials: [],
    uuid: 'uuid-1',
    ...overrides,
  })
}

function createMockChild(stdout: string, stderr = '', exitCode = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { end: ReturnType<typeof vi.fn> }
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: vi.fn() }

  // Emit events on next tick so listeners are attached first
  process.nextTick(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout))
    if (stderr) child.stderr.emit('data', Buffer.from(stderr))
    child.emit('close', exitCode)
  })

  return child
}

function createMockChildError() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { end: ReturnType<typeof vi.fn> }
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: vi.fn() }

  process.nextTick(() => {
    const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
    child.emit('error', err)
  })

  return child
}

function mockSpawnSuccess(stdout: string) {
  ;(spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(createMockChild(stdout))
}

function mockSpawnExitError(stderr: string, exitCode = 1) {
  ;(spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(createMockChild('', stderr, exitCode))
}

function mockSpawnError() {
  ;(spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(createMockChildError())
}

function getSpawnArgs(): { cmd: string; args: string[]; opts: Record<string, unknown> } {
  const call = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
  return { cmd: call[0], args: call[1], opts: call[2] }
}

describe('toDenylist', () => {
  let toDenylist: typeof import('../src/backends/claude-cli.js').toDenylist

  beforeEach(async () => {
    const mod = await import('../src/backends/claude-cli.js')
    toDenylist = mod.toDenylist
  })

  it('returns empty array when no tools specified (no restriction)', () => {
    expect(toDenylist(undefined)).toEqual([])
  })

  it('returns only internal tools when all standard tools allowed', () => {
    const allStandard = ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep',
      'WebFetch', 'WebSearch', 'TodoRead', 'TodoWrite', 'NotebookRead', 'NotebookEdit']
    const denied = toDenylist(allStandard)
    expect(denied).not.toContain('Read')
    expect(denied).not.toContain('Write')
    expect(denied).toContain('ExitPlanMode')
    expect(denied).toContain('Task')
    expect(denied).toContain('Agent')
  })

  it('computes correct denylist for read-only tools', () => {
    const denied = toDenylist(['Read', 'Glob', 'Grep'])
    expect(denied).toContain('Write')
    expect(denied).toContain('Edit')
    expect(denied).toContain('MultiEdit')
    expect(denied).toContain('Bash')
    expect(denied).not.toContain('Read')
    expect(denied).not.toContain('Glob')
    expect(denied).not.toContain('Grep')
  })

  it('computes correct denylist for read+bash tools (review step)', () => {
    const denied = toDenylist(['Read', 'Glob', 'Grep', 'Bash'])
    expect(denied).toContain('Write')
    expect(denied).toContain('Edit')
    expect(denied).toContain('MultiEdit')
    expect(denied).not.toContain('Bash')
  })

  it('excludes only non-standard tools for full edit access', () => {
    const denied = toDenylist(['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep'])
    expect(denied).not.toContain('Read')
    expect(denied).not.toContain('Bash')
    expect(denied).toContain('WebFetch')
    expect(denied).toContain('WebSearch')
  })

  it('always denies internal Claude Code tools (ExitPlanMode, Task, Agent, etc.)', () => {
    const denied = toDenylist(['Read', 'Glob', 'Grep'])
    expect(denied).toContain('ExitPlanMode')
    expect(denied).toContain('EnterPlanMode')
    expect(denied).toContain('Task')
    expect(denied).toContain('Agent')
    expect(denied).toContain('AskUserQuestion')
  })

  it('denies internal tools even when all standard tools are allowed', () => {
    const allStandard = ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Glob', 'Grep',
      'WebFetch', 'WebSearch', 'TodoRead', 'TodoWrite', 'NotebookRead', 'NotebookEdit']
    const denied = toDenylist(allStandard)
    expect(denied).toContain('ExitPlanMode')
    expect(denied).toContain('EnterPlanMode')
    expect(denied).toContain('Task')
    expect(denied).toContain('Agent')
    expect(denied).toContain('AskUserQuestion')
  })
})

describe('parseCliResult', () => {
  let parseCliResult: typeof import('../src/backends/claude-cli.js').parseCliResult

  beforeEach(async () => {
    const mod = await import('../src/backends/claude-cli.js')
    parseCliResult = mod.parseCliResult
  })

  it('parses clean JSON result field', () => {
    const result = parseCliResult(makeCliOutput(), { type: 'object' })
    expect(result.output).toEqual({ action: 'done', message: 'ok' })
    expect(result.sessionId).toBe('sess-cli-1')
    expect(result.numTurns).toBe(3)
    expect(result.durationMs).toBe(2000)
    expect(result.success).toBe(true)
  })

  it('extracts JSON from text with preamble', () => {
    const stdout = makeCliOutput({ result: 'Here is the response:\n{"action":"done","message":"ok"}' })
    const result = parseCliResult(stdout, { type: 'object' })
    expect(result.output).toEqual({ action: 'done', message: 'ok' })
  })

  it('returns raw text when no schema provided', () => {
    const stdout = makeCliOutput({ result: 'hello world' })
    const result = parseCliResult(stdout, undefined)
    expect(result.output).toBe('hello world')
    expect(result.rawText).toBe('hello world')
  })

  it('returns success:false for error subtypes', () => {
    const stdout = makeCliOutput({ subtype: 'error_max_turns', result: 'hit max turns' })
    const result = parseCliResult(stdout, undefined)
    expect(result.success).toBe(false)
    expect(result.errorMessage).toBeDefined()
  })

  it('sets costUsd to null (subscription)', () => {
    const result = parseCliResult(makeCliOutput(), undefined)
    expect(result.costUsd).toBeNull()
  })

  it('maps usage fields to TokenUsage', () => {
    const result = parseCliResult(makeCliOutput(), undefined)
    expect(result.usage).toEqual({
      inputTokens: 500,
      outputTokens: 200,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 50,
    })
  })

  it('returns raw text when JSON unparseable despite schema', () => {
    const stdout = makeCliOutput({ result: 'I could not do it' })
    const result = parseCliResult(stdout, { type: 'object' })
    expect(result.output).toBe('I could not do it')
    expect(result.rawText).toBe('I could not do it')
  })
})

describe('parseStreamResultEvent', () => {
  let parseStreamResultEvent: typeof import('../src/backends/claude-cli.js').parseStreamResultEvent

  beforeEach(async () => {
    const mod = await import('../src/backends/claude-cli.js')
    parseStreamResultEvent = mod.parseStreamResultEvent
  })

  it('parses a success result event', () => {
    const event = {
      type: 'result', subtype: 'success', session_id: 'sess-1',
      num_turns: 5, duration_ms: 3000, result: '{"action":"done","message":"ok"}',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
    const result = parseStreamResultEvent(event, { type: 'object' })
    expect(result.success).toBe(true)
    expect(result.output).toEqual({ action: 'done', message: 'ok' })
    expect(result.sessionId).toBe('sess-1')
    expect(result.numTurns).toBe(5)
  })

  it('parses an error result event', () => {
    const event = {
      type: 'result', subtype: 'error_max_turns', result: 'hit max turns',
      num_turns: 15, duration_ms: 600000,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
    const result = parseStreamResultEvent(event)
    expect(result.success).toBe(false)
    expect(result.errorMessage).toContain('error_max_turns')
  })
})

describe('ClaudeCliBackend', () => {
  let ClaudeCliBackend: typeof import('../src/backends/claude-cli.js').ClaudeCliBackend

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../src/backends/claude-cli.js')
    ClaudeCliBackend = mod.ClaudeCliBackend
  })

  describe('name', () => {
    it('returns claude-cli', () => {
      const backend = new ClaudeCliBackend()
      expect(backend.name).toBe('claude-cli')
    })
  })

  describe('invoke()', () => {
    it('spawns claude with correct base flags', async () => {
      mockSpawnSuccess(makeStreamOutput())
      const backend = new ClaudeCliBackend()

      await backend.invoke(makeInvocation())

      const { cmd, args } = getSpawnArgs()
      expect(cmd).toBe('claude')
      expect(args).toContain('-p')
      expect(args).toContain('test prompt')
      expect(args).toContain('--output-format')
      expect(args).toContain('stream-json')
      expect(args).toContain('--verbose')
      expect(args).toContain('--dangerously-skip-permissions')
    })

    it('includes --model flag', async () => {
      mockSpawnSuccess(makeStreamOutput())
      const backend = new ClaudeCliBackend()

      await backend.invoke(makeInvocation({ model: 'claude-opus-4-6' }))

      const { args } = getSpawnArgs()
      expect(args).toContain('--model')
      expect(args).toContain('claude-opus-4-6')
    })

    it('includes --append-system-prompt when systemPrompt provided', async () => {
      mockSpawnSuccess(makeStreamOutput())
      const backend = new ClaudeCliBackend()

      await backend.invoke(makeInvocation({ systemPrompt: 'You are a Director AI.' }))

      const { args } = getSpawnArgs()
      expect(args).toContain('--append-system-prompt')
      const idx = args.indexOf('--append-system-prompt')
      expect(args[idx + 1]).toContain('You are a Director AI.')
    })

    it('includes --disallowedTools computed from tools whitelist', async () => {
      mockSpawnSuccess(makeStreamOutput())
      const backend = new ClaudeCliBackend()

      await backend.invoke(makeInvocation({ tools: ['Read', 'Glob', 'Grep'] }))

      const { args } = getSpawnArgs()
      expect(args).toContain('--disallowedTools')
      const idx = args.indexOf('--disallowedTools')
      const deniedTools = args.slice(idx + 1).filter((a: string) => !a.startsWith('--'))
      expect(deniedTools).toContain('Write')
      expect(deniedTools).toContain('Edit')
      expect(deniedTools).toContain('Bash')
      expect(deniedTools).not.toContain('Read')
    })

    it('includes --resume when resumeSessionId provided', async () => {
      mockSpawnSuccess(makeStreamOutput())
      const backend = new ClaudeCliBackend()

      await backend.invoke(makeInvocation({ resumeSessionId: 'sess-123' }))

      const { args } = getSpawnArgs()
      expect(args).toContain('--resume')
      expect(args).toContain('sess-123')
    })

    it('includes --max-turns when maxTurns provided', async () => {
      mockSpawnSuccess(makeStreamOutput())
      const backend = new ClaudeCliBackend()

      await backend.invoke(makeInvocation({ maxTurns: 20 }))

      const { args } = getSpawnArgs()
      expect(args).toContain('--max-turns')
      expect(args).toContain('20')
    })

    it('ignores maxBudgetUsd (no CLI equivalent)', async () => {
      mockSpawnSuccess(makeStreamOutput())
      const backend = new ClaudeCliBackend()

      await backend.invoke(makeInvocation({ maxBudgetUsd: 5.0 }))

      const { args } = getSpawnArgs()
      expect(args.join(' ')).not.toContain('budget')
    })

    it('strips ANTHROPIC_API_KEY and CLAUDECODE from env, inherits process.env', async () => {
      mockSpawnSuccess(makeStreamOutput())
      const backend = new ClaudeCliBackend()

      await backend.invoke(makeInvocation({
        env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-test', CLAUDECODE: '1' },
      }))

      const { opts } = getSpawnArgs()
      const env = opts.env as Record<string, string>
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.CLAUDECODE).toBeUndefined()
      // Custom env overlays process.env
      expect(env.PATH).toBe('/usr/bin')
      // process.env keys are inherited (at least some exist)
      expect(Object.keys(env).length).toBeGreaterThan(2)
    })

    it('uses --strict-mcp-config with empty config', async () => {
      mockSpawnSuccess(makeStreamOutput())
      const backend = new ClaudeCliBackend()

      await backend.invoke(makeInvocation())

      const { args } = getSpawnArgs()
      expect(args).toContain('--strict-mcp-config')
      expect(args).toContain('--mcp-config')
    })

    it('sets cwd on spawn options', async () => {
      mockSpawnSuccess(makeStreamOutput())
      const backend = new ClaudeCliBackend()

      await backend.invoke(makeInvocation({ cwd: '/my/repo' }))

      const { opts } = getSpawnArgs()
      expect(opts.cwd).toBe('/my/repo')
    })

    it('closes stdin immediately to unblock CLI', async () => {
      const mockChild = createMockChild(makeStreamOutput())
      ;(spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockChild)
      const backend = new ClaudeCliBackend()

      await backend.invoke(makeInvocation())

      expect(mockChild.stdin.end).toHaveBeenCalled()
    })

    it('parses stdout as CLI JSON and returns BackendResult', async () => {
      mockSpawnSuccess(makeStreamOutput())
      const backend = new ClaudeCliBackend()

      const result = await backend.invoke(makeInvocation())

      expect(result.success).toBe(true)
      expect(result.output).toEqual({ action: 'done', message: 'ok' })
      expect(result.sessionId).toBe('sess-cli-1')
      expect(result.costUsd).toBeNull()
      expect(result.numTurns).toBe(3)
      expect(result.durationMs).toBe(2000)
    })

    it('handles non-zero exit code', async () => {
      mockSpawnExitError('Command failed', 1)
      const backend = new ClaudeCliBackend()

      const result = await backend.invoke(makeInvocation())

      expect(result.success).toBe(false)
      expect(result.errorMessage).toBeDefined()
    })

    it('handles spawn error (ENOENT)', async () => {
      mockSpawnError()
      const backend = new ClaudeCliBackend()

      const result = await backend.invoke(makeInvocation())

      expect(result.success).toBe(false)
      expect(result.errorMessage).toContain('ENOENT')
    })

    it('omits --append-system-prompt when resuming', async () => {
      mockSpawnSuccess(makeStreamOutput())
      const backend = new ClaudeCliBackend()

      await backend.invoke(makeInvocation({ resumeSessionId: 'sess-123', systemPrompt: 'ignored' }))

      const { args } = getSpawnArgs()
      expect(args).not.toContain('--append-system-prompt')
    })

    it('appends JSON instructions to system prompt when outputSchema provided', async () => {
      mockSpawnSuccess(makeStreamOutput())
      const backend = new ClaudeCliBackend()

      await backend.invoke(makeInvocation({
        systemPrompt: 'You are a Director.',
        outputSchema: { type: 'object', properties: { action: { type: 'string' } } },
      }))

      const { args } = getSpawnArgs()
      const idx = args.indexOf('--append-system-prompt')
      const sysPrompt = args[idx + 1]
      expect(sysPrompt).toContain('You are a Director.')
      expect(sysPrompt).toContain('JSON')
    })

    it('does not include --disallowedTools when no tools specified', async () => {
      mockSpawnSuccess(makeStreamOutput())
      const backend = new ClaudeCliBackend()

      await backend.invoke(makeInvocation({ tools: undefined }))

      const { args } = getSpawnArgs()
      expect(args).not.toContain('--disallowedTools')
    })

    it('uses custom cli path', async () => {
      mockSpawnSuccess(makeStreamOutput())
      const backend = new ClaudeCliBackend('/custom/claude')

      await backend.invoke(makeInvocation())

      const { cmd } = getSpawnArgs()
      expect(cmd).toBe('/custom/claude')
    })

    it('logs tool calls from stream events in real-time', async () => {
      const assistantEvent = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/foo/bar.ts' } },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } },
          ],
        },
      })
      const initEvent = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-cli-1' })
      const resultEvent = JSON.stringify({
        type: 'result', subtype: 'success', num_turns: 2, duration_ms: 1000,
        result: '"done"', session_id: 'sess-cli-1',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      })
      const streamOutput = [initEvent, assistantEvent, resultEvent].join('\n') + '\n'

      mockSpawnSuccess(streamOutput)
      const backend = new ClaudeCliBackend()
      const logger = { log: vi.fn(), logVerbose: vi.fn(), logFilePath: '' }

      await backend.invoke(makeInvocation({ logger }))

      const logCalls = logger.log.mock.calls.map((c: string[]) => c[1])
      expect(logCalls).toContainEqual('Tool: Read(/foo/bar.ts)')
      expect(logCalls).toContainEqual('Tool: Grep(TODO)')
    })
  })

  describe('preflight()', () => {
    it('returns ok when claude binary exists', async () => {
      ;(execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
          cb(null, '1.0.102')
          return { pid: 1234 }
        }
      )
      const backend = new ClaudeCliBackend()

      const result = await backend.preflight()

      expect(result).toEqual({ ok: true })
    })

    it('returns error when claude binary not found', async () => {
      ;(execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (err: NodeJS.ErrnoException) => void) => {
          cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
          return { pid: 1234 }
        }
      )
      const backend = new ClaudeCliBackend()

      const result = await backend.preflight()

      expect(result.ok).toBe(false)
      expect(result.error).toContain('claude')
    })

    it('uses custom cli path', async () => {
      ;(execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
          cb(null, '1.0.102')
          return { pid: 1234 }
        }
      )
      const backend = new ClaudeCliBackend('/usr/local/bin/claude')

      await backend.preflight()

      const call = (execFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(call[0]).toBe('/usr/local/bin/claude')
    })
  })
})

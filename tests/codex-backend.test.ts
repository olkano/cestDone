import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { CodexSdkBackend, buildCodexEnvironment, normalizeCodexUsage } from '../src/backends/codex-sdk.js'
import type { ResolvedAgentSelection } from '../src/shared/types.js'

const logger = { log: vi.fn(), logVerbose: vi.fn(), logFilePath: '' }
const selection: ResolvedAgentSelection = {
  profileName: 'codex', provider: 'codex', backend: 'codex-sdk', model: 'gpt-test',
  reasoningEffort: 'medium', callTimeoutMs: 1000, webSearchMode: 'disabled',
}
const runtime = { executablePath: process.execPath, helperPaths: [], expectedVersion: '0.155.1' }

async function* events(values: unknown[]) {
  for (const value of values) yield value
}

function fakeClient(values: unknown[]) {
  const thread = { runStreamed: vi.fn().mockResolvedValue({ events: events(values) }) }
  return {
    thread,
    client: {
      startThread: vi.fn().mockReturnValue(thread),
      resumeThread: vi.fn().mockReturnValue(thread),
    },
  }
}

describe('Codex environment', () => {
  it('rejects API-key billing and strips provider credentials from the child', () => {
    expect(() => buildCodexEnvironment({ CODEX_API_KEY: 'forbidden' }, {}, 'C:\\codex-home', true)).toThrow(/CODEX_API_KEY/)
    const env = buildCodexEnvironment(
      { Path: 'one', OPENAI_API_KEY: 'strip', CODEX_ACCESS_TOKEN: 'strip', APP_TOKEN: 'keep' },
      { PATH: 'two' },
      'C:\\codex-home',
      true,
    )
    expect(env.PATH).toBe('two')
    expect(env.CODEX_HOME).toBe('C:\\codex-home')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.CODEX_ACCESS_TOKEN).toBeUndefined()
    expect(env.APP_TOKEN).toBe('keep')
  })
})

describe('Codex usage normalization', () => {
  it('subtracts cumulative thread usage before producing exclusive buckets', () => {
    const first = normalizeCodexUsage({ input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 30, reasoning_output_tokens: 5 })
    const second = normalizeCodexUsage({ input_tokens: 160, cached_input_tokens: 60, cache_write_input_tokens: 20, output_tokens: 45, reasoning_output_tokens: 8 }, first.raw)
    expect(second.usage).toEqual({ inputTokens: 30, cacheReadInputTokens: 20, cacheCreationInputTokens: 10, outputTokens: 15 })
    expect(second.reasoningOutputTokens).toBe(3)
  })

  it('rejects decreasing or overlapping counters', () => {
    expect(() => normalizeCodexUsage({ input_tokens: 10, cached_input_tokens: 8, cache_write_input_tokens: 4, output_tokens: 1, reasoning_output_tokens: 0 })).toThrow(/usage/i)
    expect(() => normalizeCodexUsage({ input_tokens: 9, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }, { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 })).toThrow(/decreased/i)
  })
})

describe('CodexSdkBackend', () => {
  it('preflights the pinned runtime and accepts only saved ChatGPT login', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-codex-home-'))
    const calls: Array<{ args: string[]; env: Record<string, string> }> = []
    const runCommand = vi.fn(async (_file: string, args: string[], env: Record<string, string>) => {
      calls.push({ args, env })
      return args[0] === '--version'
        ? { code: 0, stdout: 'codex-cli 0.155.1', stderr: '' }
        : { code: 0, stdout: 'Logged in using ChatGPT', stderr: '' }
    })
    const backend = new CodexSdkBackend(selection, { runtime, codexHome: home, runCommand })
    await expect(backend.preflight({ cwd: process.cwd() })).resolves.toMatchObject({ ok: true, billingMode: 'subscription', runtimeVersion: '0.155.1' })
    expect(calls.map(call => call.args)).toEqual([['--version'], ['login', 'status']])
    expect(calls.every(call => call.env.CODEX_HOME === home)).toBe(true)
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('rejects non-ChatGPT login and API overrides before starting a client', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-codex-home-'))
    const apiBackend = new CodexSdkBackend(selection, { runtime, codexHome: home, env: { CODEX_API_KEY: 'sk-secret-marker' }, runCommand: vi.fn() })
    await expect(apiBackend.preflight({ cwd: process.cwd() })).resolves.toMatchObject({ ok: false, errorCategory: 'configuration_error' })
    const loginBackend = new CodexSdkBackend(selection, {
      runtime, codexHome: home,
      runCommand: vi.fn(async (_file, args) => args[0] === '--version'
        ? { code: 0, stdout: 'codex-cli 0.155.1', stderr: '' }
        : { code: 0, stdout: 'Logged in using an API key', stderr: '' }),
    })
    await expect(loginBackend.preflight({ cwd: process.cwd() })).resolves.toMatchObject({ ok: false, errorCategory: 'authentication_failed' })
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('requires an exact native runtime version', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-codex-home-'))
    const backend = new CodexSdkBackend(selection, {
      runtime, codexHome: home,
      runCommand: vi.fn().mockResolvedValue({ code: 0, stdout: 'codex-cli 0.155.10', stderr: '' }),
    })
    await expect(backend.preflight({ cwd: process.cwd() })).resolves.toMatchObject({ ok: false, errorCategory: 'runtime_missing' })
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('classifies a preflight process timeout', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-codex-home-'))
    const backend = new CodexSdkBackend(selection, {
      runtime, codexHome: home,
      runCommand: vi.fn().mockResolvedValue({ code: 124, stdout: '', stderr: '' }),
    })
    await expect(backend.preflight({ cwd: process.cwd() })).resolves.toMatchObject({ ok: false, errorCategory: 'timeout' })
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('collects a complete streamed turn and validates structured output', async () => {
    const f = fakeClient([
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', status: 'in_progress', command: 'node --test', aggregated_output: '' } },
      { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', status: 'completed', command: 'node --test', aggregated_output: '', exit_code: 0 } },
      { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: '{"action":"done","message":"ok","questions":null}' } },
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 30, reasoning_output_tokens: 5 } },
    ])
    const backend = new CodexSdkBackend(selection, { clientFactory: () => f.client as never, skipPreflight: true, runtime })
    const result = await backend.invoke({
      prompt: 'review', model: 'gpt-test', cwd: process.cwd(), accessMode: 'read-only',
      outputSchema: {
        type: 'object', additionalProperties: false,
        required: ['action', 'message', 'questions'],
        properties: { action: { const: 'done' }, message: { type: 'string' }, questions: { type: ['array', 'null'], items: { type: 'string' } } },
      },
      logger,
    })
    expect(result).toMatchObject({ success: true, sessionId: 'thread-1', billingMode: 'subscription', usageStatus: 'reported', numTurns: 1 })
    expect(result.output).toEqual({ action: 'done', message: 'ok', questions: null })
    expect(result.toolCalls).toEqual({ command_execution: 1 })
    expect(f.client.startThread).toHaveBeenCalledWith(expect.objectContaining({ sandboxMode: 'read-only', approvalPolicy: 'never' }))
  })

  it('fails closed on incomplete streams and schema violations', async () => {
    const incomplete = fakeClient([{ type: 'thread.started', thread_id: 'thread-1' }])
    const backend = new CodexSdkBackend(selection, { clientFactory: () => incomplete.client as never, skipPreflight: true, runtime })
    const result = await backend.invoke({ prompt: 'x', model: 'gpt-test', cwd: process.cwd(), logger })
    expect(result).toMatchObject({ success: false, errorCategory: 'process_failed', usageStatus: 'unavailable' })

    const invalid = fakeClient([
      { type: 'thread.started', thread_id: 'thread-2' },
      { type: 'item.completed', item: { id: 'msg', type: 'agent_message', text: 'not-json' } },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
    ])
    const backend2 = new CodexSdkBackend(selection, { clientFactory: () => invalid.client as never, skipPreflight: true, runtime })
    const invalidResult = await backend2.invoke({ prompt: 'x', model: 'gpt-test', cwd: process.cwd(), outputSchema: { type: 'object' }, logger })
    expect(invalidResult).toMatchObject({ success: false, errorCategory: 'schema_violation', usageStatus: 'reported' })
  })

  it('preserves completed usage when the stream fails after completion', async () => {
    async function* brokenEvents() {
      yield { type: 'thread.started', thread_id: 'thread-broken' }
      yield { type: 'turn.completed', usage: { input_tokens: 7, cached_input_tokens: 2, cache_write_input_tokens: 1, output_tokens: 3, reasoning_output_tokens: 1 } }
      throw new Error('child exited with sk-secret-marker OPENAI_API_KEY=synthetic-marker')
    }
    const client = {
      startThread: vi.fn().mockReturnValue({ runStreamed: vi.fn().mockResolvedValue({ events: brokenEvents() }) }),
      resumeThread: vi.fn(),
    }
    const backend = new CodexSdkBackend(selection, { clientFactory: () => client as never, skipPreflight: true, runtime })
    const result = await backend.invoke({ prompt: 'x', model: 'gpt-test', cwd: process.cwd(), logger })
    expect(result).toMatchObject({ success: false, usageStatus: 'reported', sessionId: 'thread-broken' })
    expect(result.usage).toEqual({ inputTokens: 4, cacheReadInputTokens: 2, cacheCreationInputTokens: 1, outputTokens: 3 })
    expect(result.errorMessage).not.toContain('sk-secret-marker')
    expect(result.errorMessage).not.toContain('synthetic-marker')
  })

  it('aborts an active stream at the call deadline and waits for settlement', async () => {
    let settled = false
    const thread = {
      runStreamed: vi.fn(async (_prompt: string, options?: { signal?: AbortSignal }) => ({
        events: (async function* () {
          try {
            await new Promise<void>((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            })
          } finally {
            settled = true
          }
        })(),
      })),
    }
    const client = { startThread: vi.fn().mockReturnValue(thread), resumeThread: vi.fn() }
    const backend = new CodexSdkBackend(selection, { clientFactory: () => client as never, skipPreflight: true, runtime })
    const result = await backend.invoke({ prompt: 'x', model: 'gpt-test', cwd: process.cwd(), timeoutMs: 5, logger })
    expect(result).toMatchObject({ success: false, errorCategory: 'timeout', usageStatus: 'unavailable' })
    expect(settled).toBe(true)
  })

  it('returns cancellation_incomplete only after the cleanup watchdog and pauses overlap until settlement', async () => {
    async function* ignoresAbort() {
      await new Promise(resolve => setTimeout(resolve, 40))
      yield { type: 'thread.started', thread_id: 'late-thread' }
    }
    const thread = { runStreamed: vi.fn().mockResolvedValue({ events: ignoresAbort() }) }
    const client = { startThread: vi.fn().mockReturnValue(thread), resumeThread: vi.fn() }
    const backend = new CodexSdkBackend(selection, {
      clientFactory: () => client as never, skipPreflight: true, runtime, cancellationWatchdogMs: 10,
    })
    const result = await backend.invoke({ prompt: 'x', model: 'gpt-test', cwd: process.cwd(), timeoutMs: 5, logger })
    expect(result).toMatchObject({ success: false, errorCategory: 'cancellation_incomplete' })
    let overlapSettled = false
    const overlap = backend.invoke({ prompt: 'overlap', model: 'gpt-test', cwd: process.cwd(), logger })
      .finally(() => { overlapSettled = true })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(overlapSettled).toBe(false)
    await expect(overlap).resolves.toMatchObject({ success: false, errorCategory: 'process_failed' })
  })

  it('resumes only adapter-owned matching threads and uses cumulative deltas', async () => {
    const first = fakeClient([
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'first' } },
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 1, output_tokens: 5, reasoning_output_tokens: 1 } },
    ])
    const second = fakeClient([
      { type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'second' } },
      { type: 'turn.completed', usage: { input_tokens: 16, cached_input_tokens: 3, cache_write_input_tokens: 2, output_tokens: 8, reasoning_output_tokens: 2 } },
    ])
    let call = 0
    const backend = new CodexSdkBackend(selection, { clientFactory: () => (++call === 1 ? first.client : second.client) as never, skipPreflight: true, runtime })
    const one = await backend.invoke({ prompt: 'one', systemPrompt: 'rules', model: 'gpt-test', cwd: process.cwd(), logger })
    const two = await backend.invoke({ prompt: 'two', systemPrompt: 'rules', model: 'gpt-test', cwd: process.cwd(), resumeSessionId: one.sessionId, logger })
    expect(two.usage).toEqual({ inputTokens: 4, cacheReadInputTokens: 1, cacheCreationInputTokens: 1, outputTokens: 3 })
    expect(second.client.resumeThread).toHaveBeenCalledWith('thread-1', expect.anything())
    await expect(backend.invoke({ prompt: 'x', model: 'gpt-test', cwd: process.cwd(), resumeSessionId: 'unknown', logger })).resolves.toMatchObject({ success: false, errorCategory: 'configuration_error' })
  })
})

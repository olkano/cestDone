import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Ajv } from 'ajv'
import { Codex, type CodexOptions, type ThreadEvent, type ThreadOptions } from '@openai/codex-sdk'
import type {
  Backend,
  BackendCapabilities,
  BackendInvocation,
  BackendResult,
  BackendErrorCategory,
  ResolvedAgentSelection,
  TokenUsage,
} from '../shared/types.js'
import { resolveCodexRuntime, SUPPORTED_CODEX_VERSION, type CodexRuntime } from './codex-runtime.js'

const ajv = new Ajv({ allErrors: true, strict: false })
const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
const AUTH_KEYS = new Set(['CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL', 'CESTDONE_CODEX_HOME'])
const SHELL_ENVIRONMENT_POLICY = 'shell_environment_policy={inherit="all",ignore_default_excludes=true,filters={"CODEX_API_KEY"="exclude","OPENAI_API_KEY"="exclude","CODEX_ACCESS_TOKEN"="exclude"},set={}}'
const CONFIG_OVERRIDES = [SHELL_ENVIRONMENT_POLICY]
const CANCELLATION_WATCHDOG_MS = 10_000
const unsettledCancellations = new Set<Promise<void>>()

export interface RawCodexUsage {
  input_tokens: number
  cached_input_tokens: number
  cache_write_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
}

interface CodexThreadLike {
  runStreamed(input: string, options?: { outputSchema?: unknown; signal?: AbortSignal }): Promise<{ events: AsyncGenerator<ThreadEvent> }>
}

interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike
}

interface ThreadState {
  provider: 'codex'
  model: string
  cwd: string
  home: string
  systemPrompt?: string
  lastUsage?: RawCodexUsage
  baselineUsable: boolean
}

export interface CodexBackendOptions {
  clientFactory?: (options: CodexOptions) => CodexClientLike
  runtime?: CodexRuntime
  env?: NodeJS.ProcessEnv
  codexHome?: string
  skipPreflight?: boolean
  cancellationWatchdogMs?: number
  usageObserver?: (current: Readonly<RawCodexUsage>, previous: Readonly<RawCodexUsage> | undefined, normalized: Readonly<ReturnType<typeof normalizeCodexUsage>>) => void
  runCommand?: (file: string, args: string[], env: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>
}

export function buildCodexEnvironment(
  parent: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv,
  codexHome: string,
  caseInsensitive = process.platform === 'win32',
  helperPaths: string[] = [],
): Record<string, string> {
  const combined = new Map<string, { key: string; value: string }>()
  const normalized = (key: string) => caseInsensitive ? key.toUpperCase() : key
  for (const source of [parent, overrides]) {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue
      combined.set(normalized(key), { key, value })
    }
  }
  const apiKey = combined.get(normalized('CODEX_API_KEY'))?.value
  if (apiKey?.trim()) throw new Error('CODEX_API_KEY is prohibited; Codex must use saved ChatGPT login')
  for (const key of AUTH_KEYS) combined.delete(normalized(key))
  const result: Record<string, string> = {}
  for (const { key, value } of combined.values()) result[key] = value
  const pathEntry = combined.get(normalized('PATH'))
  for (const key of Object.keys(result)) if (normalized(key) === normalized('PATH')) delete result[key]
  result.PATH = [...helperPaths, pathEntry?.value].filter(Boolean).join(path.delimiter)
  result.CODEX_HOME = codexHome
  return result
}

export function resolveCodexHome(env: NodeJS.ProcessEnv, targetRepoPath: string): string {
  const home = env.CESTDONE_CODEX_HOME ?? env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
  if (!path.isAbsolute(home)) throw new Error('Codex home must be an absolute path')
  if (!fs.existsSync(home)) throw new Error(`Codex home does not exist: ${home}`)
  const relative = path.relative(path.resolve(targetRepoPath), path.resolve(home))
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error('Codex home must be outside the target repository')
  }
  return path.resolve(home)
}

export function normalizeCodexUsage(current: RawCodexUsage, previous?: RawCodexUsage): {
  raw: RawCodexUsage
  usage: TokenUsage
  reasoningOutputTokens: number
} {
  const fields: (keyof RawCodexUsage)[] = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens']
  for (const field of fields) {
    if (!Number.isFinite(current[field]) || current[field] < 0) throw new Error(`Invalid Codex usage counter: ${field}`)
    if (previous && current[field] < previous[field]) throw new Error(`Codex cumulative usage decreased: ${field}`)
  }
  const delta = Object.fromEntries(fields.map(field => [field, current[field] - (previous?.[field] ?? 0)])) as unknown as RawCodexUsage
  if (delta.cached_input_tokens + delta.cache_write_input_tokens > delta.input_tokens) throw new Error('Invalid Codex usage: cache counters exceed input')
  if (delta.reasoning_output_tokens > delta.output_tokens) throw new Error('Invalid Codex usage: reasoning exceeds output')
  return {
    raw: { ...current },
    usage: {
      inputTokens: delta.input_tokens - delta.cached_input_tokens - delta.cache_write_input_tokens,
      cacheReadInputTokens: delta.cached_input_tokens,
      cacheCreationInputTokens: delta.cache_write_input_tokens,
      outputTokens: delta.output_tokens,
    },
    reasoningOutputTokens: delta.reasoning_output_tokens,
  }
}

function boundedMessage(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value)
  if (/^Failed to parse item:/i.test(text)) return 'Codex emitted invalid JSONL output'
  return text
    .replace(/(?:sk-|SG\.)[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/\b(?:CODEX_API_KEY|OPENAI_API_KEY|CODEX_ACCESS_TOKEN)\s*[=:]\s*\S+/gi, '[redacted credential]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 500)
}

function classify(message: string): BackendErrorCategory {
  if (/auth|login|unauthorized/i.test(message)) return 'authentication_failed'
  if (/model.+(?:not found|unavailable)|unsupported model/i.test(message)) return 'model_unavailable'
  if (/rate.?limit|too many requests|quota/i.test(message)) return 'rate_limited'
  if (/sandbox|permission denied|access denied/i.test(message)) return 'sandbox_denied'
  if (/mcp.*(?:initial|start|connect|required)/i.test(message)) return 'mcp_initialization_failed'
  return 'process_failed'
}

function defaultRunCommand(file: string, args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = execFile(file, args, { env, timeout: 10_000, maxBuffer: 65_536, windowsHide: true }, (error, stdout, stderr) => {
      const details = error as (NodeJS.ErrnoException & { killed?: boolean }) | null
      const code = details?.killed ? 124 : typeof details?.code === 'number' ? details.code : error ? 1 : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
    child.once('error', () => undefined)
  })
}

export class CodexSdkBackend implements Backend {
  readonly name = 'codex-sdk' as const
  readonly provider = 'codex' as const
  readonly capabilities: BackendCapabilities = Object.freeze({
    resume: true, structuredOutput: true, exactToolAllowlist: false,
    maxTurns: false, maxBudgetUsd: false, perInvocationMcpConfig: false,
  })
  private readonly states = new Map<string, ThreadState>()
  private readonly runtime: CodexRuntime
  private readonly clientFactory: (options: CodexOptions) => CodexClientLike
  private readonly baseEnv: NodeJS.ProcessEnv
  private readonly explicitHome?: string
  private preflightBilling = false

  constructor(private readonly selection: ResolvedAgentSelection, private readonly options: CodexBackendOptions = {}) {
    if (selection.provider !== 'codex' || selection.backend !== 'codex-sdk') throw new Error('CodexSdkBackend requires a Codex selection')
    this.runtime = options.runtime ?? (selection.codexCliPath
      ? { executablePath: selection.codexCliPath, helperPaths: [], expectedVersion: SUPPORTED_CODEX_VERSION }
      : resolveCodexRuntime())
    this.clientFactory = options.clientFactory ?? ((codexOptions) => new Codex(codexOptions))
    this.baseEnv = options.env ?? process.env
    this.explicitHome = options.codexHome
    this.preflightBilling = options.skipPreflight ?? false
  }

  async preflight(context?: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<{ ok: boolean; error?: string; errorCategory?: BackendErrorCategory; billingMode?: 'subscription'; runtimeVersion?: string }> {
    try {
      const sourceEnv = context?.env ? { ...this.baseEnv, ...context.env } : this.baseEnv
      const home = this.explicitHome ?? resolveCodexHome(sourceEnv, context?.cwd ?? process.cwd())
      const env = buildCodexEnvironment(this.baseEnv, context?.env ?? {}, home, process.platform === 'win32', this.runtime.helperPaths)
      const run = this.options.runCommand ?? defaultRunCommand
      const version = await run(this.runtime.executablePath, ['--version'], env)
      if (version.code === 124) return { ok: false, error: 'Codex runtime version check timed out', errorCategory: 'timeout' }
      const detectedVersion = `${version.stdout}\n${version.stderr}`.match(/codex(?:-cli)?\s+([^\s]+)/i)?.[1]
      if (version.code !== 0 || detectedVersion !== this.runtime.expectedVersion) {
        return { ok: false, error: `Codex runtime must be version ${this.runtime.expectedVersion}`, errorCategory: 'runtime_missing' }
      }
      const login = await run(this.runtime.executablePath, ['login', 'status'], env)
      if (login.code === 124) return { ok: false, error: 'Codex login status check timed out', errorCategory: 'timeout', runtimeVersion: detectedVersion }
      if (login.code !== 0 || !/Logged in using ChatGPT/i.test(`${login.stdout}\n${login.stderr}`)) {
        return { ok: false, error: 'Codex is not logged in using ChatGPT', errorCategory: 'authentication_failed', runtimeVersion: detectedVersion }
      }
      this.preflightBilling = true
      return { ok: true, billingMode: 'subscription', runtimeVersion: detectedVersion }
    } catch (error) {
      const message = boundedMessage(error)
      return { ok: false, error: message, errorCategory: /CODEX_API_KEY/.test(message) ? 'configuration_error' : 'runtime_missing' }
    }
  }

  async invoke(params: BackendInvocation): Promise<BackendResult> {
    const started = Date.now()
    let activeState: ThreadState | undefined
    let controller: AbortController | undefined
    let observedUsage: ReturnType<typeof normalizeCodexUsage> | undefined
    let observedCompletedUsage: RawCodexUsage | undefined
    let observedThreadId: string | undefined
    let observedToolCalls: Record<string, number> = {}
    const fail = (category: BackendErrorCategory, message: string, usage = EMPTY_USAGE, usageStatus: 'reported' | 'unavailable' = 'unavailable', extra: Partial<BackendResult> = {}): BackendResult => ({
      output: '', rawText: '', costUsd: null, numTurns: 0, durationMs: Date.now() - started,
      usage, billingMode: this.preflightBilling ? 'subscription' : 'unknown', usageStatus,
      success: false, errorCategory: category, errorMessage: boundedMessage(message), ...extra,
    })
    try {
      if (unsettledCancellations.size > 0) {
        await Promise.allSettled([...unsettledCancellations])
      }
      if (params.maxBudgetUsd !== undefined) return fail('configuration_error', 'maxBudgetUsd is unsupported for Codex')
      if (params.mcpConfig) return fail('configuration_error', 'mcpConfig is unsupported for Codex')
      const home = this.explicitHome ?? resolveCodexHome(this.baseEnv, params.cwd)
      const env = buildCodexEnvironment(this.baseEnv, params.env ?? {}, home, process.platform === 'win32', this.runtime.helperPaths)
      let state: ThreadState | undefined
      if (params.resumeSessionId) {
        state = this.states.get(params.resumeSessionId)
        if (!state || !state.baselineUsable) return fail('configuration_error', `Unknown or unusable Codex session: ${params.resumeSessionId}`)
        if (state.model !== params.model || state.cwd !== path.resolve(params.cwd) || state.home !== home || state.systemPrompt !== params.systemPrompt) {
          return fail('configuration_error', 'Codex resume parameters do not match the original session')
        }
      }
      activeState = state
      observedThreadId = params.resumeSessionId
      const client = this.clientFactory({
        codexPathOverride: this.runtime.executablePath,
        env,
        config: {
          forced_login_method: 'chatgpt',
          chatgpt_base_url: 'https://chatgpt.com/backend-api/',
          ...(params.systemPrompt !== undefined ? { developer_instructions: params.systemPrompt } : {}),
        },
        configOverrides: CONFIG_OVERRIDES,
      })
      const threadOptions: ThreadOptions = {
        model: params.model,
        workingDirectory: path.resolve(params.cwd),
        sandboxMode: params.accessMode === 'unrestricted' ? 'danger-full-access' : params.accessMode ?? 'read-only',
        approvalPolicy: 'never',
        skipGitRepoCheck: false,
        ...(params.reasoningEffort ?? this.selection.reasoningEffort ? { modelReasoningEffort: params.reasoningEffort ?? this.selection.reasoningEffort } : {}),
        webSearchMode: this.selection.webSearchMode ?? 'cached',
        ...(!params.resumeSessionId ? { threadSource: 'cestdone' } : {}),
      }
      const thread = params.resumeSessionId ? client.resumeThread(params.resumeSessionId, threadOptions) : client.startThread(threadOptions)
      controller = new AbortController()
      const callController = controller
      const timeoutMs = params.timeoutMs ?? this.selection.callTimeoutMs ?? 3_600_000
      const timer = setTimeout(() => callController.abort(), timeoutMs)
      let watchdogTimer: ReturnType<typeof setTimeout> | undefined
      const watchdogToken = Symbol('cancellation-watchdog')
      const cancellationWatchdogMs = this.options.cancellationWatchdogMs ?? CANCELLATION_WATCHDOG_MS
      const watchdog = new Promise<typeof watchdogToken>(resolve => {
        callController.signal.addEventListener('abort', () => {
          watchdogTimer = setTimeout(() => resolve(watchdogToken), cancellationWatchdogMs)
        }, { once: true })
      })
      let threadId = params.resumeSessionId
      let finalText: string | undefined
      let completedUsage: RawCodexUsage | undefined
      let completed = false
      let fatal: string | undefined
      let cancellationIncomplete = false
      const toolIds = new Set<string>()
      const toolCalls: Record<string, number> = {}
      observedToolCalls = toolCalls
      try {
        const streamed = await thread.runStreamed(params.prompt, { outputSchema: params.outputSchema, signal: callController.signal })
        const iterator = streamed.events[Symbol.asyncIterator]()
        while (true) {
          const pendingNext = iterator.next()
          const outcome = await Promise.race([
            pendingNext.then(value => ({ kind: 'next' as const, value })),
            watchdog.then(() => ({ kind: 'watchdog' as const })),
          ])
          if (outcome.kind === 'watchdog') {
            cancellationIncomplete = true
            const settlement = pendingNext
              .then(async () => { await iterator.return?.(undefined as never) })
              .catch(() => undefined)
              .then(() => undefined)
            unsettledCancellations.add(settlement)
            void settlement.finally(() => unsettledCancellations.delete(settlement))
            break
          }
          if (outcome.value.done) break
          const event = outcome.value.value
          if (event.type === 'thread.started') {
            threadId = event.thread_id
            observedThreadId = threadId
          }
          else if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
            const item = event.item
            if (event.type === 'item.completed' && item.type === 'agent_message') finalText = item.text
            if (['command_execution', 'file_change', 'web_search', 'mcp_tool_call'].includes(item.type) && !toolIds.has(item.id)) {
              toolIds.add(item.id)
              const key = item.type === 'mcp_tool_call' ? `mcp:${item.server}/${item.tool}` : item.type
              toolCalls[key] = (toolCalls[key] ?? 0) + 1
            }
          } else if (event.type === 'turn.completed') {
            completed = true
            completedUsage = { ...event.usage, cache_write_input_tokens: event.usage.cache_write_input_tokens ?? 0 }
            observedCompletedUsage = completedUsage
          } else if (event.type === 'turn.failed') fatal = event.error.message
          else if (event.type === 'error') fatal = event.message
        }
      } finally {
        clearTimeout(timer)
        if (watchdogTimer) clearTimeout(watchdogTimer)
      }
      if (cancellationIncomplete) {
        if (state) state.baselineUsable = false
        return fail('cancellation_incomplete', `Codex did not settle within ${cancellationWatchdogMs} ms after cancellation`)
      }
      if (callController.signal.aborted) {
        if (state) state.baselineUsable = false
        return fail('timeout', `Codex call timed out after ${timeoutMs} ms`)
      }
      if (!completed || !completedUsage || !threadId) {
        if (state) state.baselineUsable = false
        return fail(fatal ? classify(fatal) : 'process_failed', fatal ?? 'Codex stream ended without a completed turn')
      }
      let normalized
      try {
        normalized = normalizeCodexUsage(completedUsage, state?.lastUsage)
        observedUsage = normalized
        this.options.usageObserver?.(normalized.raw, state?.lastUsage, normalized)
      } catch (error) {
        if (state) state.baselineUsable = false
        return fail('process_failed', boundedMessage(error))
      }
      if (fatal) {
        if (state) state.baselineUsable = false
        return fail(classify(fatal), fatal, normalized.usage, 'reported', {
          sessionId: threadId, numTurns: 1, reasoningOutputTokens: normalized.reasoningOutputTokens, toolCalls,
        })
      }
      const nextState: ThreadState = state ?? { provider: 'codex', model: params.model, cwd: path.resolve(params.cwd), home, systemPrompt: params.systemPrompt, baselineUsable: true }
      nextState.lastUsage = normalized.raw
      this.states.set(threadId, nextState)
      if (finalText === undefined) return fail('process_failed', 'Codex completed without an agent message', normalized.usage, 'reported', { sessionId: threadId, numTurns: 1, reasoningOutputTokens: normalized.reasoningOutputTokens, toolCalls })
      let output: unknown = finalText
      if (params.outputSchema) {
        try { output = JSON.parse(finalText) } catch { return fail('schema_violation', 'Codex returned invalid JSON', normalized.usage, 'reported', { sessionId: threadId, numTurns: 1, reasoningOutputTokens: normalized.reasoningOutputTokens, toolCalls }) }
        const validate = ajv.compile(params.outputSchema)
        if (!validate(output)) return fail('schema_violation', 'Codex output did not match the required schema', normalized.usage, 'reported', { sessionId: threadId, numTurns: 1, reasoningOutputTokens: normalized.reasoningOutputTokens, toolCalls })
      }
      return {
        output, rawText: finalText, sessionId: threadId, costUsd: null, numTurns: 1,
        durationMs: Date.now() - started, usage: normalized.usage, toolCalls,
        billingMode: this.preflightBilling ? 'subscription' : 'unknown', usageStatus: 'reported',
        reasoningOutputTokens: normalized.reasoningOutputTokens, success: true,
      }
    } catch (error) {
      if (activeState) activeState.baselineUsable = false
      if (!observedUsage && observedCompletedUsage) {
        try { observedUsage = normalizeCodexUsage(observedCompletedUsage, activeState?.lastUsage) } catch { /* malformed usage remains unavailable */ }
      }
      const timedOut = controller?.signal.aborted === true
      return fail(timedOut ? 'timeout' : classify(boundedMessage(error)), timedOut ? 'Codex call timed out' : boundedMessage(error),
        observedUsage?.usage ?? EMPTY_USAGE, observedUsage ? 'reported' : 'unavailable', {
          ...(observedThreadId ? { sessionId: observedThreadId } : {}),
          ...(observedUsage ? { numTurns: 1, reasoningOutputTokens: observedUsage.reasoningOutputTokens } : {}),
          toolCalls: observedToolCalls,
        })
    }
  }
}

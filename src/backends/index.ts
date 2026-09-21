// src/backends/index.ts
import type { Backend, BackendCapabilities, BackendInvocation, BackendResult, BackendPreflightContext, BackendType, Config, PreflightResult, ResolvedAgentSelection } from '../shared/types.js'
import { AgentSdkBackend } from './agent-sdk.js'
import { ClaudeCliBackend } from './claude-cli.js'
import { DEFAULTS } from '../shared/config.js'
import { resolveClaudeModel } from '../shared/agent-selection.js'

class LazyCodexBackend implements Backend {
  readonly name = 'codex-sdk' as const
  readonly provider = 'codex' as const
  readonly capabilities: BackendCapabilities = Object.freeze({
    resume: true, structuredOutput: true, exactToolAllowlist: false,
    maxTurns: false, maxBudgetUsd: false, perInvocationMcpConfig: false,
  })
  private loaded?: Promise<Backend>

  constructor(private readonly selection: ResolvedAgentSelection, private readonly config: Config) {}

  private load(): Promise<Backend> {
    this.loaded ??= import('./codex-sdk.js').then(({ CodexSdkBackend }) =>
      new CodexSdkBackend(this.selection, { codexHome: this.config.codexHome }))
    return this.loaded
  }

  async preflight(context?: BackendPreflightContext): Promise<PreflightResult> {
    return (await this.load()).preflight(context)
  }

  async invoke(params: BackendInvocation): Promise<BackendResult> {
    return (await this.load()).invoke(params)
  }
}

export function createBackend(type: BackendType | ResolvedAgentSelection, config: Config): Backend {
  const selection: ResolvedAgentSelection = typeof type === 'string'
    ? { profileName: null, provider: 'claude', backend: type, model: resolveClaudeModel(DEFAULTS.directorModel) }
    : type
  const backendType = selection.backend
  switch (backendType) {
    case 'agent-sdk':
      return new AgentSdkBackend()
    case 'claude-cli':
      return new ClaudeCliBackend(config.claudeCliPath ?? DEFAULTS.claudeCliPath)
    case 'codex-sdk':
      return new LazyCodexBackend(selection, config)
    default:
      throw new Error(`Unknown backend: ${backendType as string}`)
  }
}

import path from 'node:path'
import type {
  AgentProfile,
  AgentSelectionOptions,
  BackendType,
  Config,
  ResolvedAgentSelection,
  ResolvedRunAgents,
} from './types.js'

const PROFILE_NAME = /^[a-z][a-z0-9-]*$/
const REASONING = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'])
const WEB_SEARCH = new Set(['disabled', 'cached', 'live'])
const CLAUDE_BACKENDS = new Set<BackendType>(['claude-cli', 'agent-sdk'])
const BACKENDS = new Set<BackendType>(['claude-cli', 'agent-sdk', 'codex-sdk'])
const CLAUDE_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
}

export interface ValidationResult { valid: boolean; errors: string[] }

export function resolveClaudeModel(model: string): string {
  return CLAUDE_ALIASES[model] ?? model
}

function validateProfile(name: string, profile: AgentProfile, errors: string[]): void {
  if (!PROFILE_NAME.test(name)) errors.push(`Invalid agent profile name "${name}"`)
  if (!profile || typeof profile !== 'object') {
    errors.push(`Agent profile "${name}" must be an object`)
    return
  }
  const backends = [profile.backend, profile.directorBackend ?? profile.backend, profile.workerBackend ?? profile.backend]
  if (profile.provider !== 'claude' && profile.provider !== 'codex') errors.push(`Agent profile "${name}" has an invalid provider`)
  if (backends.some(backend => !BACKENDS.has(backend))) errors.push(`Agent profile "${name}" has an invalid backend`)
  if (profile.provider === 'codex' && backends.some(backend => backend !== 'codex-sdk')) {
    errors.push(`Codex agent profile "${name}" must use codex-sdk for every role`)
  }
  if (profile.provider === 'claude' && backends.some(backend => !CLAUDE_BACKENDS.has(backend))) {
    errors.push(`Claude agent profile "${name}" must use a Claude backend`)
  }
  for (const [field, model] of [['directorModel', profile.directorModel], ['workerModel', profile.workerModel]] as const) {
    if (typeof model !== 'string' || model.trim() === '') errors.push(`Agent profile "${name}" ${field} must be a nonempty string`)
    if (profile.provider === 'codex' && (model in CLAUDE_ALIASES || model.startsWith('claude-'))) {
      errors.push(`Codex agent profile "${name}" ${field} cannot use a Claude model`)
    }
  }
  if (profile.provider === 'claude') {
    if (profile.directorReasoningEffort || profile.workerReasoningEffort || profile.callTimeoutMs || profile.webSearchMode || profile.codexCliPath) {
      errors.push(`Claude agent profile "${name}" contains Codex-only fields`)
    }
  }
  for (const effort of [profile.directorReasoningEffort, profile.workerReasoningEffort]) {
    if (effort !== undefined && !REASONING.has(effort)) errors.push(`Agent profile "${name}" has an invalid reasoning effort`)
  }
  if (profile.callTimeoutMs !== undefined && (!Number.isInteger(profile.callTimeoutMs) || profile.callTimeoutMs < 1 || profile.callTimeoutMs > 86_400_000)) {
    errors.push(`Agent profile "${name}" callTimeoutMs must be an integer between 1 and 86400000`)
  }
  if (profile.webSearchMode !== undefined && !WEB_SEARCH.has(profile.webSearchMode)) errors.push(`Agent profile "${name}" has an invalid webSearchMode`)
  if (profile.codexCliPath !== undefined && (
    !path.isAbsolute(profile.codexCliPath) || /\.(cmd|ps1|bat)$/i.test(profile.codexCliPath) || /["']|(?:^|\s)--?\w/.test(profile.codexCliPath)
  )) {
    errors.push(`Agent profile "${name}" codexCliPath must be an absolute native executable path`)
  }
}

export function validateAgentProfiles(config: Config): ValidationResult {
  const errors: string[] = []
  for (const [name, profile] of Object.entries(config.agentProfiles ?? {})) validateProfile(name, profile, errors)
  if (config.defaultAgent !== undefined && !config.agentProfiles?.[config.defaultAgent]) {
    errors.push(`Default agent profile "${config.defaultAgent}" is not defined`)
  }
  return { valid: errors.length === 0, errors }
}

function selectedProfile(config: Config, name: string, role: 'director' | 'worker'): ResolvedAgentSelection {
  const profile = config.agentProfiles?.[name]
  if (!profile) throw new Error(`Agent profile "${name}" is not defined`)
  const model = role === 'director' ? profile.directorModel : profile.workerModel
  const backend = role === 'director' ? profile.directorBackend ?? profile.backend : profile.workerBackend ?? profile.backend
  const reasoningEffort = role === 'director' ? profile.directorReasoningEffort : profile.workerReasoningEffort
  return Object.freeze({
    profileName: name,
    provider: profile.provider,
    backend,
    model: profile.provider === 'claude' ? resolveClaudeModel(model) : model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(profile.provider === 'codex' ? {
      callTimeoutMs: profile.callTimeoutMs ?? 3_600_000,
      webSearchMode: profile.webSearchMode ?? 'cached',
      ...(profile.codexCliPath ? { codexCliPath: profile.codexCliPath } : {}),
    } : {}),
  })
}

function resolveRole(
  role: 'director' | 'worker',
  config: Config,
  options: AgentSelectionOptions,
  env: NodeJS.ProcessEnv,
): ResolvedAgentSelection {
  const roleSelector = role === 'director' ? options.directorAgent : options.workerAgent
  const selector = roleSelector ?? options.agent
  const roleBackend = role === 'director' ? options.directorBackend : options.workerBackend
  const explicitBackend = roleBackend ?? options.backend
  const roleModel = role === 'director' ? options.directorModel : options.workerModel
  const conflictBackend = roleBackend ?? options.backend
  if (selector && conflictBackend) throw new Error(`Agent selector and legacy backend conflict for ${role}`)
  if (selector) {
    const selection = selectedProfile(config, selector, role)
    if (selection.provider === 'codex' && roleModel && (roleModel in CLAUDE_ALIASES || roleModel.startsWith('claude-'))) {
      throw new Error(`Codex ${role} cannot use a Claude model`)
    }
    return Object.freeze({ ...selection, ...(roleModel ? { model: selection.provider === 'claude' ? resolveClaudeModel(roleModel) : roleModel } : {}) })
  }
  if (explicitBackend === 'codex-sdk') throw new Error('Select codex-sdk through a configured agent profile')
  if (explicitBackend) return legacySelection(role, config, roleModel, explicitBackend as BackendType, env)
  if (config.defaultAgent) return selectedProfile(config, config.defaultAgent, role)
  const rootBackend = role === 'director' ? config.directorBackend : config.workerBackend
  return legacySelection(role, config, roleModel, rootBackend ?? 'claude-cli', env)
}

function legacySelection(
  role: 'director' | 'worker',
  config: Config,
  explicitModel: string | undefined,
  backend: BackendType,
  env: NodeJS.ProcessEnv,
): ResolvedAgentSelection {
  if (backend === 'codex-sdk') throw new Error('Select codex-sdk through a configured agent profile')
  const rootModel = role === 'director' ? config.directorModel : config.workerModel
  const envModel = role === 'director' ? env.CESTDONE_DIRECTOR_MODEL : env.CESTDONE_WORKER_MODEL
  return Object.freeze({
    profileName: null,
    provider: 'claude',
    backend,
    model: resolveClaudeModel(explicitModel ?? rootModel ?? envModel ?? 'opus'),
  })
}

export function resolveRunAgents(config: Config, options: AgentSelectionOptions = {}, env: NodeJS.ProcessEnv = process.env): ResolvedRunAgents {
  const validation = validateAgentProfiles(config)
  if (!validation.valid) throw new Error(`Invalid agent configuration: ${validation.errors.join('; ')}`)
  return Object.freeze({
    director: resolveRole('director', config, options, env),
    worker: resolveRole('worker', config, options, env),
  })
}

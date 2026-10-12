import { describe, expect, it } from 'vitest'
import { resolveRunAgents, validateAgentProfiles } from '../src/shared/agent-selection.js'
import type { Config } from '../src/shared/types.js'

const base: Config = { targetRepoPath: '.', runDir: '.cestdone', maxTurns: 100 }

const profiles: NonNullable<Config['agentProfiles']> = {
  claude: {
    provider: 'claude', backend: 'claude-cli',
    directorModel: 'sonnet', workerModel: 'opus',
  },
  codex: {
    provider: 'codex', backend: 'codex-sdk',
    directorModel: 'gpt-test-director', workerModel: 'gpt-test-worker',
    directorReasoningEffort: 'high', workerReasoningEffort: 'medium',
    callTimeoutMs: 1234, webSearchMode: 'disabled',
  },
}

describe('resolveRunAgents', () => {
  it('preserves the legacy Claude CLI default', () => {
    const result = resolveRunAgents(base, {}, {})
    expect(result.director).toMatchObject({ profileName: null, provider: 'claude', backend: 'claude-cli' })
    expect(result.worker).toMatchObject({ profileName: null, provider: 'claude', backend: 'claude-cli' })
  })

  it('uses a configured default profile for both roles', () => {
    const result = resolveRunAgents({ ...base, defaultAgent: 'codex', agentProfiles: profiles }, {}, {})
    expect(result.director).toMatchObject({ profileName: 'codex', provider: 'codex', model: 'gpt-test-director', reasoningEffort: 'high' })
    expect(result.worker).toMatchObject({ profileName: 'codex', provider: 'codex', model: 'gpt-test-worker', reasoningEffort: 'medium' })
  })

  it('resolves mixed role selectors independently', () => {
    const result = resolveRunAgents(
      { ...base, defaultAgent: 'claude', agentProfiles: profiles },
      { workerAgent: 'codex' },
      {},
    )
    expect(result.director.profileName).toBe('claude')
    expect(result.worker.profileName).toBe('codex')
  })

  it('lets an explicit legacy backend override a root default', () => {
    const result = resolveRunAgents(
      { ...base, defaultAgent: 'codex', agentProfiles: profiles },
      { directorBackend: 'claude-cli' },
      {},
    )
    expect(result.director.profileName).toBeNull()
    expect(result.worker.profileName).toBe('codex')
  })

  it('rejects a selector and legacy backend that apply to the same role', () => {
    expect(() => resolveRunAgents(
      { ...base, agentProfiles: profiles },
      { agent: 'codex', workerBackend: 'claude-cli' },
      {},
    )).toThrow(/conflict/i)
  })

  it('uses explicit profile model overrides without Claude alias expansion', () => {
    const result = resolveRunAgents(
      { ...base, agentProfiles: profiles },
      { agent: 'codex', workerModel: 'custom-codex-id' },
      { CESTDONE_WORKER_MODEL: 'ignored-env' },
    )
    expect(result.worker.model).toBe('custom-codex-id')
  })

  it('rejects raw codex-sdk legacy selection', () => {
    expect(() => resolveRunAgents(base, { backend: 'codex-sdk' }, {})).toThrow(/profile/i)
  })

  it('rejects a Claude model override on a selected Codex role', () => {
    expect(() => resolveRunAgents(
      { ...base, agentProfiles: profiles },
      { agent: 'codex', directorModel: 'sonnet' },
      {},
    )).toThrow(/Codex director cannot use a Claude model/)
  })
})

describe('validateAgentProfiles', () => {
  it('rejects invalid names and provider/backend combinations', () => {
    expect(validateAgentProfiles({ ...base, agentProfiles: { Bad_Name: profiles.codex } }).valid).toBe(false)
    expect(validateAgentProfiles({
      ...base,
      agentProfiles: { broken: { ...profiles.codex, backend: 'claude-cli' } },
    }).valid).toBe(false)
  })

  it('accepts a structurally valid unselected Codex profile without preflight', () => {
    expect(validateAgentProfiles({ ...base, agentProfiles: profiles }).valid).toBe(true)
  })

  it('accepts Claude effort levels and rejects Codex-only ones on a Claude profile', () => {
    const claude = (effort: string) => ({ ...base, agentProfiles: { c: { ...profiles.claude, workerReasoningEffort: effort as 'high' } } })
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) expect(validateAgentProfiles(claude(effort)).valid).toBe(true)
    for (const effort of ['minimal', 'ultra', 'persistent']) expect(validateAgentProfiles(claude(effort)).valid).toBe(false)
  })

  it('still rejects Codex-only transport fields on a Claude profile', () => {
    expect(validateAgentProfiles({ ...base, agentProfiles: { c: { ...profiles.claude, callTimeoutMs: 1000 } } }).valid).toBe(false)
  })
})

describe('Claude profile effort', () => {
  it('resolves per-role effort and current alias IDs for a Claude profile', () => {
    const result = resolveRunAgents({
      ...base,
      agentProfiles: { claude: { ...profiles.claude, directorReasoningEffort: 'medium', workerReasoningEffort: 'high' } },
    }, { agent: 'claude' }, {})
    expect(result.director).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'medium' })
    expect(result.worker).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high' })
  })
})

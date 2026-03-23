// tests/backend-factory.test.ts
import { describe, it, expect } from 'vitest'
import { createBackend } from '../src/backends/index.js'
import { AgentSdkBackend } from '../src/backends/agent-sdk.js'
import type { Config } from '../src/shared/types.js'

const baseConfig: Config = {
  targetRepoPath: '.',
  runDir: '.cestdone/test_2026-03-20_120000',
  maxTurns: 100,
}

describe('createBackend', () => {
  it('returns AgentSdkBackend for agent-sdk type', () => {
    const backend = createBackend('agent-sdk', baseConfig)
    expect(backend).toBeInstanceOf(AgentSdkBackend)
    expect(backend.name).toBe('agent-sdk')
  })

  it('returns ClaudeCliBackend for claude-cli type', () => {
    const backend = createBackend('claude-cli', baseConfig)
    expect(backend.name).toBe('claude-cli')
  })

  it('uses claudeCliPath from config for claude-cli backend', () => {
    const config = { ...baseConfig, claudeCliPath: '/usr/local/bin/claude' }
    const backend = createBackend('claude-cli', config)
    expect(backend.name).toBe('claude-cli')
  })

  it('throws for unknown backend type', () => {
    expect(() => createBackend('unknown' as never, baseConfig)).toThrow('Unknown backend')
  })
})

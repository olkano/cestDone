// tests/backend-integration.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Backend, BackendResult, Config, BackendType } from '../src/shared/types.js'
import { createBackend } from '../src/backends/index.js'

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    targetRepoPath: '.',
    maxTurns: 100,
    ...overrides,
  }
}

function makeMockBackend(name: BackendType): Backend {
  return {
    name,
    invoke: vi.fn().mockResolvedValue({
      output: { action: 'done', message: 'ok' },
      sessionId: 'sess-1',
      costUsd: name === 'claude-cli' ? null : 0.05,
      numTurns: 3,
      durationMs: 2000,
      usage: { inputTokens: 500, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      success: true,
    } satisfies BackendResult),
    preflight: vi.fn().mockResolvedValue({ ok: true }),
  }
}

describe('Backend integration', () => {
  describe('createBackend with config', () => {
    it('creates agent-sdk backend by default', () => {
      const backend = createBackend('agent-sdk', makeConfig())
      expect(backend.name).toBe('agent-sdk')
    })

    it('creates claude-cli backend', () => {
      const backend = createBackend('claude-cli', makeConfig())
      expect(backend.name).toBe('claude-cli')
    })

    it('uses claudeCliPath from config', () => {
      const backend = createBackend('claude-cli', makeConfig({ claudeCliPath: '/opt/claude' }))
      expect(backend.name).toBe('claude-cli')
    })

    it('throws on unknown backend type', () => {
      expect(() => createBackend('unknown' as BackendType, makeConfig())).toThrow('Unknown backend')
    })
  })

  describe('mixed backend scenarios', () => {
    it('director on claude-cli, coder on agent-sdk', () => {
      const config = makeConfig({ directorBackend: 'claude-cli', coderBackend: 'agent-sdk' })
      const directorBackend = createBackend(config.directorBackend!, config)
      const coderBackend = createBackend(config.coderBackend!, config)

      expect(directorBackend.name).toBe('claude-cli')
      expect(coderBackend.name).toBe('agent-sdk')
    })

    it('both on claude-cli', () => {
      const config = makeConfig({ directorBackend: 'claude-cli', coderBackend: 'claude-cli' })
      const directorBackend = createBackend(config.directorBackend!, config)
      const coderBackend = createBackend(config.coderBackend!, config)

      expect(directorBackend.name).toBe('claude-cli')
      expect(coderBackend.name).toBe('claude-cli')
    })
  })

  describe('backend result contracts', () => {
    it('agent-sdk backend returns costUsd as number', () => {
      const backend = makeMockBackend('agent-sdk')
      expect(backend.name).toBe('agent-sdk')
    })

    it('claude-cli backend returns costUsd as null', () => {
      const backend = makeMockBackend('claude-cli')
      expect(backend.name).toBe('claude-cli')
    })
  })
})

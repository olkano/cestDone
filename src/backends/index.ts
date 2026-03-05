// src/backends/index.ts
import type { Backend, BackendType, Config } from '../shared/types.js'
import { AgentSdkBackend } from './agent-sdk.js'
import { ClaudeCliBackend } from './claude-cli.js'
import { DEFAULTS } from '../shared/config.js'

export function createBackend(type: BackendType, config: Config): Backend {
  switch (type) {
    case 'agent-sdk':
      return new AgentSdkBackend()
    case 'claude-cli':
      return new ClaudeCliBackend(config.claudeCliPath ?? DEFAULTS.claudeCliPath)
    default:
      throw new Error(`Unknown backend: ${type as string}`)
  }
}

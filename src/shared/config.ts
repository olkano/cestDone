// src/shared/config.ts
import fs from 'node:fs'
import path from 'node:path'
import type { Config, BackendType, ModelAlias } from './types.js'

const CONFIG_FILENAME = '.cestdonerc.json'

// List available models:
// curl -s https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"
export const DEFAULTS = {
  // -- CLI-visible defaults (shown in --help) --
  targetRepoPath: '.',
  maxTurns: 100,
  directorModel: 'opus' as ModelAlias,   // haiku | sonnet | opus
  coderModel: 'opus' as ModelAlias,     // haiku | sonnet | opus
  backend: 'claude-cli' as BackendType, // agent-sdk (API billing) | claude-cli (subscription)
  claudeCliPath: 'claude',
  withCoder: true,                       // Two-agent mode: Director plans, Coder implements
  withReviews: true,                     // Director reviews after Coder execution
  withBashReviews: true,                 // Allow Bash in Director reviews (implies withReviews)
  withHumanValidation: false,            // Require human approval of plan before execution

  // -- Internal limits (not CLI-visible) --
  maxRejections: 3,            // Plan rejections before escalating to human
  maxCoderRetries: 3,          // Coder fix retries before escalating
  maxClarifyRounds: 3,         // Clarification Q&A rounds
  directorMaxTurnsReview: 20,  // Director turns for Review step
  directorMaxTurnsDefault: 15, // Director turns for other steps
  cliHeartbeatMs: 30_000,      // CLI backend heartbeat interval
} as const

const CONFIG_DEFAULTS: Config = {
  targetRepoPath: DEFAULTS.targetRepoPath,
  maxTurns: DEFAULTS.maxTurns,
}

export function loadConfig(cwd: string = process.cwd()): Config {
  const configPath = path.join(cwd, CONFIG_FILENAME)
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<Config>
    return { ...CONFIG_DEFAULTS, ...parsed }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...CONFIG_DEFAULTS }
    }
    throw err
  }
}

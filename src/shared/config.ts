// src/shared/config.ts
import fs from 'node:fs'
import path from 'node:path'
import type { Config, ResolvedConfig } from './types.js'

const CONFIG_FILENAME = '.cestdonerc.json'

const DEFAULTS: Config = {
  defaultModel: 'claude-opus-4-20250514',
  targetRepoPath: '.',
  maxTurns: 100,
}

export function loadConfig(cwd: string = process.cwd()): Config {
  const configPath = path.join(cwd, CONFIG_FILENAME)
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<Config>
    return { ...DEFAULTS, ...parsed }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...DEFAULTS }
    }
    throw err
  }
}

export function resolveConfig(config: Config): ResolvedConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable is required. Set it before running cestdone.'
    )
  }
  return { ...config, apiKey }
}

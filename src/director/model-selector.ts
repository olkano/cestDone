// src/director/model-selector.ts
// List available models:
// curl -s https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"

import { DEFAULTS } from '../shared/config.js'

export const SONNET = 'claude-sonnet-4-6'
export const HAIKU = 'claude-haiku-4-5'
export const OPUS = 'claude-opus-4-6'

const ALIASES: Record<string, string> = {
  haiku: HAIKU,
  sonnet: SONNET,
  opus: OPUS,
}

/** Maps short aliases (haiku/sonnet/opus) to full model IDs. Passes through unknown strings unchanged. */
export function resolveModelAlias(modelOrAlias: string): string {
  return ALIASES[modelOrAlias] ?? modelOrAlias
}

/**
 * Returns the model for Director calls.
 * Priority: override param → CESTDONE_DIRECTOR_MODEL env var → default from DEFAULTS.
 */
export function getDirectorModel(override?: string): string {
  if (override) return resolveModelAlias(override)
  const env = process.env.CESTDONE_DIRECTOR_MODEL
  if (env) return resolveModelAlias(env)
  return resolveModelAlias(DEFAULTS.directorModel)
}

/**
 * Returns the model for Worker calls.
 * Priority: override param → CESTDONE_WORKER_MODEL env var → default from DEFAULTS.
 */
export function getWorkerModel(override?: string): string {
  if (override) return resolveModelAlias(override)
  const env = process.env.CESTDONE_WORKER_MODEL
  if (env) return resolveModelAlias(env)
  return resolveModelAlias(DEFAULTS.workerModel)
}

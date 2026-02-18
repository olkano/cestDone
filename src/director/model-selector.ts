// src/director/model-selector.ts

export const SONNET = 'claude-sonnet-4-20250514'
export const HAIKU = 'claude-haiku-4-5-20251001'
export const OPUS = 'claude-opus-4-20250514'

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
 * Priority: override param → CESTDONE_DIRECTOR_MODEL env var → default (sonnet).
 */
export function getDirectorModel(override?: string): string {
  if (override) return resolveModelAlias(override)
  const env = process.env.CESTDONE_DIRECTOR_MODEL
  if (env) return resolveModelAlias(env)
  return SONNET
}

/**
 * Returns the model for Coder calls.
 * Priority: override param → CESTDONE_CODER_MODEL env var → default (haiku).
 */
export function getCoderModel(override?: string): string {
  if (override) return resolveModelAlias(override)
  const env = process.env.CESTDONE_CODER_MODEL
  if (env) return resolveModelAlias(env)
  return HAIKU
}

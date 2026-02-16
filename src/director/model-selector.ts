// src/director/model-selector.ts

export const SONNET = 'claude-sonnet-4-20250514'
export const HAIKU = 'claude-haiku-4-5-20251001'

/**
 * Returns the model for Director calls.
 * Reads from CESTDONE_DIRECTOR_MODEL env var. Throws if not set.
 */
export function getDirectorModel(): string {
  const model = process.env.CESTDONE_DIRECTOR_MODEL
  if (!model) {
    throw new Error(
      'CESTDONE_DIRECTOR_MODEL environment variable is required. Set it in .env before running cestdone.'
    )
  }
  return model
}

/**
 * Returns the model for Coder calls.
 * Reads from CESTDONE_CODER_MODEL env var. Throws if not set.
 */
export function getCoderModel(): string {
  const model = process.env.CESTDONE_CODER_MODEL
  if (!model) {
    throw new Error(
      'CESTDONE_CODER_MODEL environment variable is required. Set it in .env before running cestdone.'
    )
  }
  return model
}

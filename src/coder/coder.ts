// src/coder/coder.ts
import { createLogger } from '../shared/logger.js'
import type { CoderResult } from '../shared/types.js'

const logger = createLogger()

export function execute(): CoderResult {
  const message = 'Coder integration not yet available — manual execution required'
  logger.info(message)
  return { status: 'manual', message, cost: 0, numTurns: 0, durationMs: 0, report: null }
}

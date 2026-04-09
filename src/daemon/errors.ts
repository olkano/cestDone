// src/daemon/errors.ts

export class NonInteractiveEscalationError extends Error {
  constructor(prompt: string) {
    super(`Non-interactive mode: cannot ask human "${prompt}"`)
    this.name = 'NonInteractiveEscalationError'
  }
}

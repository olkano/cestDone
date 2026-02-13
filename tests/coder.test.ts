// tests/coder.test.ts
import { describe, it, expect } from 'vitest'
import { execute } from '../src/coder/coder.js'

describe('coder stub', () => {
  // I1: execute() returns manual status with appropriate message
  it('returns manual status with "manual execution required" message', () => {
    const result = execute()

    expect(result.status).toBe('manual')
    expect(result.message).toContain('manual execution required')
  })
})

// tests/environment.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { detectEnvironment, type EnvironmentInfo } from '../src/shared/environment.js'

describe('detectEnvironment', () => {
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  // E1: Returns an EnvironmentInfo object with required fields
  it('returns EnvironmentInfo with os, shell, and killCommand', () => {
    const env = detectEnvironment()

    expect(env.os).toBeTruthy()
    expect(env.shell).toBeTruthy()
    expect(env.killCommand).toBeTruthy()
  })

  // E2: Detects Windows correctly
  it('detects Windows platform', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    const env = detectEnvironment()

    expect(env.os).toBe('Windows')
    expect(env.killCommand).toContain('taskkill')
  })

  // E3: Detects macOS correctly
  it('detects macOS platform', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    const env = detectEnvironment()

    expect(env.os).toBe('macOS')
    expect(env.killCommand).toContain('kill')
  })

  // E4: Detects Linux correctly
  it('detects Linux platform', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })

    const env = detectEnvironment()

    expect(env.os).toBe('Linux')
    expect(env.killCommand).toContain('kill')
  })

  // E5: Reads package.json when it exists
  it('includes package.json dependencies when file exists', () => {
    const env = detectEnvironment()

    // Our own project has package.json with dependencies
    expect(env.packageManager).toBeTruthy()
  })

  // E6: Handles missing package.json gracefully
  it('handles missing package.json gracefully', () => {
    const env = detectEnvironment('/nonexistent/path')

    expect(env.packageManager).toBe('unknown')
    expect(env.dependencies).toEqual([])
  })

  // E7: Detects package manager from lock files
  it('detects npm from package-lock.json', () => {
    // Our own project uses npm
    const env = detectEnvironment()

    expect(['npm', 'yarn', 'pnpm', 'bun']).toContain(env.packageManager)
  })

  // E8: formatEnvironmentInfo produces a readable summary
  it('produces a readable summary string', () => {
    const env = detectEnvironment()
    const summary = env.summary

    expect(summary).toContain(env.os)
    expect(summary).toContain(env.shell)
    expect(summary).toContain(env.killCommand)
  })

  // E9: Detects shell from environment
  it('detects shell from environment', () => {
    const env = detectEnvironment()

    // Should be one of the common shells
    expect(env.shell).toBeTruthy()
    expect(typeof env.shell).toBe('string')
  })

  // E10: Lists key dependencies from package.json
  it('lists dependencies from package.json', () => {
    const env = detectEnvironment()

    // Our project has vitest, typescript, etc.
    expect(env.dependencies.length).toBeGreaterThan(0)
  })
})

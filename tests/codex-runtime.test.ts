import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveCodexRuntime, SUPPORTED_CODEX_VERSION } from '../src/backends/codex-runtime.js'

describe('resolveCodexRuntime', () => {
  it('finds the pinned native executable and helper path from the SDK dependency', () => {
    const runtime = resolveCodexRuntime()
    expect(runtime.expectedVersion).toBe(SUPPORTED_CODEX_VERSION)
    expect(fs.existsSync(runtime.executablePath)).toBe(true)
    expect(runtime.helperPaths.length).toBeGreaterThan(0)
    expect(runtime.helperPaths.every(item => fs.existsSync(item))).toBe(true)
  })

  it('rejects unsupported platform triples', () => {
    expect(() => resolveCodexRuntime('freebsd', 'x64')).toThrow(/unsupported/i)
  })
})

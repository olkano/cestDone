// tests/model-selector.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { getDirectorModel, getCoderModel, resolveModelAlias, SONNET, HAIKU, OPUS } from '../src/director/model-selector.js'

describe('resolveModelAlias', () => {
  // MA1
  it('resolves "haiku" to full Haiku model ID', () => {
    expect(resolveModelAlias('haiku')).toBe(HAIKU)
  })

  // MA2
  it('resolves "sonnet" to full Sonnet model ID', () => {
    expect(resolveModelAlias('sonnet')).toBe(SONNET)
  })

  // MA3
  it('resolves "opus" to full Opus model ID', () => {
    expect(resolveModelAlias('opus')).toBe(OPUS)
  })

  // MA4
  it('passes through a full model ID unchanged', () => {
    expect(resolveModelAlias('claude-sonnet-4-20250514')).toBe('claude-sonnet-4-20250514')
  })

  // MA5
  it('passes through unknown strings unchanged', () => {
    expect(resolveModelAlias('claude-custom-model')).toBe('claude-custom-model')
  })
})

describe('getDirectorModel', () => {
  const orig = process.env.CESTDONE_DIRECTOR_MODEL

  afterEach(() => {
    if (orig !== undefined) {
      process.env.CESTDONE_DIRECTOR_MODEL = orig
    } else {
      delete process.env.CESTDONE_DIRECTOR_MODEL
    }
  })

  // MD1
  it('uses override when provided, ignoring env var', () => {
    process.env.CESTDONE_DIRECTOR_MODEL = HAIKU
    expect(getDirectorModel('sonnet')).toBe(SONNET)
  })

  // MD2
  it('uses full model ID override as-is', () => {
    process.env.CESTDONE_DIRECTOR_MODEL = HAIKU
    expect(getDirectorModel('claude-sonnet-4-20250514')).toBe(SONNET)
  })

  // MD3
  it('falls back to env var when override is undefined', () => {
    process.env.CESTDONE_DIRECTOR_MODEL = HAIKU
    expect(getDirectorModel(undefined)).toBe(HAIKU)
  })

  // MD4
  it('defaults to sonnet when no override and no env var', () => {
    delete process.env.CESTDONE_DIRECTOR_MODEL
    expect(getDirectorModel(undefined)).toBe(SONNET)
  })

  // MD5 (backward compat: no-arg call)
  it('returns env var value when called with no arguments', () => {
    process.env.CESTDONE_DIRECTOR_MODEL = SONNET
    expect(getDirectorModel()).toBe(SONNET)
  })
})

describe('getCoderModel', () => {
  const orig = process.env.CESTDONE_CODER_MODEL

  afterEach(() => {
    if (orig !== undefined) {
      process.env.CESTDONE_CODER_MODEL = orig
    } else {
      delete process.env.CESTDONE_CODER_MODEL
    }
  })

  // MC1
  it('uses override when provided', () => {
    process.env.CESTDONE_CODER_MODEL = SONNET
    expect(getCoderModel('haiku')).toBe(HAIKU)
  })

  // MC2
  it('falls back to env var when override is undefined', () => {
    process.env.CESTDONE_CODER_MODEL = SONNET
    expect(getCoderModel(undefined)).toBe(SONNET)
  })

  // MC3
  it('defaults to haiku when no override and no env var', () => {
    delete process.env.CESTDONE_CODER_MODEL
    expect(getCoderModel(undefined)).toBe(HAIKU)
  })

  // MC4 (backward compat: no-arg call)
  it('returns env var value when called with no arguments', () => {
    process.env.CESTDONE_CODER_MODEL = HAIKU
    expect(getCoderModel()).toBe(HAIKU)
  })
})

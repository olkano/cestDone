// tests/model-selector.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getDirectorModel, getCoderModel, SONNET, HAIKU } from '../src/director/model-selector.js'

describe('getDirectorModel', () => {
  const orig = process.env.CESTDONE_DIRECTOR_MODEL

  afterEach(() => {
    if (orig !== undefined) {
      process.env.CESTDONE_DIRECTOR_MODEL = orig
    } else {
      delete process.env.CESTDONE_DIRECTOR_MODEL
    }
  })

  it('returns the CESTDONE_DIRECTOR_MODEL env var value', () => {
    process.env.CESTDONE_DIRECTOR_MODEL = SONNET
    expect(getDirectorModel()).toBe(SONNET)
  })

  it('throws when CESTDONE_DIRECTOR_MODEL is not set', () => {
    delete process.env.CESTDONE_DIRECTOR_MODEL
    expect(() => getDirectorModel()).toThrow('CESTDONE_DIRECTOR_MODEL')
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

  it('returns the CESTDONE_CODER_MODEL env var value', () => {
    process.env.CESTDONE_CODER_MODEL = HAIKU
    expect(getCoderModel()).toBe(HAIKU)
  })

  it('throws when CESTDONE_CODER_MODEL is not set', () => {
    delete process.env.CESTDONE_CODER_MODEL
    expect(() => getCoderModel()).toThrow('CESTDONE_CODER_MODEL')
  })
})

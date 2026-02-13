// tests/prompt.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { askApproval, askInput, ensureTTY } from '../src/cli/prompt.js'
import { PassThrough, Readable, Writable } from 'node:stream'

const nullOutput = new Writable({ write(_, __, cb) { cb() } })

describe('askApproval', () => {
  // H1: Returns approved:true when user inputs 'y'
  it('returns approved:true when user inputs y', async () => {
    const input = Readable.from(['y\n'])

    const result = await askApproval({ input, output: nullOutput })

    expect(result.approved).toBe(true)
    expect(result.feedback).toBeUndefined()
  })

  it('returns approved:true for "yes"', async () => {
    const input = Readable.from(['yes\n'])

    const result = await askApproval({ input, output: nullOutput })

    expect(result.approved).toBe(true)
  })

  // H2: On rejection, prompts for feedback and returns it
  it('returns approved:false with feedback when user rejects', async () => {
    const input = new PassThrough()
    input.write('n\nneeds more tests\n')

    const result = await askApproval({ input, output: nullOutput })

    expect(result.approved).toBe(false)
    expect(result.feedback).toBe('needs more tests')
    input.end()
  })
})

describe('askInput', () => {
  // H4: Generic text prompt for Director escalations
  it('returns the user input text', async () => {
    const input = Readable.from(['my answer\n'])

    const result = await askInput('Enter something: ', { input, output: nullOutput })

    expect(result).toBe('my answer')
  })
})

describe('ensureTTY', () => {
  const originalIsTTY = process.stdin.isTTY

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    })
  })

  // H3: Throws on non-TTY
  it('throws when stdin is not a TTY', () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: undefined,
      configurable: true,
    })

    expect(() => ensureTTY()).toThrow('interactive terminal')
  })

  it('does not throw when stdin is a TTY', () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    })

    expect(() => ensureTTY()).not.toThrow()
  })
})

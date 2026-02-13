// tests/cli.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ParsedSpec, Phase, ResolvedConfig } from '../src/shared/types.js'

vi.mock('node:fs')
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({
    messages: { create: vi.fn() }
  }))
}))
vi.mock('../src/shared/config.js')
vi.mock('../src/shared/spec-parser.js')
vi.mock('../src/shared/spec-writer.js')
vi.mock('../src/director/director.js')
vi.mock('../src/cli/prompt.js')
vi.mock('../src/coder/coder.js')

import fs from 'node:fs'
import { loadConfig, resolveConfig } from '../src/shared/config.js'
import { parseSpec } from '../src/shared/spec-parser.js'
import { runPhase } from '../src/director/director.js'
import { ensureTTY, askInput } from '../src/cli/prompt.js'
import { handleRun, handleResume } from '../src/cli/index.js'

const PENDING_PHASE: Phase = {
  number: 0, name: 'Setup', status: 'pending',
  spec: 'Set up project.', done: '_(tbd)_',
}

const IN_PROGRESS_PHASE: Phase = {
  number: 1, name: 'Build', status: 'in-progress',
  spec: 'Build it.', done: '_(tbd)_',
}

const DONE_PHASE: Phase = {
  number: 0, name: 'Init', status: 'done',
  spec: '_See Done._', done: 'Done.',
}

const MOCK_RESOLVED: ResolvedConfig = {
  defaultModel: 'claude-opus-4-20250514',
  targetRepoPath: '.',
  logLevel: 'info',
  apiKey: 'sk-test',
}

function makeMockSpec(phases: Phase[]): ParsedSpec {
  return {
    title: 'Test',
    metadata: { context: 'ctx', houseRulesRef: '' },
    phases,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fs.readFileSync).mockReturnValue('# Test\ncontent')
  vi.mocked(loadConfig).mockReturnValue({
    defaultModel: 'claude-opus-4-20250514',
    targetRepoPath: '.',
    logLevel: 'info',
  })
  vi.mocked(resolveConfig).mockReturnValue(MOCK_RESOLVED)
  vi.mocked(ensureTTY).mockReturnValue(undefined)
  vi.mocked(runPhase).mockResolvedValue(undefined)
})

describe('handleRun', () => {
  // K1: run command parses spec, finds first pending phase, calls runPhase
  it('parses spec, finds first pending phase, calls runPhase', async () => {
    const spec = makeMockSpec([PENDING_PHASE])
    vi.mocked(parseSpec).mockReturnValue(spec)

    await handleRun('spec.md')

    expect(ensureTTY).toHaveBeenCalled()
    expect(fs.readFileSync).toHaveBeenCalledWith(
      expect.stringContaining('spec.md'), 'utf-8'
    )
    expect(parseSpec).toHaveBeenCalled()
    expect(loadConfig).toHaveBeenCalled()
    expect(resolveConfig).toHaveBeenCalled()
    expect(runPhase).toHaveBeenCalledWith(
      spec,
      PENDING_PHASE,
      MOCK_RESOLVED,
      expect.stringContaining('spec.md'),
      expect.objectContaining({
        createMessage: expect.any(Function),
        askApproval: expect.any(Function),
        askInput: expect.any(Function),
      })
    )
  })

  // K2: prompts user about in-progress phase, continues on "continue"
  it('prompts about in-progress phase and continues it', async () => {
    const spec = makeMockSpec([IN_PROGRESS_PHASE, PENDING_PHASE])
    vi.mocked(parseSpec).mockReturnValue(spec)
    vi.mocked(askInput).mockResolvedValue('continue')

    await handleRun('spec.md')

    expect(askInput).toHaveBeenCalledWith(
      expect.stringContaining('in-progress')
    )
    expect(runPhase).toHaveBeenCalledWith(
      spec,
      IN_PROGRESS_PHASE,
      expect.anything(),
      expect.anything(),
      expect.anything()
    )
  })
})

describe('handleResume', () => {
  // K3: resume finds first non-done phase, calls runPhase without prompting
  it('finds first non-done phase and calls runPhase without prompting', async () => {
    const spec = makeMockSpec([DONE_PHASE, IN_PROGRESS_PHASE])
    vi.mocked(parseSpec).mockReturnValue(spec)

    await handleResume('spec.md')

    expect(ensureTTY).toHaveBeenCalled()
    expect(runPhase).toHaveBeenCalledWith(
      spec,
      IN_PROGRESS_PHASE,
      MOCK_RESOLVED,
      expect.stringContaining('spec.md'),
      expect.objectContaining({
        createMessage: expect.any(Function),
      })
    )
    // No prompt about in-progress — resume doesn't ask
    expect(askInput).not.toHaveBeenCalled()
  })
})

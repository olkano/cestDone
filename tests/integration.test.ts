// tests/integration.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let callId = 0

function makeToolResponse(action: string, message: string) {
  callId++
  return {
    content: [{
      type: 'tool_use',
      id: `toolu_integ_${callId}`,
      name: 'director_action',
      input: { action, message },
    }],
    stop_reason: 'tool_use',
  }
}

const mockCreate = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({
    messages: { create: mockCreate }
  }))
}))
vi.mock('../src/cli/prompt.js')
vi.mock('../src/shared/config.js')

import { ensureTTY, askApproval, askInput } from '../src/cli/prompt.js'
import { loadConfig, resolveConfig } from '../src/shared/config.js'
import { handleRun } from '../src/cli/index.js'

const SPEC_CONTENT = `# Integration Test

## Context
An integration test project.

## House rules

## Phase 0: Setup

### Status: pending

### Spec
Set up the project structure.

### Done
_(to be filled)_
`

let tmpDir: string
let savedApiKey: string | undefined

beforeEach(() => {
  callId = 0
  vi.clearAllMocks()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-integ-'))
  savedApiKey = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'sk-test-integration'

  vi.mocked(ensureTTY).mockReturnValue(undefined)
  vi.mocked(askApproval).mockResolvedValue({ approved: true })
  vi.mocked(askInput).mockResolvedValue('done')
  vi.mocked(loadConfig).mockReturnValue({
    defaultModel: 'claude-opus-4-20250514',
    targetRepoPath: '.',
    logLevel: 'silent',
  })
  vi.mocked(resolveConfig).mockReturnValue({
    defaultModel: 'claude-opus-4-20250514',
    targetRepoPath: '.',
    logLevel: 'silent',
    apiKey: 'sk-test-integration',
  })

  mockCreate
    .mockResolvedValueOnce(makeToolResponse('approve', 'Analysis complete. No questions.'))
    .mockResolvedValueOnce(makeToolResponse('approve', 'Plan:\n1. Create files\n2. Write tests'))
    .mockResolvedValueOnce(makeToolResponse('complete', 'Phase done. Created scaffold.'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  if (savedApiKey !== undefined) {
    process.env.ANTHROPIC_API_KEY = savedApiKey
  } else {
    delete process.env.ANTHROPIC_API_KEY
  }
})

describe('integration', () => {
  it('runs full workflow: analyze → plan → approve → execute → complete', async () => {
    const specPath = path.join(tmpDir, 'spec.md')
    fs.writeFileSync(specPath, SPEC_CONTENT, 'utf-8')

    await handleRun(specPath)

    const result = fs.readFileSync(specPath, 'utf-8')

    // Phase status should be 'done'
    expect(result).toContain('### Status: done')
    expect(result).not.toContain('### Status: pending')
    expect(result).not.toContain('### Status: in-progress')

    // Done summary should be written
    expect(result).toContain('Phase done. Created scaffold.')

    // API was called 3 times (analyze, plan, complete)
    expect(mockCreate).toHaveBeenCalledTimes(3)

    // Approval was requested
    expect(askApproval).toHaveBeenCalledTimes(1)

    // Manual execution prompt was shown
    const askInputCalls = vi.mocked(askInput).mock.calls
    const manualCall = askInputCalls.find(c => c[0].includes('manual execution'))
    expect(manualCall).toBeTruthy()
  })

  it('throws when ANTHROPIC_API_KEY is not set', async () => {
    vi.mocked(resolveConfig).mockImplementation(() => {
      throw new Error('CESTDONE_CLAUDE_API_KEY or ANTHROPIC_API_KEY environment variable is required.')
    })
    const specPath = path.join(tmpDir, 'spec.md')
    fs.writeFileSync(specPath, SPEC_CONTENT, 'utf-8')

    await expect(handleRun(specPath)).rejects.toThrow('ANTHROPIC_API_KEY')
  })

  it('exits cleanly when all phases are done', async () => {
    const doneSpec = `# Done Project

## Context
Already done.

## House rules

## Phase 0: Setup

### Status: done

### Spec
_See Done summary below._

### Done
Already completed.
`
    const specPath = path.join(tmpDir, 'spec.md')
    fs.writeFileSync(specPath, doneSpec, 'utf-8')

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await handleRun(specPath)

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No pending'))
    expect(mockCreate).not.toHaveBeenCalled()

    consoleSpy.mockRestore()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { runDirectExecution, type DirectorDeps } from '../src/director/director.js'
import type {
  Backend,
  BackendResult,
  Config,
  FreeFormSpec,
  WorkerOptions,
  WorkerResult,
} from '../src/shared/types.js'
import { CostTracker } from '../src/shared/cost-tracker.js'
import { DEFAULTS } from '../src/shared/config.js'

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
}

const SPEC: FreeFormSpec = {
  text: '# Daily scan\n\n1. Search\n2. Save results',
  houseRulesContent: 'Use TDD.',
  specFilePath: '/repo/daily-scan.md',
}

const CONFIG: Config = {
  targetRepoPath: '/repo',
  runDir: '.cestdone/daily-scan_2026-07-10_120000',
  maxTurns: 30,
  withWorker: true,
  withReviews: true,
  autoCommit: false,
}

function workerResult(status: WorkerResult['status']): WorkerResult {
  return {
    status,
    message: `${status} result`,
    cost: 0,
    numTurns: 3,
    durationMs: 1000,
    usage: ZERO_USAGE,
    report: { status, summary: `${status} summary` },
  }
}

function backendResult(action: 'done' | 'fix' | 'continue'): BackendResult {
  return {
    output: { action, message: `${action} message` },
    rawText: JSON.stringify({ action, message: `${action} message` }),
    sessionId: 'director-session',
    costUsd: 0,
    numTurns: 1,
    durationMs: 1000,
    usage: ZERO_USAGE,
    success: true,
  }
}

function makeBackend(result: BackendResult = backendResult('done')): Backend {
  return {
    name: 'claude-cli',
    invoke: vi.fn().mockResolvedValue(result),
    preflight: vi.fn().mockResolvedValue({ ok: true }),
  }
}

function makeDeps(result: WorkerResult, reviewResult: BackendResult = backendResult('done')): DirectorDeps {
  const backend = makeBackend(reviewResult)
  return {
    askApproval: vi.fn(),
    askInput: vi.fn(),
    createPlanFile: vi.fn(),
    readFile: vi.fn().mockImplementation(() => { throw new Error('not found') }),
    writeFile: vi.fn(),
    updatePhaseStatus: vi.fn(),
    writePhaseCompletion: vi.fn(),
    workerExecute: vi.fn().mockResolvedValue(result),
    display: vi.fn(),
    logger: { log: vi.fn(), logVerbose: vi.fn(), logFilePath: '' },
    costTracker: new CostTracker(),
    backend,
    workerBackend: makeBackend(),
    now: () => new Date('2026-07-10T09:30:00.000Z'),
  }
}

describe('runDirectExecution', () => {
  it('runs the complete specification as one Worker phase without a plan file', async () => {
    const deps = makeDeps(workerResult('success'))

    await runDirectExecution(SPEC, { ...CONFIG, withReviews: false }, deps)

    expect(deps.workerExecute).toHaveBeenCalledTimes(1)
    const options = vi.mocked(deps.workerExecute).mock.calls[0][0] as WorkerOptions
    expect(options.phase.name).toBe('Direct execution')
    expect(options.phase.spec).toBe(SPEC.text)
    expect(options.houseRulesContent).toBe(SPEC.houseRulesContent)
    expect(options.maxTurns).toBe(30)
    expect(options.writeArtifacts).toBe(false)
    expect(options.instructions).toContain('Authoritative UTC run context: 2026-07-10 (Friday)')
    expect(options.instructions).toContain('Do not recalculate or override this date or weekday')
    expect(deps.createPlanFile).not.toHaveBeenCalled()
    expect(deps.updatePhaseStatus).not.toHaveBeenCalled()
    expect(deps.writePhaseCompletion).not.toHaveBeenCalled()
    expect(deps.writeFile).not.toHaveBeenCalled()
    expect(deps.backend.invoke).not.toHaveBeenCalled()
  })

  it('fails immediately when the Worker returns partial', async () => {
    const deps = makeDeps(workerResult('partial'))

    await expect(runDirectExecution(SPEC, CONFIG, deps))
      .rejects.toThrow('Direct Worker incomplete')

    expect(deps.workerExecute).toHaveBeenCalledTimes(1)
    expect(deps.backend.invoke).not.toHaveBeenCalled()
  })

  it('fails immediately when the Worker returns failed', async () => {
    const deps = makeDeps(workerResult('failed'))

    await expect(runDirectExecution(SPEC, CONFIG, deps))
      .rejects.toThrow('Direct Worker failed')

    expect(deps.backend.invoke).not.toHaveBeenCalled()
  })

  it('uses exactly one Director call when reviews are enabled', async () => {
    const deps = makeDeps(workerResult('success'))

    await runDirectExecution(SPEC, CONFIG, deps)

    expect(deps.workerExecute).toHaveBeenCalledTimes(1)
    expect(deps.backend.invoke).toHaveBeenCalledTimes(1)
    expect(deps.writePhaseCompletion).not.toHaveBeenCalled()
    const invocation = vi.mocked(deps.backend.invoke).mock.calls[0][0]
    expect(invocation.prompt).not.toContain('cestdone-diff.txt')
    expect(invocation.prompt).not.toContain('phase-1-report.md')
    expect(invocation.prompt).toContain('Inspect the changed files or current git diff directly')
  })

  it('re-runs the Worker with the review feedback when the review returns fix', async () => {
    const deps = makeDeps(workerResult('success'), backendResult('done'))
    vi.mocked(deps.backend.invoke).mockResolvedValueOnce(backendResult('fix'))

    await runDirectExecution(SPEC, CONFIG, deps)

    expect(deps.workerExecute).toHaveBeenCalledTimes(2)
    expect(deps.backend.invoke).toHaveBeenCalledTimes(2)
    const fixOptions = vi.mocked(deps.workerExecute).mock.calls[1][0] as WorkerOptions
    expect(fixOptions.instructions).toContain('Review feedback:\nfix message')
    expect(fixOptions.instructions).toContain('do not repeat side effects that already happened')
    expect(fixOptions.instructions).toContain('Authoritative UTC run context')
  })

  it('fails after exhausting fix passes when the review keeps returning fix', async () => {
    const deps = makeDeps(workerResult('success'), backendResult('fix'))

    await expect(runDirectExecution(SPEC, CONFIG, deps))
      .rejects.toThrow('Direct review returned fix')

    expect(deps.workerExecute).toHaveBeenCalledTimes(1 + DEFAULTS.maxWorkerRetries)
    expect(deps.backend.invoke).toHaveBeenCalledTimes(1 + DEFAULTS.maxWorkerRetries)
  })

  it('rejects skip-planning when Worker mode is disabled', async () => {
    const deps = makeDeps(workerResult('success'))

    await expect(runDirectExecution(SPEC, { ...CONFIG, withWorker: false }, deps))
      .rejects.toThrow('skip-planning requires Worker mode')

    expect(deps.workerExecute).not.toHaveBeenCalled()
  })
})

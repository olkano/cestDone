import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Backend, BackendInvocation, BackendResult } from '../src/shared/types.js'
import type { SessionLogger } from '../src/shared/logger.js'
import { UsageRecorder, UsageTrackingBackend, normalizeApplication } from '../src/usage/recorder.js'
import type { UsageRunRecordV1 } from '../src/usage/types.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-usage-'))
  tempDirs.push(dir)
  return dir
}

function makeLogger(): SessionLogger {
  return { log: vi.fn(), logVerbose: vi.fn(), logFilePath: '' }
}

function makeResult(overrides: Partial<BackendResult> = {}): BackendResult {
  return {
    output: { status: 'success' },
    costUsd: null,
    numTurns: 2,
    durationMs: 100,
    usage: { inputTokens: 10, cacheCreationInputTokens: 20, cacheReadInputTokens: 30, outputTokens: 40 },
    success: true,
    ...overrides,
  }
}

function makeInvocation(): BackendInvocation {
  return {
    prompt: 'SECRET PROMPT CONTENT',
    model: 'claude-sonnet-5',
    cwd: process.cwd(),
    logger: makeLogger(),
    usageContext: { role: 'worker', workflowStep: 4, phaseNumber: 1 },
  }
}

function makeRecorder(usageDir: string, now?: () => Date): UsageRecorder {
  return new UsageRecorder({
    usageDir,
    application: 'Sales Reporting',
    invocation: { type: 'schedule', triggerName: 'daily-sales', daemonJobId: 'job-1', attempt: 1 },
    originalSpecPath: 'specs/report.md',
    targetRepoPath: '.',
    runDir: '.cestdone/run',
    logger: makeLogger(),
    now,
  })
}

describe('UsageRecorder', () => {
  it('writes a running record, persists calls, and finalizes atomically', async () => {
    const usageDir = makeTempDir()
    const timestamps = [
      new Date('2026-08-21T18:00:00Z'),
      new Date('2026-08-21T18:01:00Z'),
      new Date('2026-08-21T18:02:00Z'),
    ]
    const recorder = makeRecorder(usageDir, () => timestamps.shift() ?? new Date('2026-08-21T18:02:00Z'))
    const backend: Backend = {
      name: 'claude-cli',
      preflight: vi.fn().mockResolvedValue({ ok: true }),
      invoke: vi.fn().mockResolvedValue(makeResult()),
    }

    await new UsageTrackingBackend(backend, recorder).invoke(makeInvocation())
    recorder.finalize('completed')

    const record = JSON.parse(fs.readFileSync(recorder.recordPath, 'utf-8')) as UsageRunRecordV1
    expect(record.status).toBe('completed')
    expect(record.application).toBe('sales-reporting')
    expect(record.invocation).toEqual({ type: 'schedule', triggerName: 'daily-sales', daemonJobId: 'job-1', attempt: 1 })
    expect(record.calls).toHaveLength(1)
    expect(record.calls[0]).toMatchObject({
      role: 'worker', workflowStep: 4, phaseNumber: 1,
      backend: 'claude-cli', model: 'claude-sonnet-5', actualCostUsd: null,
      totalProcessedTokens: 100,
    })
    expect(record.totals).toMatchObject({ calls: 1, totalProcessedTokens: 100, actualCostUsd: null, callsWithActualCost: 0 })
    expect(fs.readFileSync(recorder.recordPath, 'utf-8')).not.toContain('SECRET PROMPT CONTENT')
    expect(fs.readdirSync(path.dirname(recorder.recordPath)).some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it('retains completed calls when the overall run fails', () => {
    const recorder = makeRecorder(makeTempDir())
    recorder.recordCall('agent-sdk', makeInvocation(), makeResult({ costUsd: 0.12 }))
    recorder.finalize('failed', new TypeError('sensitive detail'))

    const record = JSON.parse(fs.readFileSync(recorder.recordPath, 'utf-8')) as UsageRunRecordV1
    expect(record.status).toBe('failed')
    expect(record.errorCategory).toBe('TypeError')
    expect(record.calls).toHaveLength(1)
    expect(record.totals.actualCostUsd).toBe(0.12)
    expect(JSON.stringify(record)).not.toContain('sensitive detail')
  })

  it('uses distinct files for simultaneous runs', () => {
    const usageDir = makeTempDir()
    const first = makeRecorder(usageDir)
    const second = makeRecorder(usageDir)
    first.finalize('completed')
    second.finalize('completed')

    expect(first.recordPath).not.toBe(second.recordPath)
    expect(fs.existsSync(first.recordPath)).toBe(true)
    expect(fs.existsSync(second.recordPath)).toBe(true)
  })

  it('normalizes application labels', () => {
    expect(normalizeApplication('  ITM Platform / Sales  ')).toBe('itm-platform-sales')
    expect(normalizeApplication('***')).toBe('unknown')
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { aggregateUsage, fridayWeeklyWindow } from '../src/usage/aggregate.js'
import type { UsageCallRecordV1, UsageRunRecordV1 } from '../src/usage/types.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-aggregate-'))
  tempDirs.push(dir)
  fs.mkdirSync(path.join(dir, 'runs', '2026', '08'), { recursive: true })
  return dir
}

function call(overrides: Partial<UsageCallRecordV1> = {}): UsageCallRecordV1 {
  return {
    callId: 'call-1', completedAt: '2026-08-21T17:30:00Z', role: 'worker', workflowStep: 4,
    backend: 'claude-cli', model: 'claude-opus-5', success: true, durationMs: 100, numTurns: 2,
    inputTokens: 10, cacheCreationInputTokens: 20, cacheReadInputTokens: 30, outputTokens: 40,
    totalProcessedTokens: 100, actualCostUsd: null,
    ...overrides,
  }
}

function run(overrides: Partial<UsageRunRecordV1> = {}): UsageRunRecordV1 {
  const calls = overrides.calls ?? [call()]
  return {
    schemaVersion: 1, runId: 'run-1', startedAt: '2026-08-21T17:00:00Z',
    completedAt: '2026-08-21T17:40:00Z', status: 'completed', application: 'sales',
    invocation: { type: 'schedule', triggerName: 'daily-sales', attempt: 1 },
    originalSpecPath: 'specs/sales.md', targetRepoPath: 'C:/repo', runDir: '.cestdone/run-1',
    calls,
    totals: {
      calls: calls.length, successfulCalls: calls.filter(item => item.success).length,
      failedCalls: calls.filter(item => !item.success).length,
      inputTokens: calls.reduce((sum, item) => sum + item.inputTokens, 0),
      cacheCreationInputTokens: calls.reduce((sum, item) => sum + item.cacheCreationInputTokens, 0),
      cacheReadInputTokens: calls.reduce((sum, item) => sum + item.cacheReadInputTokens, 0),
      outputTokens: calls.reduce((sum, item) => sum + item.outputTokens, 0),
      totalProcessedTokens: calls.reduce((sum, item) => sum + item.totalProcessedTokens, 0),
      actualCostUsd: null, callsWithActualCost: 0,
    },
    ...overrides,
  }
}

function writeRecord(root: string, name: string, record: unknown): void {
  fs.writeFileSync(path.join(root, 'runs', '2026', '08', name), JSON.stringify(record), 'utf-8')
}

describe('aggregateUsage', () => {
  it('groups calls by application, source, role, backend, and model', () => {
    const usageDir = makeTempDir()
    writeRecord(usageDir, 'sales.json', run())
    writeRecord(usageDir, 'support.json', run({
      runId: 'run-2', application: 'support', status: 'failed',
      invocation: { type: 'poller', triggerName: 'support', attempt: 2 },
      calls: [call({ callId: 'call-2', role: 'director', backend: 'agent-sdk', model: 'claude-sonnet-5', actualCostUsd: 0.25 })],
    }))

    const snapshot = aggregateUsage({
      usageDir,
      start: new Date('2026-08-14T18:00:00Z'),
      end: new Date('2026-08-21T18:00:00Z'),
      timezone: 'Europe/Madrid',
      now: () => new Date('2026-08-21T18:01:00Z'),
    })

    expect(snapshot.totals).toMatchObject({ runs: 2, completedRuns: 1, failedRuns: 1, retries: 1, calls: 2, totalProcessedTokens: 200, actualCostUsd: 0.25, callsWithActualCost: 1 })
    expect(snapshot.byApplication.map(item => item.key).sort()).toEqual(['sales', 'support'])
    expect(snapshot.byInvocationType.map(item => item.key).sort()).toEqual(['poller', 'schedule'])
    expect(snapshot.byRole.map(item => item.key).sort()).toEqual(['director', 'worker'])
    expect(snapshot.byBackend.map(item => item.key).sort()).toEqual(['agent-sdk', 'claude-cli'])
    expect(snapshot.byModel.map(item => item.key).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5'])
    expect(snapshot.topRuns).toHaveLength(2)
  })

  it('attributes tokens by call completion and runs by run start', () => {
    const usageDir = makeTempDir()
    writeRecord(usageDir, 'crossing.json', run({
      startedAt: '2026-08-14T17:59:00Z',
      calls: [
        call({ callId: 'before', completedAt: '2026-08-14T17:59:59Z' }),
        call({ callId: 'inside', completedAt: '2026-08-14T18:00:00Z', totalProcessedTokens: 250 }),
      ],
    }))

    const snapshot = aggregateUsage({
      usageDir,
      start: new Date('2026-08-14T18:00:00Z'),
      end: new Date('2026-08-21T18:00:00Z'),
      timezone: 'Europe/Madrid',
    })

    expect(snapshot.totals.runs).toBe(0)
    expect(snapshot.totals.calls).toBe(1)
    expect(snapshot.totals.totalProcessedTokens).toBe(250)
  })

  it('counts malformed and unsupported records without failing valid aggregation', () => {
    const usageDir = makeTempDir()
    writeRecord(usageDir, 'valid.json', run())
    fs.writeFileSync(path.join(usageDir, 'runs', '2026', '08', 'broken.json'), '{bad', 'utf-8')
    writeRecord(usageDir, 'future.json', { schemaVersion: 2 })

    const snapshot = aggregateUsage({
      usageDir,
      start: new Date('2026-08-14T18:00:00Z'),
      end: new Date('2026-08-21T18:00:00Z'),
      timezone: 'Europe/Madrid',
    })

    expect(snapshot.dataQuality).toEqual({ filesRead: 3, invalidFiles: 1, unsupportedSchemaFiles: 1 })
    expect(snapshot.totals.calls).toBe(1)
  })
})

describe('fridayWeeklyWindow', () => {
  it('ends at the most recent Friday 20:00 Europe/Madrid', () => {
    const period = fridayWeeklyWindow(new Date('2026-08-22T10:00:00Z'), 'Europe/Madrid')
    expect(period.start.toISOString()).toBe('2026-08-14T18:00:00.000Z')
    expect(period.end.toISOString()).toBe('2026-08-21T18:00:00.000Z')
  })

  it('uses the prior Friday before 20:00 on Friday', () => {
    const period = fridayWeeklyWindow(new Date('2026-08-21T16:00:00Z'), 'Europe/Madrid')
    expect(period.end.toISOString()).toBe('2026-08-14T18:00:00.000Z')
  })

  it('preserves local boundaries across daylight-saving changes', () => {
    const period = fridayWeeklyWindow(new Date('2026-10-31T12:00:00Z'), 'Europe/Madrid')
    expect(period.start.toISOString()).toBe('2026-10-23T18:00:00.000Z')
    expect(period.end.toISOString()).toBe('2026-10-30T19:00:00.000Z')
    expect(period.end.getTime() - period.start.getTime()).toBe(169 * 60 * 60 * 1000)
  })
})

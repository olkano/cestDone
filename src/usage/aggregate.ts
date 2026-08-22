import fs from 'node:fs'
import path from 'node:path'
import type {
  UsageBreakdownV1,
  UsageCallRecordV1,
  UsagePeriodSnapshotV1,
  UsageRunRecordV1,
  UsageRunSummaryV1,
  UsageTotalsV1,
} from './types.js'
import { calculateUsageTotals } from './recorder.js'
import type { InvocationType } from '../shared/types.js'

export interface UsagePeriod {
  start: Date
  end: Date
  timezone: string
}

export interface AggregateUsageOptions extends UsagePeriod {
  usageDir: string
  applications?: string[]
  invocationTypes?: InvocationType[]
  now?: () => Date
}

interface LoadedRecords {
  records: UsageRunRecordV1[]
  filesRead: number
  invalidFiles: number
  unsupportedSchemaFiles: number
}

interface CallWithRun {
  call: UsageCallRecordV1
  run: UsageRunRecordV1
}

function walkJsonFiles(root: string): string[] {
  if (!fs.existsSync(root)) return []
  const result: string[] = []
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop() as string
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(fullPath)
      else if (entry.isFile() && entry.name.endsWith('.json')) result.push(fullPath)
    }
  }
  return result.sort()
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isValidCall(value: unknown): value is UsageCallRecordV1 {
  if (!value || typeof value !== 'object') return false
  const call = value as Partial<UsageCallRecordV1>
  return typeof call.callId === 'string' &&
    typeof call.completedAt === 'string' &&
    (call.role === 'director' || call.role === 'worker') &&
    typeof call.workflowStep === 'number' &&
    (call.backend === 'agent-sdk' || call.backend === 'claude-cli') &&
    typeof call.model === 'string' &&
    typeof call.success === 'boolean' &&
    isFiniteNonNegative(call.durationMs) &&
    isFiniteNonNegative(call.numTurns) &&
    isFiniteNonNegative(call.inputTokens) &&
    isFiniteNonNegative(call.cacheCreationInputTokens) &&
    isFiniteNonNegative(call.cacheReadInputTokens) &&
    isFiniteNonNegative(call.outputTokens) &&
    isFiniteNonNegative(call.totalProcessedTokens) &&
    (call.actualCostUsd === null || isFiniteNonNegative(call.actualCostUsd))
}

function isValidRecord(value: unknown): value is UsageRunRecordV1 {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<UsageRunRecordV1>
  return record.schemaVersion === 1 &&
    typeof record.runId === 'string' &&
    typeof record.startedAt === 'string' &&
    (record.status === 'running' || record.status === 'completed' || record.status === 'failed') &&
    typeof record.application === 'string' &&
    !!record.invocation &&
    ['direct', 'schedule', 'webhook', 'poller'].includes(record.invocation.type) &&
    typeof record.originalSpecPath === 'string' &&
    typeof record.targetRepoPath === 'string' &&
    typeof record.runDir === 'string' &&
    Array.isArray(record.calls) && record.calls.every(isValidCall)
}

export function loadUsageRecords(usageDir: string): LoadedRecords {
  const files = walkJsonFiles(path.join(usageDir, 'runs'))
  const loaded: LoadedRecords = { records: [], filesRead: files.length, invalidFiles: 0, unsupportedSchemaFiles: 0 }
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown
      if (parsed && typeof parsed === 'object' && (parsed as { schemaVersion?: unknown }).schemaVersion !== 1) {
        loaded.unsupportedSchemaFiles++
      } else if (!isValidRecord(parsed)) {
        loaded.invalidFiles++
      } else {
        loaded.records.push(parsed)
      }
    } catch {
      loaded.invalidFiles++
    }
  }
  return loaded
}

function inPeriod(timestamp: string, startMs: number, endMs: number): boolean {
  const value = Date.parse(timestamp)
  return Number.isFinite(value) && value >= startMs && value < endMs
}

function emptyBreakdown(key: string): UsageBreakdownV1 {
  return {
    key,
    runs: 0,
    failedRuns: 0,
    calls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    totalProcessedTokens: 0,
    actualCostUsd: null,
    callsWithActualCost: 0,
  }
}

function buildBreakdown(items: readonly CallWithRun[], keyOf: (item: CallWithRun) => string): UsageBreakdownV1[] {
  const groups = new Map<string, { calls: UsageCallRecordV1[]; runs: Map<string, UsageRunRecordV1> }>()
  for (const item of items) {
    const key = keyOf(item)
    const group = groups.get(key) ?? { calls: [], runs: new Map<string, UsageRunRecordV1>() }
    group.calls.push(item.call)
    group.runs.set(item.run.runId, item.run)
    groups.set(key, group)
  }
  return [...groups.entries()].map(([key, group]) => {
    const totals = calculateUsageTotals(group.calls)
    return {
      ...emptyBreakdown(key),
      ...totals,
      key,
      runs: group.runs.size,
      failedRuns: [...group.runs.values()].filter(run => run.status === 'failed').length,
    }
  }).sort((a, b) => b.totalProcessedTokens - a.totalProcessedTokens || a.key.localeCompare(b.key))
}

function localTimestamp(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
}

export function aggregateUsage(options: AggregateUsageOptions): UsagePeriodSnapshotV1 {
  if (!(options.start < options.end)) throw new Error('Usage period start must be before end')
  const loaded = loadUsageRecords(options.usageDir)
  const applications = options.applications ? new Set(options.applications) : undefined
  const invocationTypes = options.invocationTypes ? new Set(options.invocationTypes) : undefined
  const records = loaded.records.filter(record =>
    (!applications || applications.has(record.application)) &&
    (!invocationTypes || invocationTypes.has(record.invocation.type)),
  )
  const startMs = options.start.getTime()
  const endMs = options.end.getTime()
  const periodRuns = records.filter(record => inPeriod(record.startedAt, startMs, endMs))
  const calls: CallWithRun[] = records.flatMap(run => run.calls
    .filter(call => inPeriod(call.completedAt, startMs, endMs))
    .map(call => ({ call, run })))
  const callTotals = calculateUsageTotals(calls.map(item => item.call))

  const topRuns: UsageRunSummaryV1[] = [...new Map(calls.map(item => [item.run.runId, item.run])).values()]
    .map(run => {
      const runTotals = calculateUsageTotals(run.calls.filter(call => inPeriod(call.completedAt, startMs, endMs)))
      return {
        runId: run.runId,
        startedAt: run.startedAt,
        ...(run.completedAt ? { completedAt: run.completedAt } : {}),
        application: run.application,
        invocationType: run.invocation.type,
        ...(run.invocation.triggerName ? { triggerName: run.invocation.triggerName } : {}),
        specPath: run.originalSpecPath,
        status: run.status,
        totalProcessedTokens: runTotals.totalProcessedTokens,
        outputTokens: runTotals.outputTokens,
        actualCostUsd: runTotals.actualCostUsd,
      }
    })
    .sort((a, b) => b.totalProcessedTokens - a.totalProcessedTokens || a.runId.localeCompare(b.runId))
    .slice(0, 5)

  const completedRuns = periodRuns.filter(run => run.status === 'completed').length
  const failedRuns = periodRuns.filter(run => run.status === 'failed').length
  const terminalRuns = completedRuns + failedRuns

  return {
    schemaVersion: 1,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    period: {
      startUtc: options.start.toISOString(),
      endUtc: options.end.toISOString(),
      timezone: options.timezone,
      startLocal: localTimestamp(options.start, options.timezone),
      endLocal: localTimestamp(options.end, options.timezone),
      tokenAttribution: 'call-completed-at',
      runAttribution: 'run-started-at',
    },
    totals: {
      ...callTotals,
      runs: periodRuns.length,
      completedRuns,
      failedRuns,
      runningRuns: periodRuns.filter(run => run.status === 'running').length,
      retries: periodRuns.filter(run => (run.invocation.attempt ?? 1) > 1).length,
      successRate: terminalRuns > 0 ? completedRuns / terminalRuns : null,
    },
    byApplication: buildBreakdown(calls, item => item.run.application),
    byInvocationType: buildBreakdown(calls, item => item.run.invocation.type),
    byRole: buildBreakdown(calls, item => item.call.role),
    byBackend: buildBreakdown(calls, item => item.call.backend),
    byModel: buildBreakdown(calls, item => item.call.model),
    topRuns,
    dataQuality: {
      filesRead: loaded.filesRead,
      invalidFiles: loaded.invalidFiles,
      unsupportedSchemaFiles: loaded.unsupportedSchemaFiles,
    },
  }
}

interface LocalDateTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function zonedParts(date: Date, timezone: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const number = (type: string) => Number(parts.find(part => part.type === type)?.value)
  return {
    year: number('year'), month: number('month'), day: number('day'),
    hour: number('hour'), minute: number('minute'), second: number('second'),
  }
}

function zonedDateTimeToUtc(local: LocalDateTime, timezone: string): Date {
  const targetAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second)
  let candidate = targetAsUtc
  for (let i = 0; i < 3; i++) {
    const actual = zonedParts(new Date(candidate), timezone)
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second)
    candidate += targetAsUtc - actualAsUtc
  }
  return new Date(candidate)
}

function addLocalDays(local: LocalDateTime, days: number): LocalDateTime {
  const shifted = new Date(Date.UTC(local.year, local.month - 1, local.day + days, local.hour, local.minute, local.second))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  }
}

/** Seven-day reporting window ending at the most recent Friday 20:00 local time. */
export function fridayWeeklyWindow(now: Date, timezone: string, weeksAgo = 0): UsagePeriod {
  if (!Number.isInteger(weeksAgo) || weeksAgo < 0) throw new Error('weeksAgo must be a non-negative integer')
  const localNow = zonedParts(now, timezone)
  const localDateAsUtc = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day))
  const dayOfWeek = localDateAsUtc.getUTCDay()
  let daysSinceFriday = (dayOfWeek - 5 + 7) % 7
  if (daysSinceFriday === 0 && localNow.hour < 20) daysSinceFriday = 7
  const thisEndLocal = addLocalDays({ ...localNow, hour: 20, minute: 0, second: 0 }, -daysSinceFriday)
  const endLocal = addLocalDays(thisEndLocal, -7 * weeksAgo)
  const startLocal = addLocalDays(endLocal, -7)
  return {
    start: zonedDateTimeToUtc(startLocal, timezone),
    end: zonedDateTimeToUtc(endLocal, timezone),
    timezone,
  }
}

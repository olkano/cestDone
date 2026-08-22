// src/shared/cost-tracker.ts
import type { TokenUsage } from './types.js'

export interface UsageSnapshot extends TokenUsage {
  costUsd: number
  meteredCalls: number
  subscriptionCalls: number
}

function emptySnapshot(): UsageSnapshot {
  return {
    costUsd: 0,
    meteredCalls: 0,
    subscriptionCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }
}

function addSnapshots(a: UsageSnapshot, b: UsageSnapshot): UsageSnapshot {
  return {
    costUsd: a.costUsd + b.costUsd,
    meteredCalls: a.meteredCalls + b.meteredCalls,
    subscriptionCalls: a.subscriptionCalls + b.subscriptionCalls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  }
}

export class CostTracker {
  private directorTotal: UsageSnapshot = emptySnapshot()
  private workerTotal: UsageSnapshot = emptySnapshot()

  recordDirector(snapshot: TokenUsage & { costUsd: number | null }): void {
    this.directorTotal = addSnapshots(this.directorTotal, normalizeSnapshot(snapshot))
  }

  recordWorker(snapshot: TokenUsage & { costUsd: number | null }): void {
    this.workerTotal = addSnapshots(this.workerTotal, normalizeSnapshot(snapshot))
  }

  getDirectorTotal(): Readonly<UsageSnapshot> {
    return this.directorTotal
  }

  getWorkerTotal(): Readonly<UsageSnapshot> {
    return this.workerTotal
  }

  getGrandTotal(): Readonly<UsageSnapshot> {
    return addSnapshots(this.directorTotal, this.workerTotal)
  }
}

function normalizeSnapshot(snapshot: TokenUsage & { costUsd: number | null }): UsageSnapshot {
  return {
    ...snapshot,
    costUsd: snapshot.costUsd ?? 0,
    meteredCalls: snapshot.costUsd === null ? 0 : 1,
    subscriptionCalls: snapshot.costUsd === null ? 1 : 0,
  }
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

export function formatUsage(label: string, snap: TokenUsage & { costUsd: number | null }): string {
  const cost = snap.costUsd === null ? 'n/a (subscription)' : `$${snap.costUsd.toFixed(4)}`
  return `${label}: ${cost} | in:${snap.inputTokens} out:${snap.outputTokens} cache-r:${snap.cacheReadInputTokens} cache-w:${snap.cacheCreationInputTokens}`
}

function totalProcessed(snap: UsageSnapshot): number {
  return snap.inputTokens + snap.cacheCreationInputTokens + snap.cacheReadInputTokens + snap.outputTokens
}

function formatCost(snap: UsageSnapshot): string {
  if (snap.subscriptionCalls > 0 && snap.meteredCalls === 0) return 'n/a (subscription)'
  if (snap.subscriptionCalls > 0) return `$${snap.costUsd.toFixed(2)} metered + subscription`
  return `$${snap.costUsd.toFixed(2)}`
}

export function formatTotals(tracker: CostTracker): string {
  const d = tracker.getDirectorTotal()
  const c = tracker.getWorkerTotal()
  const g = tracker.getGrandTotal()
  return `Totals — Director: ${formatCost(d)} (processed:${fmtTokens(totalProcessed(d))} out:${fmtTokens(d.outputTokens)}) | Worker: ${formatCost(c)} (processed:${fmtTokens(totalProcessed(c))} out:${fmtTokens(c.outputTokens)}) | Total: ${formatCost(g)}`
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000)
  const mins = Math.floor(secs / 60)
  const hrs = Math.floor(mins / 60)
  if (hrs > 0) return `${hrs}h ${mins % 60}m ${secs % 60}s`
  if (mins > 0) return `${mins}m ${secs % 60}s`
  return `${secs}s`
}

export function formatFinalSummary(tracker: CostTracker, elapsedMs: number): string {
  const d = tracker.getDirectorTotal()
  const c = tracker.getWorkerTotal()
  const g = tracker.getGrandTotal()
  return [
    '=== Final Summary ===',
    `Total time: ${formatDuration(elapsedMs)}`,
    `Director — ${formatCost(d)} | processed: ${fmtTokens(totalProcessed(d))} (in:${fmtTokens(d.inputTokens)} cache-w:${fmtTokens(d.cacheCreationInputTokens)} cache-r:${fmtTokens(d.cacheReadInputTokens)} out:${fmtTokens(d.outputTokens)})`,
    `Worker    — ${formatCost(c)} | processed: ${fmtTokens(totalProcessed(c))} (in:${fmtTokens(c.inputTokens)} cache-w:${fmtTokens(c.cacheCreationInputTokens)} cache-r:${fmtTokens(c.cacheReadInputTokens)} out:${fmtTokens(c.outputTokens)})`,
    `Grand total: ${formatCost(g)} | processed tokens: ${fmtTokens(totalProcessed(g))}`,
  ].join('\n')
}

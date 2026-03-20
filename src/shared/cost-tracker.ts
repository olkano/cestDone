// src/shared/cost-tracker.ts
import type { TokenUsage } from './types.js'

export interface UsageSnapshot extends TokenUsage {
  costUsd: number
}

function emptySnapshot(): UsageSnapshot {
  return { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
}

function addSnapshots(a: UsageSnapshot, b: UsageSnapshot): UsageSnapshot {
  return {
    costUsd: a.costUsd + b.costUsd,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  }
}

export class CostTracker {
  private directorTotal: UsageSnapshot = emptySnapshot()
  private workerTotal: UsageSnapshot = emptySnapshot()

  recordDirector(snapshot: UsageSnapshot): void {
    this.directorTotal = addSnapshots(this.directorTotal, snapshot)
  }

  recordWorker(snapshot: UsageSnapshot): void {
    this.workerTotal = addSnapshots(this.workerTotal, snapshot)
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

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

export function formatUsage(label: string, snap: UsageSnapshot): string {
  return `${label}: $${snap.costUsd.toFixed(4)} | in:${snap.inputTokens} out:${snap.outputTokens} cache-r:${snap.cacheReadInputTokens} cache-w:${snap.cacheCreationInputTokens}`
}

/** Total context = non-cached input + cache-read input */
function totalIn(snap: UsageSnapshot): number {
  return snap.inputTokens + snap.cacheReadInputTokens
}

export function formatTotals(tracker: CostTracker): string {
  const d = tracker.getDirectorTotal()
  const c = tracker.getWorkerTotal()
  const g = tracker.getGrandTotal()
  return `Totals — Director: $${d.costUsd.toFixed(2)} (in:${fmtTokens(totalIn(d))} out:${fmtTokens(d.outputTokens)}) | Worker: $${c.costUsd.toFixed(2)} (in:${fmtTokens(totalIn(c))} out:${fmtTokens(c.outputTokens)}) | Total: $${g.costUsd.toFixed(2)}`
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
    `Director — $${d.costUsd.toFixed(2)} | tokens: ${fmtTokens(totalIn(d))} in, ${fmtTokens(d.outputTokens)} out`,
    `Worker    — $${c.costUsd.toFixed(2)} | tokens: ${fmtTokens(totalIn(c))} in, ${fmtTokens(c.outputTokens)} out`,
    `Grand total: $${g.costUsd.toFixed(2)}`,
  ].join('\n')
}

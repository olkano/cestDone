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
  private coderTotal: UsageSnapshot = emptySnapshot()

  recordDirector(snapshot: UsageSnapshot): void {
    this.directorTotal = addSnapshots(this.directorTotal, snapshot)
  }

  recordCoder(snapshot: UsageSnapshot): void {
    this.coderTotal = addSnapshots(this.coderTotal, snapshot)
  }

  getDirectorTotal(): Readonly<UsageSnapshot> {
    return this.directorTotal
  }

  getCoderTotal(): Readonly<UsageSnapshot> {
    return this.coderTotal
  }

  getGrandTotal(): Readonly<UsageSnapshot> {
    return addSnapshots(this.directorTotal, this.coderTotal)
  }
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

export function formatUsage(label: string, snap: UsageSnapshot): string {
  return `${label}: $${snap.costUsd.toFixed(4)} | in:${snap.inputTokens} out:${snap.outputTokens} cache-r:${snap.cacheReadInputTokens} cache-w:${snap.cacheCreationInputTokens}`
}

export function formatTotals(tracker: CostTracker): string {
  const d = tracker.getDirectorTotal()
  const c = tracker.getCoderTotal()
  const g = tracker.getGrandTotal()
  return `Totals — Director: $${d.costUsd.toFixed(2)} (in:${fmtTokens(d.inputTokens)} out:${fmtTokens(d.outputTokens)}) | Coder: $${c.costUsd.toFixed(2)} (in:${fmtTokens(c.inputTokens)} out:${fmtTokens(c.outputTokens)}) | Total: $${g.costUsd.toFixed(2)}`
}

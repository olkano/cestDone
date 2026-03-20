// tests/cost-tracker.test.ts
import { describe, it, expect } from 'vitest'
import { CostTracker, formatUsage, formatTotals, formatFinalSummary } from '../src/shared/cost-tracker.js'

describe('CostTracker', () => {
  it('starts with all zeros', () => {
    const tracker = new CostTracker()
    const d = tracker.getDirectorTotal()
    const c = tracker.getWorkerTotal()
    const g = tracker.getGrandTotal()

    for (const snap of [d, c, g]) {
      expect(snap.costUsd).toBe(0)
      expect(snap.inputTokens).toBe(0)
      expect(snap.outputTokens).toBe(0)
      expect(snap.cacheReadInputTokens).toBe(0)
      expect(snap.cacheCreationInputTokens).toBe(0)
    }
  })

  it('accumulates Director usage across multiple calls', () => {
    const tracker = new CostTracker()

    tracker.recordDirector({ costUsd: 0.05, inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 50, cacheCreationInputTokens: 10 })
    tracker.recordDirector({ costUsd: 0.03, inputTokens: 800, outputTokens: 150, cacheReadInputTokens: 30, cacheCreationInputTokens: 5 })

    const d = tracker.getDirectorTotal()
    expect(d.costUsd).toBeCloseTo(0.08)
    expect(d.inputTokens).toBe(1800)
    expect(d.outputTokens).toBe(350)
    expect(d.cacheReadInputTokens).toBe(80)
    expect(d.cacheCreationInputTokens).toBe(15)
  })

  it('accumulates Worker usage across multiple calls', () => {
    const tracker = new CostTracker()

    tracker.recordWorker({ costUsd: 1.00, inputTokens: 50000, outputTokens: 10000, cacheReadInputTokens: 5000, cacheCreationInputTokens: 500 })
    tracker.recordWorker({ costUsd: 0.50, inputTokens: 25000, outputTokens: 5000, cacheReadInputTokens: 2000, cacheCreationInputTokens: 200 })

    const c = tracker.getWorkerTotal()
    expect(c.costUsd).toBeCloseTo(1.50)
    expect(c.inputTokens).toBe(75000)
    expect(c.outputTokens).toBe(15000)
  })

  it('grand total sums Director and Worker', () => {
    const tracker = new CostTracker()

    tracker.recordDirector({ costUsd: 0.10, inputTokens: 2000, outputTokens: 500, cacheReadInputTokens: 100, cacheCreationInputTokens: 20 })
    tracker.recordWorker({ costUsd: 1.00, inputTokens: 50000, outputTokens: 10000, cacheReadInputTokens: 5000, cacheCreationInputTokens: 500 })

    const g = tracker.getGrandTotal()
    expect(g.costUsd).toBeCloseTo(1.10)
    expect(g.inputTokens).toBe(52000)
    expect(g.outputTokens).toBe(10500)
    expect(g.cacheReadInputTokens).toBe(5100)
    expect(g.cacheCreationInputTokens).toBe(520)
  })

  it('keeps Director and Worker totals independent', () => {
    const tracker = new CostTracker()

    tracker.recordDirector({ costUsd: 0.10, inputTokens: 2000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
    tracker.recordWorker({ costUsd: 1.00, inputTokens: 50000, outputTokens: 10000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })

    expect(tracker.getDirectorTotal().inputTokens).toBe(2000)
    expect(tracker.getWorkerTotal().inputTokens).toBe(50000)
  })
})

describe('formatUsage', () => {
  it('formats a usage snapshot into a single line', () => {
    const line = formatUsage('Director call', { costUsd: 0.0512, inputTokens: 1234, outputTokens: 567, cacheReadInputTokens: 890, cacheCreationInputTokens: 12 })
    expect(line).toContain('Director call')
    expect(line).toContain('$0.0512')
    expect(line).toContain('in:1234')
    expect(line).toContain('out:567')
    expect(line).toContain('cache-r:890')
    expect(line).toContain('cache-w:12')
  })
})

describe('formatTotals', () => {
  it('formats accumulated totals for both agents', () => {
    const tracker = new CostTracker()
    tracker.recordDirector({ costUsd: 0.15, inputTokens: 5000, outputTokens: 2000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
    tracker.recordWorker({ costUsd: 1.25, inputTokens: 50000, outputTokens: 15000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })

    const line = formatTotals(tracker)
    expect(line).toContain('Director: $0.15')
    expect(line).toContain('Worker: $1.25')
    expect(line).toContain('Total: $1.40')
    expect(line).toContain('5.0K')
    expect(line).toContain('50.0K')
  })

  it('shows zeros when no usage recorded', () => {
    const tracker = new CostTracker()
    const line = formatTotals(tracker)
    expect(line).toContain('Director: $0.00')
    expect(line).toContain('Worker: $0.00')
    expect(line).toContain('Total: $0.00')
  })
})

describe('formatFinalSummary', () => {
  it('includes time, costs, and token breakdown', () => {
    const tracker = new CostTracker()
    tracker.recordDirector({ costUsd: 1.38, inputTokens: 125300, outputTokens: 4200, cacheReadInputTokens: 89100, cacheCreationInputTokens: 1000 })
    tracker.recordWorker({ costUsd: 1.65, inputTokens: 200500, outputTokens: 12100, cacheReadInputTokens: 156200, cacheCreationInputTokens: 2000 })

    const summary = formatFinalSummary(tracker, 24 * 60 * 1000 + 37 * 1000) // 24m 37s
    expect(summary).toContain('=== Final Summary ===')
    expect(summary).toContain('24m 37s')
    expect(summary).toContain('Director')
    expect(summary).toContain('$1.38')
    expect(summary).toContain('Worker')
    expect(summary).toContain('$1.65')
    expect(summary).toContain('Grand total: $3.03')
  })

  it('shows total context (input + cache-read) as the input number', () => {
    const tracker = new CostTracker()
    tracker.recordDirector({ costUsd: 0, inputTokens: 28, outputTokens: 2000, cacheReadInputTokens: 222100, cacheCreationInputTokens: 5000 })
    tracker.recordWorker({ costUsd: 0, inputTokens: 8, outputTokens: 1900, cacheReadInputTokens: 183500, cacheCreationInputTokens: 3000 })

    const summary = formatFinalSummary(tracker, 1196000) // ~20m
    // Should show total context consumed, not just non-cached input
    expect(summary).toContain('222.1K in')
    expect(summary).toContain('183.5K in')
    // Should NOT show the tiny non-cached numbers as the headline
    expect(summary).not.toMatch(/tokens: 28 in/)
    expect(summary).not.toMatch(/tokens: 8 in/)
  })

  it('formats hours when elapsed > 60 minutes', () => {
    const tracker = new CostTracker()
    const summary = formatFinalSummary(tracker, 2 * 3600 * 1000 + 15 * 60 * 1000 + 30 * 1000)
    expect(summary).toContain('2h 15m 30s')
  })

  it('formats seconds only when elapsed < 60 seconds', () => {
    const tracker = new CostTracker()
    const summary = formatFinalSummary(tracker, 45 * 1000)
    expect(summary).toContain('45s')
  })
})

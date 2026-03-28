// src/daemon/cleanup.ts
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_MAX_RUNS = 7
// Matches run dir pattern: {specName}_{YYYY-MM-DD}_{HHMMSS}
const RUN_DIR_PATTERN = /^(.+)_(\d{4}-\d{2}-\d{2})_(\d{6})$/

/**
 * Deletes old run directories under `.cestdone/` for a given target repo,
 * keeping only the most recent `maxRuns` per spec name.
 */
export function cleanupOldRuns(targetRepoPath: string, maxRuns?: number): string[] {
  const keep = maxRuns ?? DEFAULT_MAX_RUNS
  const cestdoneDir = path.join(targetRepoPath, '.cestdone')

  if (!fs.existsSync(cestdoneDir)) return []

  // Read all entries and filter to directories matching the run dir pattern
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(cestdoneDir, { withFileTypes: true })
  } catch {
    return []
  }

  // Group run dirs by spec name
  const bySpec = new Map<string, { name: string; timestamp: string }[]>()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const match = RUN_DIR_PATTERN.exec(entry.name)
    if (!match) continue

    const specName = match[1]
    const timestamp = `${match[2]}_${match[3]}` // YYYY-MM-DD_HHMMSS — lexicographic sort works
    const list = bySpec.get(specName) ?? []
    list.push({ name: entry.name, timestamp })
    bySpec.set(specName, list)
  }

  // For each spec, sort newest-first and delete the excess
  const removed: string[] = []
  for (const [, dirs] of bySpec) {
    if (dirs.length <= keep) continue

    dirs.sort((a, b) => b.timestamp.localeCompare(a.timestamp)) // newest first
    const toDelete = dirs.slice(keep)

    for (const dir of toDelete) {
      const fullPath = path.join(cestdoneDir, dir.name)
      try {
        fs.rmSync(fullPath, { recursive: true, force: true })
        removed.push(dir.name)
      } catch {
        // Best-effort — don't fail the run over cleanup
      }
    }
  }

  return removed
}

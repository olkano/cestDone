// src/daemon/cleanup.ts
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_MAX_RUNS = 7
// Matches run dir / log file pattern: {specName}_{YYYY-MM-DD}_{HHMMSS}[.log]
const RUN_DIR_PATTERN = /^(.+)_(\d{4}-\d{2}-\d{2})_(\d{6})$/
const LOG_FILE_PATTERN = /^(.+)_(\d{4}-\d{2}-\d{2})_(\d{6})\.log$/

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

/**
 * Deletes old log files in the central log directory,
 * keeping only the most recent `maxLogs` per spec name.
 */
export function cleanupCentralLogs(centralLogDir: string, maxLogs?: number): string[] {
  const keep = maxLogs ?? DEFAULT_MAX_RUNS

  if (!fs.existsSync(centralLogDir)) return []

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(centralLogDir, { withFileTypes: true })
  } catch {
    return []
  }

  const bySpec = new Map<string, { name: string; timestamp: string }[]>()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const match = LOG_FILE_PATTERN.exec(entry.name)
    if (!match) continue

    const specName = match[1]
    const timestamp = `${match[2]}_${match[3]}`
    const list = bySpec.get(specName) ?? []
    list.push({ name: entry.name, timestamp })
    bySpec.set(specName, list)
  }

  const removed: string[] = []
  for (const [, files] of bySpec) {
    if (files.length <= keep) continue

    files.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    const toDelete = files.slice(keep)

    for (const file of toDelete) {
      try {
        fs.unlinkSync(path.join(centralLogDir, file.name))
        removed.push(file.name)
      } catch {
        // Best-effort
      }
    }
  }

  return removed
}

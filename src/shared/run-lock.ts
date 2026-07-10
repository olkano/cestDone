import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60 * 1000

interface RunLockOptions {
  now?: () => Date
  staleAfterMs?: number
}

interface RunLockRecord {
  token: string
  pid: number
  startedAt: string
  specName: string
}

function safeLockName(specName: string): string {
  const safe = specName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return safe || 'run'
}

function readStartedAt(lockPath: string): number | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as Partial<RunLockRecord>
    const timestamp = parsed.startedAt ? Date.parse(parsed.startedAt) : Number.NaN
    return Number.isFinite(timestamp) ? timestamp : fs.statSync(lockPath).mtimeMs
  } catch {
    try {
      return fs.statSync(lockPath).mtimeMs
    } catch {
      return undefined
    }
  }
}

export function acquireRunLock(
  targetRepoPath: string,
  specName: string,
  options: RunLockOptions = {},
): () => void {
  const now = options.now ?? (() => new Date())
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  const lockDir = path.join(targetRepoPath, '.cestdone', 'locks')
  const lockPath = path.join(lockDir, `${safeLockName(specName)}.lock`)
  const record: RunLockRecord = {
    token: randomUUID(),
    pid: process.pid,
    startedAt: now().toISOString(),
    specName,
  }

  fs.mkdirSync(lockDir, { recursive: true })

  try {
    fs.writeFileSync(lockPath, JSON.stringify(record, null, 2), { encoding: 'utf-8', flag: 'wx' })
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException
    if (nodeError.code !== 'EEXIST') throw error

    const startedAt = readStartedAt(lockPath)
    if (startedAt !== undefined && now().getTime() - startedAt > staleAfterMs) {
      try {
        fs.unlinkSync(lockPath)
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
      }
      return acquireRunLock(targetRepoPath, specName, options)
    }

    throw new Error(
      `Job "${specName}" is already running for target ${targetRepoPath}. ` +
      `Lock: ${lockPath}`,
    )
  }

  let released = false
  return () => {
    if (released) return
    released = true
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as Partial<RunLockRecord>
      if (current.token === record.token) fs.unlinkSync(lockPath)
    } catch {
      // Best effort: never mask the run's real result during cleanup.
    }
  }
}

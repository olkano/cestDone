// src/daemon/notifications.ts
import fs from 'node:fs'
import path from 'node:path'
import type { Job } from './job-queue.js'
import type { DaemonConfig } from './types.js'
import type { DaemonLogger } from './daemon-logger.js'
import { sendEmail } from '../email/index.js'

const RUN_DIR_PATTERN = /^(.+)_(\d{4}-\d{2}-\d{2})_(\d{6})$/

export async function notifyJobFailure(
  job: Job,
  errorMessage: string,
  config: DaemonConfig,
  logger: DaemonLogger,
  targetRepoPath?: string,
): Promise<void> {
  if (!config.notifications?.email) return

  const { recipients } = config.notifications.email
  const totalAttempts = job.maxRetries + 1
  const targetRepo = (job.options as Record<string, unknown>)?.target ?? targetRepoPath ?? '(not specified)'

  const subject = `[cestdone] Job "${job.trigger}" failed`

  const lines = [
    `Job "${job.trigger}" has failed after ${totalAttempts} attempt(s).`,
    '',
    `Trigger: ${job.trigger}`,
    `Spec: ${job.specPath}`,
    `Target repo: ${targetRepo}`,
    `Error: ${errorMessage}`,
    `Attempts: ${totalAttempts}`,
    `Created: ${job.createdAt.toISOString()}`,
    job.startedAt ? `Started: ${job.startedAt.toISOString()}` : '',
    job.completedAt ? `Ended: ${job.completedAt.toISOString()}` : '',
  ]

  // Try to find the latest run dir and include the last phase report
  const runDirPath = typeof targetRepo === 'string' ? targetRepo : undefined
  const { report, logFile } = findLatestRunContext(job.specPath, runDirPath)
  if (report) {
    lines.push('', '--- Last Phase Report ---', '', report)
  }
  if (logFile) {
    lines.push('', `Full log: ${logFile}`)
  }

  const body = lines.filter(Boolean).join('\n')

  try {
    const result = await sendEmail({ to: recipients, subject, body })
    if (result.success) {
      logger.info(`Failure notification sent for job "${job.trigger}" (messageId: ${result.messageId})`)
    } else {
      logger.warn(`Failed to send notification for job "${job.trigger}": ${result.error}`)
    }
  } catch (err) {
    logger.warn(`Failed to send notification for job "${job.trigger}": ${(err as Error).message}`)
  }
}

/**
 * Finds the latest run directory for a spec and returns the last phase report
 * content and log file path. Best-effort -- returns empty strings on any error.
 */
function findLatestRunContext(
  specPath: string,
  targetRepoPath?: string,
): { report: string; logFile: string } {
  const empty = { report: '', logFile: '' }
  if (!targetRepoPath) return empty

  try {
    const specName = path.basename(specPath, path.extname(specPath))
      .replace(/[^a-zA-Z0-9_-]/g, '-')
    const cestdoneDir = path.join(targetRepoPath, '.cestdone')
    if (!fs.existsSync(cestdoneDir)) return empty

    const entries = fs.readdirSync(cestdoneDir, { withFileTypes: true })
    const matchingDirs = entries
      .filter(e => e.isDirectory())
      .map(e => {
        const m = e.name.match(RUN_DIR_PATTERN)
        if (!m || m[1] !== specName) return null
        return { name: e.name, timestamp: `${m[2]}_${m[3]}` }
      })
      .filter(Boolean) as { name: string; timestamp: string }[]

    if (matchingDirs.length === 0) return empty
    matchingDirs.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    const latestDir = path.join(cestdoneDir, matchingDirs[0].name)

    // Find the last phase report (highest phase number)
    const files = fs.readdirSync(latestDir)
    const reportFiles = files
      .filter(f => /^phase-\d+-report\.md$/.test(f))
      .sort()
    const lastReport = reportFiles.length > 0 ? reportFiles[reportFiles.length - 1] : null

    const report = lastReport
      ? fs.readFileSync(path.join(latestDir, lastReport), 'utf-8').trim()
      : ''

    // Find the log file
    const logFiles = files.filter(f => f.endsWith('.log'))
    const logFile = logFiles.length > 0 ? path.join(latestDir, logFiles[0]) : ''

    return { report, logFile }
  } catch {
    return empty
  }
}

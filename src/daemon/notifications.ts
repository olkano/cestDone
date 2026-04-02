// src/daemon/notifications.ts
import type { Job } from './job-queue.js'
import type { DaemonConfig } from './types.js'
import type { DaemonLogger } from './daemon-logger.js'
import { sendEmail } from '../email/index.js'

export async function notifyJobFailure(
  job: Job,
  errorMessage: string,
  config: DaemonConfig,
  logger: DaemonLogger,
): Promise<void> {
  if (!config.notifications?.email) return

  const { recipients } = config.notifications.email
  const totalAttempts = job.maxRetries + 1
  const targetRepo = (job.options as Record<string, unknown>)?.target ?? '(not specified)'

  const subject = `[cestdone] Job "${job.trigger}" failed`

  const body = [
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
  ].filter(Boolean).join('\n')

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

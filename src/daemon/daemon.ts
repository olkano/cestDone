// src/daemon/daemon.ts
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from '../shared/types.js'
import type { RunOptions } from '../cli/index.js'
import type { DaemonConfig } from './types.js'
import type { DaemonLogger } from './daemon-logger.js'
import type { TemplateContext } from './template.js'
import { validateDaemonConfig } from './config-validator.js'
import { createJobQueue, type Job } from './job-queue.js'
import { createScheduler, type Scheduler } from './scheduler.js'
import { createWebhookServer, type WebhookServer } from './webhook-server.js'
import { createPoller, type Poller } from './poller.js'
import { writePidFile, removePidFile, isDaemonRunning } from './pid.js'
import { renderTemplate } from './template.js'
import { cleanupOldRuns, cleanupCentralLogs } from './cleanup.js'
import { notifyJobFailure } from './notifications.js'

export interface DaemonDeps {
  executeRun: (specPath: string, options: RunOptions) => Promise<void>
  logger: DaemonLogger
  config: Config
}

export interface DaemonProcess {
  start(): Promise<void>
  stop(): Promise<void>
}

const DEFAULT_LOG_DIR = 'logs/daemon'
const DEFAULT_PID_FILE = 'logs/daemon/daemon.pid'
const QUEUE_POLL_MS = 500
const SHUTDOWN_TIMEOUT_MS = 60_000

export function createDaemon(deps: DaemonDeps): DaemonProcess {
  if (!deps.config.daemon) {
    throw new Error('No daemon configuration found in .cestdonerc.json')
  }
  const daemonConfig: DaemonConfig = deps.config.daemon

  const validation = validateDaemonConfig(daemonConfig)
  if (!validation.valid) {
    throw new Error(`Invalid daemon config:\n${validation.errors.join('\n')}`)
  }

  const logDir = daemonConfig.logDir ?? DEFAULT_LOG_DIR
  const pidFile = daemonConfig.pidFile ?? DEFAULT_PID_FILE

  const queue = createJobQueue()
  let scheduler: Scheduler | undefined
  let webhookServers: WebhookServer[] = []
  let poller: Poller | undefined
  let stopped = false
  let runLoopPromise: Promise<void> | undefined

  function enqueueFromSchedule(name: string, specPath: string, options?: Partial<RunOptions>, retry?: { retries?: number; retryDelayMs?: number }): void {
    queue.enqueue({
      trigger: name,
      specPath,
      options: options ?? {},
      maxRetries: retry?.retries ?? 0,
      retryDelayMs: retry?.retryDelayMs ?? 60_000,
    })
    deps.logger.info(`Enqueued job from schedule "${name}": ${specPath}`)
  }

  function enqueueFromWebhook(
    name: string,
    specPath: string,
    payload: Record<string, unknown>,
    options?: Partial<RunOptions>,
    retry?: { retries?: number; retryDelayMs?: number },
  ): void {
    const context: TemplateContext = {
      trigger: { name, type: 'webhook' },
      payload,
      timestamp: new Date().toISOString(),
    }
    queue.enqueue({
      trigger: name,
      specPath,
      options: options ?? {},
      templateContext: context,
      maxRetries: retry?.retries ?? 0,
      retryDelayMs: retry?.retryDelayMs ?? 60_000,
    })
    deps.logger.info(`Enqueued job from webhook "${name}": ${specPath}`)
  }

  function enqueueFromPoller(
    name: string,
    specPath: string,
    output: string,
    options?: Partial<RunOptions>,
    retry?: { retries?: number; retryDelayMs?: number },
  ): void {
    const context: TemplateContext = {
      trigger: { name, type: 'poller' },
      payload: { output },
      timestamp: new Date().toISOString(),
    }
    queue.enqueue({
      trigger: name,
      specPath,
      options: options ?? {},
      templateContext: context,
      maxRetries: retry?.retries ?? 0,
      retryDelayMs: retry?.retryDelayMs ?? 60_000,
    })
    deps.logger.info(`Enqueued job from poller "${name}": ${specPath}`)
  }

  async function processJob(job: Job): Promise<void> {
    queue.markRunning(job.id)
    deps.logger.jobStart(job)

    const maxAttempts = job.maxRetries + 1

    for (let attempt = job.attempt; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1) {
          deps.logger.info(`Job "${job.trigger}" retry ${attempt - 1}/${job.maxRetries}`)
        }

        let effectiveSpecPath = job.specPath

        // Apply template if context is present
        if (job.templateContext) {
          const specContent = fs.readFileSync(job.specPath, 'utf-8')
          const rendered = renderTemplate(specContent, job.templateContext as TemplateContext)
          const renderedDir = path.join(logDir, 'rendered')
          fs.mkdirSync(renderedDir, { recursive: true })
          effectiveSpecPath = path.join(renderedDir, `${job.id}.md`)
          fs.writeFileSync(effectiveSpecPath, rendered, 'utf-8')
        }

        const runOptions: RunOptions = {
          ...(job.options as Partial<RunOptions>),
          nonInteractive: true,
        }

        await deps.executeRun(effectiveSpecPath, runOptions)
        queue.markCompleted(job.id)
        deps.logger.jobEnd(job)
        break // success
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))

        if (attempt < maxAttempts) {
          deps.logger.warn(
            `Job "${job.trigger}" attempt ${attempt}/${maxAttempts} failed: ${error.message}. ` +
            `Retrying in ${job.retryDelayMs}ms...`
          )
          await new Promise((resolve) => setTimeout(resolve, job.retryDelayMs))
          continue
        }

        // Final attempt failed
        queue.markFailed(job.id, error.message)
        deps.logger.jobEnd(job, error)
        await notifyJobFailure(job, error.message, daemonConfig, deps.logger)
      }
    }

    // Cleanup old run dirs and central logs (best-effort, runs after success or failure)
    if (daemonConfig.cleanup) {
      try {
        const targetDir = (job.options as Partial<RunOptions>).target ?? deps.config.targetRepoPath
        const removed = cleanupOldRuns(targetDir, daemonConfig.cleanup.maxRuns)
        if (removed.length > 0) {
          deps.logger.info(`Cleanup: removed ${removed.length} old run dir(s) from ${targetDir}`)
        }
      } catch (err) {
        deps.logger.warn(`Cleanup failed: ${(err as Error).message}`)
      }

      if (deps.config.centralLogDir) {
        try {
          const maxLogs = daemonConfig.cleanup.maxCentralLogs ?? daemonConfig.cleanup.maxRuns
          const removed = cleanupCentralLogs(deps.config.centralLogDir, maxLogs)
          if (removed.length > 0) {
            deps.logger.info(`Cleanup: removed ${removed.length} old central log(s)`)
          }
        } catch (err) {
          deps.logger.warn(`Central log cleanup failed: ${(err as Error).message}`)
        }
      }
    }
  }

  async function runLoop(): Promise<void> {
    while (!stopped) {
      const job = queue.dequeue()
      if (job) {
        await processJob(job)
      } else {
        await new Promise((resolve) => setTimeout(resolve, QUEUE_POLL_MS))
      }
    }
  }

  return {
    async start(): Promise<void> {
      if (isDaemonRunning(pidFile)) {
        throw new Error(`Daemon is already running (PID file: ${pidFile})`)
      }

      writePidFile(pidFile)
      deps.logger.info('Daemon starting')

      // Create scheduler
      if (daemonConfig.schedules?.length) {
        scheduler = createScheduler(daemonConfig.schedules, (schedule) => {
          enqueueFromSchedule(schedule.name, schedule.spec, {
            ...schedule.options,
            target: schedule.target,
            houseRules: schedule.houseRules,
          }, { retries: schedule.retries, retryDelayMs: schedule.retryDelayMs })
        })
        scheduler.start()
        deps.logger.info(`Scheduler started with ${daemonConfig.schedules.length} schedule(s)`)

        for (const run of scheduler.getNextRuns()) {
          deps.logger.info(`  "${run.name}" next run: ${run.next?.toISOString() ?? 'never'}`)
        }
      }

      // Create webhook servers (group by port)
      if (daemonConfig.webhooks?.length) {
        const byPort = new Map<number, typeof daemonConfig.webhooks>()
        for (const wh of daemonConfig.webhooks) {
          const existing = byPort.get(wh.port) ?? []
          existing.push(wh)
          byPort.set(wh.port, existing)
        }

        for (const [port, webhooks] of byPort) {
          const server = createWebhookServer(webhooks, (webhook, payload) => {
            enqueueFromWebhook(webhook.name, webhook.spec, payload, {
              ...webhook.options,
              target: webhook.target,
            }, { retries: webhook.retries, retryDelayMs: webhook.retryDelayMs })
          })
          await server.start()
          webhookServers.push(server)
          deps.logger.info(`Webhook server listening on port ${server.port} (${webhooks.length} hook(s))`)
        }
      }

      // Create pollers
      if (daemonConfig.pollers?.length) {
        poller = createPoller(daemonConfig.pollers, (pollerConfig, output) => {
          enqueueFromPoller(pollerConfig.name, pollerConfig.spec, output, {
            ...pollerConfig.options,
            target: pollerConfig.target,
          }, { retries: pollerConfig.retries, retryDelayMs: pollerConfig.retryDelayMs })
        })
        poller.start()
        deps.logger.info(`Poller started with ${daemonConfig.pollers.length} poller(s)`)
      }

      deps.logger.info('Daemon started')

      // Start the run loop
      runLoopPromise = runLoop()
    },

    async stop(): Promise<void> {
      deps.logger.info('Daemon stopping')
      stopped = true

      // Stop all trigger sources
      scheduler?.stop()
      poller?.stop()
      for (const server of webhookServers) {
        await server.stop()
      }
      webhookServers = []

      // Wait for current job with timeout
      if (runLoopPromise) {
        await Promise.race([
          runLoopPromise,
          new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
        ])
      }

      removePidFile(pidFile)
      deps.logger.info('Daemon stopped')
    },
  }
}

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
  const daemonConfig = deps.config.daemon
  if (!daemonConfig) {
    throw new Error('No daemon configuration found in .cestdonerc.json')
  }

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

  function enqueueFromSchedule(name: string, specPath: string, options?: Partial<RunOptions>): void {
    queue.enqueue({
      trigger: name,
      specPath,
      options: options ?? {},
    })
    deps.logger.info(`Enqueued job from schedule "${name}": ${specPath}`)
  }

  function enqueueFromWebhook(
    name: string,
    specPath: string,
    payload: Record<string, unknown>,
    options?: Partial<RunOptions>,
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
    })
    deps.logger.info(`Enqueued job from webhook "${name}": ${specPath}`)
  }

  function enqueueFromPoller(
    name: string,
    specPath: string,
    output: string,
    options?: Partial<RunOptions>,
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
    })
    deps.logger.info(`Enqueued job from poller "${name}": ${specPath}`)
  }

  async function processJob(job: Job): Promise<void> {
    queue.markRunning(job.id)
    deps.logger.jobStart(job)

    try {
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
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      queue.markFailed(job.id, error.message)
      deps.logger.jobEnd(job, error)
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
          enqueueFromSchedule(schedule.name, schedule.spec, schedule.options)
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
            enqueueFromWebhook(webhook.name, webhook.spec, payload, webhook.options)
          })
          await server.start()
          webhookServers.push(server)
          deps.logger.info(`Webhook server listening on port ${server.port} (${webhooks.length} hook(s))`)
        }
      }

      // Create pollers
      if (daemonConfig.pollers?.length) {
        poller = createPoller(daemonConfig.pollers, (config, output) => {
          enqueueFromPoller(config.name, config.spec, output, config.options)
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

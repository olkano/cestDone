// src/daemon/poller.ts
import { Cron } from 'croner'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import type { PollingConfig } from './types.js'
import type { PollerStateStore } from './poller-state.js'

export interface Poller {
  start(): void
  stop(): void
}

export function createPoller(
  pollers: PollingConfig[],
  onTrigger: (config: PollingConfig, output: string) => void,
  stateStore: PollerStateStore,
): Poller {
  const cronJobs: Cron[] = []
  let acceptingResults = true

  for (const config of pollers) {
    const job = new Cron(config.cron, { paused: true }, async () => {
      try {
        let output: string
        if (config.command) {
          output = execSync(config.command, { encoding: 'utf-8', timeout: 30_000 })
        } else if (config.url) {
          const res = await fetch(config.url)
          if (!res.ok) throw new Error(`HTTP poll failed with status ${res.status}`)
          output = await res.text()
        } else {
          return
        }
        if (!acceptingResults) return

        const hash = crypto.createHash('sha256').update(output).digest('hex')
        const sourceFingerprint = pollerSourceFingerprint(config)
        const previous = stateStore.get(config.name)

        if (previous?.sourceFingerprint !== sourceFingerprint || previous.outputHash !== hash) {
          onTrigger(config, output)
          stateStore.accept(config.name, {
            sourceFingerprint,
            outputHash: hash,
            observedAt: new Date().toISOString(),
          })
        }
      } catch {
        // Leave the observation unchanged so a later poll can retry safely.
      }
    })
    cronJobs.push(job)
  }

  return {
    start() {
      acceptingResults = true
      for (const job of cronJobs) job.resume()
    },
    stop() {
      acceptingResults = false
      for (const job of cronJobs) job.stop()
    },
  }
}

export function pollerSourceFingerprint(config: PollingConfig): string {
  const identity = config.command !== undefined
    ? { type: 'command', value: config.command }
    : { type: 'url', value: config.url ?? '' }
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

export function pollerSourceFingerprints(pollers: PollingConfig[]): Map<string, string> {
  return new Map(pollers.map(config => [config.name, pollerSourceFingerprint(config)]))
}

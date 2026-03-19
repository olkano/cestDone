// src/daemon/poller.ts
import { Cron } from 'croner'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import type { PollingConfig } from './types.js'

export interface Poller {
  start(): void
  stop(): void
}

export function createPoller(
  pollers: PollingConfig[],
  onTrigger: (config: PollingConfig, output: string) => void,
): Poller {
  const hashes = new Map<string, string>()
  const cronJobs: Cron[] = []

  for (const config of pollers) {
    const job = new Cron(config.cron, { paused: true }, async () => {
      try {
        let output: string
        if (config.command) {
          output = execSync(config.command, { encoding: 'utf-8', timeout: 30_000 })
        } else if (config.url) {
          const res = await fetch(config.url)
          output = await res.text()
        } else {
          return
        }

        const hash = crypto.createHash('sha256').update(output).digest('hex')
        const prevHash = hashes.get(config.name)

        if (prevHash !== hash) {
          hashes.set(config.name, hash)
          onTrigger(config, output)
        }
      } catch {
        // Silently skip failed polls — daemon logger handles this at the call site
      }
    })
    cronJobs.push(job)
  }

  return {
    start() {
      for (const job of cronJobs) job.resume()
    },
    stop() {
      for (const job of cronJobs) job.stop()
    },
  }
}

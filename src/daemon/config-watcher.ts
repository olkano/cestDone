// src/daemon/config-watcher.ts
import fs from 'node:fs'
import type { DaemonConfig } from './types.js'
import { validateDaemonConfig } from './config-validator.js'

export interface ConfigWatcher {
  start(): void
  stop(): void
}

export interface ConfigWatcherOptions {
  configPath: string
  debounceMs?: number
  onReload: (daemonConfig: DaemonConfig) => void
  onError: (error: Error) => void
}

const DEFAULT_DEBOUNCE_MS = 500

export function createConfigWatcher(options: ConfigWatcherOptions): ConfigWatcher {
  const { configPath, onReload, onError } = options
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS

  let watcher: fs.FSWatcher | undefined
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  function handleChange(): void {
    // Debounce: editors often fire multiple events per save
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      try {
        const raw = fs.readFileSync(configPath, 'utf-8')
        const parsed = JSON.parse(raw)
        const daemonConfig: DaemonConfig | undefined = parsed.daemon
        if (!daemonConfig) {
          onError(new Error('No "daemon" section found in config'))
          return
        }

        const validation = validateDaemonConfig(daemonConfig)
        if (!validation.valid) {
          onError(new Error(`Invalid daemon config:\n${validation.errors.join('\n')}`))
          return
        }

        onReload(daemonConfig)
      } catch (err) {
        // Partial write or invalid JSON -- ignore, will retry on next save
        onError(err instanceof Error ? err : new Error(String(err)))
      }
    }, debounceMs)
  }

  return {
    start() {
      watcher = fs.watch(configPath, { persistent: false }, (eventType) => {
        if (eventType === 'change') {
          handleChange()
        }
      })
      // Handle watcher errors (e.g., file deleted)
      watcher.on('error', (err) => {
        onError(err instanceof Error ? err : new Error(String(err)))
      })
    },

    stop() {
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = undefined
      }
      if (watcher) {
        watcher.close()
        watcher = undefined
      }
    },
  }
}

// src/daemon/config-watcher.ts
import fs from 'node:fs'
import type { Config } from '../shared/types.js'
import { validateConfig } from './config-validator.js'

export interface ConfigWatcher {
  start(): void
  stop(): void
}

export interface ConfigWatcherOptions {
  configPath: string
  debounceMs?: number
  onReload: (config: Config) => void | Promise<void>
  onError: (error: Error) => void
  onInfo?: (message: string) => void
}

const DEFAULT_DEBOUNCE_MS = 500

export function createConfigWatcher(options: ConfigWatcherOptions): ConfigWatcher {
  const { configPath, onReload, onError } = options
  const onInfo = options.onInfo ?? (() => undefined)
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS

  let watcher: fs.FSWatcher | undefined
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let lastAcceptedConfig: string | undefined
  let reloadInFlight: Promise<void> | undefined
  let reloadPending = false

  function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonicalize(entry)]),
      )
    }
    return value
  }

  function readValidConfig(): Config {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Config
    if (!parsed.daemon) throw new Error('No "daemon" section found in config')

    const validation = validateConfig(parsed)
    if (!validation.valid) {
      throw new Error(`Invalid daemon config:\n${validation.errors.join('\n')}`)
    }
    return parsed
  }

  function semanticIdentity(config: Config): string {
    return JSON.stringify(canonicalize(config))
  }

  async function reloadIfChanged(): Promise<void> {
    try {
      const parsed = readValidConfig()
      const identity = semanticIdentity(parsed)
      if (identity === lastAcceptedConfig) {
        onInfo('Skipped daemon config reload: no semantic changes')
        return
      }

      await onReload(parsed)
      lastAcceptedConfig = identity
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)))
    }
  }

  function processReload(): void {
    if (reloadInFlight) {
      reloadPending = true
      return
    }

    const operation = reloadIfChanged()
    reloadInFlight = operation
    void operation.finally(() => {
      reloadInFlight = undefined
      if (reloadPending) {
        reloadPending = false
        processReload()
      }
    })
  }

  function handleChange(): void {
    // Debounce: editors often fire multiple events per save
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(processReload, debounceMs)
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
      try {
        lastAcceptedConfig = semanticIdentity(readValidConfig())
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)))
      }
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

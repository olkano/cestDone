import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const STATE_VERSION = 1
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024
const DEFAULT_MAX_ENTRIES = 1000
const MAX_POLLER_NAME_LENGTH = 256
const SHA256_PATTERN = /^[a-f0-9]{64}$/

export interface PollerObservation {
  sourceFingerprint: string
  outputHash: string
  observedAt: string
}

export interface PollerStateStore {
  get(name: string): PollerObservation | undefined
  accept(name: string, observation: PollerObservation): void
  retain(sources: ReadonlyMap<string, string>): void
}

export interface PollerStateFileSystem {
  existsSync(filePath: string): boolean
  statSync(filePath: string): { size: number }
  readFileSync(filePath: string, encoding: BufferEncoding): string
  mkdirSync(directoryPath: string, options: { recursive: true }): unknown
  writeFileSync(filePath: string, data: string, encoding: BufferEncoding): void
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(filePath: string): void
}

export interface PollerStateStoreOptions {
  fileSystem?: PollerStateFileSystem
  warn?: (message: string) => void
  maxFileBytes?: number
  maxEntries?: number
}

interface SerializedPollerState {
  version: typeof STATE_VERSION
  observations: Record<string, PollerObservation>
}

function isObservation(value: unknown): value is PollerObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.sourceFingerprint === 'string'
    && SHA256_PATTERN.test(record.sourceFingerprint)
    && typeof record.outputHash === 'string'
    && SHA256_PATTERN.test(record.outputHash)
    && typeof record.observedAt === 'string'
    && !Number.isNaN(Date.parse(record.observedAt))
}

function parseState(raw: string, maxEntries: number): Map<string, PollerObservation> {
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid state')
  }

  const record = parsed as Record<string, unknown>
  if (record.version !== STATE_VERSION) throw new Error('unsupported state version')
  if (!record.observations || typeof record.observations !== 'object' || Array.isArray(record.observations)) {
    throw new Error('invalid observations')
  }

  const entries = Object.entries(record.observations as Record<string, unknown>)
  if (entries.length > maxEntries) throw new Error('too many observations')

  const observations = new Map<string, PollerObservation>()
  for (const [name, observation] of entries) {
    if (!name || name.length > MAX_POLLER_NAME_LENGTH || !isObservation(observation)) {
      throw new Error('invalid observation')
    }
    observations.set(name, { ...observation })
  }
  return observations
}

export function createPollerStateStore(
  statePath: string,
  options: PollerStateStoreOptions = {},
): PollerStateStore {
  const fileSystem = options.fileSystem ?? fs
  const warn = options.warn ?? (() => undefined)
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  let observations = new Map<string, PollerObservation>()

  if (fileSystem.existsSync(statePath)) {
    try {
      const stats = fileSystem.statSync(statePath)
      if (stats.size > maxFileBytes) throw new Error('state file too large')
      observations = parseState(fileSystem.readFileSync(statePath, 'utf8'), maxEntries)
    } catch {
      warn(`Poller state at ${statePath} could not be loaded; starting without established observations`)
    }
  }

  function persist(): void {
    const ordered = [...observations.entries()].sort(([left], [right]) => left.localeCompare(right))
    const serialized: SerializedPollerState = {
      version: STATE_VERSION,
      observations: Object.fromEntries(ordered),
    }
    const temporaryPath = `${statePath}.${process.pid}.${crypto.randomUUID()}.tmp`

    try {
      fileSystem.mkdirSync(path.dirname(statePath), { recursive: true })
      fileSystem.writeFileSync(temporaryPath, `${JSON.stringify(serialized, null, 2)}\n`, 'utf8')
      fileSystem.renameSync(temporaryPath, statePath)
    } catch {
      try {
        if (fileSystem.existsSync(temporaryPath)) fileSystem.unlinkSync(temporaryPath)
      } catch {
        // Best-effort cleanup only. The accepted in-memory observation is retained.
      }
      warn(`Poller state at ${statePath} could not be persisted; in-memory deduplication remains active`)
    }
  }

  return {
    get(name) {
      const observation = observations.get(name)
      return observation ? { ...observation } : undefined
    },

    accept(name, observation) {
      observations.set(name, { ...observation })
      persist()
    },

    retain(sources) {
      let changed = false
      for (const [name, observation] of observations) {
        if (sources.get(name) !== observation.sourceFingerprint) {
          observations.delete(name)
          changed = true
        }
      }
      if (changed) persist()
    },
  }
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPollerStateStore } from '../src/daemon/poller-state.js'

const tempDirs: string[] = []
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function tempStatePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-poller-state-'))
  tempDirs.push(dir)
  return path.join(dir, 'poller-state.json')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('poller state store', () => {
  it('treats a missing file as unestablished and persists an accepted observation', () => {
    const statePath = tempStatePath()
    const warn = vi.fn()
    const store = createPollerStateStore(statePath, { warn })

    expect(store.get('inbox')).toBeUndefined()
    store.accept('inbox', { sourceFingerprint: HASH_A, outputHash: HASH_B, observedAt: '2026-09-21T10:00:00.000Z' })

    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    expect(saved).toEqual({
      version: 1,
      observations: {
        inbox: {
          sourceFingerprint: HASH_A,
          outputHash: HASH_B,
          observedAt: '2026-09-21T10:00:00.000Z',
        },
      },
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('reloads a valid observation after a simulated process restart', () => {
    const statePath = tempStatePath()
    const first = createPollerStateStore(statePath)
    first.accept('inbox', { sourceFingerprint: HASH_A, outputHash: HASH_B, observedAt: '2026-09-21T10:00:00.000Z' })

    const restarted = createPollerStateStore(statePath)

    expect(restarted.get('inbox')).toEqual({
      sourceFingerprint: HASH_A,
      outputHash: HASH_B,
      observedAt: '2026-09-21T10:00:00.000Z',
    })
  })

  it.each([
    ['corrupt JSON', '{broken'],
    ['unsupported version', JSON.stringify({ version: 2, observations: {} })],
    ['invalid hash', JSON.stringify({ version: 1, observations: { inbox: { sourceFingerprint: 'secret source', outputHash: HASH_B, observedAt: '2026-09-21T10:00:00.000Z' } } })],
  ])('warns without content and starts unestablished for %s', (_label, content) => {
    const statePath = tempStatePath()
    fs.writeFileSync(statePath, content)
    const warn = vi.fn()

    const store = createPollerStateStore(statePath, { warn })

    expect(store.get('inbox')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).not.toContain(content)
  })

  it('rejects an oversized state file before parsing it', () => {
    const statePath = tempStatePath()
    fs.writeFileSync(statePath, 'x'.repeat(1_048_577))
    const warn = vi.fn()

    const store = createPollerStateStore(statePath, { warn })

    expect(store.get('inbox')).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be loaded'))
  })

  it('rejects a file with too many entries', () => {
    const statePath = tempStatePath()
    const observations = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [
      `poller-${index}`,
      { sourceFingerprint: HASH_A, outputHash: HASH_B, observedAt: '2026-09-21T10:00:00.000Z' },
    ]))
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, observations }))
    const warn = vi.fn()

    const store = createPollerStateStore(statePath, { warn })

    expect(store.get('poller-0')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('writes a temporary file and renames it without persisting raw output', () => {
    const statePath = tempStatePath()
    const writeFileSync = vi.fn()
    const renameSync = vi.fn()
    const mkdirSync = vi.fn()
    const store = createPollerStateStore(statePath, {
      fileSystem: {
        existsSync: vi.fn().mockReturnValue(false),
        statSync: vi.fn(),
        readFileSync: vi.fn(),
        mkdirSync,
        writeFileSync,
        renameSync,
        unlinkSync: vi.fn(),
      },
    })

    store.accept('inbox', { sourceFingerprint: HASH_A, outputHash: HASH_B, observedAt: '2026-09-21T10:00:00.000Z' })

    expect(writeFileSync).toHaveBeenCalledTimes(1)
    const [temporaryPath, serialized] = writeFileSync.mock.calls[0]
    expect(temporaryPath).not.toBe(statePath)
    expect(serialized).not.toContain('raw mailbox output')
    expect(renameSync).toHaveBeenCalledWith(temporaryPath, statePath)
  })

  it('keeps accepted state in memory when persistence fails', () => {
    const statePath = tempStatePath()
    const warn = vi.fn()
    const store = createPollerStateStore(statePath, {
      warn,
      fileSystem: {
        existsSync: vi.fn().mockReturnValue(false),
        statSync: vi.fn(),
        readFileSync: vi.fn(),
        mkdirSync: vi.fn(),
        writeFileSync: vi.fn(() => { throw new Error('disk full') }),
        renameSync: vi.fn(),
        unlinkSync: vi.fn(),
      },
    })

    store.accept('inbox', { sourceFingerprint: HASH_A, outputHash: HASH_B, observedAt: '2026-09-21T10:00:00.000Z' })

    expect(store.get('inbox')?.outputHash).toBe(HASH_B)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be persisted'))
  })

  it('immediately prunes removed and source-changed pollers', () => {
    const statePath = tempStatePath()
    const store = createPollerStateStore(statePath)
    store.accept('removed', { sourceFingerprint: HASH_A, outputHash: HASH_B, observedAt: '2026-09-21T10:00:00.000Z' })
    store.accept('changed', { sourceFingerprint: HASH_A, outputHash: HASH_B, observedAt: '2026-09-21T10:00:00.000Z' })
    store.accept('kept', { sourceFingerprint: HASH_A, outputHash: HASH_B, observedAt: '2026-09-21T10:00:00.000Z' })

    store.retain(new Map([['changed', HASH_B], ['kept', HASH_A]]))

    expect(store.get('removed')).toBeUndefined()
    expect(store.get('changed')).toBeUndefined()
    expect(store.get('kept')).toBeDefined()
  })
})

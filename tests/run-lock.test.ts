import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquireRunLock } from '../src/shared/run-lock.js'

const tempDirs: string[] = []

function makeTarget(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-lock-'))
  tempDirs.push(target)
  return target
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('acquireRunLock', () => {
  it('prevents a second run of the same spec until the first releases', () => {
    const target = makeTarget()
    const release = acquireRunLock(target, 'daily scan')

    expect(() => acquireRunLock(target, 'daily scan')).toThrow('already running')

    release()
    const releaseAgain = acquireRunLock(target, 'daily scan')
    releaseAgain()
  })

  it('allows different specifications to run concurrently', () => {
    const target = makeTarget()
    const releaseA = acquireRunLock(target, 'scan-a')
    const releaseB = acquireRunLock(target, 'scan-b')

    releaseA()
    releaseB()
  })

  it('replaces a lock older than the stale threshold', () => {
    const target = makeTarget()
    const lockDir = path.join(target, '.cestdone', 'locks')
    const lockPath = path.join(lockDir, 'daily-scan.lock')
    fs.mkdirSync(lockDir, { recursive: true })
    fs.writeFileSync(lockPath, JSON.stringify({ startedAt: '2026-07-09T00:00:00.000Z' }))

    const release = acquireRunLock(target, 'daily scan', {
      now: () => new Date('2026-07-10T00:00:01.000Z'),
      staleAfterMs: 6 * 60 * 60 * 1000,
    })

    release()
  })

  it('does not remove a fresh lock just because its owning wrapper may have exited', () => {
    const target = makeTarget()
    const lockDir = path.join(target, '.cestdone', 'locks')
    const lockPath = path.join(lockDir, 'daily-scan.lock')
    fs.mkdirSync(lockDir, { recursive: true })
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: '2026-07-10T00:00:00.000Z' }))

    expect(() => acquireRunLock(target, 'daily scan', {
      now: () => new Date('2026-07-10T00:01:00.000Z'),
      staleAfterMs: 6 * 60 * 60 * 1000,
    })).toThrow('already running')
  })
})

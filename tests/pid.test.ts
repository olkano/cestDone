// tests/pid.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { writePidFile, readPidFile, removePidFile, isDaemonRunning } from '../src/daemon/pid.js'

let tmpDir: string
let pidPath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-test-'))
  pidPath = path.join(tmpDir, 'daemon.pid')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('PID file management', () => {
  // PID-1
  it('writePidFile writes current process PID', () => {
    writePidFile(pidPath)
    const content = fs.readFileSync(pidPath, 'utf-8')
    expect(parseInt(content, 10)).toBe(process.pid)
  })

  // PID-2
  it('readPidFile reads PID from file', () => {
    fs.writeFileSync(pidPath, '12345', 'utf-8')
    expect(readPidFile(pidPath)).toBe(12345)
  })

  // PID-3
  it('readPidFile returns null when file does not exist', () => {
    expect(readPidFile(path.join(tmpDir, 'nonexistent.pid'))).toBeNull()
  })

  // PID-4
  it('removePidFile deletes the file', () => {
    writePidFile(pidPath)
    expect(fs.existsSync(pidPath)).toBe(true)
    removePidFile(pidPath)
    expect(fs.existsSync(pidPath)).toBe(false)
  })

  // PID-5
  it('isDaemonRunning returns true for current process', () => {
    writePidFile(pidPath)
    expect(isDaemonRunning(pidPath)).toBe(true)
  })

  // PID-6
  it('isDaemonRunning returns false when file does not exist', () => {
    expect(isDaemonRunning(path.join(tmpDir, 'nonexistent.pid'))).toBe(false)
  })
})

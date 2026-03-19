// src/daemon/pid.ts
import fs from 'node:fs'
import path from 'node:path'

export function writePidFile(pidPath: string): void {
  fs.mkdirSync(path.dirname(pidPath), { recursive: true })
  fs.writeFileSync(pidPath, String(process.pid), 'utf-8')
}

export function readPidFile(pidPath: string): number | null {
  try {
    const content = fs.readFileSync(pidPath, 'utf-8').trim()
    const pid = parseInt(content, 10)
    return Number.isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

export function removePidFile(pidPath: string): void {
  try {
    fs.unlinkSync(pidPath)
  } catch {
    // Ignore if file doesn't exist
  }
}

export function isDaemonRunning(pidPath: string): boolean {
  const pid = readPidFile(pidPath)
  if (pid === null) return false
  try {
    // Signal 0 tests if process exists without killing it
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

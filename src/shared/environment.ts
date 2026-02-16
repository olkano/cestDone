// src/shared/environment.ts
import fs from 'node:fs'
import path from 'node:path'

export interface EnvironmentInfo {
  os: string
  shell: string
  killCommand: string
  packageManager: string
  dependencies: string[]
  summary: string
}

function detectOS(): { os: string; killCommand: string } {
  switch (process.platform) {
    case 'win32':
      return { os: 'Windows', killCommand: 'taskkill /F /PID <pid>' }
    case 'darwin':
      return { os: 'macOS', killCommand: 'kill -9 <pid>' }
    default:
      return { os: 'Linux', killCommand: 'kill -9 <pid>' }
  }
}

function detectShell(): string {
  if (process.platform === 'win32') {
    return process.env.SHELL || process.env.ComSpec || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/sh'
}

function detectPackageManager(projectPath: string): string {
  const lockFiles: [string, string][] = [
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
  ]

  for (const [lockFile, manager] of lockFiles) {
    if (fs.existsSync(path.join(projectPath, lockFile))) {
      return manager
    }
  }

  return fs.existsSync(path.join(projectPath, 'package.json')) ? 'npm' : 'unknown'
}

function readDependencies(projectPath: string): string[] {
  const pkgPath = path.join(projectPath, 'package.json')
  if (!fs.existsSync(pkgPath)) return []

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    const deps = Object.keys(pkg.dependencies ?? {})
    const devDeps = Object.keys(pkg.devDependencies ?? {})
    return [...deps, ...devDeps]
  } catch {
    return []
  }
}

export function detectEnvironment(projectPath?: string): EnvironmentInfo {
  const resolvedPath = projectPath ?? process.cwd()
  const { os, killCommand } = detectOS()
  const shell = detectShell()
  const packageManager = detectPackageManager(resolvedPath)
  const dependencies = readDependencies(resolvedPath)

  const parts = [
    `OS: ${os}`,
    `Shell: ${shell}`,
    `Kill command: ${killCommand}`,
    `Package manager: ${packageManager}`,
  ]

  if (dependencies.length > 0) {
    parts.push(`Dependencies: ${dependencies.join(', ')}`)
  }

  return {
    os,
    shell,
    killCommand,
    packageManager,
    dependencies,
    summary: parts.join('\n'),
  }
}

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const SUPPORTED_CODEX_VERSION = '0.155.1'

export interface CodexRuntime {
  executablePath: string
  helperPaths: string[]
  expectedVersion: string
}

const TARGETS: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
}

export function resolveCodexRuntime(
  platform = process.platform,
  arch = process.arch,
  resolver?: NodeJS.Require,
): CodexRuntime {
  const target = TARGETS[`${platform}-${arch}`]
  if (!target) throw new Error(`Unsupported Codex runtime platform: ${platform}-${arch}`)
  let codexPackageJson: string | undefined
  const metaResolve = (import.meta as ImportMeta & { resolve?: (specifier: string) => string }).resolve
  if (typeof metaResolve === 'function') {
    try {
      const sdkEntry = fileURLToPath(metaResolve('@openai/codex-sdk'))
      codexPackageJson = createRequire(sdkEntry).resolve('@openai/codex/package.json')
    } catch { /* fall back to installation anchors */ }
  }
  const resolvers = [
    resolver,
    createRequire(import.meta.url),
    createRequire(path.join(process.cwd(), 'package.json')),
    process.argv[1] ? createRequire(path.resolve(process.argv[1])) : undefined,
  ].filter((item): item is NodeJS.Require => item !== undefined)
  for (const candidate of resolvers) {
    if (codexPackageJson) break
    try {
      codexPackageJson = candidate.resolve('@openai/codex/package.json')
      break
    } catch { /* try the next installation anchor */ }
  }
  if (!codexPackageJson) throw new Error('Unable to resolve the pinned @openai/codex runtime package')
  const codexRoot = path.dirname(codexPackageJson)
  const platformPackage = `@openai/codex-${platform}-${arch}`
  const platformPackageJson = createRequire(codexPackageJson).resolve(`${platformPackage}/package.json`)
  const vendorRoot = path.join(path.dirname(platformPackageJson), 'vendor', target)
  const manifestPath = path.join(vendorRoot, 'codex-package.json')
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version?: string; entrypoint?: string; pathDir?: string }
    const executablePath = path.join(vendorRoot, manifest.entrypoint ?? path.join('bin', platform === 'win32' ? 'codex.exe' : 'codex'))
    const helperPath = manifest.pathDir ? path.join(vendorRoot, manifest.pathDir) : undefined
    assertRuntimeFiles(executablePath, helperPath)
    return { executablePath, helperPaths: helperPath ? [helperPath] : [], expectedVersion: manifest.version ?? SUPPORTED_CODEX_VERSION }
  }
  const executablePath = path.join(vendorRoot, 'codex', platform === 'win32' ? 'codex.exe' : 'codex')
  const helperPath = path.join(vendorRoot, 'path')
  assertRuntimeFiles(executablePath, fs.existsSync(helperPath) ? helperPath : undefined)
  return { executablePath, helperPaths: fs.existsSync(helperPath) ? [helperPath] : [], expectedVersion: SUPPORTED_CODEX_VERSION }
}

function assertRuntimeFiles(executablePath: string, helperPath?: string): void {
  if (!fs.existsSync(executablePath)) throw new Error(`Bundled Codex runtime is missing: ${executablePath}`)
  if (helperPath && !fs.existsSync(helperPath)) throw new Error(`Bundled Codex helper path is missing: ${helperPath}`)
}

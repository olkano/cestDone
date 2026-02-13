#!/usr/bin/env node
// src/cli/index.ts
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { loadConfig, resolveConfig } from '../shared/config.js'
import { parseSpec } from '../shared/spec-parser.js'
import { updatePhaseStatus, writePhaseCompletion } from '../shared/spec-writer.js'
import { runPhase, type DirectorDeps } from '../director/director.js'
import { askApproval, askInput, ensureTTY } from './prompt.js'
import { executeCoder } from '../coder/coder.js'
import { ensureGitRepo } from '../shared/git.js'

export async function handleRun(
  specPath: string,
  options?: { target?: string }
): Promise<void> {
  ensureTTY()

  const config = loadConfig()
  const resolved = resolveConfig(config)
  const targetDir = path.resolve(options?.target ?? resolved.targetRepoPath)
  resolved.targetRepoPath = targetDir
  ensureGitRepo(targetDir)
  const resolvedSpecPath = path.resolve(specPath)
  const content = fs.readFileSync(resolvedSpecPath, 'utf-8')
  const spec = parseSpec(content, targetDir)

  const inProgress = spec.phases.find(p => p.status === 'in-progress')
  if (inProgress) {
    const answer = await askInput(
      `Phase ${inProgress.number} (${inProgress.name}) is in-progress. ` +
      'Reset to pending or continue? (reset/continue): '
    )
    if (answer.trim().toLowerCase() === 'reset') {
      updatePhaseStatus(resolvedSpecPath, inProgress.number, 'pending')
      const updated = fs.readFileSync(resolvedSpecPath, 'utf-8')
      const updatedSpec = parseSpec(updated, targetDir)
      const pending = updatedSpec.phases.find(p => p.status === 'pending')
      if (!pending) {
        console.log('No pending phases found.')
        return
      }
      const deps = buildDeps()
      await runPhase(updatedSpec, pending, resolved, resolvedSpecPath, deps)
      return
    }
    const deps = buildDeps()
    await runPhase(spec, inProgress, resolved, resolvedSpecPath, deps)
    return
  }

  const pending = spec.phases.find(p => p.status === 'pending')
  if (!pending) {
    console.log('No pending phases found.')
    return
  }

  const deps = buildDeps()
  await runPhase(spec, pending, resolved, resolvedSpecPath, deps)
}

export async function handleResume(
  specPath: string,
  options?: { target?: string }
): Promise<void> {
  ensureTTY()

  const config = loadConfig()
  const resolved = resolveConfig(config)
  const targetDir = path.resolve(options?.target ?? resolved.targetRepoPath)
  resolved.targetRepoPath = targetDir
  ensureGitRepo(targetDir)
  const resolvedSpecPath = path.resolve(specPath)
  const content = fs.readFileSync(resolvedSpecPath, 'utf-8')
  const spec = parseSpec(content, targetDir)

  const target = spec.phases.find(p => p.status !== 'done')
  if (!target) {
    console.log('All phases are done.')
    return
  }

  const deps = buildDeps()
  await runPhase(spec, target, resolved, resolvedSpecPath, deps)
}

function buildDeps(): DirectorDeps {
  return {
    askApproval,
    askInput,
    updatePhaseStatus: (fp, pn, st) => updatePhaseStatus(fp, pn, st),
    writePhaseCompletion: (fp, pn, ds) => writePhaseCompletion(fp, pn, ds),
    coderExecute: executeCoder,
    display: (text: string) => console.log(text),
  }
}

// Commander setup — only when executed as CLI entry point
const __filename = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const program = new Command()
  program.name('cestdone').description('AI-orchestrated development CLI')

  program.command('run')
    .requiredOption('--spec <path>', 'Path to spec file')
    .option('--target <path>', 'Target repository path')
    .action(async (opts: { spec: string; target?: string }) => {
      await handleRun(opts.spec, { target: opts.target })
    })

  program.command('resume')
    .requiredOption('--spec <path>', 'Path to spec file')
    .option('--target <path>', 'Target repository path')
    .action(async (opts: { spec: string; target?: string }) => {
      await handleResume(opts.spec, { target: opts.target })
    })

  program.parseAsync().catch((err: Error) => {
    console.error(err.message)
    process.exit(1)
  })
}

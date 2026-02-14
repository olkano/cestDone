#!/usr/bin/env node
// src/cli/index.ts
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { loadConfig, resolveConfig } from '../shared/config.js'
import { parsePlan, getPlanPath } from '../shared/plan-parser.js'
import { createPlanFile, updatePhaseStatus, writePhaseCompletion } from '../shared/spec-writer.js'
import { runPlanningFlow, runPhase, type DirectorDeps } from '../director/director.js'
import { askApproval, askInput, ensureTTY } from './prompt.js'
import { executeCoder } from '../coder/coder.js'
import { ensureGitRepo } from '../shared/git.js'
import { createSessionLogger, type SessionLogger } from '../shared/logger.js'
import { CostTracker } from '../shared/cost-tracker.js'
import type { FreeFormSpec, ResolvedConfig } from '../shared/types.js'

export async function handleRun(
  specPath: string,
  options?: { target?: string; houseRules?: string }
): Promise<void> {
  ensureTTY()
  const logger = createSessionLogger()

  const config = loadConfig()
  const resolved = resolveConfig(config)
  const targetDir = path.resolve(options?.target ?? resolved.targetRepoPath)
  resolved.targetRepoPath = targetDir
  ensureGitRepo(targetDir)

  const resolvedSpecPath = path.resolve(specPath)
  const specText = fs.readFileSync(resolvedSpecPath, 'utf-8')

  // Load house rules if provided
  let houseRulesContent = ''
  if (options?.houseRules) {
    const houseRulesPath = path.resolve(options.houseRules)
    houseRulesContent = fs.readFileSync(houseRulesPath, 'utf-8')
  }

  const planPath = getPlanPath(resolvedSpecPath)
  const deps = buildDeps(logger)

  // Check if plan already exists
  if (fs.existsSync(planPath)) {
    const planContent = fs.readFileSync(planPath, 'utf-8')
    const plan = parsePlan(planContent)

    const inProgress = plan.phases.find(p => p.status === 'in-progress')
    if (inProgress) {
      const answer = await askInput(
        `Phase ${inProgress.number} (${inProgress.name}) is in-progress. ` +
        'Reset to pending or continue? (reset/continue): '
      )
      if (answer.trim().toLowerCase() === 'reset') {
        updatePhaseStatus(planPath, inProgress.number, 'pending')
      }
    }

    await executeAllPhases(planPath, resolved, deps)
    return
  }

  // No plan exists — run planning flow
  const freeFormSpec: FreeFormSpec = {
    text: specText,
    houseRulesContent,
    specFilePath: resolvedSpecPath,
  }

  const { planPath: createdPlanPath } = await runPlanningFlow(freeFormSpec, resolved, deps)
  await executeAllPhases(createdPlanPath, resolved, deps)
}

export async function handleResume(
  specPath: string,
  options?: { target?: string }
): Promise<void> {
  ensureTTY()
  const logger = createSessionLogger()

  const config = loadConfig()
  const resolved = resolveConfig(config)
  const targetDir = path.resolve(options?.target ?? resolved.targetRepoPath)
  resolved.targetRepoPath = targetDir
  ensureGitRepo(targetDir)

  const resolvedSpecPath = path.resolve(specPath)
  const planPath = getPlanPath(resolvedSpecPath)

  if (!fs.existsSync(planPath)) {
    throw new Error(`No plan file found at ${planPath}. Run 'cestdone run' first to create a plan.`)
  }

  const deps = buildDeps(logger)
  await executeAllPhases(planPath, resolved, deps)
}

async function executeAllPhases(
  planPath: string,
  config: ResolvedConfig,
  deps: DirectorDeps,
): Promise<void> {
  while (true) {
    const planContent = fs.readFileSync(planPath, 'utf-8')
    const plan = parsePlan(planContent)
    const next = plan.phases.find(p => p.status === 'pending' || p.status === 'in-progress')
    if (!next) break
    deps.display(`\n=== Phase ${next.number}: ${next.name} ===`)
    await runPhase(plan, next, config, planPath, deps)
  }
  deps.display('\nAll phases complete.')
}

function buildDeps(logger: SessionLogger, costTracker?: CostTracker): DirectorDeps {
  return {
    askApproval,
    askInput,
    createPlanFile: (p, c) => createPlanFile(p, c),
    updatePhaseStatus: (fp, pn, st) => updatePhaseStatus(fp, pn, st),
    writePhaseCompletion: (fp, pn, ds) => writePhaseCompletion(fp, pn, ds),
    coderExecute: executeCoder,
    display: (text: string) => console.log(text),
    logger,
    costTracker: costTracker ?? new CostTracker(),
  }
}

// Commander setup — only when executed as CLI entry point
const __filename = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const program = new Command()
  program.name('cestdone').description('AI-orchestrated development CLI')

  program.command('run')
    .requiredOption('--spec <path>', 'Path to spec file (free-form text)')
    .option('--target <path>', 'Target repository path')
    .option('--house-rules <path>', 'Path to house rules file')
    .action(async (opts: { spec: string; target?: string; houseRules?: string }) => {
      await handleRun(opts.spec, { target: opts.target, houseRules: opts.houseRules })
    })

  program.command('resume')
    .requiredOption('--spec <path>', 'Path to spec file')
    .option('--target <path>', 'Target repository path')
    .action(async (opts: { spec: string; target?: string }) => {
      await handleResume(opts.spec, { target: opts.target })
    })

  program.parseAsync().catch((err: Error) => {
    const errorLogger = createSessionLogger()
    errorLogger.log('FATAL', `Unhandled error: ${err.message}`)
    errorLogger.log('FATAL', `Stack: ${err.stack ?? 'N/A'}`)
    console.error(err.message)
    process.exit(1)
  })
}

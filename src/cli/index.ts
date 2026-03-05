#!/usr/bin/env node
// src/cli/index.ts
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { loadConfig, DEFAULTS } from '../shared/config.js'
import { parsePlan, getPlanPath } from '../shared/plan-parser.js'
import { createPlanFile, updatePhaseStatus, writePhaseCompletion } from '../shared/spec-writer.js'
import { runPlanningFlow, runPhase, type DirectorDeps } from '../director/director.js'
import { askApproval, askInput, ensureTTY } from './prompt.js'
import { executeCoder } from '../coder/coder.js'
import { ensureGitRepo } from '../shared/git.js'
import { createSessionLogger, type SessionLogger } from '../shared/logger.js'
import { CostTracker, formatFinalSummary } from '../shared/cost-tracker.js'
import type { FreeFormSpec, Config, BackendType } from '../shared/types.js'
import { createBackend } from '../backends/index.js'

export interface RunOptions {
  target?: string
  houseRules?: string
  directorModel?: string
  coderModel?: string
  withCoder?: boolean
  withReviews?: boolean
  withBashReviews?: boolean
  withHumanValidation?: boolean
  backend?: string
  directorBackend?: string
  coderBackend?: string
  claudeCliPath?: string
}

export interface ResumeOptions {
  target?: string
  directorModel?: string
  coderModel?: string
  withCoder?: boolean
  withReviews?: boolean
  withBashReviews?: boolean
  withHumanValidation?: boolean
  backend?: string
  directorBackend?: string
  coderBackend?: string
  claudeCliPath?: string
}

function applyFlags(config: Config, options?: RunOptions | ResumeOptions): void {
  if (options?.directorModel) config.directorModel = options.directorModel
  if (options?.coderModel) config.coderModel = options.coderModel

  // Only override booleans when CLI flag was explicitly passed
  if (options?.withCoder !== undefined) config.withCoder = options.withCoder
  else config.withCoder = config.withCoder ?? DEFAULTS.withCoder

  if (options?.withReviews !== undefined) config.withReviews = options.withReviews
  else config.withReviews = config.withReviews ?? DEFAULTS.withReviews

  if (options?.withBashReviews !== undefined) config.withBashReviews = options.withBashReviews
  else config.withBashReviews = config.withBashReviews ?? DEFAULTS.withBashReviews

  if (options?.withHumanValidation !== undefined) config.withHumanValidation = options.withHumanValidation
  else config.withHumanValidation = config.withHumanValidation ?? DEFAULTS.withHumanValidation

  // --with-bash-reviews implies --with-reviews
  if (config.withBashReviews) config.withReviews = true

  // --with-reviews without --with-coder is invalid
  if (config.withReviews && !config.withCoder) {
    console.warn('Warning: --with-reviews requires --with-coder. Reviews will be ignored.')
    config.withReviews = false
    config.withBashReviews = false
  }

  // Backend flags
  if (options && 'backend' in options && options.backend) {
    config.directorBackend = options.backend as BackendType
    config.coderBackend = options.backend as BackendType
  }
  if (options?.directorBackend) config.directorBackend = options.directorBackend as BackendType
  if (options?.coderBackend) config.coderBackend = options.coderBackend as BackendType
  if (options && 'claudeCliPath' in options && options.claudeCliPath) {
    config.claudeCliPath = options.claudeCliPath
  }
}

export async function handleRun(
  specPath: string,
  options?: RunOptions
): Promise<void> {
  ensureTTY()
  const startTime = Date.now()
  const specName = path.basename(specPath, path.extname(specPath))
  const logger = createSessionLogger({ specName })

  const config = loadConfig()
  const targetDir = path.resolve(options?.target ?? config.targetRepoPath)
  config.targetRepoPath = targetDir
  applyFlags(config, options)
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
  const costTracker = new CostTracker()
  const deps = buildDeps(logger, costTracker, config)

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

    await executeAllPhases(planPath, config, deps)
  } else {
    // No plan exists — run planning flow
    const freeFormSpec: FreeFormSpec = {
      text: specText,
      houseRulesContent,
      specFilePath: resolvedSpecPath,
    }

    const { planPath: createdPlanPath, sessionId } = await runPlanningFlow(freeFormSpec, config, deps)
    await executeAllPhases(createdPlanPath, config, deps, sessionId)
  }

  logFinalSummary(logger, costTracker, startTime, targetDir)
}

export async function handleResume(
  specPath: string,
  options?: ResumeOptions
): Promise<void> {
  ensureTTY()
  const startTime = Date.now()
  const specName = path.basename(specPath, path.extname(specPath))
  const logger = createSessionLogger({ specName })

  const config = loadConfig()
  const targetDir = path.resolve(options?.target ?? config.targetRepoPath)
  config.targetRepoPath = targetDir
  applyFlags(config, options)
  ensureGitRepo(targetDir)

  const resolvedSpecPath = path.resolve(specPath)
  const planPath = getPlanPath(resolvedSpecPath)

  if (!fs.existsSync(planPath)) {
    throw new Error(`No plan file found at ${planPath}. Run 'cestdone run' first to create a plan.`)
  }

  const costTracker = new CostTracker()
  const deps = buildDeps(logger, costTracker, config)
  await executeAllPhases(planPath, config, deps)
  logFinalSummary(logger, costTracker, startTime, targetDir)
}

async function executeAllPhases(
  planPath: string,
  config: Config,
  deps: DirectorDeps,
  sessionId?: string,
): Promise<void> {
  let currentSessionId = sessionId
  while (true) {
    const planContent = fs.readFileSync(planPath, 'utf-8')
    const plan = parsePlan(planContent)
    const next = plan.phases.find(p => p.status === 'pending' || p.status === 'in-progress')
    if (!next) break
    deps.display(`\n=== Phase ${next.number}: ${next.name} ===`)
    currentSessionId = await runPhase(plan, next, config, planPath, deps, currentSessionId)
  }
  deps.display('\nAll phases complete.')
}

function buildDeps(logger: SessionLogger, costTracker?: CostTracker, config?: Config): DirectorDeps {
  const effectiveConfig = config ?? { targetRepoPath: DEFAULTS.targetRepoPath, maxTurns: DEFAULTS.maxTurns }
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
    backend: createBackend(
      config?.directorBackend ?? DEFAULTS.backend,
      effectiveConfig
    ),
    coderBackend: createBackend(
      config?.coderBackend ?? DEFAULTS.backend,
      effectiveConfig
    ),
  }
}

function logFinalSummary(
  logger: SessionLogger,
  costTracker: CostTracker,
  startTime: number,
  targetDir: string,
): void {
  const elapsed = Date.now() - startTime
  const summary = formatFinalSummary(costTracker, elapsed)
  logger.log('Session', summary)

  // Copy log to destination project
  if (logger.logFilePath) {
    const destDir = path.join(targetDir, '.cestdone')
    fs.mkdirSync(destDir, { recursive: true })
    const destPath = path.join(destDir, path.basename(logger.logFilePath))
    fs.copyFileSync(logger.logFilePath, destPath)
    logger.log('Session', `Log copied to ${destPath}`)
  }
}

// Helper to add common options to both run and resume commands
function addCommonOptions(cmd: Command): Command {
  return cmd
    .option('--target <path>', `Target repository path (default: "${DEFAULTS.targetRepoPath}")`)
    .option('--director-model <model>', `Director model: haiku | sonnet | opus (default: "${DEFAULTS.directorModel}")`)
    .option('--coder-model <model>', `Coder model: haiku | sonnet | opus (default: "${DEFAULTS.coderModel}")`)
    .option('--with-coder', `Two-agent mode: Director plans, Coder implements (default: ${DEFAULTS.withCoder})`)
    .option('--no-with-coder', 'Disable two-agent mode (director-only)')
    .option('--with-reviews', `Director reviews after Coder execution (default: ${DEFAULTS.withReviews})`)
    .option('--no-with-reviews', 'Disable Director reviews')
    .option('--with-bash-reviews', `Allow Bash in reviews, implies --with-reviews (default: ${DEFAULTS.withBashReviews})`)
    .option('--no-with-bash-reviews', 'Disable Bash in reviews')
    .option('--with-human-validation', `Require human approval of plan (default: ${DEFAULTS.withHumanValidation})`)
    .option('--backend <type>', `Backend for both agents: agent-sdk (API billing) | claude-cli (subscription) (default: "${DEFAULTS.backend}")`)
    .option('--director-backend <type>', 'Override Director backend: agent-sdk | claude-cli')
    .option('--coder-backend <type>', 'Override Coder backend: agent-sdk | claude-cli')
    .option('--claude-cli-path <path>', `Path to claude binary (default: "${DEFAULTS.claudeCliPath}")`)
}

// Commander setup — only when executed as CLI entry point
const __filename = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const program = new Command()
  program
    .name('cestdone')
    .description('AI-orchestrated development CLI')
    .showHelpAfterError(true)

  const runCmd = program.command('run')
    .description('Create a plan from a spec and execute all phases')
    .requiredOption('--spec <path>', 'Path to spec file (required)')
    .option('--house-rules <path>', 'Path to house rules file')
  addCommonOptions(runCmd)
    .action(async (opts: { spec: string; target?: string; houseRules?: string; directorModel?: string; coderModel?: string; withCoder?: boolean; withReviews?: boolean; withBashReviews?: boolean; withHumanValidation?: boolean; backend?: string; directorBackend?: string; coderBackend?: string; claudeCliPath?: string }) => {
      await handleRun(opts.spec, {
        target: opts.target,
        houseRules: opts.houseRules,
        directorModel: opts.directorModel,
        coderModel: opts.coderModel,
        withCoder: opts.withCoder,
        withReviews: opts.withReviews,
        withBashReviews: opts.withBashReviews,
        withHumanValidation: opts.withHumanValidation,
        backend: opts.backend,
        directorBackend: opts.directorBackend,
        coderBackend: opts.coderBackend,
        claudeCliPath: opts.claudeCliPath,
      })
    })

  const resumeCmd = program.command('resume')
    .description('Resume execution from an existing .plan.md file')
    .requiredOption('--spec <path>', 'Path to spec file (required)')
  addCommonOptions(resumeCmd)
    .action(async (opts: { spec: string; target?: string; directorModel?: string; coderModel?: string; withCoder?: boolean; withReviews?: boolean; withBashReviews?: boolean; withHumanValidation?: boolean; backend?: string; directorBackend?: string; coderBackend?: string; claudeCliPath?: string }) => {
      await handleResume(opts.spec, {
        target: opts.target,
        directorModel: opts.directorModel,
        coderModel: opts.coderModel,
        withCoder: opts.withCoder,
        withReviews: opts.withReviews,
        withBashReviews: opts.withBashReviews,
        withHumanValidation: opts.withHumanValidation,
        backend: opts.backend,
        directorBackend: opts.directorBackend,
        coderBackend: opts.coderBackend,
        claudeCliPath: opts.claudeCliPath,
      })
    })

  program.parseAsync().catch((err: Error) => {
    const errorLogger = createSessionLogger()
    errorLogger.log('FATAL', `Unhandled error: ${err.message}`)
    errorLogger.log('FATAL', `Stack: ${err.stack ?? 'N/A'}`)
    console.error(err.message)
    process.exit(1)
  })
}

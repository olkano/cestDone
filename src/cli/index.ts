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
import { executeWorker } from '../worker/worker.js'
import { ensureGitRepo } from '../shared/git.js'
import { createSessionLogger, type SessionLogger } from '../shared/logger.js'
import { CostTracker, formatFinalSummary } from '../shared/cost-tracker.js'
import type { FreeFormSpec, Config, BackendType } from '../shared/types.js'
import { createBackend } from '../backends/index.js'
import { NonInteractiveEscalationError } from '../daemon/errors.js'

export interface RunOptions {
  target?: string
  houseRules?: string
  directorModel?: string
  workerModel?: string
  directorMaxTurns?: string
  maxTurns?: string
  withWorker?: boolean
  withReviews?: boolean
  withBashReviews?: boolean
  withHumanValidation?: boolean
  backend?: string
  directorBackend?: string
  workerBackend?: string
  claudeCliPath?: string
  nonInteractive?: boolean
}

export interface ResumeOptions {
  target?: string
  directorModel?: string
  workerModel?: string
  directorMaxTurns?: string
  maxTurns?: string
  withWorker?: boolean
  withReviews?: boolean
  withBashReviews?: boolean
  withHumanValidation?: boolean
  backend?: string
  directorBackend?: string
  workerBackend?: string
  claudeCliPath?: string
  nonInteractive?: boolean
}

function applyFlags(config: Config, options?: RunOptions | ResumeOptions): void {
  if (options?.directorModel) config.directorModel = options.directorModel
  if (options?.workerModel) config.workerModel = options.workerModel
  if (options?.directorMaxTurns) config.directorMaxTurns = parseInt(options.directorMaxTurns, 10)
  if (options?.maxTurns) config.maxTurns = parseInt(options.maxTurns, 10)

  // Only override booleans when CLI flag was explicitly passed
  if (options?.withWorker !== undefined) config.withWorker = options.withWorker
  else config.withWorker = config.withWorker ?? DEFAULTS.withWorker

  if (options?.withReviews !== undefined) config.withReviews = options.withReviews
  else config.withReviews = config.withReviews ?? DEFAULTS.withReviews

  if (options?.withBashReviews !== undefined) config.withBashReviews = options.withBashReviews
  else config.withBashReviews = config.withBashReviews ?? DEFAULTS.withBashReviews

  if (options?.withHumanValidation !== undefined) config.withHumanValidation = options.withHumanValidation
  else config.withHumanValidation = config.withHumanValidation ?? DEFAULTS.withHumanValidation

  // --with-bash-reviews implies --with-reviews
  if (config.withBashReviews) config.withReviews = true

  // --with-reviews without --with-worker is invalid
  if (config.withReviews && !config.withWorker) {
    console.warn('Warning: --with-reviews requires --with-worker. Reviews will be ignored.')
    config.withReviews = false
    config.withBashReviews = false
  }

  // Backend flags
  if (options && 'backend' in options && options.backend) {
    config.directorBackend = options.backend as BackendType
    config.workerBackend = options.backend as BackendType
  }
  if (options?.directorBackend) config.directorBackend = options.directorBackend as BackendType
  if (options?.workerBackend) config.workerBackend = options.workerBackend as BackendType
  if (options && 'claudeCliPath' in options && options.claudeCliPath) {
    config.claudeCliPath = options.claudeCliPath
  }

  if (options?.nonInteractive !== undefined) config.nonInteractive = options.nonInteractive
  else config.nonInteractive = config.nonInteractive ?? DEFAULTS.nonInteractive
}

export async function handleRun(
  specPath: string,
  options?: RunOptions
): Promise<void> {
  const startTime = Date.now()
  const specName = path.basename(specPath, path.extname(specPath))
  const logger = createSessionLogger({ specName })

  const config = loadConfig()
  const targetDir = path.resolve(options?.target ?? config.targetRepoPath)
  config.targetRepoPath = targetDir
  applyFlags(config, options)

  if (!config.nonInteractive) ensureTTY()
  ensureGitRepo(targetDir)

  const resolvedSpecPath = path.resolve(specPath)
  const specText = fs.readFileSync(resolvedSpecPath, 'utf-8')

  // Load house rules if provided
  let houseRulesContent = ''
  if (options?.houseRules) {
    const houseRulesPath = path.resolve(options.houseRules)
    houseRulesContent = fs.readFileSync(houseRulesPath, 'utf-8')
  }

  const planPath = getPlanPath(resolvedSpecPath, targetDir)
  const costTracker = new CostTracker()
  const deps = buildDeps(logger, costTracker, config)

  // Check if plan already exists
  if (fs.existsSync(planPath)) {
    const planContent = fs.readFileSync(planPath, 'utf-8')
    const plan = parsePlan(planContent)

    const inProgress = plan.phases.find(p => p.status === 'in-progress')
    if (inProgress) {
      if (config.nonInteractive) {
        // Auto-continue in non-interactive mode
        deps.display(`Non-interactive: auto-continuing phase ${inProgress.number} (${inProgress.name})`)
      } else {
        const answer = await askInput(
          `Phase ${inProgress.number} (${inProgress.name}) is in-progress. ` +
          'Reset to pending or continue? (reset/continue): '
        )
        if (answer.trim().toLowerCase() === 'reset') {
          updatePhaseStatus(planPath, inProgress.number, 'pending')
        }
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

    const { planPath: createdPlanPath } = await runPlanningFlow(freeFormSpec, config, deps)
    await executeAllPhases(createdPlanPath, config, deps)
  }

  logFinalSummary(logger, costTracker, startTime, targetDir)
}

export async function handleResume(
  specPath: string,
  options?: ResumeOptions
): Promise<void> {
  const startTime = Date.now()
  const specName = path.basename(specPath, path.extname(specPath))
  const logger = createSessionLogger({ specName })

  const config = loadConfig()
  const targetDir = path.resolve(options?.target ?? config.targetRepoPath)
  config.targetRepoPath = targetDir
  applyFlags(config, options)

  if (!config.nonInteractive) ensureTTY()
  ensureGitRepo(targetDir)

  const resolvedSpecPath = path.resolve(specPath)
  const planPath = getPlanPath(resolvedSpecPath, targetDir)

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
): Promise<void> {
  let currentSessionId: string | undefined
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
  const ni = effectiveConfig.nonInteractive ?? false

  return {
    askApproval: ni
      ? async () => ({ approved: true })
      : askApproval,
    askInput: ni
      ? async (prompt: string) => {
          // Clarification questions get empty answer (skip); escalations throw
          if (prompt.includes('guidance') || prompt.includes('stuck')) {
            throw new NonInteractiveEscalationError(prompt)
          }
          return ''
        }
      : askInput,
    createPlanFile: (p, c) => createPlanFile(p, c),
    readFile: (p) => fs.readFileSync(p, 'utf-8'),
    writeFile: (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c, 'utf-8') },
    updatePhaseStatus: (fp, pn, st) => updatePhaseStatus(fp, pn, st),
    writePhaseCompletion: (fp, pn, ds) => writePhaseCompletion(fp, pn, ds),
    workerExecute: executeWorker,
    display: (text: string) => console.log(text),
    logger,
    costTracker: costTracker ?? new CostTracker(),
    backend: createBackend(
      config?.directorBackend ?? DEFAULTS.backend,
      effectiveConfig
    ),
    workerBackend: createBackend(
      config?.workerBackend ?? DEFAULTS.backend,
      effectiveConfig
    ),
  }
}

export interface SendEmailOptions {
  to: string
  subject: string
  body: string
  html?: string
}

export async function handleSendEmail(opts: SendEmailOptions): Promise<void> {
  const { sendEmail } = await import('../email/index.js')
  const result = await sendEmail({
    to: opts.to,
    subject: opts.subject,
    body: opts.body,
    html: opts.html,
  })
  if (!result.success) {
    throw new Error(result.error ?? 'Failed to send email')
  }
  console.log(`Email sent successfully (messageId: ${result.messageId ?? 'N/A'})`)
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
    .option('--worker-model <model>', `Worker model: haiku | sonnet | opus (default: "${DEFAULTS.workerModel}")`)
    .option('--director-max-turns <n>', `Max turns for Director steps (default: ${DEFAULTS.directorMaxTurnsDefault})`)
    .option('--max-turns <n>', `Max turns for Worker (default: ${DEFAULTS.maxTurns})`)
    .option('--with-worker', `Two-agent mode: Director plans, Worker implements (default: ${DEFAULTS.withWorker})`)
    .option('--no-with-worker', 'Disable two-agent mode (director-only)')
    .option('--with-reviews', `Director reviews after Worker execution (default: ${DEFAULTS.withReviews})`)
    .option('--no-with-reviews', 'Disable Director reviews')
    .option('--with-bash-reviews', `Allow Bash in reviews, implies --with-reviews (default: ${DEFAULTS.withBashReviews})`)
    .option('--no-with-bash-reviews', 'Disable Bash in reviews')
    .option('--with-human-validation', `Require human approval of plan (default: ${DEFAULTS.withHumanValidation})`)
    .option('--backend <type>', `Backend for both agents: agent-sdk (API billing) | claude-cli (subscription) (default: "${DEFAULTS.backend}")`)
    .option('--director-backend <type>', 'Override Director backend: agent-sdk | claude-cli')
    .option('--worker-backend <type>', 'Override Worker backend: agent-sdk | claude-cli')
    .option('--claude-cli-path <path>', `Path to claude binary (default: "${DEFAULTS.claudeCliPath}")`)
    .option('--non-interactive', `Run without TTY, auto-approve plans (default: ${DEFAULTS.nonInteractive})`)
}

// Commander setup — only when executed as CLI entry point
// realpathSync resolves symlinks (e.g. npm link) so the guard works globally
const __filename = fileURLToPath(import.meta.url)
function isCliEntryPoint(): boolean {
  if (!process.argv[1] || process.env.VITEST) return false
  const argv1 = path.resolve(process.argv[1])
  if (argv1 === __filename) return true
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(__filename)
  } catch {
    return false
  }
}
if (isCliEntryPoint()) {
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
    .action(async (opts: { spec: string; target?: string; houseRules?: string; directorModel?: string; workerModel?: string; directorMaxTurns?: string; maxTurns?: string; withWorker?: boolean; withReviews?: boolean; withBashReviews?: boolean; withHumanValidation?: boolean; backend?: string; directorBackend?: string; workerBackend?: string; claudeCliPath?: string; nonInteractive?: boolean }) => {
      await handleRun(opts.spec, {
        target: opts.target,
        houseRules: opts.houseRules,
        directorModel: opts.directorModel,
        workerModel: opts.workerModel,
        directorMaxTurns: opts.directorMaxTurns,
        maxTurns: opts.maxTurns,
        withWorker: opts.withWorker,
        withReviews: opts.withReviews,
        withBashReviews: opts.withBashReviews,
        withHumanValidation: opts.withHumanValidation,
        backend: opts.backend,
        directorBackend: opts.directorBackend,
        workerBackend: opts.workerBackend,
        claudeCliPath: opts.claudeCliPath,
        nonInteractive: opts.nonInteractive,
      })
    })

  const resumeCmd = program.command('resume')
    .description('Resume execution from an existing .plan.md file')
    .requiredOption('--spec <path>', 'Path to spec file (required)')
  addCommonOptions(resumeCmd)
    .action(async (opts: { spec: string; target?: string; directorModel?: string; workerModel?: string; directorMaxTurns?: string; maxTurns?: string; withWorker?: boolean; withReviews?: boolean; withBashReviews?: boolean; withHumanValidation?: boolean; backend?: string; directorBackend?: string; workerBackend?: string; claudeCliPath?: string; nonInteractive?: boolean }) => {
      await handleResume(opts.spec, {
        target: opts.target,
        directorModel: opts.directorModel,
        workerModel: opts.workerModel,
        directorMaxTurns: opts.directorMaxTurns,
        maxTurns: opts.maxTurns,
        withWorker: opts.withWorker,
        withReviews: opts.withReviews,
        withBashReviews: opts.withBashReviews,
        withHumanValidation: opts.withHumanValidation,
        backend: opts.backend,
        directorBackend: opts.directorBackend,
        workerBackend: opts.workerBackend,
        claudeCliPath: opts.claudeCliPath,
        nonInteractive: opts.nonInteractive,
      })
    })

  const daemonCmd = program.command('daemon')
    .description('Start daemon with schedules and triggers from .cestdonerc.json')
    .option('--log-dir <path>', 'Log directory (default: .cestdone/daemon)')
    .action(async (opts: { logDir?: string }) => {
      const { createDaemon } = await import('../daemon/daemon.js')
      const { createDaemonLogger } = await import('../daemon/daemon-logger.js')

      const config = loadConfig()
      if (!config.daemon) {
        console.error('No "daemon" section found in .cestdonerc.json')
        process.exit(1)
      }

      if (opts.logDir) config.daemon.logDir = opts.logDir
      const logDir = config.daemon.logDir ?? '.cestdone/daemon'
      const logger = createDaemonLogger(logDir)

      const daemon = createDaemon({
        executeRun: handleRun,
        logger,
        config,
      })

      // Graceful shutdown
      const shutdown = async () => {
        await daemon.stop()
        process.exit(0)
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)

      await daemon.start()
    })

  daemonCmd.command('status')
    .description('Show daemon status')
    .action(async () => {
      const { readPidFile, isDaemonRunning } = await import('../daemon/pid.js')
      const config = loadConfig()
      const pidFile = config.daemon?.pidFile ?? '.cestdone/daemon.pid'
      const pid = readPidFile(pidFile)

      if (pid !== null && isDaemonRunning(pidFile)) {
        console.log(`Daemon is running (PID: ${pid})`)
      } else {
        console.log('Daemon is not running')
      }
    })

  daemonCmd.command('stop')
    .description('Stop running daemon')
    .action(async () => {
      const { readPidFile, isDaemonRunning } = await import('../daemon/pid.js')
      const config = loadConfig()
      const pidFile = config.daemon?.pidFile ?? '.cestdone/daemon.pid'
      const pid = readPidFile(pidFile)

      if (pid === null || !isDaemonRunning(pidFile)) {
        console.log('Daemon is not running')
        process.exit(1)
      }

      try {
        process.kill(pid, 'SIGTERM')
        console.log(`Sent SIGTERM to daemon (PID: ${pid})`)
      } catch (err) {
        console.error(`Failed to stop daemon: ${(err as Error).message}`)
        process.exit(1)
      }
    })

  program.command('send-email')
    .description('Send an email (used by Worker agent via Bash)')
    .requiredOption('--to <address>', 'Recipient email address')
    .requiredOption('--subject <subject>', 'Email subject line')
    .requiredOption('--body <body>', 'Email body (plain text)')
    .option('--html <html>', 'Optional HTML body')
    .action(async (opts: { to: string; subject: string; body: string; html?: string }) => {
      await handleSendEmail(opts)
    })

  program.parseAsync().catch((err: Error) => {
    const errorLogger = createSessionLogger()
    errorLogger.log('FATAL', `Unhandled error: ${err.message}`)
    errorLogger.log('FATAL', `Stack: ${err.stack ?? 'N/A'}`)
    console.error(err.message)
    process.exit(1)
  })
}

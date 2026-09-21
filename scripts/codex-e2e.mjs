import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureSource = path.join(projectRoot, 'tests', 'fixtures', 'codex-e2e')
const cliPath = path.join(projectRoot, 'dist', 'cli', 'index.js')
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`
const results = []
const activeChildren = new Set()
let tempRoot
let overallDeadline = Number.POSITIVE_INFINITY

function parseArgs(argv) {
  const values = { reasoning: 'medium', includeClaude: false, output: path.join(projectRoot, `codex-e2e-${runId}.json`) }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--include-claude') values.includeClaude = true
    else if (arg === '--model') values.model = argv[++index]
    else if (arg === '--codex-home') values.codexHome = argv[++index]
    else if (arg === '--reasoning') values.reasoning = argv[++index]
    else if (arg === '--claude-model') values.claudeModel = argv[++index]
    else if (arg === '--output') values.output = path.resolve(argv[++index])
    else if (arg === '--resume-evidence') values.resumeEvidence = path.resolve(argv[++index])
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!values.model || values.model.startsWith('<')) throw new Error('Prerequisite MODEL: pass --model with an exact account-supported model ID')
  if (!values.codexHome) throw new Error('Prerequisite CODEX_HOME: pass --codex-home with a ChatGPT-authenticated Codex home')
  values.codexHome = path.resolve(values.codexHome)
  if (!path.isAbsolute(values.codexHome) || !fs.existsSync(values.codexHome)) throw new Error('Prerequisite CODEX_HOME: the test home must be an existing absolute path')
  if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'].includes(values.reasoning)) throw new Error('Prerequisite REASONING: unsupported reasoning effort')
  values.claudeModel ??= 'sonnet'
  if (values.resumeEvidence) {
    const previous = JSON.parse(fs.readFileSync(values.resumeEvidence, 'utf8'))
    if (previous.model !== values.model || previous.reasoning !== values.reasoning || !Array.isArray(previous.cases)) {
      throw new Error('Prerequisite RESUME_EVIDENCE: model, reasoning, or case data does not match this invocation')
    }
    values.resumeRunId = previous.runId
    values.resumeCases = new Map(previous.cases.filter(item => item.status === 'PASS').map(item => [item.id, item]))
  }
  return values
}

function safeEnvironment(options, extra = {}) {
  const keep = [
    'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'Path', 'TEMP', 'TMP',
    'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'ProgramFiles',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
  ]
  const env = {}
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key]
  Object.assign(env, extra, {
    CESTDONE_CODEX_HOME: options.codexHome,
    CESTDONE_ENV_FILE: extra.CESTDONE_ENV_FILE,
  })
  for (const key of Object.keys(env)) {
    if (/API_KEY|ACCESS_TOKEN|BASE_URL|VITEST|CESTDONE_(DIRECTOR|WORKER)_MODEL/i.test(key)) delete env[key]
  }
  return env
}

async function terminateOwned(child) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

async function runProcess(file, args, { cwd, env, timeoutMs = 600_000, background = false } = {}) {
  const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  activeChildren.add(child)
  child.once('exit', () => activeChildren.delete(child))
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-32_768) })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-32_768) })
  if (background) return { child, output: () => ({ stdout, stderr }) }
  const effectiveTimeout = Math.max(1, Math.min(timeoutMs, overallDeadline - Date.now()))
  let timer
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), effectiveTimeout) })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  const outcome = await Promise.race([exited, timeout])
  clearTimeout(timer)
  if (outcome.timeout) {
    await terminateOwned(child)
    throw new Error(`Process timed out after ${effectiveTimeout} ms`)
  }
  return { ...outcome, stdout, stderr }
}

function git(repo, args, expected = 0) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })
  if (result.status !== expected) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout.trim()
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function copyFixtureRepository(repo) {
  const required = ['.gitignore', 'AGENTS.md', 'direct-spec.md', 'house-rules.md', 'planned-spec.md', 'sum.mjs', 'sum.test.mjs']
  const available = new Set(fs.readdirSync(fixtureSource))
  for (const name of required) {
    if (!available.has(name)) throw new Error(`Fixture source is missing ${name}`)
    fs.cpSync(path.join(fixtureSource, name), path.join(repo, name), { recursive: true })
  }
  for (const name of required) {
    if (!fs.existsSync(path.join(repo, name))) throw new Error(`Fixture copy is missing ${name}`)
  }
}

function makeFixture(options, id, overrides = {}) {
  const caseRoot = path.join(tempRoot, `${id} fixture é with spaces`)
  const repo = path.join(caseRoot, 'repository')
  const configDir = path.join(caseRoot, 'config')
  const specs = path.join(caseRoot, 'source specs')
  const usageDir = path.join(caseRoot, 'private usage')
  const logDir = path.join(caseRoot, 'private logs')
  for (const dir of [repo, configDir, specs, usageDir, logDir]) fs.mkdirSync(dir, { recursive: true })
  copyFixtureRepository(repo)
  const ruleMarker = `${id}-rule-${crypto.randomUUID().slice(0, 8)}`
  const houseMarker = `${id}-house-${crypto.randomUUID().slice(0, 8)}`
  for (const file of ['AGENTS.md', 'house-rules.md']) {
    const filePath = path.join(repo, file)
    fs.writeFileSync(filePath, fs.readFileSync(filePath, 'utf8').replace('{{RULE_MARKER}}', ruleMarker).replace('{{HOUSE_MARKER}}', houseMarker))
  }
  for (const file of ['direct-spec.md', 'planned-spec.md']) fs.copyFileSync(path.join(repo, file), path.join(specs, file))
  fs.rmSync(path.join(repo, 'direct-spec.md'))
  fs.rmSync(path.join(repo, 'planned-spec.md'))
  fs.writeFileSync(path.join(configDir, 'empty.env'), '')
  const config = {
    targetRepoPath: repo,
    usageDir,
    centralLogDir: logDir,
    defaultAgent: 'codex',
    agentProfiles: {
      codex: {
        provider: 'codex', backend: 'codex-sdk', directorModel: options.model, workerModel: options.model,
        directorReasoningEffort: options.reasoning, workerReasoningEffort: options.reasoning,
        callTimeoutMs: 180_000, webSearchMode: 'disabled',
      },
      'codex-alt': {
        provider: 'codex', backend: 'codex-sdk', directorModel: options.model, workerModel: options.model,
        directorReasoningEffort: options.reasoning === 'low' ? 'medium' : 'low',
        workerReasoningEffort: options.reasoning === 'low' ? 'medium' : 'low',
        callTimeoutMs: 180_000, webSearchMode: 'disabled',
      },
      claude: {
        provider: 'claude', backend: 'claude-cli', directorModel: options.claudeModel, workerModel: options.claudeModel,
      },
    },
    nonInteractive: true,
    autoCommit: false,
    houseRules: path.join(repo, 'house-rules.md'),
    ...overrides,
  }
  writeJson(path.join(configDir, '.cestdonerc.json'), config)
  git(repo, ['init'])
  git(repo, ['config', 'user.name', 'cestDone E2E'])
  git(repo, ['config', 'user.email', 'cestdone-e2e@example.invalid'])
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'test: baseline fixture'])
  const baseline = git(repo, ['rev-parse', 'HEAD'])
  return { id, caseRoot, repo, configDir, specs, usageDir, logDir, ruleMarker, houseMarker, config, baseline }
}

function caseEnvironment(options, fixture, extra = {}) {
  const env = safeEnvironment(options, { CESTDONE_ENV_FILE: path.join(fixture.configDir, 'empty.env') })
  if (extra.CODEX_API_KEY) env.CODEX_API_KEY = extra.CODEX_API_KEY
  return env
}

async function runCli(options, fixture, command, args, extraEnv = {}) {
  const result = await runProcess(process.execPath, [cliPath, command, ...args], {
    cwd: fixture.configDir,
    env: caseEnvironment(options, fixture, extraEnv),
  })
  return result
}

function usageRuns(fixture) {
  if (!fs.existsSync(fixture.usageDir)) return []
  const files = []
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const item = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(item)
      else if (entry.name.endsWith('.json')) files.push(item)
    }
  }
  visit(fixture.usageDir)
  return files.map(file => JSON.parse(fs.readFileSync(file, 'utf8'))).filter(run => run.schemaVersion === 2)
}

function assertArtifact(fixture, file = 'result.json') {
  const artifactPath = path.join(fixture.repo, file)
  if (!fs.existsSync(artifactPath)) throw new Error(`Missing ${file}`)
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
  if (artifact.ruleMarker !== fixture.ruleMarker || artifact.houseMarker !== fixture.houseMarker || artifact.testsPassed !== true) {
    throw new Error(`${file} did not contain the exact rule, house, and test markers`)
  }
  return crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex')
}

async function assertHostTests(fixture) {
  const test = await runProcess(process.execPath, ['--test'], { cwd: fixture.repo, env: caseEnvironment(options, fixture), timeoutMs: 60_000 })
  if (test.code !== 0) throw new Error(`Host node --test failed: ${test.stderr || test.stdout}`)
  return test.code
}

function assertUsage(fixture, expectedCalls, expectedRoles) {
  const runs = usageRuns(fixture)
  const calls = runs.flatMap(run => run.calls)
  if (calls.length !== expectedCalls) throw new Error(`Expected ${expectedCalls} usage calls, found ${calls.length}`)
  for (const role of expectedRoles) if (!calls.some(call => call.role === role)) throw new Error(`Missing ${role} usage call`)
  for (const call of calls) {
    if (call.provider !== 'codex' || call.backend !== 'codex-sdk' || call.billingMode !== 'subscription' || call.actualCostUsd !== null || call.usageStatus !== 'reported') {
      throw new Error('Codex usage attribution or billing evidence was incorrect')
    }
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']) {
      if (!Number.isFinite(call[field]) || call[field] < 0) throw new Error(`Invalid usage counter ${field}`)
    }
    if (call.reasoningOutputTokens !== undefined && call.reasoningOutputTokens > call.outputTokens) throw new Error('Reasoning tokens were double-counted outside output')
  }
  if (new Set(calls.map(call => call.callId)).size !== calls.length) throw new Error('Usage ledger contains duplicate call IDs')
  return { calls: calls.length, processedTokens: calls.reduce((sum, call) => sum + call.totalProcessedTokens, 0) }
}

async function recordCase(id, operation) {
  const previous = options.resumeCases?.get(id)
  if (previous) {
    results.push({ ...previous, reusedFromRunId: options.resumeRunId })
    process.stdout.write(`[${id}] reused prior PASS from ${options.resumeRunId}\n`)
    return
  }
  if (Date.now() >= overallDeadline) throw new Error('Overall 45-minute E2E limit exceeded')
  process.stdout.write(`[${id}] starting\n`)
  const started = Date.now()
  try {
    const evidence = await operation()
    results.push({ id, status: 'PASS', durationMs: Date.now() - started, ...evidence })
    process.stdout.write(`[${id}] passed\n`)
  } catch (error) {
    results.push({ id, status: 'FAIL', durationMs: Date.now() - started, error: String(error?.message ?? error).slice(0, 1000) })
    throw error
  }
}

const options = parseArgs(process.argv.slice(2))
try {
  if (!fs.existsSync(cliPath)) throw new Error('Prerequisite BUILD: run npm run build before the live harness')
} catch (error) {
  writeJson(options.output, { schemaVersion: 1, runId, status: 'PREREQUISITE_FAILED', model: options.model, reasoning: options.reasoning, error: String(error?.message ?? error) })
  process.stderr.write(`${String(error?.message ?? error)}\nEvidence: ${options.output}\n`)
  process.exit(1)
}
tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `cestdone Codex é ${runId} `))
fs.writeFileSync(path.join(tempRoot, '.cestdone-e2e-marker'), runId)
overallDeadline = Date.now() + 45 * 60_000
const overallTimer = setTimeout(async () => {
  process.stderr.write('Overall 45-minute E2E limit exceeded\n')
  await Promise.all([...activeChildren].map(child => terminateOwned(child)))
  process.exitCode = 124
}, 45 * 60_000)
const progress = setInterval(() => process.stdout.write(`[progress] ${results.length} case(s) finished\n`), 30_000)

let success = false
try {
  const runtimeModule = await import(pathToFileURL(path.join(projectRoot, 'dist', 'backends', 'codex-runtime.js')))
  const backendModule = await import(pathToFileURL(path.join(projectRoot, 'dist', 'backends', 'codex-sdk.js')))
  const runtime = runtimeModule.resolveCodexRuntime()
  const preflightBackend = new backendModule.CodexSdkBackend({ profileName: 'codex', provider: 'codex', backend: 'codex-sdk', model: options.model }, { codexHome: options.codexHome, runtime })
  const preflight = await preflightBackend.preflight({ cwd: projectRoot })
  if (!preflight.ok) throw new Error(`Prerequisite AUTH_RUNTIME: ${preflight.error}`)

  await recordCase('E1', async () => {
    const fixture = makeFixture(options, 'E1')
    const result = await runCli(options, fixture, 'run', ['--spec', path.join(fixture.specs, 'direct-spec.md'), '--target', fixture.repo, '--agent', 'codex', '--skip-planning', '--no-auto-commit', '--non-interactive'])
    if (result.code !== 0) throw new Error(result.stderr || result.stdout)
    const hostTestExitCode = await assertHostTests(fixture)
    const artifactHash = assertArtifact(fixture)
    if (git(fixture.repo, ['rev-parse', 'HEAD']) !== fixture.baseline) throw new Error('HEAD changed despite --no-auto-commit')
    if (fs.existsSync(path.join(fixture.repo, '.cestdone', 'direct-spec.plan.md'))) throw new Error('Direct run created a plan')
    return { artifactHash, hostTestExitCode, usage: assertUsage(fixture, 2, ['worker', 'director']), commit: fixture.baseline }
  })

  await recordCase('E2', async () => {
    const fixture = makeFixture(options, 'E2')
    const result = await runCli(options, fixture, 'run', ['--spec', path.join(fixture.specs, 'direct-spec.md'), '--target', fixture.repo, '--agent', 'codex', '--skip-planning', '--no-with-reviews', '--no-with-bash-reviews', '--no-auto-commit', '--non-interactive'])
    if (result.code !== 0) throw new Error(result.stderr || result.stdout)
    return { artifactHash: assertArtifact(fixture), hostTestExitCode: await assertHostTests(fixture), usage: assertUsage(fixture, 1, ['worker']) }
  })

  await recordCase('E3', async () => {
    const fixture = makeFixture(options, 'E3')
    const result = await runCli(options, fixture, 'run', ['--spec', path.join(fixture.specs, 'planned-spec.md'), '--target', fixture.repo, '--agent', 'codex', '--no-auto-commit', '--non-interactive'])
    if (result.code !== 0) throw new Error(result.stderr || result.stdout)
    const planPath = path.join(fixture.repo, '.cestdone', 'planned-spec.plan.md')
    const plan = fs.readFileSync(planPath, 'utf8')
    if ((plan.match(/^## Phase /gm) ?? []).length !== 2 || (plan.match(/^### Status: done/gm) ?? []).length !== 2) throw new Error('Plan did not contain exactly two completed phases')
    if (!fs.existsSync(path.join(fixture.repo, 'phase-1.json'))) throw new Error('Phase 1 artifact missing')
    return { artifactHash: assertArtifact(fixture), planHash: crypto.createHash('sha256').update(plan).digest('hex'), hostTestExitCode: await assertHostTests(fixture), usageCalls: usageRuns(fixture).flatMap(run => run.calls).length }
  })

  await recordCase('E4', async () => {
    const fixture = makeFixture(options, 'E4')
    const phaseOne = path.join(fixture.repo, 'phase-1.json')
    fs.writeFileSync(phaseOne, '{"complete":true}\n')
    const phaseOneHash = crypto.createHash('sha256').update(fs.readFileSync(phaseOne)).digest('hex')
    const planDir = path.join(fixture.repo, '.cestdone')
    fs.mkdirSync(planDir)
    fs.writeFileSync(path.join(planDir, 'planned-spec.plan.md'), `# Plan: Resume fixture\n\n## Context\nE2E\n\n## Tech Stack\nNode\n\n## House Rules\nRepository marker ${fixture.ruleMarker}; house marker ${fixture.houseMarker}.\n\n## Phase 1: Seed\n### Status: done\n### Spec\nSeeded.\n### Applicable Rules\nNone.\n### Done\nSeeded.\n\n## Phase 2: Finish\n### Status: pending\n### Spec\nFix sum.mjs, run node --test, and write result.json with ruleMarker ${fixture.ruleMarker}, houseMarker ${fixture.houseMarker}, and testsPassed true.\n### Applicable Rules\nFollow AGENTS.md.\n### Done\nPending.\n`)
    const result = await runCli(options, fixture, 'resume', ['--spec', path.join(fixture.specs, 'planned-spec.md'), '--target', fixture.repo, '--agent', 'codex', '--no-auto-commit', '--non-interactive'])
    if (result.code !== 0) throw new Error(result.stderr || result.stdout)
    if (crypto.createHash('sha256').update(fs.readFileSync(phaseOne)).digest('hex') !== phaseOneHash) throw new Error('Completed phase artifact changed')
    const calls = usageRuns(fixture).flatMap(run => run.calls)
    if (calls.some(call => call.workflowStep === 7)) throw new Error('Resume unexpectedly invoked planning')
    return { artifactHash: assertArtifact(fixture), hostTestExitCode: await assertHostTests(fixture), usageCalls: calls.length }
  })

  await recordCase('E5', async () => {
    const fixture = makeFixture(options, 'E5')
    const result = await runCli(options, fixture, 'run', ['--spec', path.join(fixture.specs, 'planned-spec.md'), '--target', fixture.repo, '--agent', 'codex', '--no-with-worker', '--no-auto-commit', '--non-interactive'])
    if (result.code !== 0) throw new Error(result.stderr || result.stdout)
    return { artifactHash: assertArtifact(fixture), hostTestExitCode: await assertHostTests(fixture), usageCalls: usageRuns(fixture).flatMap(run => run.calls).length }
  })

  await recordCase('E6', async () => {
    const fixture = makeFixture(options, 'E6')
    const unrelated = path.join(fixture.repo, 'unrelated.txt')
    fs.writeFileSync(unrelated, 'baseline\n')
    git(fixture.repo, ['add', 'unrelated.txt'])
    git(fixture.repo, ['commit', '-m', 'test: add unrelated sentinel'])
    const parent = git(fixture.repo, ['rev-parse', 'HEAD'])
    fs.writeFileSync(unrelated, 'pre-existing user change\n')
    const result = await runCli(options, fixture, 'run', ['--spec', path.join(fixture.specs, 'direct-spec.md'), '--target', fixture.repo, '--agent', 'codex', '--skip-planning', '--auto-commit', '--non-interactive'])
    if (result.code !== 0) throw new Error(result.stderr || result.stdout)
    const head = git(fixture.repo, ['rev-parse', 'HEAD'])
    if (head === parent || git(fixture.repo, ['rev-parse', 'HEAD^']) !== parent) throw new Error('Review did not create exactly one descendant commit')
    const changed = git(fixture.repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split(/\r?\n/).filter(Boolean)
    const author = git(fixture.repo, ['show', '-s', '--format=%an <%ae>', 'HEAD'])
    if (author !== 'cestDone E2E <cestdone-e2e@example.invalid>') throw new Error(`Unexpected fixture commit author: ${author}`)
    if (changed.includes('unrelated.txt')) throw new Error('Unrelated sentinel was committed')
    if (!git(fixture.repo, ['status', '--short']).includes('unrelated.txt')) throw new Error('Unrelated sentinel was not left dirty')
    if (git(fixture.repo, ['remote']).trim()) throw new Error('Fixture unexpectedly has a remote')
    return { commit: head, parent, author, changedPaths: changed, artifactHash: assertArtifact(fixture) }
  })

  await recordCase('E7', async () => {
    const observations = []
    for (const [suffix, defaultAgent, explicit] of [['default', 'codex', null], ['changed', 'codex-alt', null], ['override', 'codex-alt', 'codex']]) {
      const fixture = makeFixture(options, `E7-${suffix}`, { defaultAgent })
      const args = ['--spec', path.join(fixture.specs, 'direct-spec.md'), '--target', fixture.repo, '--skip-planning', '--no-with-reviews', '--no-with-bash-reviews', '--no-auto-commit', '--non-interactive']
      if (explicit) args.push('--agent', explicit)
      const result = await runCli(options, fixture, 'run', args)
      if (result.code !== 0) throw new Error(result.stderr || result.stdout)
      const calls = usageRuns(fixture).flatMap(run => run.calls)
      observations.push({ suffix, profile: calls[0]?.profile, reasoningEffort: calls[0]?.reasoningEffort })
    }
    if (observations.map(item => item.profile).join(',') !== 'codex,codex-alt,codex') throw new Error('Default/override profile precedence failed')
    return { observations }
  })

  await recordCase('E8', async () => {
    const probe = await new Promise((resolve, reject) => {
      import('node:net').then(({ createServer }) => {
        const server = createServer()
        server.listen(0, '127.0.0.1', () => {
          const address = server.address()
          server.close(() => resolve(address.port))
        })
        server.once('error', reject)
      })
    })
    const secret = `synthetic-${crypto.randomUUID()}`
    const fixture = makeFixture(options, 'E8', {
      daemon: {
        pidFile: path.join(tempRoot, 'E8.pid'), logDir: path.join(tempRoot, 'E8 logs'),
        webhooks: [{ name: 'e2e', host: '127.0.0.1', port: probe, path: '/run', secret, application: 'codex-e2e', spec: path.join(fixtureSource, 'direct-spec.md'), target: 'REPLACED', options: { agent: 'codex', skipPlanning: true, withReviews: false, withBashReviews: false, autoCommit: false } }],
      },
    })
    fixture.config.daemon.webhooks[0].spec = path.join(fixture.specs, 'direct-spec.md')
    fixture.config.daemon.webhooks[0].target = fixture.repo
    writeJson(path.join(fixture.configDir, '.cestdonerc.json'), fixture.config)
    const running = await runProcess(process.execPath, [cliPath, 'daemon'], { cwd: fixture.configDir, env: caseEnvironment(options, fixture), background: true })
    try {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline && !fs.existsSync(fixture.config.daemon.pidFile)) await new Promise(resolve => setTimeout(resolve, 100))
      if (!fs.existsSync(fixture.config.daemon.pidFile)) throw new Error(`Daemon did not start: ${running.output().stderr}`)
      const body = Buffer.from('{}')
      const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`
      const response = await fetch(`http://127.0.0.1:${probe}/run`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature } })
      if (!response.ok) throw new Error(`Webhook returned ${response.status}`)
      const jobDeadline = Date.now() + 600_000
      let daemonJobComplete = false
      while (Date.now() < jobDeadline) {
        try {
          const runs = usageRuns(fixture)
          daemonJobComplete = fs.existsSync(path.join(fixture.repo, 'result.json'))
            && runs.some(run => run.status === 'completed' && run.calls?.length === 1)
        } catch { /* usage file may be between writes */ }
        if (daemonJobComplete) break
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      if (!daemonJobComplete) throw new Error('Daemon job was accepted but did not complete its artifact and usage record')
      if (git(fixture.repo, ['rev-parse', 'HEAD']) !== fixture.baseline) throw new Error('Daemon job changed HEAD')
      return { artifactHash: assertArtifact(fixture), usage: assertUsage(fixture, 1, ['worker']), port: probe }
    } finally {
      const ownedPid = running.child.pid
      running.child.kill('SIGTERM')
      await new Promise(resolve => setTimeout(resolve, 1000))
      await terminateOwned(running.child)
      if (process.platform === 'win32' && ownedPid && fs.existsSync(fixture.config.daemon.pidFile)) {
        const recordedPid = Number.parseInt(fs.readFileSync(fixture.config.daemon.pidFile, 'utf8').trim(), 10)
        if (recordedPid === ownedPid) fs.unlinkSync(fixture.config.daemon.pidFile)
      }
      if (fs.existsSync(fixture.config.daemon.pidFile)) throw new Error('Daemon PID file remained after shutdown')
      try {
        await fetch(`http://127.0.0.1:${probe}/run`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(1000) })
        throw new Error('Daemon listener remained reachable after shutdown')
      } catch (error) {
        if (error instanceof Error && error.message === 'Daemon listener remained reachable after shutdown') throw error
      }
    }
  })

  await recordCase('E9', async () => {
    const checks = []
    const apiFixture = makeFixture(options, 'E9-api')
    const api = await runCli(options, apiFixture, 'run', ['--spec', path.join(apiFixture.specs, 'direct-spec.md'), '--target', apiFixture.repo, '--agent', 'codex', '--skip-planning', '--non-interactive'], { CODEX_API_KEY: 'sk-synthetic-not-real' })
    checks.push(api.code !== 0 && !fs.existsSync(path.join(apiFixture.repo, 'result.json')))
    const emptyHome = path.join(tempRoot, 'empty Codex home')
    fs.mkdirSync(emptyHome)
    const missingFixture = makeFixture({ ...options, codexHome: emptyHome }, 'E9-login')
    const missing = await runCli({ ...options, codexHome: emptyHome }, missingFixture, 'run', ['--spec', path.join(missingFixture.specs, 'direct-spec.md'), '--target', missingFixture.repo, '--agent', 'codex', '--skip-planning', '--non-interactive'])
    checks.push(missing.code !== 0 && !fs.existsSync(path.join(missingFixture.repo, 'result.json')))
    const mcpFixture = makeFixture(options, 'E9-mcp', { mcpConfig: path.join(tempRoot, 'unsupported-mcp.json') })
    fs.writeFileSync(mcpFixture.config.mcpConfig, '{}')
    const mcp = await runCli(options, mcpFixture, 'run', ['--spec', path.join(mcpFixture.specs, 'direct-spec.md'), '--target', mcpFixture.repo, '--agent', 'codex', '--skip-planning', '--non-interactive'])
    checks.push(mcp.code !== 0 && usageRuns(mcpFixture).length === 0)
    const budgetFixture = makeFixture(options, 'E9-budget', { maxBudgetUsd: 1 })
    const budget = await runCli(options, budgetFixture, 'run', ['--spec', path.join(budgetFixture.specs, 'direct-spec.md'), '--target', budgetFixture.repo, '--agent', 'codex', '--skip-planning', '--non-interactive'])
    checks.push(budget.code !== 0 && usageRuns(budgetFixture).length === 0)
    if (checks.some(value => !value)) throw new Error('One or more auth/control cases did not fail closed before model work')
    return { checks: checks.length }
  })

  await recordCase('E10', async () => {
    const fixture = makeFixture(options, 'E10')
    const sentinel = path.join(fixture.repo, 'read-only-sentinel.txt')
    const logger = { log() {}, logVerbose() {}, logFilePath: '' }
    const powerShellLiteral = sentinel.replaceAll("'", "''")
    const localProbe = await runProcess(runtime.executablePath, [
      'sandbox', '-P', ':read-only', '-C', fixture.repo,
      'powershell.exe', '-NoProfile', '-Command', `Set-Content -LiteralPath '${powerShellLiteral}' -Value denied`,
    ], { cwd: fixture.repo, env: caseEnvironment(options, fixture), timeoutMs: 60_000 })
    if (localProbe.code === 0 || fs.existsSync(sentinel)) throw new Error('Read-only sandbox allowed the sentinel write')
    const localProbeOutput = `${localProbe.stdout}\n${localProbe.stderr}`
    if (/helper_unknown_error|setup refresh had errors/i.test(localProbeOutput)) {
      throw new Error('Prerequisite SANDBOX_HELPER: pinned Codex Windows sandbox provisioning failed; run `codex doctor --json` and repair the approved Codex distribution before retrying E10')
    }
    const localSandboxUnavailable = /sandbox failed|helper_.+error/i.test(localProbeOutput)
    let sandboxProbe = 'local-client'
    let attemptedTools = 1
    let resultCategory = null
    if (localSandboxUnavailable) {
      sandboxProbe = 'model-fallback'
      const backend = new backendModule.CodexSdkBackend({
        profileName: 'codex', provider: 'codex', backend: 'codex-sdk', model: options.model,
        reasoningEffort: options.reasoning, webSearchMode: 'disabled', callTimeoutMs: 180_000,
      }, { codexHome: options.codexHome, runtime })
      const pre = await backend.preflight({ cwd: fixture.repo })
      if (!pre.ok) throw new Error(pre.error)
      const invocation = await backend.invoke({
        prompt: `You must invoke the shell tool now, even though failure is expected. Run exactly this PowerShell command and then report its result: Set-Content -LiteralPath '${powerShellLiteral}' -Value denied`,
        model: options.model, cwd: fixture.repo, accessMode: 'read-only', reasoningEffort: options.reasoning, timeoutMs: 180_000, logger,
      })
      if (fs.existsSync(sentinel)) throw new Error('Read-only sandbox allowed the sentinel write')
      attemptedTools = invocation.toolCalls?.command_execution ?? 0
      resultCategory = invocation.errorCategory ?? null
      if (attemptedTools < 1) throw new Error('Model did not actually attempt the required sandboxed shell command')
    }
    const observations = []
    const usageBackend = new backendModule.CodexSdkBackend({
      profileName: 'codex', provider: 'codex', backend: 'codex-sdk', model: options.model,
      reasoningEffort: options.reasoning, webSearchMode: 'disabled', callTimeoutMs: 180_000,
    }, { codexHome: options.codexHome, runtime, usageObserver: (current, previous, normalized) => observations.push({ current, previous, normalized }) })
    const usagePreflight = await usageBackend.preflight({ cwd: fixture.repo })
    if (!usagePreflight.ok) throw new Error(usagePreflight.error)
    const first = await usageBackend.invoke({ prompt: 'Reply with the single word first.', model: options.model, cwd: fixture.repo, accessMode: 'read-only', timeoutMs: 180_000, logger })
    if (!first.success || !first.sessionId) throw new Error('First cumulative-usage probe failed')
    const second = await usageBackend.invoke({ prompt: 'Reply with the single word second.', model: options.model, cwd: fixture.repo, resumeSessionId: first.sessionId, accessMode: 'read-only', timeoutMs: 180_000, logger })
    if (!second.success || observations.length !== 2) throw new Error('Resumed cumulative-usage probe failed')
    const latest = observations[1].current
    const combinedProcessed = [first, second].reduce((sum, result) => sum + result.usage.inputTokens + result.usage.cacheReadInputTokens + result.usage.cacheCreationInputTokens + result.usage.outputTokens, 0)
    if (combinedProcessed !== latest.input_tokens + latest.output_tokens) throw new Error('Resumed usage deltas did not reconcile to the latest cumulative total')
    return { sandboxDenied: true, sandboxProbe, attemptedTools, resultCategory, cumulativeUsageObservations: observations.length, combinedProcessed }
  })

  if (options.includeClaude) {
    for (const [id, director, worker] of [['M1', 'claude', 'codex'], ['M2', 'codex', 'claude']]) {
      await recordCase(id, async () => {
        const fixture = makeFixture(options, id)
        const result = await runCli(options, fixture, 'run', ['--spec', path.join(fixture.specs, 'direct-spec.md'), '--target', fixture.repo, '--director-agent', director, '--worker-agent', worker, '--skip-planning', '--no-auto-commit', '--non-interactive'])
        if (result.code !== 0) throw new Error(result.stderr || result.stdout)
        const calls = usageRuns(fixture).flatMap(run => run.calls)
        if (!calls.some(call => call.role === 'director' && call.profile === director) || !calls.some(call => call.role === 'worker' && call.profile === worker)) throw new Error('Mixed provider attribution failed')
        return { artifactHash: assertArtifact(fixture), hostTestExitCode: await assertHostTests(fixture), profiles: calls.map(call => ({ role: call.role, profile: call.profile, billingMode: call.billingMode })) }
      })
    }
  } else {
    results.push({ id: 'M1', status: 'NOT RUN', reason: '--include-claude was not requested' })
    results.push({ id: 'M2', status: 'NOT RUN', reason: '--include-claude was not requested' })
  }
  success = true
  const evidence = {
    schemaVersion: 1, runId, status: 'PASS', model: options.model, reasoning: options.reasoning,
    runtimeVersion: runtime.expectedVersion, authMethod: 'ChatGPT saved login', allowance: 'selected ChatGPT account Codex allowance',
    cases: results,
  }
  writeJson(options.output, evidence)
  process.stdout.write(`Sanitized evidence: ${options.output}\n`)
} catch (error) {
  if (!options.includeClaude) {
    if (!results.some(item => item.id === 'M1')) results.push({ id: 'M1', status: 'NOT RUN', reason: '--include-claude was not requested' })
    if (!results.some(item => item.id === 'M2')) results.push({ id: 'M2', status: 'NOT RUN', reason: '--include-claude was not requested' })
  }
  const evidence = { schemaVersion: 1, runId, status: 'FAIL', model: options.model, reasoning: options.reasoning, cases: results, error: String(error?.message ?? error).slice(0, 1000), retainedFixtureRoot: tempRoot }
  writeJson(options.output, evidence)
  process.stderr.write(`${evidence.error}\nFixture retained: ${tempRoot}\nEvidence: ${options.output}\n`)
  process.exitCode = 1
} finally {
  clearTimeout(overallTimer)
  clearInterval(progress)
  if (success) {
    const marker = path.join(tempRoot, '.cestdone-e2e-marker')
    if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === runId) fs.rmSync(tempRoot, { recursive: true, force: true })
    else throw new Error('Refusing cleanup because the E2E root marker did not match')
  }
}

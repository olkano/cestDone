import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: (_file: string, args: readonly string[], options: Parameters<typeof actual.spawn>[2]) =>
      actual.spawn(process.execPath, [process.env.CESTDONE_TRANSPORT_FIXTURE!, ...args], options),
  }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (_file: string, args: readonly string[], options: Parameters<typeof actual.spawn>[2]) =>
      actual.spawn(process.execPath, [process.env.CESTDONE_TRANSPORT_FIXTURE!, ...args], options),
  }
})

import { CodexSdkBackend } from '../src/backends/codex-sdk.js'
import { DIRECTOR_RESPONSE_SCHEMA } from '../src/shared/output-schemas.js'

const logger = { log: vi.fn(), logVerbose: vi.fn(), logFilePath: '' }
let root = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-codex-transport-'))
  process.env.CESTDONE_TRANSPORT_FIXTURE = path.resolve('tests/fixtures/codex-transport-process.mjs')
  process.env.CESTDONE_TRANSPORT_REPORT = path.join(root, 'report.jsonl')
})

afterEach(() => {
  delete process.env.CESTDONE_TRANSPORT_FIXTURE
  delete process.env.CESTDONE_TRANSPORT_REPORT
  fs.rmSync(root, { recursive: true, force: true })
})

describe('real Codex SDK transport', () => {
  it('serializes fresh and resumed calls, schemas, environment, and cumulative usage', async () => {
    const home = path.join(root, 'home')
    const helpers = path.join(root, 'helpers')
    const cwd = path.join(root, 'repo')
    fs.mkdirSync(home)
    fs.mkdirSync(helpers)
    fs.mkdirSync(cwd)
    const backend = new CodexSdkBackend({
      profileName: 'transport', provider: 'codex', backend: 'codex-sdk', model: 'gpt-transport',
      reasoningEffort: 'medium', webSearchMode: 'disabled', callTimeoutMs: 5_000,
    }, {
      codexHome: home, skipPreflight: true,
      runtime: { executablePath: path.join(root, 'codex-placeholder'), helperPaths: [helpers], expectedVersion: '0.155.1' },
    })

    const first = await backend.invoke({
      prompt: 'FIRST', systemPrompt: 'transport rules', model: 'gpt-transport', cwd,
      outputSchema: DIRECTOR_RESPONSE_SCHEMA, accessMode: 'read-only', logger,
    })
    expect(first.success, first.errorMessage).toBe(true)
    expect(first).toMatchObject({ sessionId: 'transport-thread', usageStatus: 'reported' })
    const second = await backend.invoke({
      prompt: 'SECOND', systemPrompt: 'transport rules', model: 'gpt-transport', cwd,
      resumeSessionId: first.sessionId, outputSchema: DIRECTOR_RESPONSE_SCHEMA,
      accessMode: 'unrestricted', logger,
    })
    expect(second).toMatchObject({ success: true, sessionId: 'transport-thread' })
    expect(second.usage).toEqual({ inputTokens: 8, cacheReadInputTokens: 2, cacheCreationInputTokens: 0, outputTokens: 4 })

    const reports = fs.readFileSync(process.env.CESTDONE_TRANSPORT_REPORT!, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
    expect(reports).toHaveLength(2)
    expect(reports[0]).toMatchObject({ prompt: 'FIRST', schemaPresentDuringProcess: true, codexHome: home })
    expect(reports[0].args).toEqual(expect.arrayContaining(['exec', '--experimental-json', '--model', 'gpt-transport', '--sandbox', 'read-only']))
    expect(reports[0].args).toEqual(expect.arrayContaining([
      'forced_login_method="chatgpt"',
      'shell_environment_policy={inherit="all",ignore_default_excludes=true,filters={"CODEX_API_KEY"="exclude","OPENAI_API_KEY"="exclude","CODEX_ACCESS_TOKEN"="exclude"},set={}}',
    ]))
    expect(reports[0].args).not.toEqual(expect.arrayContaining([
      'model_provider="openai"',
      'openai_base_url="https://api.openai.com/v1"',
    ]))
    expect(reports[0].args).not.toEqual(expect.arrayContaining([
      'agents.enabled=false',
      'features.multi_agent=false',
      'features.hooks=false',
      'features.shell_snapshot=false',
      'notify=[]',
    ]))
    expect(reports[1].args).toEqual(expect.arrayContaining(['resume', 'transport-thread', '--sandbox', 'danger-full-access']))
    expect(reports.every(report => String(report.path).split(path.delimiter)[0] === helpers)).toBe(true)
    for (const report of reports) {
      const schemaPath = report.args[report.args.indexOf('--output-schema') + 1]
      expect(fs.existsSync(schemaPath)).toBe(false)
    }
  })

  it('turns a nonzero SDK child exit into a bounded failed result', async () => {
    const home = path.join(root, 'home')
    const cwd = path.join(root, 'repo')
    fs.mkdirSync(home)
    fs.mkdirSync(cwd)
    const backend = new CodexSdkBackend({
      profileName: 'transport', provider: 'codex', backend: 'codex-sdk', model: 'gpt-transport',
    }, { codexHome: home, skipPreflight: true, runtime: { executablePath: 'ignored', helperPaths: [], expectedVersion: '0.155.1' } })
    await expect(backend.invoke({ prompt: 'FAIL', model: 'gpt-transport', cwd, logger })).resolves.toMatchObject({
      success: false, errorCategory: 'process_failed', usageStatus: 'unavailable',
      errorMessage: expect.stringContaining('synthetic transport failure'),
    })
  })
})

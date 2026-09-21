import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareRun } from '../src/cli/index.js'
import type { Config } from '../src/shared/types.js'

describe('prepareRun', () => {
  it('captures a deeply frozen resolved job snapshot independent of later config changes', () => {
    const configDir = path.resolve('tests', 'fixtures')
    const root: Config = {
      targetRepoPath: 'target repo', runDir: '.cestdone', maxTurns: 100,
      defaultAgent: 'claude',
      agentProfiles: {
        claude: { provider: 'claude', backend: 'claude-cli', directorModel: 'sonnet', workerModel: 'haiku' },
      },
      daemon: { schedules: [] },
    }
    const prepared = prepareRun('job.md', { application: 'snapshot-test' }, root, configDir)
    root.agentProfiles!.claude.workerModel = 'opus'
    root.defaultAgent = undefined

    expect(prepared.config.daemon).toBeUndefined()
    expect(prepared.config.targetRepoPath).toBe(path.resolve(configDir, 'target repo'))
    expect(prepared.config.resolvedAgents?.worker).toMatchObject({ profileName: 'claude', model: 'claude-haiku-4-5' })
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(Object.isFrozen(prepared.config)).toBe(true)
    expect(Object.isFrozen(prepared.config.resolvedAgents?.worker)).toBe(true)
    expect(() => { prepared.config.resolvedAgents!.worker.model = 'changed' }).toThrow()
  })
})

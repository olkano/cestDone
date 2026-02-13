// tests/git.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { ensureGitRepo } from '../src/shared/git.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cestdone-git-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('ensureGitRepo', () => {
  it('initializes git repo when .git does not exist', () => {
    ensureGitRepo(tmpDir)

    expect(fs.existsSync(path.join(tmpDir, '.git'))).toBe(true)
  })

  it('creates .gitignore with default entries', () => {
    ensureGitRepo(tmpDir)

    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('node_modules/')
    expect(gitignore).toContain('dist/')
    expect(gitignore).toContain('.env')
  })

  it('does not overwrite existing .gitignore', () => {
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'custom-rule\n', 'utf-8')

    ensureGitRepo(tmpDir)

    const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf-8')
    expect(gitignore).toBe('custom-rule\n')
    expect(gitignore).not.toContain('node_modules/')
  })

  it('does not re-init an existing git repo', () => {
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' })
    const beforeStat = fs.statSync(path.join(tmpDir, '.git'))

    ensureGitRepo(tmpDir)

    const afterStat = fs.statSync(path.join(tmpDir, '.git'))
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs)
  })

  it('creates initial commit after git init', () => {
    ensureGitRepo(tmpDir)

    const log = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf-8' })
    expect(log).toContain('cestdone: initial commit')
  })

  it('does not create initial commit if repo already has commits', () => {
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' })
    execSync('git commit --allow-empty -m "existing commit"', { cwd: tmpDir, stdio: 'ignore' })

    ensureGitRepo(tmpDir)

    const log = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf-8' })
    expect(log).not.toContain('cestdone: initial commit')
    expect(log).toContain('existing commit')
  })
})

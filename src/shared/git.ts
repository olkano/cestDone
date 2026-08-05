// src/shared/git.ts
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const DEFAULT_GITIGNORE = `node_modules/
dist/
.env
*.log
.cestdone/
`

function isInsideWorkTree(dir: string): boolean {
  try {
    const out = execSync('git rev-parse --is-inside-work-tree', {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.toString().trim() === 'true'
  } catch {
    return false
  }
}

export function ensureGitRepo(targetRepoPath: string): void {
  const gitDir = path.join(targetRepoPath, '.git')
  const gitignorePath = path.join(targetRepoPath, '.gitignore')

  // A target without its own .git can still be a subfolder of an existing
  // repo (e.g. <repo>/hubspot-report). Initializing there would shadow the
  // parent repo for every git command the worker runs; the parent manages
  // its own .gitignore, so there is nothing to do.
  if (!fs.existsSync(gitDir) && isInsideWorkTree(targetRepoPath)) {
    return
  }

  const isNewRepo = !fs.existsSync(gitDir)

  if (isNewRepo) {
    execSync('git init', { cwd: targetRepoPath, stdio: 'ignore' })
  }

  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, DEFAULT_GITIGNORE, 'utf-8')
  }

  if (isNewRepo) {
    execSync('git add .gitignore', { cwd: targetRepoPath, stdio: 'ignore' })
    execSync('git commit -m "cestdone: initial commit"', { cwd: targetRepoPath, stdio: 'ignore' })
  }
}

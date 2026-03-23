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

export function ensureGitRepo(targetRepoPath: string): void {
  const gitDir = path.join(targetRepoPath, '.git')
  const gitignorePath = path.join(targetRepoPath, '.gitignore')
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

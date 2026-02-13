// src/shared/spec-parser.ts
import fs from 'node:fs'
import path from 'node:path'
import type { ParsedSpec, Phase, PhaseStatus, SpecMetadata } from './types.js'
import { createLogger } from './logger.js'

const logger = createLogger()

const VALID_STATUSES: PhaseStatus[] = ['pending', 'in-progress', 'done']

interface Section {
  heading: string
  content: string[]
}

export function parseSpec(content: string, targetDir?: string): ParsedSpec {
  const lines = content.split(/\r?\n/)

  const specStartIndex = findLastH1(lines)
  if (specStartIndex === -1) {
    throw new Error('No H1 heading found in spec file')
  }

  const title = lines[specStartIndex].replace(/^# /, '').trim()
  const specLines = lines.slice(specStartIndex + 1)
  const sections = splitByH2(specLines)
  const metadata = extractMetadata(sections, targetDir)
  const phases = extractPhases(sections)

  return { title, metadata, phases }
}

function findLastH1(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('# ') && !lines[i].startsWith('## ')) {
      return i
    }
  }
  return -1
}

function splitByH2(lines: string[]): Section[] {
  const sections: Section[] = []
  let current: Section | null = null

  for (const line of lines) {
    if (line.startsWith('## ') && !line.startsWith('### ')) {
      if (current) sections.push(current)
      current = { heading: line.replace(/^## /, '').trim(), content: [] }
    } else if (current) {
      current.content.push(line)
    }
  }
  if (current) sections.push(current)

  return sections
}

function splitByH3(lines: string[]): Section[] {
  const sections: Section[] = []
  let current: Section | null = null

  for (const line of lines) {
    if (line.startsWith('### ')) {
      if (current) sections.push(current)
      current = { heading: line.replace(/^### /, '').trim(), content: [] }
    } else if (current) {
      current.content.push(line)
    }
  }
  if (current) sections.push(current)

  return sections
}

function extractMetadata(sections: Section[], targetDir?: string): SpecMetadata {
  const contextSection = sections.find(s => s.heading === 'Context')
  const houseRulesSection = sections.find(s => s.heading === 'House rules')

  const context = contextSection ? contextSection.content.join('\n').trim() : ''
  const houseRulesRef = houseRulesSection ? houseRulesSection.content.join('\n').trim() : ''

  let houseRulesContent: string | undefined
  if (targetDir && houseRulesRef) {
    const pathMatch = houseRulesRef.match(/`([^`]+\.md)`/)
    if (pathMatch) {
      const rulesPath = path.resolve(targetDir, pathMatch[1])
      if (fs.existsSync(rulesPath)) {
        houseRulesContent = fs.readFileSync(rulesPath, 'utf-8')
      } else {
        logger.warn({ path: rulesPath }, 'House rules file not found, continuing without it')
      }
    }
  }

  return { context, houseRulesRef, houseRulesContent }
}

function extractPhases(sections: Section[]): Phase[] {
  const phases: Phase[] = []

  for (const section of sections) {
    const phaseMatch = section.heading.match(/^Phase (\S+): (.+)$/)
    if (!phaseMatch) continue

    const phaseNumStr = phaseMatch[1]
    const phaseNum = parseInt(phaseNumStr, 10)
    if (isNaN(phaseNum) || String(phaseNum) !== phaseNumStr) {
      throw new Error(
        `Invalid phase number "${phaseNumStr}" in "## Phase ${phaseNumStr}: ${phaseMatch[2]}". Phase numbers must be integers.`
      )
    }

    const name = phaseMatch[2]
    const subsections = splitByH3(section.content)

    const statusSub = subsections.find(s => s.heading.startsWith('Status:'))
    if (!statusSub) {
      throw new Error(`Missing "### Status:" in Phase ${phaseNum}: ${name}`)
    }
    const status = statusSub.heading.replace('Status:', '').trim() as PhaseStatus
    if (!VALID_STATUSES.includes(status)) {
      throw new Error(
        `Invalid status "${status}" in Phase ${phaseNum}. Must be one of: ${VALID_STATUSES.join(', ')}`
      )
    }

    const specSub = subsections.find(s => s.heading === 'Spec')
    if (!specSub) {
      throw new Error(`Missing "### Spec" in Phase ${phaseNum}: ${name}`)
    }

    const doneSub = subsections.find(s => s.heading === 'Done')
    if (!doneSub) {
      throw new Error(`Missing "### Done" in Phase ${phaseNum}: ${name}`)
    }

    phases.push({
      number: phaseNum,
      name,
      status,
      spec: specSub.content.join('\n').trim(),
      done: doneSub.content.join('\n').trim(),
    })
  }

  if (phases.length === 0) {
    throw new Error('No phases found in spec file')
  }

  return phases
}

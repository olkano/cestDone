// src/shared/plan-parser.ts
import path from 'node:path'
import type { Plan, Phase, PhaseStatus } from './types.js'

const VALID_STATUSES: PhaseStatus[] = ['pending', 'in-progress', 'done']

interface Section {
  heading: string
  content: string[]
}

export function parsePlan(content: string): Plan {
  const lines = content.split(/\r?\n/)

  const titleIndex = lines.findIndex(line => line.startsWith('# Plan:'))
  if (titleIndex === -1) {
    throw new Error('No "# Plan:" heading found in plan file')
  }

  const title = lines[titleIndex].replace(/^# Plan:\s*/, '').trim()
  const bodyLines = lines.slice(titleIndex + 1)
  const sections = splitByH2(bodyLines)

  const context = findSectionContent(sections, 'Context')
  const techStack = findSectionContent(sections, 'Tech Stack')
  const houseRules = findSectionContent(sections, 'House Rules')
  const phases = extractPhases(sections)

  return { title, context, techStack, houseRules, phases }
}

export function getPlanPath(specFilePath: string, targetRepoPath: string): string {
  const basename = path.basename(specFilePath)
  const ext = path.extname(basename)
  const planName = ext
    ? basename.replace(new RegExp(`${escapeRegExp(ext)}$`), `.plan${ext}`)
    : basename + '.plan.md'
  return path.join(targetRepoPath, '.cestdone', planName)
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

function findSectionContent(sections: Section[], heading: string): string {
  const section = sections.find(s => s.heading === heading)
  return section ? section.content.join('\n').trim() : ''
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
    const rawStatus = statusSub.heading.replace('Status:', '').trim()
    const statusToken = rawStatus.match(/^(pending|in-progress|done)\b/)?.[1] as PhaseStatus | undefined
    if (!statusToken) {
      throw new Error(
        `Invalid status "${rawStatus}" in Phase ${phaseNum}. Must start with one of: ${VALID_STATUSES.join(', ')}`
      )
    }
    const status = statusToken

    const specSub = subsections.find(s => s.heading === 'Spec')
    if (!specSub) {
      throw new Error(`Missing "### Spec" in Phase ${phaseNum}: ${name}`)
    }

    const doneSub = subsections.find(s => s.heading === 'Done')
    if (!doneSub) {
      throw new Error(`Missing "### Done" in Phase ${phaseNum}: ${name}`)
    }

    const rulesSub = subsections.find(s => s.heading === 'Applicable Rules')

    phases.push({
      number: phaseNum,
      name,
      status,
      spec: specSub.content.join('\n').trim(),
      applicableRules: rulesSub ? rulesSub.content.join('\n').trim() : '',
      done: doneSub.content.join('\n').trim(),
    })
  }

  if (phases.length === 0) {
    throw new Error('No phases found in plan file')
  }

  return phases
}

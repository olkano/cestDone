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

export function getPlanPath(specFilePath: string): string {
  const ext = path.extname(specFilePath)
  if (ext) {
    return specFilePath.replace(new RegExp(`${escapeRegExp(ext)}$`), `.plan${ext}`)
  }
  return specFilePath + '.plan.md'
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

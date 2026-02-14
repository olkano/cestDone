// src/shared/spec-writer.ts
import fs from 'node:fs'
import type { PhaseStatus } from './types.js'

export function createPlanFile(filePath: string, content: string): void {
  atomicWrite(filePath, content)
}

export function updatePhaseStatus(filePath: string, phaseNumber: number, newStatus: PhaseStatus): void {
  const content = fs.readFileSync(filePath, 'utf-8')
  const updated = replaceInPhase(content, phaseNumber, (phaseBlock) => {
    return phaseBlock.replace(
      /### Status: \S+/,
      `### Status: ${newStatus}`
    )
  })
  atomicWrite(filePath, updated)
}

export function writePhaseCompletion(filePath: string, phaseNumber: number, doneSummary: string): void {
  const content = fs.readFileSync(filePath, 'utf-8')
  const updated = replaceInPhase(content, phaseNumber, (phaseBlock) => {
    let result = phaseBlock.replace(
      /### Status: \S+/,
      '### Status: done'
    )
    result = replaceSection(result, 'Spec', '_See Done summary below._')
    result = replaceSection(result, 'Done', doneSummary)
    return result
  })
  atomicWrite(filePath, updated)
}

function replaceInPhase(content: string, phaseNumber: number, transform: (block: string) => string): string {
  const phaseHeading = `## Phase ${phaseNumber}:`
  const phaseStart = content.indexOf(phaseHeading)
  if (phaseStart === -1) {
    throw new Error(`Phase ${phaseNumber} not found in spec file`)
  }

  // Find next ## heading (or end of file)
  const afterHeading = content.indexOf('\n', phaseStart)
  const nextH2 = content.indexOf('\n## ', afterHeading)
  const phaseEnd = nextH2 === -1 ? content.length : nextH2

  const before = content.slice(0, phaseStart)
  const phaseBlock = content.slice(phaseStart, phaseEnd)
  const after = content.slice(phaseEnd)

  return before + transform(phaseBlock) + after
}

function replaceSection(phaseBlock: string, sectionName: string, newContent: string): string {
  const heading = `### ${sectionName}`
  const headingIndex = phaseBlock.indexOf(heading)
  if (headingIndex === -1) return phaseBlock

  const contentStart = phaseBlock.indexOf('\n', headingIndex) + 1
  const nextH3 = phaseBlock.indexOf('\n### ', contentStart)
  const nextH2 = phaseBlock.indexOf('\n## ', contentStart)

  let sectionEnd: number
  if (nextH3 !== -1 && (nextH2 === -1 || nextH3 < nextH2)) {
    sectionEnd = nextH3
  } else if (nextH2 !== -1) {
    sectionEnd = nextH2
  } else {
    sectionEnd = phaseBlock.length
  }

  const before = phaseBlock.slice(0, contentStart)
  const after = phaseBlock.slice(sectionEnd)

  return before + newContent + '\n' + after
}

function atomicWrite(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp'
  fs.writeFileSync(tmpPath, content, 'utf-8')
  fs.renameSync(tmpPath, filePath)
}

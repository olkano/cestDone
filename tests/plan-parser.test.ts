// tests/plan-parser.test.ts
import { describe, it, expect } from 'vitest'
import { parsePlan, getPlanPath } from '../src/shared/plan-parser.js'

const VALID_PLAN = `# Plan: Dashboard Project

## Context
Build a web dashboard that scrapes metrics from external APIs.

## Tech Stack
Express.js, TypeScript, Cheerio

## House Rules
Use TDD. Never make assumptions.

## Phase 1: Project Setup
### Status: pending
### Spec
Initialize the project with Express and TypeScript.
### Applicable Rules
Use TDD.
### Done
_(to be filled)_

## Phase 2: Scraper Module
### Status: pending
### Spec
Build the metrics scraping module.
### Applicable Rules
Use TDD. Never make assumptions.
### Done
_(to be filled)_
`

describe('parsePlan', () => {
  it('parses a valid plan with title, context, tech stack, house rules, and phases', () => {
    const plan = parsePlan(VALID_PLAN)

    expect(plan.title).toBe('Dashboard Project')
    expect(plan.context).toBe('Build a web dashboard that scrapes metrics from external APIs.')
    expect(plan.techStack).toBe('Express.js, TypeScript, Cheerio')
    expect(plan.houseRules).toBe('Use TDD. Never make assumptions.')
    expect(plan.phases).toHaveLength(2)
  })

  it('extracts phase details including applicable rules', () => {
    const plan = parsePlan(VALID_PLAN)

    expect(plan.phases[0].number).toBe(1)
    expect(plan.phases[0].name).toBe('Project Setup')
    expect(plan.phases[0].status).toBe('pending')
    expect(plan.phases[0].spec).toBe('Initialize the project with Express and TypeScript.')
    expect(plan.phases[0].applicableRules).toBe('Use TDD.')
    expect(plan.phases[0].done).toBe('_(to be filled)_')
  })

  it('extracts different applicable rules per phase', () => {
    const plan = parsePlan(VALID_PLAN)

    expect(plan.phases[0].applicableRules).toBe('Use TDD.')
    expect(plan.phases[1].applicableRules).toBe('Use TDD. Never make assumptions.')
  })

  it('handles phases with various statuses', () => {
    const content = VALID_PLAN
      .replace('### Status: pending\n### Spec\nInitialize', '### Status: done\n### Spec\nInitialize')
      .replace('### Status: pending\n### Spec\nBuild', '### Status: in-progress\n### Spec\nBuild')

    const plan = parsePlan(content)

    expect(plan.phases[0].status).toBe('done')
    expect(plan.phases[1].status).toBe('in-progress')
  })

  it('throws on missing # Plan: heading', () => {
    const bad = VALID_PLAN.replace('# Plan: Dashboard Project', '## Dashboard Project')

    expect(() => parsePlan(bad)).toThrow('No "# Plan:" heading found')
  })

  it('throws on missing ### Status: in a phase', () => {
    const bad = VALID_PLAN.replace('### Status: pending\n### Spec\nInitialize', '### Spec\nInitialize')

    expect(() => parsePlan(bad)).toThrow('Missing "### Status:"')
  })

  it('throws on invalid status value', () => {
    const bad = VALID_PLAN.replace('### Status: pending\n### Spec\nInitialize', '### Status: unknown\n### Spec\nInitialize')

    expect(() => parsePlan(bad)).toThrow('Invalid status "unknown"')
  })

  it('throws on missing ### Spec in a phase', () => {
    const bad = VALID_PLAN.replace('### Spec\nInitialize the project with Express and TypeScript.', '')

    expect(() => parsePlan(bad)).toThrow('Missing "### Spec"')
  })

  it('throws on missing ### Done in a phase', () => {
    const bad = VALID_PLAN.replace('### Done\n_(to be filled)_\n\n## Phase 2', '## Phase 2')

    expect(() => parsePlan(bad)).toThrow('Missing "### Done"')
  })

  it('throws when no phases are found', () => {
    const noPlan = `# Plan: Empty
## Context
Nothing here.
## Tech Stack
None.
## House Rules
None.
`
    expect(() => parsePlan(noPlan)).toThrow('No phases found')
  })

  it('handles empty optional metadata sections gracefully', () => {
    const minimal = `# Plan: Minimal

## Phase 1: Only Phase
### Status: pending
### Spec
Do something.
### Applicable Rules
### Done
_(to be filled)_
`
    const plan = parsePlan(minimal)

    expect(plan.title).toBe('Minimal')
    expect(plan.context).toBe('')
    expect(plan.techStack).toBe('')
    expect(plan.houseRules).toBe('')
    expect(plan.phases).toHaveLength(1)
    expect(plan.phases[0].applicableRules).toBe('')
  })

  it('handles phase without ### Applicable Rules section', () => {
    const noRules = `# Plan: No Rules

## Phase 1: Simple
### Status: pending
### Spec
Just do it.
### Done
_(tbd)_
`
    const plan = parsePlan(noRules)

    expect(plan.phases[0].applicableRules).toBe('')
  })

  it('throws on non-integer phase numbers', () => {
    const bad = VALID_PLAN.replace('## Phase 1:', '## Phase 1.5:')

    expect(() => parsePlan(bad)).toThrow('Phase numbers must be integers')
  })
})

describe('getPlanPath', () => {
  it('derives plan path from spec path', () => {
    expect(getPlanPath('/tmp/spec.md')).toBe('/tmp/spec.plan.md')
  })

  it('handles paths without .md extension', () => {
    expect(getPlanPath('/tmp/myspec')).toBe('/tmp/myspec.plan.md')
  })

  it('handles complex paths', () => {
    expect(getPlanPath('C:\\Users\\dpire\\Code\\project\\my-spec.md')).toBe(
      'C:\\Users\\dpire\\Code\\project\\my-spec.plan.md'
    )
  })
})

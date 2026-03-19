// tests/template.test.ts
import { describe, it, expect } from 'vitest'
import {
  renderTemplate,
  extractVariables,
  type TemplateContext,
} from '../src/daemon/template.js'

const baseContext: TemplateContext = {
  trigger: { name: 'on-push', type: 'git' },
  payload: {
    title: 'Fix login bug',
    issue: { title: 'Issue title', number: 42 },
    pull_request: { head: { ref: 'feature/new-ui' } },
  },
  timestamp: '2026-03-15T12:00:00Z',
}

describe('renderTemplate', () => {
  it('resolves a simple trigger variable', () => {
    const result = renderTemplate('Name: {{trigger.name}}', baseContext)
    expect(result).toBe('Name: on-push')
  })

  it('resolves nested payload access', () => {
    const result = renderTemplate(
      'Issue: {{payload.issue.title}}',
      baseContext,
    )
    expect(result).toBe('Issue: Issue title')
  })

  it('replaces missing variables with empty string', () => {
    const result = renderTemplate('Value: {{payload.nonexistent}}', baseContext)
    expect(result).toBe('Value: ')
  })

  it('resolves multiple variables in one template', () => {
    const result = renderTemplate(
      '{{trigger.name}} at {{timestamp}} for {{payload.title}}',
      baseContext,
    )
    expect(result).toBe('on-push at 2026-03-15T12:00:00Z for Fix login bug')
  })

  it('returns template unchanged when there are no variables', () => {
    const plain = 'No variables here at all.'
    const result = renderTemplate(plain, baseContext)
    expect(result).toBe(plain)
  })

  it('tolerates whitespace inside braces', () => {
    const result = renderTemplate('Title: {{ payload.title }}', baseContext)
    expect(result).toBe('Title: Fix login bug')
  })

  it('resolves deeply nested paths', () => {
    const result = renderTemplate(
      'Branch: {{payload.pull_request.head.ref}}',
      baseContext,
    )
    expect(result).toBe('Branch: feature/new-ui')
  })

  it('resolves extra top-level context keys', () => {
    const ctx: TemplateContext = {
      ...baseContext,
      customKey: 'custom-value',
    }
    const result = renderTemplate('Custom: {{customKey}}', ctx)
    expect(result).toBe('Custom: custom-value')
  })

  it('stringifies non-string leaf values', () => {
    const ctx: TemplateContext = {
      ...baseContext,
      payload: { count: 7, active: true, ratio: 3.14 },
    }
    const result = renderTemplate(
      '{{payload.count}} {{payload.active}} {{payload.ratio}}',
      ctx,
    )
    expect(result).toBe('7 true 3.14')
  })

  it('returns empty string for null or undefined in path', () => {
    const ctx: TemplateContext = {
      ...baseContext,
      payload: { value: null as unknown as string },
    }
    const result = renderTemplate(
      '{{payload.value}} and {{payload.missing.deep}}',
      ctx,
    )
    expect(result).toBe(' and ')
  })
})

describe('extractVariables', () => {
  it('returns all variable paths in order of appearance', () => {
    const template =
      '{{trigger.name}} {{payload.title}} {{timestamp}} {{trigger.name}}'
    const vars = extractVariables(template)
    expect(vars).toEqual(['trigger.name', 'payload.title', 'timestamp'])
  })

  it('returns empty array when template has no variables', () => {
    const vars = extractVariables('Plain text with no placeholders.')
    expect(vars).toEqual([])
  })
})

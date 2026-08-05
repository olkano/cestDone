// tests/email-markdown.test.ts
import { describe, it, expect } from 'vitest'
import { renderEmailHtml } from '../src/email/markdown.js'

describe('renderEmailHtml', () => {
  it('renders markdown structure to HTML', () => {
    const html = renderEmailHtml('## Resumen\n\nHola **mundo**')
    expect(html).toContain('<h2')
    expect(html).toContain('Resumen')
    expect(html).toContain('<strong>mundo</strong>')
  })

  it('renders GFM tables', () => {
    const html = renderEmailHtml('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(html).toContain('<table')
    expect(html).toContain('<td')
  })

  it('preserves single line breaks so plain-text bodies stay multi-line', () => {
    const html = renderEmailHtml('linea uno\nlinea dos')
    expect(html).toContain('<br')
  })

  it('wraps the content in a complete styled document', () => {
    const html = renderEmailHtml('hola')
    expect(html.toLowerCase()).toContain('<!doctype html>')
    expect(html).toContain('<style>')
    expect(html).toContain('hola')
  })

  it('keeps links clickable', () => {
    const html = renderEmailHtml('[Responder](https://ventas.troho.net/?re=HS-001)')
    expect(html).toContain('href="https://ventas.troho.net/?re=HS-001"')
  })
})

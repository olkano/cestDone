// src/email/markdown.ts
import { Marked } from 'marked'

// breaks:true keeps single newlines as <br>, so plain-text bodies written by
// specs render faithfully while real Markdown (headings, tables, links) gets structure.
const marked = new Marked({ gfm: true, breaks: true })

const STYLE = `
  body { margin:0; padding:0; background:#f4f5f7; }
  .wrap { max-width:720px; margin:0 auto; padding:24px 12px; }
  .card { background:#ffffff; border-radius:8px; padding:28px 32px; font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:15px; line-height:1.55; color:#24292f; }
  h1,h2,h3,h4 { line-height:1.25; margin:1.2em 0 0.5em; }
  h1 { font-size:22px; } h2 { font-size:18px; border-bottom:1px solid #e5e7eb; padding-bottom:4px; } h3 { font-size:16px; }
  p { margin:0.6em 0; }
  a { color:#0b66c3; }
  table { border-collapse:collapse; width:100%; margin:12px 0; font-size:14px; }
  th,td { border:1px solid #d0d7de; padding:6px 10px; text-align:left; vertical-align:top; }
  th { background:#f6f8fa; }
  code { background:#f6f8fa; padding:1px 5px; border-radius:4px; font-size:13px; }
  pre { background:#f6f8fa; padding:12px; border-radius:6px; overflow-x:auto; }
  pre code { background:none; padding:0; }
  blockquote { margin:0.8em 0; padding:2px 12px; border-left:3px solid #d0d7de; color:#57606a; }
  ul,ol { margin:0.6em 0; padding-left:22px; }
  hr { border:none; border-top:1px solid #e5e7eb; margin:16px 0; }
`

/** Renders a Markdown (or plain text) email body into a self-contained styled HTML document. */
export function renderEmailHtml(markdown: string): string {
  const content = marked.parse(markdown) as string
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><style>' + STYLE + '</style></head>',
    '<body><div class="wrap"><div class="card">',
    content,
    '</div></div></body></html>',
  ].join('\n')
}

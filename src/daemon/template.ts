// src/daemon/template.ts

export interface TemplateContext {
  trigger: { name: string; type: string }
  payload: Record<string, unknown>
  timestamp: string // ISO 8601
  [key: string]: unknown
}

const VARIABLE_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g

/**
 * Traverse an object by dot-notation path.
 * Returns undefined if any segment along the path is null/undefined/non-object.
 */
function resolve(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.')
  let current: unknown = obj
  for (const segment of segments) {
    if (current == null || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * Replace all `{{path.to.value}}` placeholders in `template` with values from `context`.
 *
 * - Dot-notation path traversal into the context object
 * - Whitespace inside braces is tolerated: `{{ payload.title }}`
 * - Unresolved variables become empty string `''`
 * - Non-string leaf values are coerced via `String(value)`
 * - null / undefined at any point in the path → empty string
 */
export function renderTemplate(
  template: string,
  context: TemplateContext,
): string {
  return template.replace(VARIABLE_PATTERN, (_match, path: string) => {
    const value = resolve(context as Record<string, unknown>, path)
    if (value == null) return ''
    return typeof value === 'string' ? value : String(value)
  })
}

/**
 * Return the unique list of variable paths referenced in `template`.
 * Order matches first occurrence.
 */
export function extractVariables(template: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  let match: RegExpExecArray | null
  const re = new RegExp(VARIABLE_PATTERN.source, VARIABLE_PATTERN.flags)
  while ((match = re.exec(template)) !== null) {
    const path = match[1]
    if (!seen.has(path)) {
      seen.add(path)
      result.push(path)
    }
  }
  return result
}

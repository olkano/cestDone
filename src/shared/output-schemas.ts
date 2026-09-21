import { Ajv } from 'ajv'

export const DIRECTOR_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['analyze', 'ask_human', 'approve', 'fix', 'continue', 'done', 'escalate'] },
    message: { type: 'string' },
    questions: { type: ['array', 'null'], items: { type: 'string' } },
  },
  required: ['action', 'message', 'questions'],
} as const

export const WORKER_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['success', 'partial', 'failed'] },
    summary: { type: 'string' },
    filesChanged: { type: ['array', 'null'], items: { type: 'string' } },
    testsRun: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object', additionalProperties: false,
          properties: {
            passed: { type: 'integer', minimum: 0 },
            failed: { type: 'integer', minimum: 0 },
            skipped: { type: 'integer', minimum: 0 },
          },
          required: ['passed', 'failed', 'skipped'],
        },
      ],
    },
    issues: { type: ['array', 'null'], items: { type: 'string' } },
  },
  required: ['status', 'summary', 'filesChanged', 'testsRun', 'issues'],
} as const

const ajv = new Ajv({ allErrors: true, strict: false })
const validateDirector = ajv.compile(DIRECTOR_RESPONSE_SCHEMA)
const validateWorker = ajv.compile(WORKER_REPORT_SCHEMA)

export function normalizeDirectorWire(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return { questions: null, ...(value as Record<string, unknown>) }
}

export function normalizeWorkerWire(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return { filesChanged: null, testsRun: null, issues: null, ...(value as Record<string, unknown>) }
}

export function isDirectorWire(value: unknown): boolean { return validateDirector(value) }
export function isWorkerWire(value: unknown): boolean { return validateWorker(value) }

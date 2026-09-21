// src/daemon/job-queue.ts
import crypto from 'node:crypto'
import type { InvocationType } from '../shared/types.js'
import type { PreparedRun } from '../cli/index.js'

export interface Job {
  id: string
  trigger: string // name of the trigger/schedule that created this
  sourceType: Exclude<InvocationType, 'direct'>
  application?: string
  specPath: string
  options: Record<string, unknown>
  preparedRun?: PreparedRun
  templateContext?: unknown
  status: 'queued' | 'running' | 'completed' | 'failed'
  createdAt: Date
  startedAt?: Date
  completedAt?: Date
  error?: string
  maxRetries: number     // max retry attempts (0 = no retry)
  retryDelayMs: number   // delay between retries in ms
  attempt: number        // current attempt (1-based)
  coalescing?: {
    key: string
    eligible: boolean
    maxMessages: number
    originalPayload: Record<string, unknown>
  }
  batchMemberIds?: string[]
}

export type JobEnqueueInput = Omit<Job, 'id' | 'status' | 'createdAt' | 'attempt'> & { attempt?: number }

export interface JobQueue {
  enqueue(job: JobEnqueueInput): Job
  dequeue(): Job | undefined
  peek(): Job | undefined
  getRunning(): Job | undefined
  getAll(): readonly Job[]
  markRunning(id: string): void
  markCompleted(id: string): void
  markFailed(id: string, error: string): void
  clear(): void
  readonly length: number
}

export function createJobQueue(): JobQueue {
  const jobs: Job[] = []

  function findJobOrThrow(id: string): Job {
    const job = jobs.find((j) => j.id === id)
    if (!job) {
      throw new Error(`Job not found: ${id}`)
    }
    return job
  }

  function enqueue(partial: JobEnqueueInput): Job {
    const job: Job = {
      ...partial,
      id: crypto.randomUUID(),
      status: 'queued',
      createdAt: new Date(),
      maxRetries: partial.maxRetries ?? 0,
      retryDelayMs: partial.retryDelayMs ?? 60_000,
      attempt: partial.attempt ?? 1,
    }
    jobs.push(job)
    return job
  }

  function dequeue(): Job | undefined {
    const first = jobs.find((j) => j.status === 'queued')
    if (!first?.coalescing?.eligible || first.batchMemberIds) return first

    const queued = jobs.filter((job) => job.status === 'queued')
    const members = [first]
    for (const job of queued.slice(1)) {
      if (members.length >= first.coalescing.maxMessages) break
      if (job.coalescing?.eligible !== true || job.coalescing.key !== first.coalescing.key) break
      members.push(job)
    }
    if (members.length < 2) return first

    first.batchMemberIds = members.slice(1).map((job) => job.id)
    const context = first.templateContext as { payload?: Record<string, unknown> } | undefined
    if (context?.payload) {
      const messages = members.map((job) => job.coalescing!.originalPayload)
      context.payload.messages = messages
      context.payload.messagesJson = JSON.stringify(messages)
    }
    return first
  }

  function peek(): Job | undefined {
    return jobs.find((j) => j.status === 'queued')
  }

  function getRunning(): Job | undefined {
    return jobs.find((j) => j.status === 'running')
  }

  function getAll(): readonly Job[] {
    return jobs
  }

  function markRunning(id: string): void {
    const job = findJobOrThrow(id)
    const members = [job, ...(job.batchMemberIds ?? []).map(findJobOrThrow)]
    const now = new Date()
    for (const member of members) {
      member.status = 'running'
      member.startedAt = now
    }
  }

  function markCompleted(id: string): void {
    const job = findJobOrThrow(id)
    const members = [job, ...(job.batchMemberIds ?? []).map(findJobOrThrow)]
    const now = new Date()
    for (const member of members) {
      member.status = 'completed'
      member.completedAt = now
    }
  }

  function markFailed(id: string, error: string): void {
    const job = findJobOrThrow(id)
    const members = [job, ...(job.batchMemberIds ?? []).map(findJobOrThrow)]
    const now = new Date()
    for (const member of members) {
      member.status = 'failed'
      member.completedAt = now
      member.error = error
    }
  }

  function clear(): void {
    jobs.length = 0
  }

  return {
    enqueue,
    dequeue,
    peek,
    getRunning,
    getAll,
    markRunning,
    markCompleted,
    markFailed,
    clear,
    get length() {
      return jobs.length
    },
  }
}

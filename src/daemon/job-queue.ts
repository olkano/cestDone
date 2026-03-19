// src/daemon/job-queue.ts
import crypto from 'node:crypto'

export interface Job {
  id: string
  trigger: string // name of the trigger/schedule that created this
  specPath: string
  options: Record<string, unknown>
  templateContext?: unknown
  status: 'queued' | 'running' | 'completed' | 'failed'
  createdAt: Date
  startedAt?: Date
  completedAt?: Date
  error?: string
}

export interface JobQueue {
  enqueue(job: Omit<Job, 'id' | 'status' | 'createdAt'>): Job
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

  function enqueue(partial: Omit<Job, 'id' | 'status' | 'createdAt'>): Job {
    const job: Job = {
      ...partial,
      id: crypto.randomUUID(),
      status: 'queued',
      createdAt: new Date(),
    }
    jobs.push(job)
    return job
  }

  function dequeue(): Job | undefined {
    return jobs.find((j) => j.status === 'queued')
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
    job.status = 'running'
    job.startedAt = new Date()
  }

  function markCompleted(id: string): void {
    const job = findJobOrThrow(id)
    job.status = 'completed'
    job.completedAt = new Date()
  }

  function markFailed(id: string, error: string): void {
    const job = findJobOrThrow(id)
    job.status = 'failed'
    job.completedAt = new Date()
    job.error = error
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

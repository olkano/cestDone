// tests/job-queue.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createJobQueue, type JobQueue } from '../src/daemon/job-queue.js'

function makeJobInput(overrides: Record<string, unknown> = {}) {
  return {
    trigger: 'manual',
    specPath: '/specs/feature.md',
    options: {},
    ...overrides,
  }
}

describe('createJobQueue', () => {
  let queue: JobQueue

  beforeEach(() => {
    queue = createJobQueue()
  })

  it('enqueue adds a job with queued status and generated id', () => {
    const job = queue.enqueue(makeJobInput())

    expect(job.id).toBeDefined()
    expect(typeof job.id).toBe('string')
    expect(job.id.length).toBeGreaterThan(0)
    expect(job.status).toBe('queued')
    expect(job.createdAt).toBeInstanceOf(Date)
    expect(job.trigger).toBe('manual')
    expect(job.specPath).toBe('/specs/feature.md')
  })

  it('dequeue returns jobs in FIFO order', () => {
    queue.enqueue(makeJobInput({ specPath: '/specs/first.md' }))
    queue.enqueue(makeJobInput({ specPath: '/specs/second.md' }))

    const first = queue.dequeue()
    expect(first?.specPath).toBe('/specs/first.md')
  })

  it('dequeue returns undefined when queue is empty', () => {
    expect(queue.dequeue()).toBeUndefined()
  })

  it('peek returns next job without removing it', () => {
    queue.enqueue(makeJobInput({ specPath: '/specs/peek.md' }))

    const peeked = queue.peek()
    expect(peeked?.specPath).toBe('/specs/peek.md')

    // Peeking again returns the same job
    const peekedAgain = queue.peek()
    expect(peekedAgain?.id).toBe(peeked?.id)
  })

  it('markRunning updates status and sets startedAt', () => {
    const job = queue.enqueue(makeJobInput())
    queue.markRunning(job.id)

    const all = queue.getAll()
    const updated = all.find((j) => j.id === job.id)
    expect(updated?.status).toBe('running')
    expect(updated?.startedAt).toBeInstanceOf(Date)
  })

  it('markCompleted updates status and sets completedAt', () => {
    const job = queue.enqueue(makeJobInput())
    queue.markRunning(job.id)
    queue.markCompleted(job.id)

    const all = queue.getAll()
    const updated = all.find((j) => j.id === job.id)
    expect(updated?.status).toBe('completed')
    expect(updated?.completedAt).toBeInstanceOf(Date)
  })

  it('markFailed updates status, sets completedAt, and stores error', () => {
    const job = queue.enqueue(makeJobInput())
    queue.markRunning(job.id)
    queue.markFailed(job.id, 'Something went wrong')

    const all = queue.getAll()
    const updated = all.find((j) => j.id === job.id)
    expect(updated?.status).toBe('failed')
    expect(updated?.completedAt).toBeInstanceOf(Date)
    expect(updated?.error).toBe('Something went wrong')
  })

  it('getRunning returns the currently running job', () => {
    const job = queue.enqueue(makeJobInput())
    queue.markRunning(job.id)

    const running = queue.getRunning()
    expect(running?.id).toBe(job.id)
    expect(running?.status).toBe('running')
  })

  it('getRunning returns undefined when nothing is running', () => {
    queue.enqueue(makeJobInput())
    expect(queue.getRunning()).toBeUndefined()
  })

  it('getAll returns all jobs in order', () => {
    queue.enqueue(makeJobInput({ specPath: '/specs/a.md' }))
    queue.enqueue(makeJobInput({ specPath: '/specs/b.md' }))
    queue.enqueue(makeJobInput({ specPath: '/specs/c.md' }))

    const all = queue.getAll()
    expect(all).toHaveLength(3)
    expect(all[0].specPath).toBe('/specs/a.md')
    expect(all[1].specPath).toBe('/specs/b.md')
    expect(all[2].specPath).toBe('/specs/c.md')
  })

  it('clear removes all jobs', () => {
    queue.enqueue(makeJobInput())
    queue.enqueue(makeJobInput())
    expect(queue.length).toBe(2)

    queue.clear()
    expect(queue.length).toBe(0)
    expect(queue.getAll()).toHaveLength(0)
  })

  it('length reflects current queue size', () => {
    expect(queue.length).toBe(0)

    queue.enqueue(makeJobInput())
    expect(queue.length).toBe(1)

    queue.enqueue(makeJobInput())
    expect(queue.length).toBe(2)
  })

  it('multiple enqueues maintain FIFO order through dequeue', () => {
    const jobs = ['first', 'second', 'third'].map((name) =>
      queue.enqueue(makeJobInput({ trigger: name }))
    )

    // Mark first as running so dequeue skips it
    queue.markRunning(jobs[0].id)

    const next = queue.dequeue()
    expect(next?.trigger).toBe('second')
  })

  it('markRunning throws if job ID not found', () => {
    expect(() => queue.markRunning('nonexistent-id')).toThrow('Job not found: nonexistent-id')
  })

  it('dequeue skips jobs that are not in queued status', () => {
    const job1 = queue.enqueue(makeJobInput({ trigger: 'a' }))
    queue.enqueue(makeJobInput({ trigger: 'b' }))

    queue.markRunning(job1.id)

    const next = queue.dequeue()
    expect(next?.trigger).toBe('b')
  })
})

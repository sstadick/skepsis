/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import type { AgentRuntime } from './agentRuntime.ts'
import type { Hunk } from './hunks.ts'
import type { ScoringSummary } from '../shared/types.ts'
import {
  SCORE_MAX_CONCURRENCY,
  SCORE_MAX_HUNK_BYTES,
  SCORE_REQUEST_TIMEOUT_MS,
} from '../shared/scoring.ts'

type PublishReason = 'score-queued' | 'scored'

interface ScoreJob extends Hunk {
  state: 'queued' | 'running' | 'failed'
  error?: string
  controller?: AbortController
  timeout?: ReturnType<typeof setTimeout>
}

interface EnqueueResult {
  queued: number
  changed: boolean
}

interface ScoreStoreOptions {
  runtime: Pick<AgentRuntime, 'score'>
  loadCached: () => Promise<Set<string>>
  currentHunks: () => Promise<Hunk[]>
  save: (entries: { hash: string; score: number }[]) => Promise<void>
  publish: (reason: PublishReason) => void
  mutate: <T>(fn: () => T | Promise<T>) => Promise<T>
  concurrency?: number
  timeoutMs?: number
}

function formatRuntimeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'Scoring failed.'
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function abortedError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortedError(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(abortedError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function timeoutError(): string {
  return 'Scoring timed out. Retry to try again.'
}

function oversizedError(): string {
  return 'Hunk exceeds classifier context budget; review it manually.'
}

/** In-flight only; finished scores live in the versioned, on-disk cache. */
export class ScoreStore {
  private readonly jobs = new Map<string, ScoreJob>()
  private readonly runtime: Pick<AgentRuntime, 'score'>
  private readonly loadCached: () => Promise<Set<string>>
  private readonly currentHunks: () => Promise<Hunk[]>
  private readonly save: (entries: { hash: string; score: number }[]) => Promise<void>
  private readonly publish: (reason: PublishReason) => void
  private readonly mutate: <T>(fn: () => T | Promise<T>) => Promise<T>
  private readonly concurrency: number
  private readonly timeoutMs: number
  // Hold slots until the transport actually settles, including across retries.
  // Releasing on logical cancellation would exceed four real concurrent calls.
  // classifierTransport.test.ts verifies the native H2O adapter honors abort.
  private readonly activeCalls = new Set<Promise<number>>()
  private readonly inFlight = new Set<Promise<void>>()
  private closed = false
  private pumping = false

  constructor(opts: ScoreStoreOptions) {
    this.runtime = opts.runtime
    this.loadCached = opts.loadCached
    this.currentHunks = opts.currentHunks
    this.save = opts.save
    this.publish = opts.publish
    this.mutate = opts.mutate
    this.concurrency = opts.concurrency ?? SCORE_MAX_CONCURRENCY
    this.timeoutMs = opts.timeoutMs ?? SCORE_REQUEST_TIMEOUT_MS
  }

  /** Remove work whose source no longer appears in the current diff. */
  private pruneLocked(hunks: Hunk[], cached: Set<string>): boolean {
    const hashes = new Set(hunks.map((h) => h.hash))
    let changed = false
    for (const [hash, job] of this.jobs) {
      if (hashes.has(hash) && !cached.has(hash)) continue
      this.abortJob(job)
      this.jobs.delete(hash)
      changed = true
    }
    return changed
  }

  private enqueueLocked(hunks: Hunk[], cached: Set<string>): EnqueueResult {
    let queued = 0
    let changed = false
    for (const hunk of hunks) {
      if (cached.has(hunk.hash)) continue
      const existing = this.jobs.get(hunk.hash)
      if (existing?.state === 'queued' || existing?.state === 'running') continue
      const tooLarge = Buffer.byteLength(hunk.text) > SCORE_MAX_HUNK_BYTES
      const job: ScoreJob = {
        ...hunk,
        state: tooLarge ? 'failed' : 'queued',
        error: tooLarge ? oversizedError() : undefined,
      }
      this.jobs.set(hunk.hash, job)
      changed = true
      if (!tooLarge) queued++
    }
    return { queued, changed }
  }

  async snapshot(hunks: Hunk[]): Promise<ScoringSummary> {
    let changed = false
    const summary = await this.mutate(async () => {
      const cached = await this.loadCached()
      changed = this.pruneLocked(hunks, cached)
      return this.summaryLocked()
    })
    if (changed) this.publish('scored')
    return summary
  }

  async trigger(hunks?: Hunk[]): Promise<{ queued: number; pending: number }> {
    let queued = 0
    let pending = 0
    let changed = false
    await this.mutate(async () => {
      const current = await this.currentHunks()
      const cached = await this.loadCached()
      changed = this.pruneLocked(current, cached)
      const enqueue = this.enqueueLocked(hunks ?? current, cached)
      queued = enqueue.queued
      changed = enqueue.changed || changed
      pending = this.pendingLocked()
    })
    if (changed || queued > 0) this.publish('score-queued')
    this.pump()
    return { queued, pending }
  }

  async cancel(): Promise<void> {
    let changed = false
    await this.mutate(() => {
      changed = this.jobs.size > 0
      for (const job of this.jobs.values()) this.abortJob(job)
      this.jobs.clear()
    })
    if (changed) this.publish('scored')
  }

  async close(): Promise<void> {
    this.closed = true
    await this.cancel()
    await Promise.allSettled(this.inFlight)
  }

  summary(): ScoringSummary {
    return this.summaryLocked()
  }

  pending(): number {
    return this.pendingLocked()
  }

  private summaryLocked(): ScoringSummary {
    const summary: ScoringSummary = { queued: 0, claimed: 0, failed: 0 }
    for (const job of this.jobs.values()) {
      summary[job.state === 'running' ? 'claimed' : job.state]++
      if (job.error) summary.error = job.error
    }
    return summary
  }

  private pendingLocked(): number {
    const summary = this.summaryLocked()
    return summary.queued + summary.claimed
  }

  private pump(): void {
    if (this.closed || this.pumping) return
    this.pumping = true
    try {
      while (this.activeCalls.size < this.concurrency) {
        const next = [...this.jobs.values()].find((job) => job.state === 'queued')
        if (!next) break
        this.start(next)
      }
    } finally {
      this.pumping = false
    }
  }

  private start(job: ScoreJob): void {
    if (job.state !== 'queued') return
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort(new Error('timeout'))
    }, this.timeoutMs)
    timeout.unref?.()
    const provider = Promise.resolve().then(() =>
      this.runtime.score({ file: job.file, text: job.text }, controller.signal),
    )
    job.state = 'running'
    job.controller = controller
    job.timeout = timeout
    this.activeCalls.add(provider)
    this.publish('scored')
    provider.then(
      () => {
        this.activeCalls.delete(provider)
        this.pump()
      },
      () => {
        this.activeCalls.delete(provider)
        this.pump()
      },
    )
    const task = this.run(job, provider, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timeout)
        job.controller = undefined
        job.timeout = undefined
        this.inFlight.delete(task)
      })
    this.inFlight.add(task)
  }

  private abortJob(job: ScoreJob): void {
    job.controller?.abort()
    if (job.timeout) clearTimeout(job.timeout)
    job.controller = undefined
    job.timeout = undefined
  }

  private async run(
    job: ScoreJob,
    provider: Promise<number>,
    signal: AbortSignal,
  ): Promise<void> {
    let score: number
    try {
      score = await raceWithSignal(provider, signal)
    } catch (error) {
      const current = this.jobs.get(job.hash)
      if (current !== job) return
      if (signal.aborted || isAbortLike(error)) {
        await this.failIfCurrent(job, timeoutError())
        return
      }
      await this.failIfCurrent(job, formatRuntimeError(error))
      return
    }

    if (signal.aborted) {
      await this.failIfCurrent(job, timeoutError())
      return
    }

    if (!Number.isFinite(score) || score < 0 || score > 1) {
      await this.failIfCurrent(job, 'Invalid score returned by scoring runtime.')
      return
    }

    let changed = false
    try {
      await this.mutate(async () => {
        const hunks = await this.currentHunks()
        const cached = await this.loadCached()
        changed = this.pruneLocked(hunks, cached) || changed
        const current = this.jobs.get(job.hash)
        if (current !== job || current.state !== 'running') return
        if (signal.aborted) {
          changed = this.markFailedIfCurrentLocked(job, timeoutError()) || changed
          return
        }
        await this.save([{ hash: job.hash, score }])
        if (this.jobs.get(job.hash) === job) {
          this.jobs.delete(job.hash)
          changed = true
        }
      })
    } catch (error) {
      await this.failIfCurrent(job, formatRuntimeError(error))
      return
    }

    if (changed) this.publish('scored')
  }

  private markFailedIfCurrentLocked(job: ScoreJob, error: string): boolean {
    const current = this.jobs.get(job.hash)
    if (current !== job || current.state !== 'running') return false
    current.state = 'failed'
    current.error = error
    return true
  }

  private async failIfCurrent(job: ScoreJob, error: string): Promise<void> {
    let changed = false
    await this.mutate(() => {
      changed = this.markFailedIfCurrentLocked(job, error)
    })
    if (changed) this.publish('scored')
  }
}

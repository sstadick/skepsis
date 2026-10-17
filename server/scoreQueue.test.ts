/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScoreStore } from './scoreQueue.ts'
import type { Hunk } from './hunks.ts'
import { SCORE_MAX_HUNK_BYTES } from '../shared/scoring.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  // Polling is deliberate here: each check depends on prior async state changes.
  // oxlint-disable-next-line no-await-in-loop
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    // oxlint-disable-next-line no-await-in-loop
    await flush()
  }
  throw new Error(message)
}

function createMutate() {
  let tail: Promise<void> = Promise.resolve()
  return <T>(fn: () => T | Promise<T>): Promise<T> => {
    const result = tail.then(fn)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function hunk(hash: string, overrides: Partial<Hunk> = {}): Hunk {
  return {
    file: `${hash}.ts`,
    newStart: 1,
    newCount: 1,
    oldStart: 1,
    oldCount: 1,
    hash,
    text: `@@ -1 +1 @@ ${hash}\n-export const value = '${hash}'\n+export const value = '${hash}!'`,
    ...overrides,
  }
}

describe('ScoreStore', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts multiple jobs in parallel, caps concurrency at 4, and publishes incremental completion progress', async () => {
    const hunks = ['a', 'b', 'c', 'd', 'e', 'f'].map((hash) => hunk(hash))
    const cached = new Set<string>()
    const current = hunks
    const saves: string[] = []
    const started: string[] = []
    const publishSnapshots: ReturnType<ScoreStore['summary']>[] = []
    const active = new Set<string>()
    const deferreds = new Map<string, ReturnType<typeof deferred<number>>>()
    let maxActive = 0
    const store = new ScoreStore({
      runtime: {
        score: ({ file }) => {
          const hash = file.replace(/\.ts$/, '')
          const pending = deferred<number>()
          deferreds.set(hash, pending)
          started.push(hash)
          active.add(hash)
          maxActive = Math.max(maxActive, active.size)
          return pending.promise.finally(() => {
            active.delete(hash)
          })
        },
      },
      loadCached: async () => new Set(cached),
      currentHunks: async () => current,
      save: async (entries) => {
        for (const entry of entries) {
          saves.push(entry.hash)
          cached.add(entry.hash)
        }
      },
      publish: () => {
        publishSnapshots.push(store.summary())
      },
      mutate: createMutate(),
    })

    const trigger = await store.trigger(hunks)
    expect(trigger).toEqual({ queued: 6, pending: 6 })
    expect(started.length).toBeGreaterThan(1)
    expect(started).toHaveLength(4)
    expect(maxActive).toBe(4)
    expect(store.summary()).toEqual({ queued: 2, claimed: 4, failed: 0 })

    deferreds.get('b')!.resolve(0.2)
    await waitFor(() => saves.length === 1, 'first score did not persist')
    expect(saves).toEqual(['b'])
    expect(store.summary()).toEqual({ queued: 1, claimed: 4, failed: 0 })

    deferreds.get('a')!.resolve(0.1)
    await waitFor(() => saves.length === 2, 'second score did not persist')
    expect(saves).toEqual(['b', 'a'])
    expect(maxActive).toBe(4)
    expect(started).toHaveLength(6)
    expect(store.summary()).toEqual({ queued: 0, claimed: 4, failed: 0 })

    deferreds.get('f')!.resolve(0.6)
    deferreds.get('e')!.resolve(0.5)
    deferreds.get('d')!.resolve(0.4)
    deferreds.get('c')!.resolve(0.3)
    await waitFor(() => store.pending() === 0, 'store never drained')

    expect(saves).toEqual(['b', 'a', 'f', 'e', 'd', 'c'])
    expect(store.summary()).toEqual({ queued: 0, claimed: 0, failed: 0 })
    expect(
      publishSnapshots.some(
        (snapshot) =>
          snapshot.queued === 1 && snapshot.claimed === 4 && snapshot.failed === 0,
      ),
    ).toBe(true)
    expect(
      publishSnapshots.some(
        (snapshot) =>
          snapshot.queued === 0 && snapshot.claimed === 4 && snapshot.failed === 0,
      ),
    ).toBe(true)
  })

  it('aborts queued and in-flight work on cancel and ignores stale completions after retry', async () => {
    const hunks = [hunk('a'), hunk('b')]
    const cached = new Set<string>()
    const saves: string[] = []
    const attempts = new Map<string, number>()
    const stale = new Map<string, ReturnType<typeof deferred<number>>>()
    const retry = new Map<string, ReturnType<typeof deferred<number>>>()
    const aborted: string[] = []
    let round = 1

    const store = new ScoreStore({
      runtime: {
        score: ({ file }, signal) => {
          const hash = file.replace(/\.ts$/, '')
          attempts.set(hash, (attempts.get(hash) ?? 0) + 1)
          if (round === 1) {
            const pending = deferred<number>()
            stale.set(hash, pending)
            signal.addEventListener(
              'abort',
              () => {
                aborted.push(hash)
              },
              { once: true },
            )
            return pending.promise
          }
          const pending = deferred<number>()
          retry.set(hash, pending)
          return pending.promise
        },
      },
      loadCached: async () => new Set(cached),
      currentHunks: async () => hunks,
      save: async (entries) => {
        for (const entry of entries) {
          saves.push(`${entry.hash}:${entry.score}`)
          cached.add(entry.hash)
        }
      },
      publish: () => {},
      mutate: createMutate(),
    })

    await store.trigger(hunks)
    await store.cancel()
    expect(aborted.toSorted()).toEqual(['a', 'b'])
    expect(store.summary()).toEqual({ queued: 0, claimed: 0, failed: 0 })

    round = 2
    const retryTrigger = await store.trigger(hunks)
    expect(retryTrigger).toEqual({ queued: 2, pending: 2 })
    expect(attempts).toEqual(
      new Map([
        ['a', 2],
        ['b', 2],
      ]),
    )

    stale.get('a')!.resolve(0.1)
    stale.get('b')!.resolve(0.2)
    await flush()
    expect(saves).toEqual([])
    expect(store.summary()).toEqual({ queued: 0, claimed: 2, failed: 0 })

    retry.get('b')!.resolve(0.8)
    retry.get('a')!.resolve(0.7)
    await waitFor(() => store.pending() === 0, 'retry never completed')

    expect(saves).toEqual(['b:0.8', 'a:0.7'])
    expect(store.summary()).toEqual({ queued: 0, claimed: 0, failed: 0 })
  })

  it('keeps successful scores, retries only failures, and skips cached hunks on later triggers', async () => {
    const hunks = [hunk('a'), hunk('b'), hunk('c')]
    const cached = new Set<string>()
    const attempts = new Map<string, number>()
    const saves: string[] = []
    const bRetry = deferred<number>()

    const store = new ScoreStore({
      runtime: {
        score: async ({ file }) => {
          const hash = file.replace(/\.ts$/, '')
          attempts.set(hash, (attempts.get(hash) ?? 0) + 1)
          if (hash === 'a') return 0.1
          if (hash === 'c') return 0.9
          if ((attempts.get(hash) ?? 0) === 1) throw new Error('classifier offline')
          return bRetry.promise
        },
      },
      loadCached: async () => new Set(cached),
      currentHunks: async () => hunks,
      save: async (entries) => {
        for (const entry of entries) {
          saves.push(`${entry.hash}:${entry.score}`)
          cached.add(entry.hash)
        }
      },
      publish: () => {},
      mutate: createMutate(),
    })

    await store.trigger(hunks)
    await waitFor(
      () => saves.length === 2 && store.summary().failed === 1,
      'initial pass did not finish with one failure',
    )
    expect(saves).toEqual(['a:0.1', 'c:0.9'])
    expect(store.summary()).toEqual({
      queued: 0,
      claimed: 0,
      failed: 1,
      error: 'classifier offline',
    })
    expect(attempts).toEqual(
      new Map([
        ['a', 1],
        ['b', 1],
        ['c', 1],
      ]),
    )

    const retryTrigger = await store.trigger(hunks)
    expect(retryTrigger).toEqual({ queued: 1, pending: 1 })
    expect(attempts).toEqual(
      new Map([
        ['a', 1],
        ['b', 2],
        ['c', 1],
      ]),
    )

    bRetry.resolve(0.5)
    await waitFor(() => store.pending() === 0, 'retry did not finish')
    expect(saves).toEqual(['a:0.1', 'c:0.9', 'b:0.5'])
    expect(store.summary()).toEqual({ queued: 0, claimed: 0, failed: 0 })

    const cachedTrigger = await store.trigger(hunks)
    expect(cachedTrigger).toEqual({ queued: 0, pending: 0 })
    expect(attempts).toEqual(
      new Map([
        ['a', 1],
        ['b', 2],
        ['c', 1],
      ]),
    )
  })

  it('prunes changed-source jobs, aborts them, and ignores late stale results', async () => {
    const original = hunk('old', { file: 'src/app.ts' })
    const replacement = hunk('new', {
      file: 'src/app.ts',
      text: '@@ -1 +1 @@\n-export const value = 1\n+export const value = 2',
    })
    const cached = new Set<string>()
    let current = [original]
    let phase: 'old' | 'new' = 'old'
    let oldAborted = false
    const pendingOld = deferred<number>()
    const pendingNew = deferred<number>()
    const saves: string[] = []

    const store = new ScoreStore({
      runtime: {
        score: (_input, signal) => {
          if (phase === 'old') {
            signal.addEventListener(
              'abort',
              () => {
                oldAborted = true
              },
              { once: true },
            )
            return pendingOld.promise
          }
          return pendingNew.promise
        },
      },
      loadCached: async () => new Set(cached),
      currentHunks: async () => current,
      save: async (entries) => {
        for (const entry of entries) {
          saves.push(entry.hash)
          cached.add(entry.hash)
        }
      },
      publish: () => {},
      mutate: createMutate(),
    })

    await store.trigger(current)
    current = [replacement]
    expect(await store.snapshot(current)).toEqual({ queued: 0, claimed: 0, failed: 0 })
    expect(oldAborted).toBe(true)

    pendingOld.resolve(0.4)
    await flush()
    expect(saves).toEqual([])

    phase = 'new'
    await store.trigger(current)
    pendingNew.resolve(0.9)
    await waitFor(() => store.pending() === 0, 'replacement hunk did not finish')
    expect(saves).toEqual(['new'])
    expect(store.summary()).toEqual({ queued: 0, claimed: 0, failed: 0 })
  })

  it('fails oversized hunks immediately instead of truncating them', async () => {
    const store = new ScoreStore({
      runtime: {
        score: async () => 0.5,
      },
      loadCached: async () => new Set(),
      currentHunks: async () => [],
      save: async () => {},
      publish: () => {},
      mutate: createMutate(),
    })

    const result = await store.trigger([
      hunk('large', { text: 'x'.repeat(SCORE_MAX_HUNK_BYTES + 1) }),
    ])
    expect(result).toEqual({ queued: 0, pending: 0 })
    expect(store.summary()).toEqual({
      queued: 0,
      claimed: 0,
      failed: 1,
      error: 'Hunk exceeds classifier context budget; review it manually.',
    })
  })

  it('fails timed-out runtime requests without leaving running jobs behind', async () => {
    vi.useFakeTimers()
    const store = new ScoreStore({
      runtime: {
        score: (_input, signal) =>
          new Promise<number>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                reject(abortError())
              },
              { once: true },
            )
          }),
      },
      loadCached: async () => new Set(),
      currentHunks: async () => [hunk('a')],
      save: async () => {},
      publish: () => {},
      mutate: createMutate(),
      timeoutMs: 50,
    })

    await store.trigger([hunk('a')])
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.summary()).toEqual({
      queued: 0,
      claimed: 0,
      failed: 1,
      error: 'Scoring timed out. Retry to try again.',
    })
  })
})

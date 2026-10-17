/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { SCORE_MAX_HUNK_BYTES, SCORE_REQUEST_TIMEOUT_MS } from '../shared/scoring.ts'
import { isolateVcsConfig } from './testUtil.ts'

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

async function waitFor(
  check: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  // Polling is deliberate here: each check depends on prior async state changes.
  // oxlint-disable-next-line no-await-in-loop
  for (let attempt = 0; attempt < 200; attempt++) {
    // oxlint-disable-next-line no-await-in-loop
    if (await check()) return
    // oxlint-disable-next-line no-await-in-loop
    await flush()
  }
  throw new Error(message)
}

function makeMutate() {
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

function multiFilePatch(ids: string[]): string {
  return ids
    .map(
      (id, index) => `diff --git a/${id}.ts b/${id}.ts
index 1111111..2222222 100644
--- a/${id}.ts
+++ b/${id}.ts
@@ -1 +1 @@
-export const value = ${index}
+export const value = ${index + 1}`,
    )
    .join('\n')
}

function singleFilePatch(value: number): string {
  return `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1 +1 @@
-export const value = ${value}
+export const value = ${value + 1}`
}

function oversizedPatch(id: string): string {
  const payload = 'x'.repeat(SCORE_MAX_HUNK_BYTES + 64)
  return `diff --git a/${id}.ts b/${id}.ts
index 1111111..2222222 100644
--- a/${id}.ts
+++ b/${id}.ts
@@ -1 +1 @@
-${payload}
+${payload}!`
}

const home = await isolateVcsConfig()
const { registerScoreRoutes } = await import('./scoreRoutes.ts')
const { parseHunks } = await import('./hunks.ts')
const { loadFileScores } = await import('./scores.ts')

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

interface DiffLikeResponse {
  patch: string
  scores: Record<string, Array<{ score: number }>>
  scoring: {
    queued: number
    claimed: number
    failed: number
    error?: string
  }
}

function pushDeferred(
  deferreds: Map<string, Array<ReturnType<typeof deferred<number>>>>,
  key: string,
): ReturnType<typeof deferred<number>> {
  const pending = deferred<number>()
  const existing = deferreds.get(key)
  if (existing) existing.push(pending)
  else deferreds.set(key, [pending])
  return pending
}

async function createHarness(
  runtime: {
    score: (hunk: { file: string; text: string }, signal: AbortSignal) => Promise<number>
  },
  opts: {
    patch?: string
    patchProvider?: () => string | Promise<string>
  } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), 'skepsis-embedded-scoring-'))
  const app = new Hono()
  const events: Array<{ reason: 'score-queued' | 'scored'; pending: number }> = []
  const mutate = makeMutate()
  let patch = opts.patch ?? multiFilePatch(['a'])
  let patchProvider = opts.patchProvider
  const getPatch = async () => (patchProvider ? patchProvider() : patch)
  const scoring = registerScoreRoutes(app, {
    cwd,
    runtime,
    patch: getPatch,
    publish: (reason, pending) => {
      events.push({ reason, pending })
    },
    mutate,
  })

  app.get('/api/diff', async (c) => {
    const currentPatch = await getPatch()
    const hunks = parseHunks(currentPatch)
    const scores = await loadFileScores(cwd, hunks)
    return c.json({
      patch: currentPatch,
      scores,
      scoring: await scoring.snapshot(hunks),
    } satisfies DiffLikeResponse)
  })

  async function request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
  ): Promise<Response> {
    return app.request('http://skepsis.test' + path, { method })
  }

  return {
    cwd,
    events,
    setPatch(next: string) {
      patch = next
      patchProvider = undefined
    },
    setPatchProvider(next: () => string | Promise<string>) {
      patchProvider = next
    },
    async getDiff(): Promise<DiffLikeResponse> {
      const res = await request('GET', '/api/diff')
      expect(res.status).toBe(200)
      return res.json()
    },
    request,
    async close(): Promise<void> {
      await scoring.close()
      await rm(cwd, { recursive: true, force: true })
    },
  }
}

describe('embedded scoring routes', () => {
  it('exposes only public trigger/cancel routes and no worker claim protocol', async () => {
    const runtime = {
      score: async () => 0.5,
    }
    const harness = await createHarness(runtime)
    try {
      harness.setPatch(multiFilePatch(['a', 'b']))
      const before = await harness.getDiff()
      expect(before.scoring).toEqual({ queued: 0, claimed: 0, failed: 0 })

      const trigger = await harness.request('POST', '/api/score')
      expect(trigger.status).toBe(200)
      expect(await trigger.json()).toEqual({ queued: 2, pending: 2 })

      expect((await harness.request('POST', '/api/score/claim')).status).toBe(404)
      expect((await harness.request('POST', '/api/score/submit')).status).toBe(404)
      expect((await harness.request('POST', '/api/score/fail')).status).toBe(404)

      const cancel = await harness.request('DELETE', '/api/score')
      expect(cancel.status).toBe(200)
      expect(await cancel.json()).toEqual({ ok: true })
    } finally {
      await harness.close()
    }
  })

  it('starts several scoring calls in parallel, backfills freed slots, and never exceeds four active model calls', async () => {
    const deferreds = new Map<string, Array<ReturnType<typeof deferred<number>>>>()
    const started: string[] = []
    let active = 0
    let maxActive = 0
    const runtime = {
      score: ({ file }: { file: string; text: string }) => {
        const id = file.replace(/\.ts$/, '')
        started.push(id)
        active++
        maxActive = Math.max(maxActive, active)
        return pushDeferred(deferreds, id).promise.finally(() => {
          active--
        })
      },
    }
    const harness = await createHarness(runtime)
    try {
      harness.setPatch(multiFilePatch(['a', 'b', 'c', 'd', 'e', 'f']))
      const trigger = await harness.request('POST', '/api/score')
      expect(trigger.status).toBe(200)
      expect(await trigger.json()).toEqual({ queued: 6, pending: 6 })

      await waitFor(() => started.length === 4, 'initial scoring did not fill all slots')
      expect(maxActive).toBeGreaterThanOrEqual(2)
      expect(maxActive).toBeLessThanOrEqual(4)

      deferreds.get('a')![0]!.resolve(0.1)
      await waitFor(() => started.length === 5, 'freed scoring slot was not backfilled')
      expect(maxActive).toBe(4)
      expect((await harness.getDiff()).scoring).toEqual({
        queued: 1,
        claimed: 4,
        failed: 0,
      })
      expect((await harness.getDiff()).scores['a.ts']).toMatchObject([{ score: 0.1 }])

      deferreds.get('b')![0]!.resolve(0.2)
      deferreds.get('c')![0]!.resolve(0.3)
      deferreds.get('d')![0]!.resolve(0.4)
      deferreds.get('e')![0]!.resolve(0.5)
      await waitFor(() => started.length === 6, 'final queued hunk never started')
      deferreds.get('f')![0]!.resolve(0.6)
      await waitFor(
        async () => (await harness.getDiff()).scoring.claimed === 0,
        'scoring never drained',
      )

      expect((await harness.getDiff()).scoring).toEqual({
        queued: 0,
        claimed: 0,
        failed: 0,
      })
      expect(maxActive).toBe(4)
    } finally {
      await harness.close()
    }
  })

  it('streams unordered incremental progress, preserves successful scores across failures, retries failed hunks, and skips cached hunks', async () => {
    const attempts = new Map<string, number>()
    const deferreds = new Map<string, Array<ReturnType<typeof deferred<number>>>>()
    const runtime = {
      score: ({ file }: { file: string; text: string }) => {
        const id = file.replace(/\.ts$/, '')
        attempts.set(id, (attempts.get(id) ?? 0) + 1)
        return pushDeferred(deferreds, id).promise
      },
    }
    const harness = await createHarness(runtime)
    try {
      harness.setPatch(multiFilePatch(['a', 'b', 'c']))
      const trigger = await harness.request('POST', '/api/score')
      expect(trigger.status).toBe(200)
      expect(await trigger.json()).toEqual({ queued: 3, pending: 3 })

      deferreds.get('c')![0]!.resolve(0.9)
      await waitFor(async () => {
        const diff = await harness.getDiff()
        return diff.scores['c.ts']?.[0]?.score === 0.9 && diff.scoring.claimed === 2
      }, 'first completion never appeared in diff')

      deferreds.get('b')![0]!.reject(new Error('classifier offline'))
      await waitFor(
        async () => (await harness.getDiff()).scoring.failed === 1,
        'failure never surfaced',
      )

      deferreds.get('a')![0]!.resolve(0.1)
      await waitFor(async () => {
        const diff = await harness.getDiff()
        return diff.scores['a.ts']?.[0]?.score === 0.1 && diff.scoring.failed === 1
      }, 'successful scores were not preserved after a sibling failure')

      const afterFirstPass = await harness.getDiff()
      expect(afterFirstPass.scores).toMatchObject({
        'a.ts': [{ score: 0.1 }],
        'c.ts': [{ score: 0.9 }],
      })
      expect(afterFirstPass.scores['b.ts']).toBeUndefined()
      expect(afterFirstPass.scoring).toEqual({
        queued: 0,
        claimed: 0,
        failed: 1,
        error: 'classifier offline',
      })
      expect(
        harness.events
          .filter((event) => event.reason === 'scored')
          .map((event) => event.pending),
      ).toContain(2)
      expect(
        harness.events
          .filter((event) => event.reason === 'scored')
          .map((event) => event.pending),
      ).toContain(1)
      expect(
        harness.events
          .filter((event) => event.reason === 'scored')
          .map((event) => event.pending),
      ).toContain(0)

      const retry = await harness.request('POST', '/api/score')
      expect(retry.status).toBe(200)
      expect(await retry.json()).toEqual({ queued: 1, pending: 1 })
      expect(attempts).toEqual(
        new Map([
          ['a', 1],
          ['b', 2],
          ['c', 1],
        ]),
      )

      deferreds.get('b')![1]!.resolve(0.5)
      await waitFor(async () => {
        const diff = await harness.getDiff()
        return diff.scores['b.ts']?.[0]?.score === 0.5 && diff.scoring.failed === 0
      }, 'retry score never appeared')

      const cachedTrigger = await harness.request('POST', '/api/score')
      expect(cachedTrigger.status).toBe(200)
      expect(await cachedTrigger.json()).toEqual({ queued: 0, pending: 0 })
      expect(attempts).toEqual(
        new Map([
          ['a', 1],
          ['b', 2],
          ['c', 1],
        ]),
      )
    } finally {
      await harness.close()
    }
  })

  it('publishes oversized-only failures so other browsers refresh failed scoring state', async () => {
    let calls = 0
    const runtime = {
      score: async () => {
        calls++
        return 0.5
      },
    }
    const harness = await createHarness(runtime)
    try {
      harness.setPatch(oversizedPatch('large'))
      const trigger = await harness.request('POST', '/api/score')
      expect(trigger.status).toBe(200)
      expect(await trigger.json()).toEqual({ queued: 0, pending: 0 })
      expect(calls).toBe(0)
      expect(harness.events).toContainEqual({ reason: 'score-queued', pending: 0 })
      expect((await harness.getDiff()).scoring).toEqual({
        queued: 0,
        claimed: 0,
        failed: 1,
        error: 'Hunk exceeds classifier context budget; review it manually.',
      })
    } finally {
      await harness.close()
    }
  })

  it('times out hung model calls, ignores their late results, and keeps total concurrent calls capped across cancel and immediate retry', async () => {
    vi.useFakeTimers()
    const deferreds = new Map<string, Array<ReturnType<typeof deferred<number>>>>()
    const started: string[] = []
    const active = new Set<string>()
    let callId = 0
    let maxActive = 0
    const runtime = {
      score: ({ file }: { file: string; text: string }, _signal: AbortSignal) => {
        const key = `${file}#${callId++}`
        started.push(key)
        active.add(key)
        maxActive = Math.max(maxActive, active.size)
        return pushDeferred(deferreds, file).promise.finally(() => {
          active.delete(key)
        })
      },
    }
    const harness = await createHarness(runtime)
    try {
      harness.setPatch(multiFilePatch(['a', 'b', 'c', 'd']))
      const trigger = await harness.request('POST', '/api/score')
      expect(trigger.status).toBe(200)
      expect(await trigger.json()).toEqual({ queued: 4, pending: 4 })
      expect(started).toHaveLength(4)
      expect(maxActive).toBe(4)

      await vi.advanceTimersByTimeAsync(SCORE_REQUEST_TIMEOUT_MS)
      await vi.advanceTimersByTimeAsync(0)
      expect((await harness.getDiff()).scoring).toEqual({
        queued: 0,
        claimed: 0,
        failed: 4,
        error: 'Scoring timed out. Retry to try again.',
      })

      const cancel = await harness.request('DELETE', '/api/score')
      expect(cancel.status).toBe(200)
      expect(await cancel.json()).toEqual({ ok: true })
      expect((await harness.getDiff()).scoring).toEqual({
        queued: 0,
        claimed: 0,
        failed: 0,
      })

      const retry = await harness.request('POST', '/api/score')
      expect(retry.status).toBe(200)
      expect(await retry.json()).toEqual({ queued: 4, pending: 4 })
      expect(started).toHaveLength(4)
      expect(maxActive).toBe(4)

      deferreds.get('a.ts')![0]!.resolve(0.11)
      deferreds.get('b.ts')![0]!.resolve(0.22)
      deferreds.get('c.ts')![0]!.resolve(0.33)
      deferreds.get('d.ts')![0]!.resolve(0.44)
      await vi.advanceTimersByTimeAsync(0)

      expect(started).toHaveLength(8)
      expect(maxActive).toBe(4)
      expect(Object.keys((await harness.getDiff()).scores)).toEqual([])

      deferreds.get('a.ts')![1]!.resolve(0.61)
      deferreds.get('b.ts')![1]!.resolve(0.72)
      deferreds.get('c.ts')![1]!.resolve(0.83)
      deferreds.get('d.ts')![1]!.resolve(0.94)

      let diff: DiffLikeResponse | undefined
      // Polling is deliberate here: fake timers must drive the timeout race and
      // filesystem writes before the saved scores become observable.
      // oxlint-disable-next-line no-await-in-loop
      for (let attempt = 0; attempt < 20; attempt++) {
        // oxlint-disable-next-line no-await-in-loop
        await vi.advanceTimersByTimeAsync(0)
        // oxlint-disable-next-line no-await-in-loop
        diff = await harness.getDiff()
        if (Object.keys(diff.scores).length === 4) break
      }

      expect(Object.keys(diff!.scores).toSorted()).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
      expect(diff!.scores).toMatchObject({
        'a.ts': [{ score: 0.61 }],
        'b.ts': [{ score: 0.72 }],
        'c.ts': [{ score: 0.83 }],
        'd.ts': [{ score: 0.94 }],
      })
      expect(diff!.scoring).toEqual({ queued: 0, claimed: 0, failed: 0 })
    } finally {
      await harness.close()
      vi.useRealTimers()
    }
  })

  it('closes promptly after aborting hung runtime calls that ignore abort', async () => {
    const runtime = {
      score: async () => new Promise<number>(() => undefined),
    }
    const harness = await createHarness(runtime)
    harness.setPatch(multiFilePatch(['a', 'b']))
    const trigger = await harness.request('POST', '/api/score')
    expect(trigger.status).toBe(200)
    expect(await trigger.json()).toEqual({ queued: 2, pending: 2 })

    await expect(
      Promise.race([
        harness.close().then(() => 'closed' as const),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
      ]),
    ).resolves.toBe('closed')
  })

  it('cancels in-flight work, aborts runtime signals, and ignores late stale completions after cancel and source changes', async () => {
    const deferreds = new Map<string, Array<ReturnType<typeof deferred<number>>>>()
    const aborted: string[] = []
    const runtime = {
      score: ({ file }: { file: string; text: string }, signal: AbortSignal) => {
        const id = file
        const pending = pushDeferred(deferreds, id)
        signal.addEventListener(
          'abort',
          () => {
            aborted.push(id)
          },
          { once: true },
        )
        return pending.promise
      },
    }
    const harness = await createHarness(runtime)
    try {
      harness.setPatch(multiFilePatch(['a', 'b']))
      const trigger = await harness.request('POST', '/api/score')
      expect(await trigger.json()).toEqual({ queued: 2, pending: 2 })

      const cancel = await harness.request('DELETE', '/api/score')
      expect(cancel.status).toBe(200)
      await waitFor(() => aborted.length === 2, 'cancel did not abort both runtime calls')
      expect((await harness.getDiff()).scoring).toEqual({
        queued: 0,
        claimed: 0,
        failed: 0,
      })

      deferreds.get('a.ts')![0]!.resolve(0.1)
      deferreds.get('b.ts')![0]!.resolve(0.2)
      await flush()
      const afterLateCancel = await harness.getDiff()
      expect(Object.keys(afterLateCancel.scores)).toEqual([])
      expect(afterLateCancel.scoring).toEqual({ queued: 0, claimed: 0, failed: 0 })

      harness.setPatch(singleFilePatch(5))
      const changedTrigger = await harness.request('POST', '/api/score')
      expect(await changedTrigger.json()).toEqual({ queued: 1, pending: 1 })

      harness.setPatch(singleFilePatch(6))
      const pruned = await harness.getDiff()
      expect(pruned.scoring).toEqual({ queued: 0, claimed: 0, failed: 0 })
      await waitFor(
        () => aborted.includes('src/app.ts'),
        'changed-source job was not aborted',
      )

      deferreds.get('src/app.ts')![0]!.resolve(0.9)
      await flush()
      const afterLatePrune = await harness.getDiff()
      expect(Object.keys(afterLatePrune.scores)).toEqual([])
      expect(afterLatePrune.scoring).toEqual({ queued: 0, claimed: 0, failed: 0 })
    } finally {
      await harness.close()
    }
  })
})

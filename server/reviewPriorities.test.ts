/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { randomUUID } from 'node:crypto'
import { parsePatchFiles } from '@pierre/diffs'
import { createModels } from '@earendil-works/pi-ai/models'
import type { ClassifierModel, ClassifierResult } from '@earendil-works/pi-ai'
import { afterEach, expect, it, vi } from 'vitest'
import { createReviewPriorities, type PriorityState } from './reviewPriorities.ts'

const model: ClassifierModel<'test-classifier'> = {
  type: 'classifier',
  api: 'test-classifier',
  id: 'test',
  name: 'Test',
  provider: 'test',
  baseUrl: 'http://127.0.0.1/never-called',
  input: ['text'],
  contextWindow: 32000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
const answer = (): ClassifierResult => ({
  api: model.api,
  provider: model.provider,
  model: model.id,
  timestamp: 0,
  stopReason: 'stop',
  answers: {
    priority: { type: 'score', score: 2.75, confidence: 0.8 },
    category: {
      type: 'choice',
      choice: 'correctness',
      confidence: 0.9,
      probabilities: {
        mechanical: 0,
        correctness: 1,
        security: 0,
        performance: 0,
        tests: 0,
        documentation: 0,
        other: 0,
      },
    },
  },
})
const patch = (count = 1) =>
  Array.from(
    { length: count },
    (_, n) => `diff --git a/file${n}.txt b/file${n}.txt
--- a/file${n}.txt
+++ b/file${n}.txt
@@ -1,2 +1,2 @@
 context
-before${n}
+after${n}
`,
  ).join('')
const state = (text = patch(), revision = 'revision-one'): PriorityState => ({
  revision,
  patch: text,
  files: parsePatchFiles(text).flatMap((item) => item.files),
})
const services: ReturnType<typeof createReviewPriorities>[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()))
  vi.restoreAllMocks()
})
function fixture(count = 1, concurrency = 4, available = true) {
  const models = createModels()
  const lookup = vi.spyOn(models, 'getModelOfType').mockReturnValue(model)
  const classify = vi.spyOn(models, 'classify').mockImplementation(async () => answer())
  const chat = vi.spyOn(models, 'complete')
  let source = state(patch(count))
  const current = vi.fn(async () => source)
  const publish = vi.fn()
  const service = createReviewPriorities({
    revision: source.revision,
    models,
    classifier: available ? { provider: model.provider, model: model.id } : undefined,
    classifierConcurrency: concurrency,
    current,
    publish,
  })
  services.push(service)
  const input = { id: randomUUID(), revision: source.revision }
  return {
    service,
    input,
    classify,
    chat,
    lookup,
    current,
    publish,
    setState(next: PriorityState) {
      source = next
    },
  }
}

it('uses only the selected classifier, scores exact original hunks and anchors changed lines', async () => {
  const f = fixture()
  const text = `diff --git a/old.txt b/new.txt
similarity index 80%
rename from old.txt
rename to new.txt
--- a/old.txt
+++ b/new.txt
@@ -3,3 +3,3 @@ function first
 context
-before
+after
 end
@@ -30,2 +30,1 @@
-delete only
 context
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
diff --git a/binary b/binary
Binary files a/binary and b/binary differ
diff --git a/moved b/renamed
similarity index 100%
rename from moved
rename to renamed
`
  f.setState(state(text))
  expect(f.service.snapshot()).toMatchObject({ status: 'idle', total: 0, available: true })
  expect(f.classify).not.toHaveBeenCalled()
  expect(f.current).not.toHaveBeenCalled()
  await f.service.start(f.input)
  await expect.poll(() => f.service.snapshot().status).toBe('complete')
  const result = f.service.snapshot()
  expect(result.total).toBe(3)
  expect(result.completed).toBe(3)
  expect(result.results.map((item) => item.anchor)).toEqual([
    { path: 'new.txt', side: 'RIGHT', line: 4, revision: f.input.revision },
    { path: 'new.txt', side: 'LEFT', line: 30, revision: f.input.revision },
    { path: 'gone.txt', side: 'LEFT', line: 1, revision: f.input.revision },
  ])
  expect(f.classify.mock.calls.map((call) => call[1].state)).toMatchObject([
    {
      path: 'new.txt',
      previousPath: 'old.txt',
      patch: ' context\n-before\n+after\n end\n',
    },
    { path: 'new.txt', patch: '-delete only\n context\n' },
    { path: 'gone.txt', patch: '-one\n-two\n' },
  ])
  expect(f.lookup).toHaveBeenCalledExactlyOnceWith('classifier', 'test', 'test')
  expect(f.chat).not.toHaveBeenCalled()
  for (const call of f.classify.mock.calls) {
    expect(call[0]).toBe(model)
    expect(call[1].questions.priority).toMatchObject({
      type: 'score',
      criteria: expect.any(Array),
    })
    expect(call[1].questions.category).toMatchObject({ type: 'choice' })
    expect(call[2]?.signal).toBeInstanceOf(AbortSignal)
  }
  const ids = result.results.map((item) => item.id)
  await f.service.start({ ...f.input, id: randomUUID() })
  await expect.poll(() => f.service.snapshot().status).toBe('complete')
  expect(f.service.snapshot().results.map((item) => item.id)).toEqual(ids)
  // Returned snapshots cannot mutate the service.
  result.results[0]!.score = 0
  expect(f.service.snapshot().results[0]!.score).toBe(2.75)
  expect(f.publish.mock.calls.length).toBeGreaterThan(3)
})

it('runs more than four calls in parallel, bounds the pool, and admits one idempotent batch', async () => {
  const f = fixture(13, 8)
  let active = 0
  let peak = 0
  const pending: (() => void)[] = []
  f.classify.mockImplementation(async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise<void>((resolve) => pending.push(resolve))
    active--
    return answer()
  })
  await f.service.start(f.input)
  expect(f.classify).toHaveBeenCalledTimes(8)
  expect(peak).toBe(8)
  expect((await f.service.start(f.input)).runId).toBe(f.input.id)
  await expect(f.service.start({ ...f.input, revision: 'changed' })).rejects.toMatchObject({
    status: 409,
  })
  await expect(f.service.start({ ...f.input, id: randomUUID() })).rejects.toMatchObject({
    status: 409,
  })
  pending.splice(0).forEach((release) => release())
  await expect.poll(() => f.classify.mock.calls.length).toBe(13)
  expect(f.service.snapshot().completed).toBe(8)
  pending.splice(0).forEach((release) => release())
  await expect.poll(() => f.service.snapshot().status).toBe('complete')
  expect(peak).toBe(8)
  expect(f.service.snapshot().completed).toBe(13)
  await f.service.start(f.input)
  expect(f.classify).toHaveBeenCalledTimes(13)
  const count = f.current.mock.calls.length
  f.service.snapshot()
  f.service.snapshot()
  expect(f.current).toHaveBeenCalledTimes(count)
})

it.each([0, 1, 64, 100])('clamps concurrency %i to 1..64', async (concurrency) => {
  const f = fixture(70, concurrency)
  const pending: (() => void)[] = []
  f.classify.mockImplementation(async () => {
    await new Promise<void>((resolve) => pending.push(resolve))
    return answer()
  })
  await f.service.start(f.input)
  expect(f.classify).toHaveBeenCalledTimes(Math.max(1, Math.min(64, concurrency)))
  f.service.cancel(f.input)
  pending.forEach((release) => release())
  await f.service.close()
})

it('keeps successful partial scores but never turns failures or invalid answers into zero', async () => {
  const f = fixture(9)
  const invalid = answer()
  invalid.answers.priority = { type: 'score', score: Number.NaN, confidence: 0.9 }
  const badConfidence = answer()
  badConfidence.answers.priority = { type: 'score', score: 0, confidence: Infinity }
  const badCategory = answer()
  badCategory.answers.category = {
    type: 'choice',
    choice: 'secret',
    confidence: 1,
    probabilities: { secret: 1 },
  }
  const badProbability = answer()
  badProbability.answers.category = {
    type: 'choice',
    choice: 'correctness',
    confidence: 1,
    probabilities: {},
  }
  f.classify
    .mockResolvedValueOnce(answer())
    .mockResolvedValueOnce({
      ...answer(),
      stopReason: 'error',
      errorMessage: 'https://secret@private',
    })
    .mockResolvedValueOnce({ ...answer(), stopReason: 'aborted' })
    .mockRejectedValueOnce(new Error('token=SECRET'))
    .mockResolvedValueOnce({ ...answer(), answers: {} })
    .mockResolvedValueOnce(invalid)
    .mockResolvedValueOnce(badConfidence)
    .mockResolvedValueOnce(badCategory)
    .mockResolvedValueOnce(badProbability)
  await f.service.start(f.input)
  await expect.poll(() => f.service.snapshot().status).toBe('failed')
  const snapshot = f.service.snapshot()
  expect(snapshot.completed).toBe(9)
  expect(snapshot.results[0]).toMatchObject({
    status: 'scored',
    score: 2.75,
    confidence: 0.8,
    category: 'correctness',
  })
  for (const result of snapshot.results.slice(1)) {
    expect(result.status).toBe('failed')
    expect(result.score).toBeUndefined()
    expect(result.confidence).toBeUndefined()
    expect(result.category).toBeUndefined()
  }
  expect(JSON.stringify(snapshot)).not.toMatch(/SECRET|secret@|token=|https:/)
  expect(f.chat).not.toHaveBeenCalled()
})

it('accepts a genuine zero without rounding continuous scores', async () => {
  const f = fixture()
  const zero = answer()
  zero.answers.priority = { type: 'score', score: 0, confidence: 0 }
  f.classify.mockResolvedValue(zero)
  await f.service.start(f.input)
  await expect.poll(() => f.service.snapshot().status).toBe('complete')
  expect(f.service.snapshot().results[0]).toMatchObject({
    status: 'scored',
    score: 0,
    confidence: 0,
  })
})

it('skips oversized hunks whole, rejects oversized batches before inference, and handles empty diffs', async () => {
  const f = fixture()
  f.setState(state(patch().replace('after0', 'x'.repeat(25000))))
  await f.service.start(f.input)
  await expect.poll(() => f.service.snapshot().status).toBe('complete')
  expect(f.service.snapshot()).toMatchObject({
    completed: 1,
    total: 1,
    results: [{ status: 'skipped', error: expect.stringContaining('24,000') }],
  })
  expect(f.service.snapshot().results[0]?.score).toBeUndefined()
  f.setState(state(patch(1001)))
  await f.service.start({ ...f.input, id: randomUUID() })
  await expect.poll(() => f.service.snapshot().status).toBe('failed')
  expect(f.service.snapshot().error).toContain('1,000')
  expect(f.service.snapshot().results).toEqual([])
  f.setState(state(''))
  await f.service.start({ ...f.input, id: randomUUID() })
  await expect.poll(() => f.service.snapshot().status).toBe('complete')
  expect(f.service.snapshot()).toMatchObject({ total: 0, completed: 0, results: [] })
  expect(f.classify).not.toHaveBeenCalled()
})

it('cancels only the matching run and joins transport before releasing admission or shutdown', async () => {
  const f = fixture(5, 1)
  let finish!: () => void
  f.classify.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return answer()
  })
  await f.service.start(f.input)
  expect(() => f.service.cancel({ ...f.input, id: randomUUID() })).toThrow(
    'no longer matches',
  )
  expect(() => f.service.cancel({ ...f.input, revision: 'different' })).toThrow(
    'no longer matches',
  )
  const signal = f.classify.mock.calls[0]![2]!.signal!
  expect(signal.aborted).toBe(false)
  expect(f.service.cancel(f.input).status).toBe('cancelled')
  expect(signal.aborted).toBe(true)
  await expect(f.service.start({ ...f.input, id: randomUUID() })).rejects.toMatchObject({
    status: 409,
  })
  finish()
  await expect
    .poll(async () => {
      try {
        return (await f.service.start({ ...f.input, id: randomUUID() })).status
      } catch {
        return 'busy'
      }
    })
    .toBe('running')
  expect(() => f.service.cancel(f.input)).toThrow('no longer matches')
  expect(f.service.snapshot().status).toBe('running')
  let closed = false
  const closing = f.service.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(closed).toBe(false)
  expect(f.classify.mock.calls.at(-1)![2]!.signal!.aborted).toBe(true)
  finish()
  await closing
  expect(f.service.snapshot().results.every((item) => item.score === undefined)).toBe(true)
  await expect(f.service.start(f.input)).rejects.toMatchObject({ status: 503 })
})

it('invalidates running and completed results, and checks the revision after completion', async () => {
  const f = fixture(2, 1)
  let finish!: () => void
  f.classify.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return answer()
  })
  await f.service.start(f.input)
  f.service.invalidate('revision-two')
  expect(f.classify.mock.calls[0]![2]!.signal!.aborted).toBe(true)
  finish()
  await f.service.close()
  expect(f.service.snapshot()).toMatchObject({
    status: 'stale',
    revision: f.input.revision,
  })
  expect(f.classify).toHaveBeenCalledTimes(1)
  expect(f.service.snapshot().results.every((item) => item.score === undefined)).toBe(true)

  const post = fixture()
  post.current
    .mockResolvedValueOnce(state())
    .mockResolvedValueOnce(state(patch(), 'revision-two'))
  await post.service.start(post.input)
  await expect.poll(() => post.service.snapshot().status).toBe('stale')
  expect(post.service.snapshot().revision).toBe(post.input.revision)
  expect(post.service.snapshot().results[0]?.anchor.revision).toBe(post.input.revision)

  const completed = fixture()
  await completed.service.start(completed.input)
  await expect.poll(() => completed.service.snapshot().status).toBe('complete')
  completed.service.invalidate('revision-two')
  expect(completed.service.snapshot().status).toBe('stale')
})

it('refuses a changed revision before inference and sanitizes preparation and final-check failures', async () => {
  const stale = fixture()
  stale.setState(state(patch(), 'revision-two'))
  await expect(stale.service.start(stale.input)).rejects.toMatchObject({ status: 409 })
  expect(stale.classify).not.toHaveBeenCalled()
  expect(stale.service.snapshot().status).toBe('stale')
  const broken = fixture()
  broken.current.mockRejectedValue(new Error('https://secret:token@private'))
  await broken.service.start(broken.input)
  await expect.poll(() => broken.service.snapshot().status).toBe('failed')
  expect(broken.classify).not.toHaveBeenCalled()
  expect(broken.service.snapshot().error).not.toContain('secret')
  const final = fixture()
  final.current.mockResolvedValueOnce(state()).mockRejectedValue(new Error('SECRET'))
  await final.service.start(final.input)
  await expect.poll(() => final.service.snapshot().status).toBe('failed')
  expect(final.service.snapshot().error).toContain('verify')
  expect(JSON.stringify(final.service.snapshot())).not.toContain('SECRET')
})

it('is disabled without explicit classifier configuration, regardless of chat availability', async () => {
  const f = fixture(1, 4, false)
  expect(f.service.snapshot()).toMatchObject({
    available: false,
    status: 'idle',
    unavailableReason: expect.stringContaining('--classifier-config'),
  })
  expect(f.lookup).not.toHaveBeenCalled()
  await expect(f.service.start(f.input)).rejects.toMatchObject({ status: 503 })
  expect(f.current).not.toHaveBeenCalled()
  expect(f.classify).not.toHaveBeenCalled()
  expect(f.chat).not.toHaveBeenCalled()
})

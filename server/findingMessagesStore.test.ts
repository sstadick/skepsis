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
import { afterEach, expect, it, vi } from 'vitest'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { formatFindingQuestion } from './agentReviewProtocol.ts'
import { openReviewStore, ReviewRequestConflict, type ReviewStore } from './reviewStore.ts'

const directories: string[] = []
const stores: ReviewStore[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})
const output = JSON.stringify({
  summary: 'Original review summary',
  findings: [
    { path: 'src/code.ts', side: 'RIGHT', line: 4, body: 'issue: original error' },
    { path: 'src/code.ts', side: 'RIGHT', line: 5, body: 'question: original behavior' },
  ],
})
async function fixture(tokensPerSecond = 100_000) {
  const directory = await mkdtemp(join(tmpdir(), 'skepsis-finding-followup-'))
  directories.push(directory)
  const faux = fauxProvider({
    provider: 'faux-finding',
    models: [{ id: 'pinned', reasoning: true }],
    tokensPerSecond,
    tokenSize: tokensPerSecond < 1000 ? { min: 1, max: 1 } : { min: 1024, max: 1024 },
  })
  const models = createModels()
  models.setProvider(faux.provider)
  const model = { provider: faux.getModel().provider, modelId: faux.getModel().id }
  const opts = {
    cwd: directory,
    directory,
    models,
    model,
    inferenceEnabled: true,
    currentRevision: 'rev-1',
    tools: [],
    maxRunMs: 10_000,
    onChange() {},
  }
  const input = {
    id: crypto.randomUUID(),
    prompt: 'Find the error handling regressions.',
    revision: 'rev-1',
    model,
    reasoningLevel: 'high' as const,
    context: 'ORIGINAL WHOLE DIFF: +src/code.ts line 4 and line 5',
    locations: [{ path: 'src/code.ts', side: 'RIGHT' as const, start: 4, count: 2 }],
  }
  const open = async (options: Parameters<typeof openReviewStore>[0] = opts) => {
    const store = await openReviewStore(options)
    stores.push(store)
    return store
  }
  faux.setResponses([fauxAssistantMessage(output)])
  const store = await open()
  await store.startAgentReview(input)
  await expect
    .poll(async () => (await store.snapshot()).agentReviews[0]?.status, {
      timeout: 12_000,
    })
    .toBe('answered')
  const run = (await store.snapshot()).agentReviews[0]!
  expect(run.findings).toHaveLength(2)
  return { faux, opts, input, run, store, open }
}
const message = (text: string) => ({ id: crypto.randomUUID(), text })
async function answered(store: ReviewStore, runId: string, turnId: string) {
  await expect
    .poll(
      async () =>
        (await store.snapshot()).agentReviews
          .find((run) => run.id === runId)
          ?.turns.find((turn) => turn.id === turnId)?.answer,
      { timeout: 12_000 },
    )
    .toBeTruthy()
}

it('discusses multiple findings in the original diff conversation as Markdown without changing findings', async () => {
  const { faux, input, run, store } = await fixture()
  const first = run.findings[0]!
  const second = run.findings[1]!
  const one = message('Why is this an error?')
  const two = message('Does this need fixing too?')
  faux.setResponses([
    (ctx, options, _state, model) => {
      expect(model.id).toBe('pinned')
      expect(options?.reasoning).toBe('high')
      const transcript = JSON.stringify(ctx.messages)
      expect(transcript).toContain(input.prompt)
      expect(transcript).toContain(input.context)
      expect(transcript).toContain('Original review summary')
      expect(transcript).toContain(first.body)
      expect(transcript).toContain(one.text)
      const latest = ctx.messages.findLast((item) => item.role === 'user')
      expect(JSON.stringify(latest?.content)).toContain(
        JSON.stringify(formatFindingQuestion(first, one.text)).slice(1, -1),
      )
      return fauxAssistantMessage(
        [
          { type: 'text', text: 'Tool narration must not become the answer' },
          fauxToolCall('codemode', { code: 'text("read-only result")' }),
        ],
        { stopReason: 'toolUse' },
      )
    },
    fauxAssistantMessage('**The original failure path** can lose the error.'),
    (ctx, options) => {
      expect(options?.reasoning).toBe('high')
      const transcript = JSON.stringify(ctx.messages)
      expect(transcript).toContain('The original failure path')
      expect(transcript).toContain(second.body)
      expect(transcript).toContain(two.text)
      expect(transcript).toContain(input.context)
      return fauxAssistantMessage('No, this second finding is **not** a bug.')
    },
  ])
  await store.askFinding(input.id, first.id, one)
  await answered(store, input.id, one.id)
  expect((await store.snapshot()).agentReviews[0]?.turns[1]).toEqual({
    id: one.id,
    findingId: first.id,
    question: one.text,
    answer: '**The original failure path** can lose the error.',
  })
  await store.askFinding(input.id, second.id, two)
  await answered(store, input.id, two.id)
  const snapshot = await store.snapshot()
  expect(snapshot.agentReviews[0]?.turns[2]).toMatchObject({
    id: two.id,
    findingId: second.id,
    answer: 'No, this second finding is **not** a bug.',
  })
  expect(snapshot.agentReviews[0]?.summary).toBe(run.summary)
  expect(JSON.stringify(snapshot.agentReviews[0]?.findings)).toBe(
    JSON.stringify(run.findings),
  )
  expect(snapshot.agentReviews[0]?.turns[0]).toEqual(run.turns[0])
  expect(snapshot.drafts).toEqual([])
  expect(snapshot.threads).toEqual([])
  expect(faux.state.callCount).toBe(4)
})

it('permits accepted and dismissed findings, preserving a human-edited draft', async () => {
  const { faux, input, run, store } = await fixture()
  const first = run.findings[0]!
  const second = run.findings[1]!
  await store.acceptFinding(input.id, first.id, input.revision)
  await store.saveDraft({ id: first.id, anchor: first.anchor, body: 'Human edited text' })
  await store.dismissFinding(input.id, second.id)
  const before = await store.snapshot()
  faux.setResponses([
    fauxAssistantMessage('You can disagree with the accepted suggestion.'),
    fauxAssistantMessage('The dismissed finding was probably wrong.'),
  ])
  const one = message('Please reconsider the accepted finding')
  await store.askFinding(input.id, first.id, one)
  await answered(store, input.id, one.id)
  const two = message('Please explain the dismissed finding')
  await store.askFinding(input.id, second.id, two)
  await answered(store, input.id, two.id)
  const after = await store.snapshot()
  expect(after.agentReviews[0]?.findings).toEqual(before.agentReviews[0]?.findings)
  expect(after.agentReviews[0]?.summary).toBe(before.agentReviews[0]?.summary)
  expect(after.drafts).toEqual(before.drafts)
  expect(after.drafts[0]?.body).toBe('Human edited text')
})

it('atomically admits one outstanding follow-up and makes exact concurrent retries idempotent', async () => {
  const { faux, input, run, store } = await fixture()
  const first = run.findings[0]!
  const second = run.findings[1]!
  let release!: (answer: ReturnType<typeof fauxAssistantMessage>) => void
  const delayed = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
    release = resolve
  })
  faux.setResponses([() => delayed])
  const one = message('Explain this again')
  await Promise.all([
    store.askFinding(input.id, first.id, one),
    store.askFinding(input.id, first.id, one),
    store.askFinding(input.id, first.id, one),
  ])
  await expect.poll(() => faux.state.callCount).toBe(2)
  const busy = (await store.snapshot()).agentReviews[0]!
  expect(busy.turns).toHaveLength(2)
  expect(busy.turns[1]).toMatchObject({
    id: one.id,
    findingId: first.id,
    question: one.text,
  })
  await expect(
    store.askFinding(input.id, first.id, { ...one, text: 'Different' }),
  ).rejects.toBeInstanceOf(ReviewRequestConflict)
  await expect(store.askFinding(input.id, second.id, one)).rejects.toBeInstanceOf(
    ReviewRequestConflict,
  )
  await expect(
    store.askFinding(input.id, second.id, message('While busy')),
  ).rejects.toBeInstanceOf(ReviewRequestConflict)
  const snapshots = await Promise.all(Array.from({ length: 20 }, () => store.snapshot()))
  expect(snapshots.every((state) => state.agentReviews[0]?.turns.length === 2)).toBe(true)
  release(fauxAssistantMessage('Final, private answer'))
  await answered(store, input.id, one.id)
  await store.askFinding(input.id, first.id, one)
  expect(faux.state.callCount).toBe(2)
  expect((await store.snapshot()).agentReviews[0]?.turns).toHaveLength(2)
  await Promise.all(
    [input.id, first.id].map((collision) =>
      expect(
        store.askFinding(input.id, second.id, { id: collision, text: 'Collision' }),
      ).rejects.toBeInstanceOf(ReviewRequestConflict),
    ),
  )
  faux.setResponses([fauxAssistantMessage('Separate line answer')])
  const lineId = crypto.randomUUID()
  await store.ask({
    id: lineId,
    anchor: { path: 'src/code.ts', side: 'RIGHT', line: 4, revision: input.revision },
    text: 'Line question',
    context: '',
  })
  await expect
    .poll(async () => (await store.snapshot()).threads[0]?.status)
    .toBe('answered')
  await expect(
    store.askFinding(input.id, second.id, { id: lineId, text: 'Collision' }),
  ).rejects.toBeInstanceOf(ReviewRequestConflict)
})

it('validates new finding messages before admitting any work', async () => {
  const { faux, input, run, store } = await fixture()
  const findingId = run.findings[0]!.id
  const valid = message('Question')
  await Promise.all(
    [
      { ...valid, text: '   ' },
      { ...valid, text: 'x'.repeat(20_001) },
      { ...valid, id: 'not-a-uuid' },
      { ...valid, unexpected: 'not part of the contract' },
    ].map((bad) => expect(store.askFinding(input.id, findingId, bad)).rejects.toThrow()),
  )
  expect((await store.snapshot()).agentReviews[0]?.turns).toHaveLength(1)
  expect(faux.state.callCount).toBe(1)
})

it('cancels a live follow-up without losing original review history, even after reload', async () => {
  const { faux, opts, input, run, store, open } = await fixture()
  const finding = run.findings[0]!
  const previous = message('First answer')
  faux.setResponses([fauxAssistantMessage('Previous private answer')])
  await store.askFinding(input.id, finding.id, previous)
  await answered(store, input.id, previous.id)
  let release!: (answer: ReturnType<typeof fauxAssistantMessage>) => void
  const late = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
    release = resolve
  })
  faux.setResponses([() => late])
  const cancelled = message('Second answer to cancel')
  await store.askFinding(input.id, finding.id, cancelled)
  await expect.poll(() => faux.state.callCount).toBe(3)
  const stopping = store.cancel(input.id)
  try {
    await expect
      .poll(async () => (await store.snapshot()).agentReviews[0]?.turns[2]?.error)
      .toBe('Cancelled')
  } finally {
    release(fauxAssistantMessage('LATE: never saved'))
    await stopping
  }
  await expect
    .poll(async () => (await store.snapshot()).agentReviews[0]?.turns[2]?.error)
    .toBe('Cancelled')
  await store.close()
  const reopened = await open({ ...opts, model: undefined, inferenceEnabled: true })
  const after = (await reopened.snapshot()).agentReviews[0]!
  expect(after.turns).toMatchObject([
    run.turns[0],
    { id: previous.id, answer: 'Previous private answer' },
    { id: cancelled.id, error: 'Cancelled' },
  ])
  expect(after.turns[2]?.answer).toBeUndefined()
  expect(after.findings).toEqual(run.findings)
  expect(after.summary).toBe(run.summary)
  expect((await reopened.snapshot()).drafts).toEqual([])
  faux.setResponses([fauxAssistantMessage('Third answer')])
  const third = message('Try again in the same conversation')
  await reopened.askFinding(input.id, finding.id, third)
  await answered(reopened, input.id, third.id)
  expect((await reopened.snapshot()).agentReviews[0]?.turns).toHaveLength(4)
}, 15_000)

it('resumes a persisted follow-up with its pinned model and reasoning, without a default', async () => {
  const { faux, opts, input, run, store, open } = await fixture(1000)
  const finding = run.findings[0]!
  faux.setResponses([
    fauxAssistantMessage('A slow answer that will be interrupted'.repeat(1000)),
  ])
  const pending = message('Can you expand on the first finding?')
  await store.askFinding(input.id, finding.id, pending)
  await expect.poll(() => faux.state.callCount).toBe(2)
  await store.close()
  faux.setResponses([
    (ctx, options, _state, model) => {
      expect(model.id).toBe('pinned')
      expect(options?.reasoning).toBe('high')
      expect(JSON.stringify(ctx.messages)).toContain(input.context)
      expect(JSON.stringify(ctx.messages)).toContain(pending.text)
      return fauxAssistantMessage('Pinned model answer after reload')
    },
  ])
  const reopened = await open({ ...opts, model: undefined, inferenceEnabled: true })
  await answered(reopened, input.id, pending.id)
  expect((await reopened.snapshot()).agentReviews[0]?.turns[1]?.answer).toBe(
    'Pinned model answer after reload',
  )
  expect((await reopened.snapshot()).agentReviews[0]?.findings).toEqual(run.findings)
  expect(faux.state.callCount).toBe(3)
}, 15_000)

it('resumes queued finding work behind a different review without a default', async () => {
  const { faux, opts, input, run, store, open } = await fixture(1000)
  faux.setResponses([fauxAssistantMessage('An interrupted review'.repeat(1000))])
  const other = { ...input, id: crypto.randomUUID(), prompt: 'Another review' }
  await store.startAgentReview(other)
  await expect.poll(() => faux.state.callCount).toBe(2)
  const pending = message('Queued whole-review follow-up')
  await store.askFinding(input.id, run.findings[0]!.id, pending)
  expect((await store.snapshot()).agentReviews[0]?.turns[1]).toMatchObject({
    id: pending.id,
    findingId: run.findings[0]!.id,
  })
  await store.close()
  faux.setResponses([
    fauxAssistantMessage(output),
    fauxAssistantMessage('The queued answer, from the pinned model'),
  ])
  const resumed = await open({ ...opts, model: undefined, inferenceEnabled: true })
  await answered(resumed, input.id, pending.id)
  expect((await resumed.snapshot()).agentReviews[0]?.turns[1]?.answer).toBe(
    'The queued answer, from the pinned model',
  )
  expect((await resumed.snapshot()).agentReviews[1]?.status).toBe('answered')
  expect(faux.state.callCount).toBe(4)
}, 15_000)

it('cancels stale follow-up output on revision change without replacing earlier findings', async () => {
  const { faux, input, run, store } = await fixture()
  let release!: (answer: ReturnType<typeof fauxAssistantMessage>) => void
  const late = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
    release = resolve
  })
  faux.setResponses([() => late])
  const pending = message('Is this still a bug?')
  await store.askFinding(input.id, run.findings[0]!.id, pending)
  await expect.poll(() => faux.state.callCount).toBe(2)
  const updating = store.updateRevision('rev-2')
  try {
    await expect
      .poll(async () => (await store.snapshot()).agentReviews[0]?.turns[1]?.error)
      .toBe('Review revision changed; start a new review')
  } finally {
    release(fauxAssistantMessage('LATE: ignored'))
    await updating
  }
  const snapshot = await store.snapshot()
  expect(snapshot.agentReviews[0]?.turns[1]?.answer).toBeUndefined()
  expect(snapshot.agentReviews[0]?.turns[0]).toEqual(run.turns[0])
  expect(snapshot.agentReviews[0]?.findings).toEqual(run.findings)
  expect(snapshot.agentReviews[0]?.summary).toBe(run.summary)
  expect(snapshot.drafts).toEqual([])
  await store.askFinding(input.id, run.findings[0]!.id, pending) // Exact retry, no work.
  expect(faux.state.callCount).toBe(2)
}, 15_000)

it('rejects new requests when disabled, stale, unauthenticated, or the pinned model/level is unavailable; retries still work', async () => {
  const { faux, opts, input, run, store, open } = await fixture()
  const finding = run.findings[0]!
  const accepted = message('Admitted before changes')
  faux.setResponses([fauxAssistantMessage('Answer kept')])
  await store.askFinding(input.id, finding.id, accepted)
  await answered(store, input.id, accepted.id)
  await expect(
    store.askFinding(input.id, crypto.randomUUID(), message('Wrong target')),
  ).rejects.toThrow('Unknown agent review finding')
  await expect(
    store.askFinding(crypto.randomUUID(), finding.id, message('Wrong run')),
  ).rejects.toThrow('Unknown agent review')
  const getAvailable = vi.spyOn(opts.models, 'getAvailable').mockResolvedValue([])
  await store.askFinding(input.id, finding.id, accepted)
  expect(getAvailable).not.toHaveBeenCalled()
  await expect(store.askFinding(input.id, finding.id, message('No auth'))).rejects.toThrow(
    'authentication',
  )
  getAvailable.mockRestore()
  const model = faux.getModel()
  opts.models.setProvider({
    ...faux.provider,
    getModels: () => [{ ...model, thinkingLevelMap: { high: null } }],
  })
  await expect(
    store.askFinding(input.id, finding.id, message('Unsupported level')),
  ).rejects.toThrow('reasoning level is unavailable')
  opts.models.setProvider({ ...faux.provider, getModels: () => [] })
  await expect(
    store.askFinding(input.id, finding.id, message('Unavailable model')),
  ).rejects.toThrow('reasoning level is unavailable')
  opts.models.setProvider(faux.provider)
  await store.updateRevision('rev-2')
  await expect(store.askFinding(input.id, finding.id, message('Stale'))).rejects.toThrow(
    'revision changed',
  )
  await store.askFinding(input.id, finding.id, accepted)
  await store.close()
  const paused = await open({ ...opts, currentRevision: 'rev-2', inferenceEnabled: false })
  await paused.askFinding(input.id, finding.id, accepted)
  await expect(
    paused.askFinding(input.id, finding.id, message('Disabled')),
  ).rejects.toThrow('Configure a review model')
  await expect(
    paused.askFinding(input.id, finding.id, { id: accepted.id, text: 'Different' }),
  ).rejects.toBeInstanceOf(ReviewRequestConflict)
  expect((await paused.snapshot()).agentReviews[0]?.turns).toHaveLength(2)
  expect(faux.state.callCount).toBe(2)
})

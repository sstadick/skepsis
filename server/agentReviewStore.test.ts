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
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { openReviewStore, ReviewRequestConflict, type ReviewStore } from './reviewStore.ts'
import { formatAgentReviewInput } from './agentReviewProtocol.ts'

const directories: string[] = []
const stores: ReviewStore[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  )
})
const locations = [
  { path: 'source.ts', side: 'RIGHT' as const, start: 4, count: 2 },
  { path: 'source.ts', side: 'LEFT' as const, start: 7, count: 1 },
]
const output = (findings: unknown[] = []) =>
  JSON.stringify({ summary: 'Summary', findings })
const finding = (body = 'issue: handle the error') => ({
  path: 'source.ts',
  side: 'RIGHT',
  line: 4,
  body,
})
async function fixture(tokensPerSecond = 100000) {
  const directory = await mkdtemp(join(tmpdir(), 'skepsis-whole-review-'))
  directories.push(directory)
  const faux = fauxProvider({
    provider: 'faux-original',
    models: [{ id: 'chosen', reasoning: true }],
    tokensPerSecond,
    tokenSize: tokensPerSecond < 1000 ? { min: 1, max: 1 } : { min: 1024, max: 1024 },
  })
  const models = createModels()
  models.setProvider(faux.provider)
  const model = { provider: faux.getModel().provider, modelId: faux.getModel().id }
  const opts = {
    directory,
    cwd: directory,
    models,
    model,
    currentRevision: 'rev-1',
    tools: [],
    onChange() {},
    maxRunMs: 10000,
  }
  const input = {
    id: crypto.randomUUID(),
    prompt: 'Find correctness bugs, especially in error handling.',
    revision: 'rev-1',
    model,
    reasoningLevel: 'high' as const,
    context: 'UNTRUSTED REPOSITORY DIFF: + line 4',
    locations,
  }
  const open = async (options: Parameters<typeof openReviewStore>[0] = opts) => {
    const store = await openReviewStore(options)
    stores.push(store)
    return store
  }
  return { faux, opts, input, open }
}
async function settled(store: ReviewStore, id: string, status = 'answered') {
  await expect
    .poll(
      async () =>
        (await store.snapshot()).agentReviews.find((run) => run.id === id)?.status,
      { timeout: 12000 },
    )
    .toBe(status)
}

it('pins the chosen model/level, persists only validated findings, and accepts exactly one editable draft', async () => {
  const { faux, input, open } = await fixture()
  faux.setResponses([
    (ctx, options, _state, model) => {
      expect(model.id).toBe('chosen')
      expect(options?.reasoning).toBe('high')
      const message = ctx.messages.findLast((item) => item.role === 'user')
      expect(JSON.stringify(message?.content)).toContain(
        JSON.stringify(formatAgentReviewInput(input)).slice(1, -1),
      )
      return fauxAssistantMessage([
        fauxThinking('not part of the JSON output'),
        {
          type: 'text',
          text: output([
            finding(),
            finding(),
            { ...finding(), side: 'LEFT', line: 7, body: 'question: why delete this?' },
          ]),
        },
      ])
    },
  ])
  const store = await open()
  await Promise.all([store.startAgentReview(input), store.startAgentReview(input)])
  await settled(store, input.id)
  const snapshot = await store.snapshot()
  expect(snapshot.threads).toEqual([])
  expect(snapshot.drafts).toEqual([])
  expect(snapshot.agentReviews[0]).toMatchObject({
    revision: input.revision,
    model: input.model,
    reasoningLevel: input.reasoningLevel,
    summary: 'Summary',
    status: 'answered',
  })
  expect(snapshot.agentReviews[0]?.findings).toHaveLength(2) // exact duplicates collapse
  expect(snapshot.agentReviews[0]?.turns[0]?.answer).toBe('Summary')
  expect(faux.state.callCount).toBe(1)
  const first = snapshot.agentReviews[0]!.findings[0]!
  const second = snapshot.agentReviews[0]!.findings[1]!
  await expect(store.acceptFinding(input.id, first.id, 'old')).rejects.toThrow('revision')
  expect((await store.snapshot()).drafts).toEqual([])
  const accepting = Promise.all([
    store.acceptFinding(input.id, first.id, input.revision),
    store.acceptFinding(input.id, first.id, input.revision),
  ])
  // Concurrent API reads must wait for the atomic finding + draft decision,
  // not expose a draft alongside a still-pending finding mid-commit.
  const snapshots = await Promise.all(Array.from({ length: 20 }, () => store.snapshot()))
  await accepting
  for (const state of snapshots) {
    expect(state.agentReviews[0]?.findings[0]?.status).toBe(
      state.drafts.length ? 'accepted' : 'pending',
    )
    expect(state.drafts.length).toBeLessThanOrEqual(1)
  }
  expect((await store.snapshot()).drafts).toEqual([
    { id: first.id, anchor: first.anchor, body: first.body },
  ])
  await store.saveDraft({ id: first.id, anchor: first.anchor, body: 'Human edit' })
  await store.acceptFinding(input.id, first.id, input.revision)
  expect((await store.snapshot()).drafts[0]?.body).toBe('Human edit')
  await store.dismissFinding(input.id, second.id)
  await store.dismissFinding(input.id, second.id)
  await expect(store.acceptFinding(input.id, second.id, input.revision)).rejects.toThrow(
    'dismissed',
  )
  await expect(store.dismissFinding(input.id, first.id)).rejects.toThrow('accepted')
  await store.close()
  const reopened = await open()
  expect(
    (await reopened.snapshot()).agentReviews[0]?.findings.map((item) => item.status),
  ).toEqual(['accepted', 'dismissed'])
  expect((await reopened.snapshot()).drafts[0]?.body).toBe('Human edit')
  await reopened.deleteDraft(first.id)
  await reopened.acceptFinding(input.id, first.id, input.revision)
  expect((await reopened.snapshot()).drafts).toEqual([]) // never resurrect deleted edits
  await expect(
    reopened.startAgentReview({ ...input, prompt: 'Different request' }),
  ).rejects.toBeInstanceOf(ReviewRequestConflict)
  expect(faux.state.callCount).toBe(1)
})

it('runs a chosen available model without a default, but still rejects line questions', async () => {
  const { faux, opts, input, open } = await fixture()
  faux.setResponses([
    (_ctx, options, _state, model) => {
      expect(model.id).toBe('chosen')
      expect(options?.reasoning).toBe('high')
      return fauxAssistantMessage(output([finding()]))
    },
  ])
  const store = await open({ ...opts, model: undefined, inferenceEnabled: true })
  await store.startAgentReview(input)
  await settled(store, input.id)
  expect((await store.snapshot()).agentReviews[0]?.findings).toHaveLength(1)
  await expect(
    store.ask({
      id: crypto.randomUUID(),
      anchor: { path: 'source.ts', side: 'RIGHT', line: 4, revision: 'rev-1' },
      text: 'Question',
      context: '',
    }),
  ).rejects.toThrow('Configure a review model')
  expect((await store.snapshot()).threads).toEqual([])
  expect(faux.state.callCount).toBe(1)
})

it('requires usable credentials for the chosen model before committing a review', async () => {
  const { faux, opts, input, open } = await fixture()
  const store = await open({ ...opts, model: undefined, inferenceEnabled: true })
  const available = vi.spyOn(opts.models, 'getAvailable').mockResolvedValue([])
  await expect(store.startAgentReview(input)).rejects.toThrow('authentication')
  expect(available).toHaveBeenCalledWith(input.model.provider)
  expect((await store.snapshot()).agentReviews).toEqual([])
  expect(faux.state.callCount).toBe(0)
  available.mockRestore()
  faux.setResponses([fauxAssistantMessage(output())])
  await store.startAgentReview(input)
  await settled(store, input.id)
  expect(faux.state.callCount).toBe(1)
})

it('rejects unsupported reasoning levels before creating a conversation', async () => {
  const { faux, opts, input, open } = await fixture()
  const store = await open({ ...opts, model: undefined, inferenceEnabled: true })
  await Promise.all(
    (['xhigh', 'max'] as const).map((reasoningLevel) =>
      expect(store.startAgentReview({ ...input, reasoningLevel })).rejects.toThrow(
        'reasoning level is unavailable',
      ),
    ),
  )
  const model = faux.getModel()
  opts.models.setProvider({
    ...faux.provider,
    getModels: () => [{ ...model, thinkingLevelMap: { high: null } }],
  })
  await expect(store.startAgentReview(input)).rejects.toThrow(
    'reasoning level is unavailable',
  )
  expect((await store.snapshot()).agentReviews).toEqual([])
  expect(faux.state.callCount).toBe(0)
})

it('keeps pending findings across restart and allows human acceptance with --no-agent', async () => {
  const { faux, opts, input, open } = await fixture()
  faux.setResponses([fauxAssistantMessage(output([finding()]))])
  const store = await open()
  await store.startAgentReview(input)
  await settled(store, input.id)
  await store.close()
  const paused = await open({ ...opts, model: undefined })
  const item = (await paused.snapshot()).agentReviews[0]?.findings[0]
  expect(item?.status).toBe('pending')
  await paused.acceptFinding(input.id, item!.id, input.revision)
  expect((await paused.snapshot()).drafts).toEqual([
    { id: item!.id, anchor: item!.anchor, body: item!.body },
  ])
  expect(faux.state.callCount).toBe(1)
})

it('parses only the final assistant response after tool narration and shares admission with line threads', async () => {
  const { faux, input, open } = await fixture()
  faux.setResponses([
    fauxAssistantMessage(
      [
        { type: 'text', text: output([{ ...finding(), path: 'decoy.ts' }]) },
        fauxToolCall('codemode', { code: 'text("read-only result")' }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage(output([finding()])),
    fauxAssistantMessage('Line-thread answer'),
  ])
  const store = await open()
  await store.startAgentReview(input)
  await store.ask({
    id: 'ordinary-line-thread',
    anchor: { path: 'source.ts', side: 'RIGHT', line: 4, revision: 'rev-1' },
    text: 'Question',
    context: '',
  })
  await settled(store, input.id)
  await expect
    .poll(async () => (await store.snapshot()).threads[0]?.status)
    .toBe('answered')
  expect((await store.snapshot()).agentReviews[0]?.findings).toHaveLength(1)
  expect((await store.snapshot()).threads[0]?.turns[0]?.answer).toBe('Line-thread answer')
  expect(faux.state.callCount).toBe(3)
})

it('allows a valid empty summary and zero findings', async () => {
  const { faux, input, open } = await fixture()
  faux.setResponses([fauxAssistantMessage(JSON.stringify({ summary: '', findings: [] }))])
  const store = await open()
  await store.startAgentReview(input)
  await settled(store, input.id)
  expect((await store.snapshot()).agentReviews[0]).toMatchObject({
    summary: '',
    findings: [],
    status: 'answered',
  })
})

it.each([
  ['not JSON', 'not JSON', 'not a JSON object'],
  ['markdown', `\`\`\`json\n${output()}\n\`\`\``, 'not a JSON object'],
  ['outside patch', output([{ ...finding(), line: 6 }]), 'outside the reviewed diff'],
  ['wrong side', output([{ ...finding(), side: 'LEFT' }]), 'outside the reviewed diff'],
  [
    'invented path',
    output([{ ...finding(), path: 'other.ts' }]),
    'outside the reviewed diff',
  ],
  ['extra field', output([{ ...finding(), revision: 'rev-1' }]), 'invalid structure'],
  ['oversized body', output([finding('x'.repeat(20_001))]), 'invalid structure'],
  ['too many', output(Array.from({ length: 101 }, () => finding())), 'invalid structure'],
])('shows a bounded failure for %s and creates no draft', async (_, answer, error) => {
  const { faux, input, open } = await fixture()
  faux.setResponses([fauxAssistantMessage(answer)])
  const store = await open()
  await store.startAgentReview(input)
  await settled(store, input.id, 'failed')
  const snapshot = await store.snapshot()
  expect(snapshot.agentReviews[0]?.turns[0]?.error).toContain(error)
  expect(snapshot.agentReviews[0]?.findings).toEqual([])
  expect(snapshot.drafts).toEqual([])
  await store.close()
  const reopened = await open()
  expect((await reopened.snapshot()).agentReviews[0]?.turns[0]?.error).toContain(error)
  expect(faux.state.callCount).toBe(1)
})

it('keeps queued whole reviews paused without an agent and resumes with the original provider after a default change', async () => {
  const { faux, opts, input, open } = await fixture(35)
  faux.setResponses([
    fauxAssistantMessage('A deliberately slow first generation'.repeat(8)),
  ])
  const first = await open()
  await first.startAgentReview(input)
  await expect.poll(() => faux.state.callCount).toBe(1)
  const next = { ...input, id: crypto.randomUUID(), prompt: 'Second review' }
  await first.startAgentReview(next)
  await first.close()
  const other = fauxProvider({ provider: 'faux-new-default', models: [{ id: 'new' }] })
  opts.models.setProvider(other.provider)
  const newDefault = { provider: other.getModel().provider, modelId: other.getModel().id }
  const paused = await open({ ...opts, model: undefined })
  expect((await paused.snapshot()).agentReviews.map((run) => run.status)).toEqual([
    'running',
    'queued',
  ])
  await expect(
    paused.startAgentReview({ ...input, id: crypto.randomUUID() }),
  ).rejects.toThrow('Configure a review model')
  await paused.close()
  faux.setResponses([
    fauxAssistantMessage(output([finding()])),
    fauxAssistantMessage(output()),
  ])
  other.setResponses([fauxAssistantMessage('Wrong provider')])
  const resumed = await open({ ...opts, model: newDefault })
  await settled(resumed, next.id)
  expect((await resumed.snapshot()).agentReviews.map((run) => run.status)).toEqual([
    'answered',
    'answered',
  ])
  expect(other.state.callCount).toBe(0)
  expect(faux.state.callCount).toBe(3)
  expect((await resumed.snapshot()).agentReviews[0]?.findings[0]?.anchor.revision).toBe(
    input.revision,
  )
})

it('pauses both kinds of inference when explicitly disabled, despite an available default', async () => {
  const { faux, opts, input, open } = await fixture(35)
  faux.setResponses([
    fauxAssistantMessage('A deliberately slow first generation'.repeat(8)),
  ])
  const first = await open()
  await first.startAgentReview(input)
  await expect.poll(() => faux.state.callCount).toBe(1)
  const queued = { ...input, id: crypto.randomUUID(), prompt: 'Second review' }
  await first.startAgentReview(queued)
  await first.close()
  const before = faux.state.callCount

  const paused = await open({
    ...opts,
    inferenceEnabled: false,
    currentRevision: 'rev-2',
    toolPolicyKey: 'new-policy',
  })
  expect((await paused.snapshot()).agentReviews.map((run) => run.status)).toEqual([
    'running',
    'queued',
  ])
  await expect(
    paused.startAgentReview({ ...input, id: crypto.randomUUID() }),
  ).rejects.toThrow('Configure a review model')
  await expect(
    paused.ask({
      id: crypto.randomUUID(),
      anchor: { path: 'source.ts', side: 'RIGHT', line: 4, revision: 'rev-1' },
      text: 'Question',
      context: '',
    }),
  ).rejects.toThrow('Configure a review model')
  expect((await paused.snapshot()).threads).toEqual([])
  expect(faux.state.callCount).toBe(before)
  await paused.updateRevision('rev-2') // An explicit update may invalidate paused work.
  expect((await paused.snapshot()).agentReviews.map((run) => run.status)).toEqual([
    'failed',
    'failed',
  ])
  expect((await paused.snapshot()).agentReviews[0]?.turns[0]?.error).toBe(
    'Review revision changed; start a new review',
  )
  expect(faux.state.callCount).toBe(before)
})

it('resumes pinned whole-review reasoning without a default, skipping queued line work', async () => {
  const { faux, opts, input, open } = await fixture(35)
  faux.setResponses([
    fauxAssistantMessage('A deliberately slow first generation'.repeat(8)),
  ])
  const first = await open()
  await first.startAgentReview(input)
  await expect.poll(() => faux.state.callCount).toBe(1)
  const lineId = crypto.randomUUID()
  await first.ask({
    id: lineId,
    anchor: { path: 'source.ts', side: 'RIGHT', line: 4, revision: 'rev-1' },
    text: 'Line question',
    context: '',
  })
  const next = { ...input, id: crypto.randomUUID(), prompt: 'Second review' }
  await first.startAgentReview(next)
  await first.close()

  faux.setResponses([
    (_ctx, options, _state, model) => {
      expect(model.id).toBe('chosen')
      expect(options?.reasoning).toBe('high')
      return fauxAssistantMessage(output([finding()]))
    },
    (_ctx, options, _state, model) => {
      expect(model.id).toBe('chosen')
      expect(options?.reasoning).toBe('high')
      return fauxAssistantMessage(output())
    },
  ])
  const resumed = await open({ ...opts, model: undefined, inferenceEnabled: true })
  await settled(resumed, next.id)
  const snapshot = await resumed.snapshot()
  expect(snapshot.agentReviews.map((run) => run.status)).toEqual(['answered', 'answered'])
  expect(snapshot.agentReviews[0]?.findings[0]?.anchor.revision).toBe('rev-1')
  expect(snapshot.threads).toMatchObject([{ id: lineId, status: 'queued' }])
  expect(faux.state.callCount).toBe(3)

  await resumed.close()
  faux.setResponses([fauxAssistantMessage('Line resumed')])
  const withDefault = await open()
  await expect
    .poll(async () => (await withDefault.snapshot()).threads[0]?.status)
    .toBe('answered')
  expect((await withDefault.snapshot()).threads[0]?.turns[0]?.answer).toBe('Line resumed')
  expect(faux.state.callCount).toBe(4)
})

it('does not resume a pinned review if its reasoning level is no longer supported', async () => {
  const { faux, opts, input, open } = await fixture(35)
  faux.setResponses([
    fauxAssistantMessage('A deliberately slow first generation'.repeat(8)),
  ])
  const first = await open()
  await first.startAgentReview(input)
  await expect.poll(() => faux.state.callCount).toBe(1)
  await first.close()

  const model = faux.getModel()
  opts.models.setProvider({
    ...faux.provider,
    getModels: () => [{ ...model, thinkingLevelMap: { high: null } }],
  })
  const resumed = await open({ ...opts, model: undefined, inferenceEnabled: true })
  expect((await resumed.snapshot()).agentReviews[0]?.turns[0]?.error).toContain(
    'reasoning level is unavailable',
  )
  expect(faux.state.callCount).toBe(1)
})

it.each([
  ['tool policy', { toolPolicyKey: 'new-policy' }, 'tool policy changed'],
  ['revision', { currentRevision: 'rev-2' }, 'revision changed'],
])(
  'invalidates a %s-changed whole run on recovery without a default',
  async (_, change, error) => {
    const { faux, opts, input, open } = await fixture(35)
    faux.setResponses([
      fauxAssistantMessage('A deliberately slow first generation'.repeat(8)),
    ])
    const first = await open({ ...opts, toolPolicyKey: 'original-policy' })
    await first.startAgentReview(input)
    await expect.poll(() => faux.state.callCount).toBe(1)
    await first.close()

    const resumed = await open({
      ...opts,
      ...change,
      model: undefined,
      inferenceEnabled: true,
      toolPolicyKey:
        ('toolPolicyKey' in change ? change.toolPolicyKey : undefined) ?? 'original-policy',
    })
    const run = (await resumed.snapshot()).agentReviews[0]
    expect(run?.status).toBe('failed')
    expect(run?.turns[0]?.error).toContain(error)
    expect(faux.state.callCount).toBe(1)
  },
)

it('applies the shared run deadline without accepting an unfinished finding', async () => {
  const { faux, opts, input, open } = await fixture(10)
  opts.maxRunMs = 75
  faux.setResponses([fauxAssistantMessage(output([finding()]))])
  const store = await open()
  await store.startAgentReview(input)
  await settled(store, input.id, 'failed')
  expect((await store.snapshot()).agentReviews[0]?.turns[0]?.error).toBe('Review timed out')
  expect((await store.snapshot()).agentReviews[0]?.findings).toEqual([])
  expect((await store.snapshot()).drafts).toEqual([])
})

it('invalidates live active and queued reviews, ignores late output, and runs the new revision', async () => {
  const { faux, input, open } = await fixture()
  let release!: (message: ReturnType<typeof fauxAssistantMessage>) => void
  const late = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
    release = resolve
  })
  faux.setResponses([
    () => late,
    fauxAssistantMessage(output([finding('issue: new revision only')])),
  ])
  const store = await open()
  await store.startAgentReview(input)
  await expect.poll(() => faux.state.callCount).toBe(1)
  const queued = { ...input, id: crypto.randomUUID(), prompt: 'Queued old review' }
  await store.startAgentReview(queued)

  const updating = store.updateRevision('rev-2')
  try {
    await expect
      .poll(async () => (await store.snapshot()).agentReviews[0]?.status)
      .toBe('failed')
  } finally {
    // Return a valid old answer even if the transport resolves after cancellation.
    release(fauxAssistantMessage(output([finding('issue: obsolete')])))
    await updating
  }
  const stale = (await store.snapshot()).agentReviews
  expect(stale.map((run) => run.status)).toEqual(['failed', 'failed'])
  for (const run of stale) {
    expect(run.turns[0]?.error).toBe('Review revision changed; start a new review')
    expect(run.findings).toEqual([])
  }
  expect(faux.state.callCount).toBe(1) // The queued old review never ran.
  await expect(
    store.startAgentReview({ ...input, id: crypto.randomUUID() }),
  ).rejects.toThrow('revision changed')

  const fresh = { ...input, id: crypto.randomUUID(), revision: 'rev-2' }
  await store.startAgentReview(fresh)
  await settled(store, fresh.id)
  const snapshot = await store.snapshot()
  expect(snapshot.agentReviews.map((run) => run.status)).toEqual([
    'failed',
    'failed',
    'answered',
  ])
  expect(snapshot.agentReviews.slice(0, 2).every((run) => run.findings.length === 0)).toBe(
    true,
  )
  expect(snapshot.agentReviews[2]?.findings[0]?.anchor.revision).toBe('rev-2')
  expect(faux.state.callCount).toBe(2)
})

it('rejects acceptance of pending old findings after the live revision changes', async () => {
  const { faux, input, open } = await fixture()
  faux.setResponses([fauxAssistantMessage(output([finding()]))])
  const store = await open()
  await store.startAgentReview(input)
  await settled(store, input.id)
  const pending = (await store.snapshot()).agentReviews[0]?.findings[0]
  expect(pending?.status).toBe('pending')
  await store.updateRevision('rev-2')
  await expect(store.acceptFinding(input.id, pending!.id, 'rev-1')).rejects.toThrow(
    'revision changed',
  )
  expect((await store.snapshot()).agentReviews[0]?.findings[0]?.status).toBe('pending')
  expect((await store.snapshot()).drafts).toEqual([])
  expect(faux.state.callCount).toBe(1)
})

it('cancels whole runs through the common cancellation path and rejects stale revisions on recovery', async () => {
  const { faux, opts, input, open } = await fixture(30)
  faux.setResponses([
    fauxAssistantMessage('A slow answer that must not be accepted'.repeat(8)),
  ])
  const store = await open()
  await store.startAgentReview(input)
  await expect.poll(() => faux.state.callCount).toBe(1)
  await store.cancel(input.id)
  await settled(store, input.id, 'cancelled')
  expect((await store.snapshot()).agentReviews[0]?.findings).toEqual([])
  const pending = { ...input, id: crypto.randomUUID() }
  await store.startAgentReview(pending)
  await store.close()
  const stale = await open({ ...opts, currentRevision: 'rev-2' })
  expect((await stale.snapshot()).agentReviews[1]?.status).toBe('failed')
  expect((await stale.snapshot()).agentReviews[1]?.turns[0]?.error).toContain(
    'revision changed',
  )
  await expect(
    stale.acceptFinding(input.id, crypto.randomUUID(), input.revision),
  ).rejects.toThrow('revision changed')
  expect((await stale.snapshot()).drafts).toEqual([])
})

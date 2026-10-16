/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { Harness, createRegistry, defineDoc } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { openReviewStore, type ReviewStore } from './reviewStore.ts'
import { PublicationRejected } from './github.ts'

const anchor = { path: 'source.ts', side: 'RIGHT' as const, line: 1, revision: 'abc' }
const stores: ReviewStore[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
async function fixture(maxRunMs = 5000, slow = false) {
  const directory = await mkdtemp(join(tmpdir(), 'skepsis-review-'))
  directories.push(directory)
  const faux = fauxProvider({
    tokensPerSecond: slow ? 2 : 100000,
    tokenSize: { min: 1, max: 1 },
  })
  const models = createModels()
  models.setProvider(faux.provider)
  const model = faux.getModel()
  const opts = {
    directory,
    cwd: directory,
    models,
    model: { provider: model.provider, modelId: model.id },
    tools: [],
    onChange() {},
    maxRunMs,
  }
  const open = async () => {
    const store = await openReviewStore(opts)
    stores.push(store)
    return store
  }
  return { directory, faux, opts, open }
}
async function settled(store: ReviewStore, id: string, status = 'answered') {
  await expect
    .poll(
      async () =>
        (await store.snapshot()).threads.find((thread) => thread.id === id)?.status,
      { timeout: 10000 },
    )
    .toBe(status)
}

it('persists answers and follow-ups, deduplicates IDs and never edits source files', async () => {
  const { directory, faux, open } = await fixture()
  await writeFile(join(directory, 'source.ts'), 'original\n')
  faux.setResponses([
    fauxAssistantMessage('First answer'),
    fauxAssistantMessage('Follow-up answer'),
  ])
  const store = await open()
  const question = { id: 'one', anchor, text: 'Question', context: 'PRIVATE CONTEXT' }
  await Promise.all([store.ask(question), store.ask(question)])
  await settled(store, 'one')
  await store.reply('one', {
    id: 'two',
    text: 'Follow-up',
    context: 'MORE PRIVATE CONTEXT',
  })
  await settled(store, 'one')
  expect(faux.state.callCount).toBe(2)
  await store.close()
  const reopened = await open()
  expect((await reopened.snapshot()).threads[0]?.turns).toEqual([
    { id: 'one', question: 'Question', answer: 'First answer' },
    { id: 'two', question: 'Follow-up', answer: 'Follow-up answer' },
  ])
  expect(JSON.stringify(await reopened.snapshot())).not.toContain('PRIVATE CONTEXT')
  expect(await readFile(join(directory, 'source.ts'), 'utf8')).toBe('original\n')
})

it('recovers interrupted runs and queued turns with fixed request IDs', async () => {
  const { faux, open } = await fixture(20000, true)
  faux.setResponses([fauxAssistantMessage('a long interrupted answer that streams slowly')])
  const store = await open()
  await store.ask({ id: 'one', anchor, text: 'Question', context: 'fixed context' })
  await expect.poll(() => faux.state.callCount).toBe(1)
  await store.reply('one', { id: 'two', text: 'Next', context: 'fixed next context' })
  expect(faux.state.callCount).toBe(1) // Host queue does not submit the follow-up yet.
  await store.close()
  faux.setResponses([fauxAssistantMessage('ok'), fauxAssistantMessage('yes')])
  const reopened = await open()
  await settled(reopened, 'one')
  const turns = (await reopened.snapshot()).threads[0]!.turns
  expect(turns.map((turn) => turn.answer)).toEqual(['ok', 'yes'])
  await reopened.ask({ id: 'one', anchor, text: 'Question', context: 'changed context' })
  expect((await reopened.snapshot()).threads[0]!.turns).toHaveLength(2)
})

it.each([0, 1250])(
  'resumes after process death without forfeiting the entire budget (delay=%s)',
  async (delay) => {
    const { directory, faux, open } = await fixture(10000)
    // A separate process is essential: close() would refund the precharge.
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
    import { createModels } from '@earendil-works/pi-ai/models'
    import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
    import { openReviewStore } from ${JSON.stringify(new URL('reviewStore.ts', import.meta.url).href)}
    const faux = fauxProvider({ tokensPerSecond: 1 })
    const models = createModels()
    models.setProvider(faux.provider)
    const model = faux.getModel()
    faux.setResponses([() => {
      setTimeout(() => process.stdout.write('running\\n'), ${delay})
      return fauxAssistantMessage('a very long interrupted answer')
    }])
    const store = await openReviewStore({
      directory: ${JSON.stringify(directory)}, cwd: ${JSON.stringify(directory)},
      models, model: { provider: model.provider, modelId: model.id },
      tools: [], onChange() {}, maxRunMs: 10000,
    })
    await store.ask({ id: 'crash', anchor: ${JSON.stringify(anchor)}, text: 'Question', context: '' })
  `,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    let errors = ''
    child.stdout.on('data', (data) => {
      output += String(data)
    })
    child.stderr.on('data', (data) => {
      errors += String(data)
    })
    const exited = once(child, 'exit')
    try {
      await expect
        .poll(() => output || (child.exitCode !== null ? errors : ''), { timeout: 10000 })
        .toContain('running')
    } finally {
      child.kill('SIGKILL')
      await exited
    }
    // The owner is proven dead; do not wait for proper-lockfile's stale timeout.
    await rm(`${directory}.lock`, { recursive: true, force: true })
    const inspector = await Harness.open(
      await openNodeSqliteStorage(join(directory, 'review.sqlite')),
      { models: createModels(), registry: createRegistry() },
      context,
    )
    try {
      const journal = defineDoc<{ intents: { status: string; remainingMs: number }[] }>({
        kind: 'skepsis.review',
        version: 2,
        scope: 'conversation',
        history: 'latest',
        fork: 'initial',
        initial: () => ({ intents: [] }),
      })
      const root = await inspector.root(context)
      const intent = (await inspector.snapshot(journal, root.id, context))!.intents[0]!
      expect(intent.status).toBe('running')
      if (delay === 0) expect(intent.remainingMs).toBe(9000)
      else {
        expect(intent.remainingMs).toBeLessThan(8500)
        expect(intent.remainingMs).toBeGreaterThan(6500)
      }
    } finally {
      await inspector.close(context)
    }
    faux.setResponses([fauxAssistantMessage('recovered')])
    const reopened = await open()
    await settled(reopened, 'crash')
    expect(faux.state.callCount).toBe(1)
    expect((await reopened.snapshot()).threads[0]?.turns[0]?.answer).toBe('recovered')
  },
)

it('cancels stale running and queued work before recovery, preserving history and drafts', async () => {
  const { faux, opts, open } = await fixture(20000, true)
  faux.setResponses([fauxAssistantMessage('a long interrupted answer')])
  const store = await open()
  await store.ask({ id: 'one', anchor, text: 'Question', context: '' })
  await expect.poll(() => faux.state.callCount).toBe(1)
  await store.ask({ id: 'two', anchor, text: 'Queued', context: '' })
  await store.saveDraft({ id: 'draft', anchor, body: 'Keep this' })
  await store.close()
  faux.setResponses([
    fauxAssistantMessage('must not run'),
    fauxAssistantMessage('nor this'),
  ])
  const reopened = await openReviewStore({ ...opts, currentRevision: 'new' })
  stores.push(reopened)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(faux.state.callCount).toBe(1)
  const snapshot = await reopened.snapshot()
  expect(snapshot.threads).toHaveLength(2)
  for (const thread of snapshot.threads) {
    expect(thread.status).toBe('failed')
    expect(thread.turns[0]?.error).toBe('Review revision changed; start a new thread')
  }
  expect(snapshot.drafts[0]?.body).toBe('Keep this')
  await reopened.ask({
    id: 'new',
    anchor: { ...anchor, revision: 'newer' },
    text: 'New revision',
    context: '',
  })
  await settled(reopened, 'new')
})

it('leaves saved running and queued work paused without a selected model', async () => {
  const { faux, opts, open } = await fixture(20000, true)
  faux.setResponses([fauxAssistantMessage('a long interrupted answer')])
  const store = await open()
  await store.ask({ id: 'one', anchor, text: 'Question', context: '' })
  await expect.poll(() => faux.state.callCount).toBe(1)
  await store.ask({ id: 'two', anchor, text: 'Queued', context: '' })
  await store.close()
  faux.setResponses([fauxAssistantMessage('must not run')])
  const reopened = await openReviewStore({ ...opts, model: undefined })
  stores.push(reopened)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(faux.state.callCount).toBe(1)
  expect((await reopened.snapshot()).threads.map((thread) => thread.status)).toEqual([
    'running',
    'queued',
  ])
})

it.each([false, true])(
  'uses the newly selected model for follow-ups (interrupted=%s)',
  async (interrupted) => {
    const { faux, opts, open } = await fixture(20000, interrupted)
    faux.setResponses([fauxAssistantMessage('original answer that may be interrupted')])
    const store = await open()
    await store.ask({ id: 'one', anchor, text: 'Question', context: '' })
    if (interrupted) await expect.poll(() => faux.state.callCount).toBe(1)
    else await settled(store, 'one')
    await store.close()
    const next = fauxProvider({
      provider: 'next-faux',
      models: [{ id: 'new-model' }],
      tokensPerSecond: 100000,
    })
    opts.models.setProvider(next.provider)
    const selected = next.getModel()
    next.setResponses([
      (_context, _options, _state, model) => {
        expect(model.id).toBe(selected.id)
        expect(model.provider).toBe(selected.provider)
        return fauxAssistantMessage('new answer')
      },
    ])
    let reopened = await openReviewStore({
      ...opts,
      model: { provider: selected.provider, modelId: selected.id },
    })
    stores.push(reopened)
    if (interrupted) {
      expect((await reopened.snapshot()).threads[0]?.turns[0]?.error).toBe(
        'Provider changed; confirm before sending conversation history',
      )
    }
    expect(next.state.callCount).toBe(0)
    expect((await reopened.snapshot()).threads[0]?.providerChange).toEqual({
      from: opts.model.provider,
      to: selected.provider,
    })
    await expect(
      reopened.reply('one', { id: 'blocked', text: 'No', context: '' }),
    ).rejects.toThrow('Confirm provider')
    await expect(reopened.confirmProvider('one', 'outdated')).rejects.toThrow('outdated')
    await reopened.close()
    const paused = await openReviewStore({ ...opts, model: undefined })
    stores.push(paused)
    expect((await paused.snapshot()).threads[0]?.providerChange?.to).toBe(selected.provider)
    await expect(paused.confirmProvider('one', selected.provider)).rejects.toThrow(
      'unavailable',
    )
    expect(next.state.callCount).toBe(0)
    await paused.close()
    reopened = await openReviewStore({
      ...opts,
      model: { provider: selected.provider, modelId: selected.id },
    })
    stores.push(reopened)
    await reopened.confirmProvider('one', selected.provider)
    expect((await reopened.snapshot()).threads[0]?.providerChange).toBeUndefined()
    expect(next.state.callCount).toBe(0)
    await reopened.reply('one', { id: 'two', text: 'Follow-up', context: '' })
    await settled(reopened, 'one')
    expect((await reopened.snapshot()).threads[0]?.turns[1]?.answer).toBe('new answer')
    expect(faux.state.callCount).toBe(1)
    expect(next.state.callCount).toBe(1)
  },
)

it('releases drafts after definitive publication rejection', async () => {
  const { open } = await fixture()
  const store = await open()
  await store.saveDraft({ id: 'draft', anchor, body: 'Fix me' })
  await expect(
    store.publish(
      { id: 'rejected', event: 'COMMENT', body: '', draftIds: ['draft'] },
      async () => {
        throw new PublicationRejected('Validation failed')
      },
    ),
  ).rejects.toThrow('Validation failed')
  expect((await store.snapshot()).publication?.status).toBe('failed')
  await store.saveDraft({ id: 'draft', anchor, body: 'Fixed' })
  await store.deleteDraft('draft')
  expect((await store.snapshot()).drafts).toEqual([])
})

it('times out and cancels work, retaining resolved threads', async () => {
  const { faux, open } = await fixture(150, true)
  faux.setResponses([
    fauxAssistantMessage('very long response'),
    fauxAssistantMessage('another long response'),
  ])
  const store = await open()
  await store.ask({ id: 'timeout', anchor, text: 'Question', context: '' })
  await settled(store, 'timeout', 'failed')
  expect((await store.snapshot()).threads[0]!.turns[0]!.error).toContain('timed out')
  await store.ask({ id: 'cancel', anchor, text: 'Question', context: '' })
  await store.resolve('cancel')
  const thread = (await store.snapshot()).threads.find((item) => item.id === 'cancel')!
  expect(thread.resolved).toBe(true)
  expect(thread.status).toBe('cancelled')
  await expect(
    store.reply('cancel', { id: 'later', text: 'No', context: '' }),
  ).rejects.toThrow('resolved')
})

it('excludes shutdown pauses but retains consumed execution across reopen', async () => {
  // Faux cancellation may take a token interval to quiesce; that is active
  // execution too, unlike the subsequent time with the store fully closed.
  const { faux, open } = await fixture(2500, true)
  faux.setResponses([fauxAssistantMessage('an answer that will not finish in time')])
  const store = await open()
  await store.ask({ id: 'one', anchor, text: 'Question', context: '' })
  await expect.poll(() => faux.state.callCount).toBe(1)
  await new Promise((resolve) => setTimeout(resolve, 150))
  await store.close()
  await new Promise((resolve) => setTimeout(resolve, 2600))
  faux.setResponses([fauxAssistantMessage('still a long response')])
  const start = performance.now()
  const reopened = await open()
  await settled(reopened, 'one', 'failed')
  expect(performance.now() - start).toBeLessThan(2500)
  expect(faux.state.callCount).toBe(2)
  expect((await reopened.snapshot()).threads[0]!.turns[0]!.error).toContain('timed out')
}, 10000)

it('journals only selected public drafts, freezes uncertainty and reconciles without resending', async () => {
  const { open } = await fixture()
  const store = await open()
  await store.saveDraft({ id: 'draft', anchor, body: 'Public comment' })
  const input = {
    id: 'publication',
    event: 'COMMENT' as const,
    body: 'Public summary',
    draftIds: ['draft'],
  }
  let sends = 0
  await expect(
    store.publish(input, async (sent, drafts) => {
      sends++
      expect(sent).toEqual(input)
      expect(drafts).toEqual([{ id: 'draft', anchor, body: 'Public comment' }])
      expect((await store.snapshot()).publication?.status).toBe('publishing')
      throw new Error('connection lost after send')
    }),
  ).rejects.toThrow('connection lost')
  await expect(store.deleteDraft('draft')).rejects.toThrow('frozen')
  await expect(store.saveDraft({ id: 'draft', anchor, body: 'changed' })).rejects.toThrow(
    'frozen',
  )
  await store.close()
  const reopened = await open()
  await reopened.publish(input, async () => {
    sends++
    return { id: 99, url: 'bad' }
  })
  await reopened.reconcile(async () => null)
  expect((await reopened.snapshot()).publication?.status).toBe('uncertain')
  await reopened.reconcile(async (id) => {
    expect(id).toBe('publication')
    return { id: 42, url: 'review-url' }
  })
  expect((await reopened.snapshot()).drafts[0]?.publishedReviewId).toBe(42)
  expect(sends).toBe(1)
  await reopened.saveDraft({ id: 'next', anchor, body: 'Second batch' })
  await reopened.publish({ ...input, id: 'second', draftIds: ['next'] }, async () => ({
    id: 43,
    url: 'next-url',
  }))
  await reopened.publish(input, async () => {
    throw new Error('Must not resend archived ID')
  })
  expect((await reopened.snapshot()).publication?.reviewId).toBe(43)
})

it('abandons only uncertain publications, unlocks drafts, and never reuses their IDs', async () => {
  const { open } = await fixture()
  const store = await open()
  const input = { id: 'old', event: 'COMMENT' as const, body: '', draftIds: ['draft'] }
  await store.saveDraft({ id: 'draft', anchor, body: 'Original' })
  await expect(
    store.publish(input, async () => {
      throw new Error('unknown outcome')
    }),
  ).rejects.toThrow()
  await expect(store.abandonPublication('wrong')).rejects.toThrow('uncertain')
  await store.abandonPublication('old')
  expect((await store.snapshot()).publication).toMatchObject({
    status: 'abandoned',
    error: expect.stringContaining('Explicit user override'),
  })
  await expect(store.abandonPublication('old')).rejects.toThrow('uncertain')
  await store.saveDraft({ id: 'draft', anchor, body: 'Updated' })
  const send = async () => ({ id: 42, url: input.id })
  await expect(store.publish(input, send)).rejects.toThrow('abandoned')
  await store.publish({ ...input, id: 'new' }, send)
  await expect(store.abandonPublication('new')).rejects.toThrow('uncertain')
  await store.close()
  const reopened = await open()
  await expect(reopened.publish(input, send)).rejects.toThrow('abandoned')
})

it('does not charge host queue waiting time', async () => {
  const { faux, open } = await fixture(150, true)
  faux.setResponses([
    fauxAssistantMessage('a long answer'),
    fauxAssistantMessage('another long answer'),
    fauxAssistantMessage('ok'),
  ])
  const store = await open()
  await Promise.all(
    ['first', 'second', 'third'].map((id) =>
      store.ask({ id, anchor, text: 'Question', context: '' }),
    ),
  )
  await settled(store, 'third', 'failed')
  // Every queued turn receives its own execution window even though the last
  // waited longer than its whole budget before it was submitted.
  expect(faux.state.callCount).toBe(3)
})

it('keeps enforcing the run budget while shutdown drains publication receipts', async () => {
  const { faux, open } = await fixture(150, true)
  faux.setResponses([fauxAssistantMessage('long running response')])
  const store = await open()
  await store.ask({ id: 'active', anchor, text: 'Question', context: '' })
  await expect.poll(() => faux.state.callCount).toBe(1)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const publication = store.publish(
    { id: 'publishing', event: 'COMMENT', body: 'Summary', draftIds: [] },
    async () => {
      await gate
      return { id: 1, url: 'https://github.com/o/r/pull/1' }
    },
  )
  await expect
    .poll(async () => (await store.snapshot()).publication?.status)
    .toBe('publishing')
  const closing = store.close()
  try {
    await settled(store, 'active', 'failed')
    expect((await store.snapshot()).threads[0]?.turns[0]?.error).toBe('Review timed out')
  } finally {
    release()
    await publication
    await closing
  }
})

it('rejects duplicate/missing draft IDs, excludes simultaneous owners, and gives a friendly no-model error', async () => {
  const { opts, open } = await fixture()
  const store = await open()
  await expect(openReviewStore(opts)).rejects.toThrow()
  const send = async () => ({ id: 1, url: opts.directory })
  await expect(
    store.publish({ id: 'x', event: 'COMMENT', body: '', draftIds: ['missing'] }, send),
  ).rejects.toThrow('missing')
  await expect(
    store.publish({ id: 'x', event: 'COMMENT', body: '', draftIds: ['a', 'a'] }, send),
  ).rejects.toThrow('Duplicate')
  await store.close()
  const noModel = await openReviewStore({
    ...opts,
    model: undefined,
    onChange() {
      throw new Error('UI error')
    },
  })
  stores.push(noModel)
  await expect(
    noModel.ask({ id: 'one', anchor, text: 'Question', context: '' }),
  ).rejects.toThrow('Configure a review model')
})

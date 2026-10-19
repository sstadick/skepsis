/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { ClassifierModel, ClassifierResult } from '@earendil-works/pi-ai'
import { Hono } from 'hono'
import { afterEach, expect, it, vi } from 'vitest'
import type { DiffArgs } from '../shared/types.ts'
import type { PrioritySnapshot } from '../shared/priorities.ts'
import { mountReviewApi } from './reviewApi.ts'
import type { ReviewStore } from './reviewStore.ts'
import { diffCommand } from './diff.ts'
import { createReviewContext } from './reviewContext.ts'
import { setupReviewAgentWithEnvironment } from './reviewAgent.ts'
import * as github from './github.ts'

const classifier: ClassifierModel<'test-classifier'> = {
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
  api: classifier.api,
  provider: classifier.provider,
  model: classifier.id,
  timestamp: 0,
  stopReason: 'stop',
  answers: {
    priority: { type: 'score', score: 3.4, confidence: 0.9 },
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
const stores: ReviewStore[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  vi.restoreAllMocks()
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})
async function fixture(
  options: { enabled?: boolean; files?: string[]; chat?: boolean } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), 'review-priorities-api-'))
  directories.push(cwd)
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  git('init', '-q')
  for (const name of ['file.txt', 'other.txt', 'old.txt', 'gone.txt'])
    // oxlint-disable-next-line no-await-in-loop
    await writeFile(
      join(cwd, name),
      Array.from({ length: 20 }, (_, n) => `${name} line ${n}`).join('\n') + '\n',
    )
  git('add', '.')
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-qm',
    'initial',
  )
  await writeFile(join(cwd, 'file.txt'), 'changed\n')
  await writeFile(join(cwd, 'other.txt'), 'other changed\n')
  const models = createModels()
  const faux = fauxProvider({ tokensPerSecond: 100000 })
  if (options.chat) models.setProvider(faux.provider)
  const model = faux.getModel()
  vi.spyOn(models, 'getModelOfType').mockReturnValue(classifier)
  const classify = vi.spyOn(models, 'classify').mockImplementation(async () => answer())
  const chat = vi.spyOn(models, 'complete')
  const source: DiffArgs = {
    vcs: 'git',
    args: ['HEAD'],
    files: options.files ?? [],
    endpoints: { left: 'HEAD', right: 'workingCopy' },
  }
  const publish = vi.fn()
  let servedPatch: string | undefined
  const open = async () => {
    const app = new Hono()
    const store = await mountReviewApi(app, {
      cwd,
      diffSource: source,
      getOrigin: () => 'http://localhost:4321',
      publish,
      review: {
        directory: join(cwd, '.review'),
        models,
        ...(options.chat ? { model: { provider: model.provider, modelId: model.id } } : {}),
        classifierConcurrency: 8,
        // Chat is normally unavailable: priorities are an independent classifier-only capability.
        agent: {
          available: Boolean(options.chat),
          model: options.chat ? `${model.provider}/${model.id}` : null,
          ...(options.enabled === false
            ? {}
            : {
                classifier: {
                  provider: 'test',
                  model: 'test',
                  endpoint: classifier.baseUrl,
                },
              }),
        },
        browserOrigin: 'http://localhost:5173',
        pullRequest: {
          owner: 'o',
          repository: 'r',
          number: 1,
          title: 'Test',
          url: 'https://github.com/o/r/pull/1',
          baseSha: 'a'.repeat(40),
          headSha: 'b'.repeat(40),
          diffBaseSha: 'a'.repeat(40),
        },
      },
    })
    stores.push(store)
    app.get('/api/diff', (c) =>
      c.json({ patch: servedPatch ?? git(...diffCommand(source).args) }),
    )
    const request = (path: string, init?: RequestInit) =>
      app.request(`http://localhost:4321${path}`, init)
    const token = (await (await request('/api/session')).json()).token as string
    const post = (path: string, body: unknown) =>
      request(path, {
        method: 'POST',
        headers: { 'x-skepsis-token': token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const snapshot = async (): Promise<PrioritySnapshot> =>
      (await request('/api/priorities')).json()
    const input = { id: randomUUID(), revision: (await snapshot()).revision }
    return { store, request, token, post, snapshot, input }
  }
  return {
    cwd,
    git,
    source,
    models,
    faux,
    classify,
    chat,
    publish,
    open,
    setPatch(patch: string) {
      servedPatch = patch
    },
    ...(await open()),
  }
}

it('starts explicitly, returns cached progress, survives reload but not server restart', async () => {
  const f = await fixture({ files: ['file.txt'] })
  expect(await f.snapshot()).toMatchObject({
    status: 'idle',
    available: true,
    results: [],
    completed: 0,
    total: 0,
  })
  expect(f.classify).not.toHaveBeenCalled()
  const response = await f.post('/api/priorities', f.input)
  expect([200, 202]).toContain(response.status)
  expect(await response.json()).toMatchObject({
    runId: f.input.id,
    revision: f.input.revision,
  })
  await expect.poll(async () => (await f.snapshot()).status).toBe('complete')
  const completed = await f.snapshot()
  expect(completed.results.map((item) => item.path)).toEqual(['file.txt'])
  expect(completed.results[0]).toMatchObject({
    status: 'scored',
    score: 3.4,
    anchor: { revision: f.input.revision },
  })
  expect(f.classify).toHaveBeenCalledTimes(1)
  expect(f.chat).not.toHaveBeenCalled()
  expect(f.publish).toHaveBeenCalled()
  expect((await f.post('/api/priorities', f.input)).status).toBe(200)
  expect(
    (await f.post('/api/priorities', { ...f.input, revision: 'different' })).status,
  ).toBe(409)
  // GET cannot spawn git: even while the repository is unavailable it serves the cache.
  await rename(join(f.cwd, '.git'), join(f.cwd, '.git-hidden'))
  try {
    const cached = await f.request('/api/priorities')
    expect(cached.headers.get('cache-control')).toBe('no-store')
    expect(await cached.json()).toEqual(completed)
  } finally {
    await rename(join(f.cwd, '.git-hidden'), join(f.cwd, '.git'))
  }
  await f.store.close()
  const reopened = await f.open()
  expect(await reopened.snapshot()).toMatchObject({ status: 'idle', results: [], total: 0 })
  expect(f.classify).toHaveBeenCalledTimes(1)
  expect((await reopened.store.snapshot()).threads).toEqual([])
  expect((await reopened.store.snapshot()).drafts).toEqual([])
})

it('requires classifier configuration and never substitutes the chat service', async () => {
  const f = await fixture({ enabled: false })
  expect(await f.snapshot()).toMatchObject({
    available: false,
    unavailableReason: expect.stringContaining('--classifier-config'),
  })
  const response = await f.post('/api/priorities', f.input)
  expect(response.status).toBe(503)
  expect((await response.json()).error).toContain('Chat models are never used')
  expect(f.classify).not.toHaveBeenCalled()
  expect(f.chat).not.toHaveBeenCalled()
})

it('protects start/cancel with host, origin, token and body bounds; refuses client patches', async () => {
  const f = await fixture()
  await Promise.all(
    ['/api/priorities', '/api/priorities/cancel'].map(async (path) => {
      expect((await f.request(path, { method: 'POST' })).status).toBe(403)
      expect(
        (
          await f.request(path, {
            method: 'POST',
            headers: { 'x-skepsis-token': f.token },
            body: 'x'.repeat(65537),
          })
        ).status,
      ).toBe(413)
      expect(
        (await f.post(path, { id: 'not-a-uuid', revision: f.input.revision })).status,
      ).toBe(400)
      expect((await f.post(path, { ...f.input, patch: 'client supplied' })).status).toBe(
        400,
      )
      await Promise.all(
        (
          [
            { host: 'evil.test' },
            { origin: 'https://evil.test' },
            { 'sec-fetch-site': 'cross-site' },
          ] as Record<string, string>[]
        ).map(async (headers) => {
          expect(
            (
              await f.request(path, {
                method: 'POST',
                headers: { ...headers, 'x-skepsis-token': f.token },
                body: JSON.stringify(f.input),
              })
            ).status,
          ).toBe(403)
        }),
      )
    }),
  )
  expect(
    (await f.request('/api/priorities', { headers: { origin: 'https://evil.test' } }))
      .status,
  ).toBe(403)
  expect(
    (await f.request('/api/priorities', { headers: { origin: 'http://localhost:5173' } }))
      .status,
  ).toBe(200)
  expect(f.classify).not.toHaveBeenCalled()
})

it('invalidates on diff refresh and post-completion verification, rejecting stale starts', async () => {
  const f = await fixture({ files: ['file.txt'] })
  let finish!: () => void
  f.classify.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return answer()
  })
  await f.post('/api/priorities', f.input)
  const signal = f.classify.mock.calls[0]![2]!.signal!
  await writeFile(join(f.cwd, 'file.txt'), 'different\n')
  const diff = await (await f.request('/api/diff')).json()
  expect(diff.reviewRevision).not.toBe(f.input.revision)
  expect(signal.aborted).toBe(true)
  expect(await f.snapshot()).toMatchObject({ status: 'stale', revision: f.input.revision })
  finish()
  await expect
    .poll(
      async () =>
        (await f.post('/api/priorities', { id: randomUUID(), revision: f.input.revision }))
          .status,
    )
    .toBe(409)
  // A fresh run can be invalidated without any subsequent browser reload.
  let response!: Response
  await expect
    .poll(async () => {
      response = await f.post('/api/priorities', {
        id: randomUUID(),
        revision: diff.reviewRevision,
      })
      return response.status
    })
    .toBe(202)
  await writeFile(join(f.cwd, 'file.txt'), 'changed while scoring\n')
  finish()
  await expect.poll(async () => (await f.snapshot()).status).toBe('stale')
  expect((await f.snapshot()).results[0]?.anchor.revision).toBe(diff.reviewRevision)
  expect((await f.snapshot()).revision).toBe(diff.reviewRevision)
})

it('does not score a displayed patch whose identity differs from the current authoritative patch', async () => {
  const f = await fixture({ files: ['file.txt'] })
  const context = createReviewContext(f.cwd, f.source, {
    owner: 'o',
    repository: 'r',
    number: 1,
    title: 'Test',
    url: 'https://github.com/o/r/pull/1',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    diffBaseSha: 'a'.repeat(40),
  })
  const old = await context.current()
  f.setPatch(old.patch)
  await writeFile(join(f.cwd, 'file.txt'), 'changed after capture\n')
  const displayed = await (await f.request('/api/diff')).json()
  expect(displayed.patch).toBe(old.patch)
  expect(
    (
      await f.post('/api/priorities', {
        id: randomUUID(),
        revision: displayed.reviewRevision,
      })
    ).status,
  ).toBe(409)
  expect(f.classify).not.toHaveBeenCalled()
})

it('maps rename/deletion anchors from the exact path-filtered original files', async () => {
  const f = await fixture({ files: ['old.txt', 'new.txt', 'gone.txt'] })
  f.git('mv', 'old.txt', 'new.txt')
  await writeFile(
    join(f.cwd, 'new.txt'),
    Array.from({ length: 20 }, (_, n) =>
      n === 10 ? 'replaced' : `old.txt line ${n}`,
    ).join('\n') + '\n',
  )
  await unlink(join(f.cwd, 'gone.txt'))
  const diff = await (await f.request('/api/diff')).json()
  expect(
    (await f.post('/api/priorities', { id: randomUUID(), revision: diff.reviewRevision }))
      .status,
  ).toBe(202)
  await expect.poll(async () => (await f.snapshot()).status).toBe('complete')
  const results = (await f.snapshot()).results
  expect(results.map((item) => item.anchor)).toEqual([
    { path: 'gone.txt', side: 'LEFT', line: 1, revision: diff.reviewRevision },
    { path: 'new.txt', side: 'RIGHT', line: 11, revision: diff.reviewRevision },
  ])
  expect(f.classify.mock.calls[1]![1].state.previousPath).toBe('old.txt')
})

it('cancellation bypasses publication mutex and store close aborts and joins the batch', async () => {
  const f = await fixture({ files: ['file.txt'] })
  let finish!: () => void
  f.classify.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return answer()
  })
  await f.post('/api/priorities', f.input)
  let releasePreflight!: () => void
  const gate = new Promise<void>((resolve) => {
    releasePreflight = resolve
  })
  const preflight = vi.spyOn(github, 'preflightReview').mockImplementation(async () => {
    await gate
    throw new Error('Test preflight stopped')
  })
  const submission = f.post('/api/review/submit', {
    id: randomUUID(),
    event: 'COMMENT',
    body: 'Summary',
    draftIds: [],
  })
  try {
    await expect.poll(() => preflight.mock.calls.length).toBe(1)
    expect(
      (await f.post('/api/priorities/cancel', { ...f.input, id: randomUUID() })).status,
    ).toBe(409)
    expect((await f.snapshot()).status).toBe('running')
    expect((await f.post('/api/priorities/cancel', f.input)).status).toBe(200)
    expect(f.classify.mock.calls[0]![2]!.signal!.aborted).toBe(true)
    let closed = false
    const closing = f.store.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    finish()
    await closing
    expect(closed).toBe(true)
  } finally {
    finish()
    releasePreflight()
    await submission
  }
})

it('begins real chat shutdown while a priority transport is still settling', async () => {
  const f = await fixture({ files: ['file.txt'], chat: true })
  const transport = Promise.withResolvers<undefined>()
  const chatCleanup = Promise.withResolvers<undefined>()
  let chatSignal: AbortSignal | undefined
  f.classify.mockImplementation(async () => {
    await transport.promise
    return answer()
  })
  f.faux.setResponses([
    async (_context, options) => {
      chatSignal = options?.signal
      if (!chatSignal) throw new Error('Missing chat abort signal')
      await Promise.race([
        chatCleanup.promise,
        new Promise<void>((resolve) => {
          if (chatSignal!.aborted) resolve()
          else chatSignal!.addEventListener('abort', () => resolve(), { once: true })
        }),
      ])
      return fauxAssistantMessage('Must not complete during shutdown')
    },
  ])
  let closed = false
  try {
    await f.post('/api/priorities', f.input)
    await f.store.ask({
      id: 'paused-chat',
      anchor: { path: 'file.txt', side: 'RIGHT', line: 1, revision: f.input.revision },
      text: 'Keep this conversation private',
      context: '',
    })
    await expect.poll(() => chatSignal !== undefined).toBe(true)
    const closing = f.store.close()
    void closing.then(() => {
      closed = true
    })
    expect(f.store.close()).toBe(closing)
    expect(f.classify.mock.calls[0]![2]!.signal!.aborted).toBe(true)
    // This fails with priorities.close().then(closeStore): the priority
    // transport deliberately cannot settle until AFTER chat has been aborted.
    await expect.poll(() => chatSignal?.aborted).toBe(true)
    expect(closed).toBe(false)
    expect((await f.snapshot()).status).toBe('cancelled')
    expect((await f.post('/api/priorities', { ...f.input, id: randomUUID() })).status).toBe(
      503,
    )
    await expect(
      f.store.ask({
        id: 'too-late',
        anchor: { path: 'file.txt', side: 'RIGHT', line: 1, revision: f.input.revision },
        text: 'Cannot enqueue work after shutdown starts',
        context: '',
      }),
    ).rejects.toThrow('closed')
    transport.resolve(undefined)
    await closing
    expect(closed).toBe(true)
    expect(f.faux.state.callCount).toBe(1)
    expect((await f.snapshot()).results[0]?.score).toBeUndefined()
  } finally {
    chatCleanup.resolve(undefined)
    transport.resolve(undefined)
    await f.store.close()
  }
})

it('passes configured classifier concurrency through setup and skips setup under --no-agent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'priority-setup-'))
  directories.push(home)
  const path = join(home, 'classifier.json')
  await writeFile(
    path,
    JSON.stringify({
      model: 'local-test',
      endpoint: 'http://127.0.0.1:1/not-contacted',
      maxConcurrency: 17,
    }),
  )
  const setup = await setupReviewAgentWithEnvironment(undefined, {}, home, path)
  expect(setup.classifierConcurrency).toBe(17)
  expect(setup.status.classifier?.model).toBe('local-test')
  const disabled = await setupReviewAgentWithEnvironment(false, {}, home, '/no/such/file')
  expect(disabled.classifierConcurrency).toBeUndefined()
  expect(disabled.status.classifier).toBeUndefined()
})

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, expect, it, vi } from 'vitest'
import * as github from './github.ts'
import {
  PUBLICATION_ABANDON_ACK,
  reviewDraftsDigest,
  type PullRequest,
} from '../shared/review.ts'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { mountReviewApi } from './reviewApi.ts'
import type { ReviewStore } from './reviewStore.ts'
import type { DiffArgs } from '../shared/types.ts'
import { createReviewContext } from './reviewContext.ts'
import { diffCommand } from './diff.ts'

const stores: ReviewStore[] = []
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
async function fixture(pullRequest?: PullRequest) {
  const cwd = await mkdtemp(join(tmpdir(), 'review-api-'))
  directories.push(cwd)
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  git('init', '-q')
  await writeFile(join(cwd, 'file.txt'), 'before\n')
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
  await writeFile(join(cwd, 'file.txt'), 'after\n')
  const models = createModels()
  const faux = fauxProvider({ tokensPerSecond: 100000 })
  models.setProvider(faux.provider)
  faux.setResponses([fauxAssistantMessage('Answer'), fauxAssistantMessage('Follow-up')])
  const model = faux.getModel()
  const source: DiffArgs = {
    vcs: 'git',
    args: ['HEAD'],
    files: [],
    endpoints: { left: 'HEAD', right: 'workingCopy' },
    commentsEnabled: true,
  }
  let servedPatch: string | undefined
  const open = async () => {
    const app = new Hono()
    const store = await mountReviewApi(app, {
      cwd,
      diffSource: source,
      getOrigin: () => 'http://localhost:4321',
      publish() {},
      review: {
        directory: join(cwd, '.review'),
        pullRequest,
        models,
        model: { provider: model.provider, modelId: model.id },
        agent: { available: true, model: model.id },
        browserOrigin: 'http://localhost:5173',
      },
    })
    stores.push(store)
    app.post('/api/legacy', (c) => c.json({ ok: true }))
    app.get('/api/diff', (c) =>
      c.json({ patch: servedPatch ?? git(...diffCommand(source).args) }),
    )
    const request = (path: string, init?: RequestInit) =>
      app.request(`http://localhost:4321${path}`, init)
    const token = (await (await request('/api/session')).json()).token
    const mutate = (path: string, body: unknown, method = 'POST') =>
      request(path, {
        method,
        headers: { 'x-skepsis-token': token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    return { request, mutate, store, token }
  }
  return {
    cwd,
    source,
    setPatch: (patch: string) => {
      servedPatch = patch
    },
    open,
    ...(await open()),
  }
}
it('serves cached progress revisions and refreshes on diff reload', async () => {
  const { cwd, request, mutate, store } = await fixture()
  const revision = (await (await request('/api/review')).json()).revision
  await writeFile(join(cwd, 'file.txt'), 'changed\n')
  expect((await (await request('/api/review')).json()).revision).toBe(revision)
  const response = await request('/api/diff')
  expect(response.headers.get('cache-control')).toBe('no-store')
  const diff = await response.json()
  expect(diff.reviewRevision).not.toBe(revision)
  const progress = await request('/api/review')
  expect(progress.headers.get('cache-control')).toBe('no-store')
  expect((await progress.json()).revision).toBe(diff.reviewRevision)
  const responseToQuestion = await mutate('/api/threads', {
    id: randomUUID(),
    anchor: { path: 'file.txt', side: 'RIGHT', line: 1, revision: diff.reviewRevision },
    text: 'Ask about the refreshed diff',
  })
  expect(responseToQuestion.status).toBe(200)
  await expect
    .poll(async () => (await store.snapshot()).threads[0]?.status)
    .toBe('answered')
})

it('attaches the identity of the served patch, not a freshly generated diff', async () => {
  const { cwd, source, setPatch, request } = await fixture()
  const context = createReviewContext(cwd, source)
  const displayed = await context.current()
  setPatch(displayed.patch)
  await writeFile(join(cwd, 'file.txt'), 'changed after patch capture\n')
  const response = await (await request('/api/diff')).json()
  expect(response.patch).toBe(displayed.patch)
  // Tool-visible working content also participates in identity. Even with old
  // patch bytes the anchor must be distinct from a fresh current-patch anchor.
  expect(response.reviewRevision).toBe(
    (await context.revisionForPatch(displayed.patch)).revision,
  )
  expect(response.reviewRevision).not.toBe((await context.current()).revision)
  expect((await (await request('/api/review')).json()).revision).toBe(
    response.reviewRevision,
  )
})

it('does not block cancellation behind GitHub preflight', async () => {
  const { mutate, store, request } = await fixture({
    owner: 'o',
    repository: 'r',
    number: 1,
    title: 'PR',
    url: 'https://github.com/o/r/pull/1',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    diffBaseSha: 'a'.repeat(40),
  })
  const revision = (await (await request('/api/review')).json()).revision
  const id = randomUUID()
  await mutate('/api/threads', {
    id,
    anchor: { path: 'file.txt', side: 'RIGHT', line: 1, revision },
    text: 'Why?',
  })
  const cancel = vi.spyOn(store, 'cancel').mockResolvedValue()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const preflight = vi.spyOn(github, 'preflightReview').mockImplementation(async () => {
    await gate
    throw new Error('Test preflight stopped')
  })
  const submission = mutate('/api/review/submit', {
    id: randomUUID(),
    event: 'COMMENT',
    body: 'Summary',
    draftIds: [],
  })
  try {
    await expect.poll(() => preflight.mock.calls.length).toBe(1)
    const cancellation = mutate(`/api/threads/${id}/cancel`, {})
    await expect.poll(() => cancel.mock.calls.length).toBe(1)
    expect((await cancellation).status).toBe(200)
  } finally {
    release()
    await submission
  }
})

it.each(['published', 'publishing', 'uncertain'] as const)(
  'short-circuits latest %s publication before preflight or draft validation',
  async (status) => {
    const { mutate, store } = await fixture({
      owner: 'o',
      repository: 'r',
      number: 1,
      title: 'PR',
      url: 'https://github.com/o/r/pull/1',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      diffBaseSha: 'a'.repeat(40),
    })
    const input = {
      id: randomUUID(),
      event: 'COMMENT' as const,
      body: 'Summary',
      draftIds: [randomUUID()],
    }
    const snapshot = await store.snapshot()
    vi.spyOn(store, 'snapshot').mockResolvedValue({
      ...snapshot,
      publication: { ...input, status },
    })
    const preflight = vi.spyOn(github, 'preflightReview')
    expect((await mutate('/api/review/submit', input)).status).toBe(
      status === 'published' ? 200 : 409,
    )
    expect(preflight).not.toHaveBeenCalled()
  },
)

it.each(['COMMENT', 'REQUEST_CHANGES'] as const)(
  'rejects an empty %s summary before durable intent',
  async (event) => {
    const { mutate, store } = await fixture({
      owner: 'o',
      repository: 'r',
      number: 1,
      title: 'PR',
      url: 'https://github.com/o/r/pull/1',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      diffBaseSha: 'a'.repeat(40),
    })
    const publish = vi.spyOn(store, 'publish')
    const response = await mutate('/api/review/submit', {
      id: randomUUID(),
      event,
      body: ' ',
      draftIds: [],
    })
    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('requires')
    expect(publish).not.toHaveBeenCalled()
    expect((await store.snapshot()).publication).toBeNull()
  },
)

it('enforces origin, host, token and resource bounds while protecting legacy APIs', async () => {
  const { request, token } = await fixture()
  await Promise.all(
    (
      [
        { host: 'evil.test' },
        { origin: 'https://evil.test' },
        { 'sec-fetch-site': 'cross-site' },
      ] as Record<string, string>[]
    ).map(async (headers) => {
      expect((await request('/api/session', { headers })).status).toBe(403)
      expect((await request('/api/legacy', { method: 'POST', headers })).status).toBe(403)
    }),
  )
  expect(
    (await request('/api/session', { headers: { origin: 'http://localhost:5173' } }))
      .status,
  ).toBe(200)
  expect((await request('/api/threads', { method: 'POST' })).status).toBe(403)
  expect((await request('/api/legacy', { method: 'POST' })).status).toBe(200)
  expect(
    (
      await request('/api/threads', {
        method: 'POST',
        headers: { 'x-skepsis-token': token },
        body: 'x'.repeat(65537),
      })
    ).status,
  ).toBe(413)
})
it('persists private ask/follow-up and drafts without source writes; refuses stale anchors', async () => {
  const { cwd, open, request, mutate, store } = await fixture()
  const revision = (await (await request('/api/review')).json()).revision
  const anchor = { path: 'file.txt', side: 'RIGHT', line: 1, revision }
  const id = randomUUID()
  expect((await mutate('/api/threads', { id, anchor, text: 'Why?' })).status).toBe(200)
  await expect
    .poll(async () => (await store.snapshot()).threads[0]?.status)
    .toBe('answered')
  expect(
    (await mutate(`/api/threads/${id}/messages`, { id: randomUUID(), text: 'Explain' }))
      .status,
  ).toBe(200)
  await expect
    .poll(async () => (await store.snapshot()).threads[0]?.turns[1]?.answer)
    .toBe('Follow-up')
  const draft = { id: randomUUID(), anchor, body: 'Publish only this' }
  expect((await mutate('/api/drafts', draft, 'PUT')).status).toBe(200)
  expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('after\n')
  expect(JSON.stringify(await (await request('/api/review')).json())).not.toContain(
    'Selected excerpt',
  )
  await writeFile(join(cwd, 'file.txt'), 'new revision\n')
  expect(
    (await mutate(`/api/threads/${id}/messages`, { id: randomUUID(), text: 'Again' }))
      .status,
  ).toBe(409)
  expect((await (await request('/api/review')).json()).revision).not.toBe(revision)
  expect((await mutate('/api/drafts', { ...draft, id: randomUUID() }, 'PUT')).status).toBe(
    409,
  )
  expect(
    (await mutate('/api/drafts', { ...draft, body: 'Archived edit' }, 'PUT')).status,
  ).toBe(200)
  await store.close()
  const reopened = await open()
  expect((await reopened.store.snapshot()).drafts[0]?.body).toBe('Archived edit')
  expect((await reopened.store.snapshot()).threads[0]?.turns).toHaveLength(2)
  expect(reopened.token).not.toBe((await (await request('/api/session')).json()).token)
})

const testPr: PullRequest = {
  owner: 'o',
  repository: 'r',
  number: 1,
  title: 'PR',
  url: 'https://github.com/o/r/pull/1',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  diffBaseSha: 'a'.repeat(40),
}

it('requires a preview matching the saved draft, including cross-tab updates', async () => {
  const { request, mutate, store } = await fixture(testPr)
  const revision = (await (await request('/api/review')).json()).revision
  const draft = {
    id: randomUUID(),
    body: 'Previewed body',
    anchor: { path: 'file.txt', side: 'RIGHT' as const, line: 1, revision },
  }
  await store.saveDraft(draft)
  const input = {
    id: randomUUID(),
    event: 'COMMENT',
    body: 'Summary',
    draftIds: [draft.id],
    draftsDigest: await reviewDraftsDigest([draft]),
  }
  await store.saveDraft({ ...draft, body: 'Changed in another tab' })
  const preflight = vi.spyOn(github, 'preflightReview').mockResolvedValue()
  const send = vi
    .spyOn(github, 'publishReview')
    .mockResolvedValue({ id: 42, url: testPr.url })
  expect((await mutate('/api/review/submit', input)).status).toBe(409)
  expect(preflight).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled()
  input.draftsDigest = await reviewDraftsDigest((await store.snapshot()).drafts)
  expect((await mutate('/api/review/submit', input)).status).toBe(200)
  expect(send.mock.calls[0]?.[2][0]?.body).toBe('Changed in another tab')
})

it.each(['absent', 'found', 'offline'] as const)(
  'manual unlock rechecks GitHub (%s) and never resubmits',
  async (outcome) => {
    const { mutate, store } = await fixture(testPr)
    const input = {
      id: randomUUID(),
      event: 'COMMENT' as const,
      body: 'Summary',
      draftIds: [],
    }
    await expect(
      store.publish(input, async () => {
        throw new Error('Lost response')
      }),
    ).rejects.toThrow('Lost response')
    const find = vi.spyOn(github, 'findPublishedReview')
    if (outcome === 'offline') find.mockRejectedValue(new Error('Offline'))
    else find.mockResolvedValue(outcome === 'found' ? { id: 42, url: testPr.url } : null)
    const send = vi.spyOn(github, 'publishReview')
    expect((await mutate('/api/review/abandon', { id: input.id })).status).toBe(400)
    expect(
      (
        await mutate('/api/review/abandon', {
          id: randomUUID(),
          acknowledgement: PUBLICATION_ABANDON_ACK,
        })
      ).status,
    ).toBe(409)
    expect(find).not.toHaveBeenCalled()
    const response = await mutate('/api/review/abandon', {
      id: input.id,
      acknowledgement: PUBLICATION_ABANDON_ACK,
    })
    expect(response.status).toBe(outcome === 'offline' ? 500 : 200)
    expect(find).toHaveBeenCalledExactlyOnceWith(testPr, input.id)
    expect((await store.snapshot()).publication?.status).toBe(
      outcome === 'found' ? 'published' : outcome === 'absent' ? 'abandoned' : 'uncertain',
    )
    expect(send).not.toHaveBeenCalled()
    if (outcome === 'absent')
      expect((await mutate('/api/review/submit', input)).status).toBe(409)
  },
)

it('provider confirmation names the current target and cannot implicitly send a follow-up', async () => {
  const { mutate, store } = await fixture()
  const threadId = randomUUID()
  vi.spyOn(store, 'snapshot').mockResolvedValue({
    drafts: [],
    publication: null,
    threads: [
      {
        id: threadId,
        anchor: { path: 'file.txt', side: 'RIGHT', line: 1, revision: 'old' },
        turns: [],
        status: 'failed',
        resolved: false,
        providerChange: { from: 'previous', to: 'faux' },
      },
    ],
  })
  const confirm = vi.spyOn(store, 'confirmProvider').mockResolvedValue()
  const reply = vi.spyOn(store, 'reply')
  expect(
    (
      await mutate(`/api/threads/${threadId}/messages`, {
        id: randomUUID(),
        text: 'Follow up',
      })
    ).status,
  ).toBe(409)
  expect(reply).not.toHaveBeenCalled()
  expect(
    (await mutate(`/api/threads/${threadId}/provider`, { provider: 'wrong' })).status,
  ).toBe(409)
  expect(confirm).not.toHaveBeenCalled()
  expect(
    (await mutate(`/api/threads/${threadId}/provider`, { provider: 'faux' })).status,
  ).toBe(200)
  expect(confirm).toHaveBeenCalledExactlyOnceWith(threadId, 'faux')
  expect(reply).not.toHaveBeenCalled()
})

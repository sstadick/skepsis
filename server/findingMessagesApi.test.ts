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
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { FindingMessage, StartAgentReview } from '../shared/agentReview.ts'
import type { PullRequest } from '../shared/review.ts'
import type { DiffArgs } from '../shared/types.ts'
import * as github from './github.ts'
import { diffCommand } from './diff.ts'
import { mountReviewApi } from './reviewApi.ts'
import type { ReviewStore } from './reviewStore.ts'

const directories: string[] = []
const stores: ReviewStore[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
const pr: PullRequest = {
  owner: 'o',
  repository: 'r',
  number: 1,
  title: 'PR',
  url: 'https://github.com/o/r/pull/1',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  diffBaseSha: 'a'.repeat(40),
}
const finding = (body = 'issue: handle the error') => ({
  path: 'file.txt',
  side: 'RIGHT',
  line: 1,
  body,
})
const answer = (findings: unknown[]) =>
  JSON.stringify({ summary: 'Original summary', findings })

async function completed(store: ReviewStore, id: string) {
  await expect
    .poll(
      async () =>
        (await store.snapshot()).agentReviews.find((run) => run.id === id)?.status,
    )
    .toBe('answered')
  return (await store.snapshot()).agentReviews.find((run) => run.id === id)!
}

async function fixture(options: { defaultModel?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'finding-messages-api-'))
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
  const source: DiffArgs = {
    vcs: 'git',
    args: ['HEAD'],
    files: [],
    endpoints: { left: 'HEAD', right: 'workingCopy' },
  }
  const faux = fauxProvider({
    provider: 'faux-finding-messages',
    models: [
      { id: 'chosen', reasoning: true },
      { id: 'default', reasoning: false },
    ],
    tokensPerSecond: 100000,
    tokenSize: { min: 1024, max: 1024 },
  })
  const models = createModels()
  models.setProvider(faux.provider)
  const chosen = faux.getModel('chosen')!
  const model = { provider: chosen.provider, modelId: chosen.id }
  const publishReview = vi
    .spyOn(github, 'publishReview')
    .mockRejectedValue(new Error('Unexpected GitHub publication'))
  vi.spyOn(github, 'getPullRequestComments').mockRejectedValue(
    new Error('Unexpected GitHub fetch'),
  )
  const mount = async (enabled = true) => {
    const app = new Hono()
    const store = await mountReviewApi(app, {
      cwd,
      diffSource: source,
      getOrigin: () => 'http://localhost:4321',
      publish() {},
      review: {
        directory: join(cwd, '.review'),
        pullRequest: pr,
        models,
        model:
          options.defaultModel === false
            ? undefined
            : { provider: chosen.provider, modelId: 'default' },
        agent: {
          model: options.defaultModel === false ? null : 'default',
          available: enabled,
          enabled,
        },
        browserOrigin: 'http://localhost:5173',
      },
    })
    stores.push(store)
    app.get('/api/diff', (c) => c.json({ patch: git(...diffCommand(source).args) }))
    const request = (path: string, init?: RequestInit) =>
      app.request(`http://localhost:4321${path}`, init)
    const token = (await (await request('/api/session')).json()).token as string
    const mutate = (path: string, body: unknown) =>
      request(path, {
        method: 'POST',
        headers: { 'x-skepsis-token': token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    return { store, request, mutate, token }
  }
  const server = await mount()
  const revision = async () =>
    ((await (await server.request('/api/diff')).json()) as { reviewRevision: string })
      .reviewRevision
  const start = async (): Promise<StartAgentReview> => ({
    id: randomUUID(),
    revision: await revision(),
    prompt: 'Review the changed error path.',
    model,
    reasoningLevel: 'high',
  })
  const finish = (id: string) => completed(server.store, id)
  return { ...server, cwd, faux, models, model, mount, start, finish, publishReview }
}

it('requires the session and same origin; rejects invalid messages and unknown targets without inference on reads', async () => {
  const { cwd, faux, store, request, mutate, start, finish, token } = await fixture()
  expect((await request('/api/review')).status).toBe(200)
  expect((await request('/api/agent-review/models')).status).toBe(200)
  expect(faux.state.callCount).toBe(0)
  faux.setResponses([fauxAssistantMessage(answer([finding()]))])
  const review = await start()
  expect((await mutate('/api/agent-review', review)).status).toBe(202)
  const run = await finish(review.id)
  const path = `/api/agent-review/${run.id}/findings/${run.findings[0]!.id}/messages`
  const message: FindingMessage = { id: randomUUID(), text: 'Why is this unsafe?' }
  const progress = await request('/api/review')
  expect(progress.headers.get('cache-control')).toBe('no-store')
  expect((await progress.json()).agentReviews[0].turns).toHaveLength(1)
  expect(faux.state.callCount).toBe(1)
  expect((await request(path, { method: 'POST' })).status).toBe(403)
  expect(
    await Promise.all(
      (
        [
          { host: 'evil.test' },
          { origin: 'https://evil.test' },
          { 'sec-fetch-site': 'cross-site' },
        ] as Record<string, string>[]
      ).map(
        async (headers) =>
          (
            await request(path, {
              method: 'POST',
              headers: { ...headers, 'x-skepsis-token': token },
              body: JSON.stringify(message),
            })
          ).status,
      ),
    ),
  ).toEqual([403, 403, 403])
  const invalid = [
    { ...message, id: 'bad' },
    { ...message, text: '  ' },
    { ...message, text: 'x'.repeat(20_001) },
    { ...message, extra: true },
    { text: message.text },
  ]
  expect(
    await Promise.all(invalid.map(async (input) => (await mutate(path, input)).status)),
  ).toEqual([400, 400, 400, 400, 400])
  expect(
    (
      await mutate(
        `/api/agent-review/${randomUUID()}/findings/${run.findings[0]!.id}/messages`,
        message,
      )
    ).status,
  ).toBe(404)
  expect(
    (await mutate(`/api/agent-review/${run.id}/findings/${randomUUID()}/messages`, message))
      .status,
  ).toBe(404)
  expect(
    (
      await request(path, {
        method: 'POST',
        headers: { 'x-skepsis-token': token },
        body: 'x'.repeat(65537),
      })
    ).status,
  ).toBe(413)
  expect((await store.snapshot()).agentReviews[0]?.turns).toHaveLength(1)
  expect((await store.snapshot()).drafts).toEqual([])
  expect(faux.state.callCount).toBe(1)
  expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('after\n')
})

it('keeps follow-ups in the original pinned conversation, including after decisions, without creating drafts or publishing', async () => {
  const { cwd, faux, model, mutate, start, finish, store, publishReview } = await fixture({
    defaultModel: false,
  })
  faux.setResponses([fauxAssistantMessage(answer([finding(), finding('question: why?')]))])
  const review = await start()
  expect((await mutate('/api/agent-review', review)).status).toBe(202)
  const run = await finish(review.id)
  const [accepted, dismissed] = run.findings
  expect(accepted && dismissed).toBeTruthy()
  expect(
    (await mutate(`/api/agent-review/${run.id}/findings/${accepted!.id}/accept`, {}))
      .status,
  ).toBe(200)
  expect(
    (await mutate(`/api/agent-review/${run.id}/findings/${dismissed!.id}/dismiss`, {}))
      .status,
  ).toBe(200)
  const before = await store.snapshot()
  const firstPath = `/api/agent-review/${run.id}/findings/${accepted!.id}/messages`
  const secondPath = `/api/agent-review/${run.id}/findings/${dismissed!.id}/messages`
  const first: FindingMessage = { id: randomUUID(), text: '  Clarify the impact.  ' }
  const second: FindingMessage = {
    id: randomUUID(),
    text: 'Is the dismissed case related?',
  }
  faux.setResponses([
    (ctx, opts, _state, selectedModel) => {
      expect(selectedModel.id).toBe(model.modelId)
      expect(opts?.reasoning).toBe('high')
      const history = JSON.stringify(ctx.messages)
      expect(history).toContain(review.prompt)
      expect(history).toContain('Complete reviewed diff')
      expect(history).toContain('file.txt')
      expect(history).toContain('Clarify the impact.')
      return fauxAssistantMessage('The error path returns without handling the failure.')
    },
    (ctx, opts, _state, selectedModel) => {
      expect(selectedModel.id).toBe(model.modelId)
      expect(opts?.reasoning).toBe('high')
      const history = JSON.stringify(ctx.messages)
      expect(history).toContain('The error path returns without handling the failure.')
      expect(history).toContain(second.text)
      return fauxAssistantMessage('It is a separate case.')
    },
  ])
  const receipt = await mutate(firstPath, first)
  expect(receipt.status).toBe(202)
  expect(receipt.headers.get('cache-control')).toBe('no-store')
  await expect
    .poll(async () => (await store.snapshot()).agentReviews[0]?.turns[1]?.answer)
    .toBe('The error path returns without handling the failure.')
  expect((await mutate(secondPath, second)).status).toBe(202)
  await expect
    .poll(async () => (await store.snapshot()).agentReviews[0]?.turns[2]?.answer)
    .toBe('It is a separate case.')
  const after = await store.snapshot()
  expect(after.agentReviews[0]?.turns.slice(1)).toMatchObject([
    { id: first.id, question: 'Clarify the impact.', findingId: accepted!.id },
    { id: second.id, question: second.text, findingId: dismissed!.id },
  ])
  expect(after.agentReviews[0]?.summary).toBe(before.agentReviews[0]?.summary)
  expect(after.agentReviews[0]?.findings).toEqual(before.agentReviews[0]?.findings)
  expect(after.drafts).toEqual(before.drafts)
  expect(after.publication).toBeNull()
  expect(publishReview).not.toHaveBeenCalled()
  expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('after\n')
  expect(faux.state.callCount).toBe(3)
})

it('acknowledges exact retries before stale revision, missing auth, or --no-agent; rejects reused IDs and new stale messages', async () => {
  const { cwd, faux, models, store, mutate, start, finish, mount } = await fixture()
  faux.setResponses([
    fauxAssistantMessage(answer([finding(), finding('question: second')])),
    fauxAssistantMessage('Private explanation'),
  ])
  const review = await start()
  expect((await mutate('/api/agent-review', review)).status).toBe(202)
  const run = await finish(review.id)
  const path = `/api/agent-review/${run.id}/findings/${run.findings[0]!.id}/messages`
  const other = `/api/agent-review/${run.id}/findings/${run.findings[1]!.id}/messages`
  const message = { id: randomUUID(), text: 'Explain this finding' }
  expect((await mutate(path, message)).status).toBe(202)
  await expect
    .poll(async () => (await store.snapshot()).agentReviews[0]?.turns[1]?.answer)
    .toBe('Private explanation')
  await writeFile(join(cwd, 'file.txt'), 'new revision\n')
  const available = vi
    .spyOn(models, 'getAvailableOfType')
    .mockRejectedValue(new Error('Private authentication secret'))
  expect((await mutate(path, message)).status).toBe(202)
  expect((await mutate(path, { ...message, text: 'Different question' })).status).toBe(409)
  expect((await mutate(other, message)).status).toBe(409)
  expect((await mutate(path, { id: randomUUID(), text: message.text })).status).toBe(409)
  expect(available).not.toHaveBeenCalled()
  expect(faux.state.callCount).toBe(2)
  await store.close()
  const paused = await mount(false)
  expect((await paused.mutate(path, message)).status).toBe(202)
  expect((await paused.mutate(path, { id: randomUUID(), text: message.text })).status).toBe(
    503,
  )
  expect(available).not.toHaveBeenCalled()
  expect(faux.state.callCount).toBe(2)
})

it('refuses new chats when the pinned model loses auth or its reasoning level, without using a default', async () => {
  const { faux, models, mutate, start, finish, store } = await fixture()
  faux.setResponses([fauxAssistantMessage(answer([finding()]))])
  const review = await start()
  expect((await mutate('/api/agent-review', review)).status).toBe(202)
  const run = await finish(review.id)
  const path = `/api/agent-review/${run.id}/findings/${run.findings[0]!.id}/messages`
  const available = vi.spyOn(models, 'getAvailableOfType')
  available.mockResolvedValueOnce([faux.getModel('default')!])
  expect(
    (await mutate(path, { id: randomUUID(), text: 'Unauthenticated model?' })).status,
  ).toBe(503)
  available.mockRejectedValueOnce(new Error('Private authentication secret'))
  const failed = await mutate(path, { id: randomUUID(), text: 'Credentials failed?' })
  expect(failed.status).toBe(503)
  expect(await failed.text()).not.toContain('Private authentication secret')
  available.mockResolvedValueOnce([
    { ...faux.getModel('chosen')!, thinkingLevelMap: { high: null } },
    faux.getModel('default')!,
  ])
  expect(
    (await mutate(path, { id: randomUUID(), text: 'Unsupported reasoning?' })).status,
  ).toBe(503)
  expect((await store.snapshot()).agentReviews[0]?.turns).toHaveLength(1)
  expect(faux.state.callCount).toBe(1)
})

it('returns conflict for another outstanding follow-up, while retrying the running request is safe', async () => {
  const { faux, mutate, start, finish, store } = await fixture()
  faux.setResponses([fauxAssistantMessage(answer([finding()]))])
  const review = await start()
  expect((await mutate('/api/agent-review', review)).status).toBe(202)
  const run = await finish(review.id)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  faux.setResponses([
    async () => {
      await gate
      return fauxAssistantMessage('Late private explanation')
    },
  ])
  const path = `/api/agent-review/${run.id}/findings/${run.findings[0]!.id}/messages`
  const message = { id: randomUUID(), text: 'Please clarify' }
  try {
    expect((await mutate(path, message)).status).toBe(202)
    await expect.poll(() => faux.state.callCount).toBe(2)
    expect((await mutate(path, message)).status).toBe(202)
    expect(
      (await mutate(path, { id: randomUUID(), text: 'Another question' })).status,
    ).toBe(409)
  } finally {
    release()
  }
  await expect
    .poll(async () => (await store.snapshot()).agentReviews[0]?.turns[1]?.answer)
    .toBe('Late private explanation')
  expect((await store.snapshot()).agentReviews[0]?.findings).toEqual(run.findings)
  expect((await store.snapshot()).drafts).toEqual([])
  expect(faux.state.callCount).toBe(2)
})

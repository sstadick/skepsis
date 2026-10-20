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
import type { ClassifierModel } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { StartAgentReview } from '../shared/agentReview.ts'
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
const answer = (findings: unknown[] = []) =>
  JSON.stringify({ summary: 'Summary', findings })
const finding = (body = 'issue: handle the error') => ({
  path: 'file.txt',
  side: 'RIGHT',
  line: 1,
  body,
})

async function fixture(
  options: { enabled?: boolean; defaultModel?: boolean; slow?: boolean } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-review-api-'))
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
    provider: 'faux-review-api',
    models: [
      { id: 'chosen', reasoning: true },
      { id: 'plain', reasoning: false },
      { id: 'unavailable', reasoning: true },
    ],
    tokensPerSecond: options.slow ? 20 : 100000,
    tokenSize: options.slow ? { min: 1, max: 1 } : { min: 1024, max: 1024 },
  })
  const models = createModels()
  const chosen = faux.getModel('chosen')!
  const classifier: ClassifierModel<'test-classifier'> = {
    ...chosen,
    type: 'classifier',
    api: 'test-classifier',
    id: 'not-a-chat-model',
  }
  models.setProvider({
    ...faux.provider,
    getAllModels: () => [...faux.models, classifier],
    filterModels: (items) => items.filter((item) => item.id !== 'unavailable'),
  })
  const model = { provider: chosen.provider, modelId: chosen.id }
  const publishReview = vi
    .spyOn(github, 'publishReview')
    .mockRejectedValue(new Error('Unexpected GitHub publication'))
  vi.spyOn(github, 'getPullRequestComments').mockRejectedValue(
    new Error('Unexpected GitHub fetch'),
  )
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
      model: options.defaultModel === false ? undefined : model,
      agent: {
        model: options.defaultModel === false ? null : chosen.id,
        available: options.enabled !== false && options.defaultModel !== false,
        enabled: options.enabled !== false,
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
  const revision = async () =>
    ((await (await request('/api/diff')).json()) as { reviewRevision: string })
      .reviewRevision
  const start = async (
    changes: Partial<StartAgentReview> = {},
  ): Promise<StartAgentReview> => ({
    id: randomUUID(),
    revision: await revision(),
    prompt: 'Custom focus: check the changed error path.',
    model,
    reasoningLevel: 'high',
    ...changes,
  })
  return {
    cwd,
    store,
    faux,
    models,
    model,
    request,
    mutate,
    revision,
    start,
    token,
    publishReview,
  }
}

it('lists authenticated chat models and supported levels without running inference; selected models work without a default', async () => {
  const { faux, models, model, request, mutate, start, store } = await fixture({
    defaultModel: false,
  })
  const available = vi.spyOn(models, 'getAvailableOfType')
  const response = await request('/api/agent-review/models')
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual({
    defaultModel: null,
    models: [
      {
        ...model,
        name: faux.getModel('chosen')!.name,
        reasoningLevels: ['off', 'minimal', 'low', 'medium', 'high'],
      },
      {
        provider: model.provider,
        modelId: 'plain',
        name: faux.getModel('plain')!.name,
        reasoningLevels: ['off'],
      },
    ],
  })
  expect(available).toHaveBeenCalledWith('chat')
  expect(faux.state.callCount).toBe(0)
  expect((await store.snapshot()).agentReviews).toEqual([])
  faux.setResponses([fauxAssistantMessage(answer())])
  const input = await start()
  expect((await mutate('/api/agent-review', input)).status).toBe(202)
  await expect
    .poll(async () => (await store.snapshot()).agentReviews[0]?.status)
    .toBe('answered')
  faux.setResponses([
    (_ctx, options, _state, selectedModel) => {
      expect(selectedModel.id).toBe('plain')
      expect(['off', undefined]).toContain(options?.reasoning)
      return fauxAssistantMessage(answer())
    },
  ])
  const second = await start({
    model: { provider: model.provider, modelId: 'plain' },
    reasoningLevel: 'off',
  })
  expect((await mutate('/api/agent-review', second)).status).toBe(202)
  await expect
    .poll(async () => (await store.snapshot()).agentReviews[1]?.status)
    .toBe('answered')
  expect(faux.state.callCount).toBe(2)
})

it('starts a pending whole-diff run with the explicit prompt/model/level and keeps findings private until human acceptance', async () => {
  const { cwd, faux, model, request, mutate, store, start, token, publishReview } =
    await fixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const selected = await start()
  faux.setResponses([
    async (ctx, opts, _state, selectedModel) => {
      expect(selectedModel.id).toBe(model.modelId)
      expect(opts?.reasoning).toBe('high')
      const content = JSON.stringify(ctx.messages.findLast((item) => item.role === 'user'))
      expect(content).toContain(selected.prompt)
      expect(content).toContain('Complete reviewed diff')
      expect(content).toContain('file.txt')
      await gate
      return fauxAssistantMessage(
        answer([
          finding(),
          finding('question: why change this?'),
          finding('suggestion: add coverage'),
        ]),
      )
    },
  ])
  try {
    const response = await mutate('/api/agent-review', selected)
    expect(response.status).toBe(202)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await store.snapshot()).agentReviews).toMatchObject([
      {
        id: selected.id,
        revision: selected.revision,
        model,
        reasoningLevel: 'high',
        findings: [],
      },
    ])
    expect((await store.snapshot()).drafts).toEqual([])
  } finally {
    release()
  }
  await expect
    .poll(async () => (await store.snapshot()).agentReviews[0]?.status)
    .toBe('answered')
  const progress = await request('/api/review')
  expect(progress.headers.get('cache-control')).toBe('no-store')
  const snapshot = await progress.json()
  expect(snapshot.agentReviews[0]).toMatchObject({
    summary: 'Summary',
    status: 'answered',
    findings: [
      {
        anchor: { path: 'file.txt', side: 'RIGHT', line: 1, revision: selected.revision },
        status: 'pending',
      },
      { status: 'pending' },
      { status: 'pending' },
    ],
  })
  const [first, second, third] = snapshot.agentReviews[0].findings as {
    id: string
    body: string
    anchor: unknown
  }[]
  expect(snapshot.drafts).toEqual([])
  expect(snapshot.publication).toBeNull()
  const accept = `/api/agent-review/${selected.id}/findings/${first!.id}/accept`
  expect((await request(accept, { method: 'POST' })).status).toBe(403)
  expect((await mutate(accept, {})).status).toBe(200)
  expect((await mutate(accept, {})).status).toBe(200)
  expect((await store.snapshot()).drafts).toEqual([
    { id: first!.id, body: first!.body, anchor: first!.anchor },
  ])
  expect(
    (
      await request('/api/drafts', {
        method: 'PUT',
        headers: {
          'x-skepsis-token': token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          id: first!.id,
          body: 'Human-edited draft',
          anchor: first!.anchor,
        }),
      })
    ).status,
  ).toBe(200)
  expect((await mutate(accept, {})).status).toBe(200)
  expect((await store.snapshot()).drafts).toMatchObject([{ body: 'Human-edited draft' }])
  const dismiss = `/api/agent-review/${selected.id}/findings/${second!.id}/dismiss`
  expect((await request(dismiss, { method: 'POST' })).status).toBe(403)
  expect((await mutate(dismiss, {})).status).toBe(200)
  expect((await mutate(dismiss, {})).status).toBe(200)
  expect(
    (await mutate(`/api/agent-review/${selected.id}/findings/${third!.id}/accept`, {}))
      .status,
  ).toBe(200)
  expect(
    (await store.snapshot()).agentReviews[0]?.findings.map((item) => item.status),
  ).toEqual(['accepted', 'dismissed', 'accepted'])
  expect((await store.snapshot()).drafts).toEqual([
    { id: first!.id, anchor: first!.anchor, body: 'Human-edited draft' },
    { id: third!.id, anchor: third!.anchor, body: third!.body },
  ])
  expect((await store.snapshot()).publication).toBeNull()
  expect(publishReview).not.toHaveBeenCalled()
  expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('after\n')
})

it('rejects malformed, unsupported, unauthenticated and stale starts without inference; protects mutations and body size', async () => {
  const { cwd, faux, model, request, mutate, store, start, token } = await fixture()
  const input = await start()
  const invalid = [
    { ...input, id: 'not-a-uuid' },
    { ...input, prompt: ' ' },
    { ...input, reasoningLevel: 'unknown' },
    { ...input, extra: true },
    { ...input, prompt: 'x'.repeat(20_001) },
  ]
  expect(
    await Promise.all(
      invalid.map(
        async (candidate) => (await mutate('/api/agent-review', candidate)).status,
      ),
    ),
  ).toEqual([400, 400, 400, 400, 400])
  expect(
    (await mutate('/api/agent-review', { ...input, reasoningLevel: 'max' })).status,
  ).toBe(400)
  expect(
    (
      await mutate('/api/agent-review', {
        ...input,
        model: { ...model, modelId: 'unavailable' },
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await mutate('/api/agent-review', {
        ...input,
        model: { ...model, modelId: 'missing' },
      })
    ).status,
  ).toBe(400)
  expect((await mutate('/api/agent-review', { ...input, revision: 'old' })).status).toBe(
    409,
  )
  expect(
    (await request('/api/agent-review', { method: 'POST', body: JSON.stringify(input) }))
      .status,
  ).toBe(403)
  await Promise.all(
    (
      [
        { host: 'evil.test' },
        { origin: 'https://evil.test' },
        { 'sec-fetch-site': 'cross-site' },
      ] as Record<string, string>[]
    ).map(async (headers) => {
      expect((await request('/api/agent-review/models', { headers })).status).toBe(403)
      expect(
        (
          await request('/api/agent-review', {
            method: 'POST',
            headers: { ...headers, 'x-skepsis-token': token },
            body: JSON.stringify(input),
          })
        ).status,
      ).toBe(403)
    }),
  )
  expect(
    (
      await request('/api/agent-review/models', {
        headers: { origin: 'http://localhost:5173' },
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await request('/api/agent-review', {
        method: 'POST',
        headers: { 'x-skepsis-token': token },
        body: 'x'.repeat(65537),
      })
    ).status,
  ).toBe(413)
  expect((await store.snapshot()).agentReviews).toEqual([])
  expect(faux.state.callCount).toBe(0)
  expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('after\n')
})

it('rejects oversized diffs before inference and sanitizes model-discovery errors', async () => {
  const { cwd, faux, models, request, mutate, store, start } = await fixture()
  const available = vi
    .spyOn(models, 'getAvailableOfType')
    .mockRejectedValueOnce(new Error('private authentication secret'))
  const failed = await request('/api/agent-review/models')
  expect(failed.status).toBe(503)
  expect(await failed.text()).not.toContain('private authentication secret')
  const input = await start()
  available.mockRejectedValueOnce(new Error('private authentication secret'))
  const startFailed = await mutate('/api/agent-review', input)
  expect(startFailed.status).toBe(503)
  expect(await startFailed.text()).not.toContain('private authentication secret')
  available.mockRestore()
  await writeFile(join(cwd, 'file.txt'), 'changed\n' + 'x'.repeat(129_000) + '\n')
  const oversized = await mutate('/api/agent-review', await start())
  expect(oversized.status).toBe(413)
  expect((await store.snapshot()).agentReviews).toEqual([])
  expect(faux.state.callCount).toBe(0)
})

it('disables review model discovery and start under --no-agent', async () => {
  const { faux, models, request, mutate, start, store } = await fixture({ enabled: false })
  const available = vi.spyOn(models, 'getAvailableOfType')
  expect(await (await request('/api/agent-review/models')).json()).toMatchObject({
    models: [],
  })
  expect((await mutate('/api/agent-review', await start())).status).toBe(503)
  expect(available).not.toHaveBeenCalled()
  expect(faux.state.callCount).toBe(0)
  expect((await store.snapshot()).agentReviews).toEqual([])
})

it('refuses stale finding acceptance but starts a new run after a diff reload in the SAME server', async () => {
  const { cwd, faux, request, mutate, start, store, revision } = await fixture()
  faux.setResponses([
    fauxAssistantMessage(answer([finding()])),
    fauxAssistantMessage(answer([finding('issue: new revision')])),
  ])
  const first = await start()
  expect((await mutate('/api/agent-review', first)).status).toBe(202)
  await expect
    .poll(async () => (await store.snapshot()).agentReviews[0]?.status)
    .toBe('answered')
  const firstFinding = (await store.snapshot()).agentReviews[0]!.findings[0]!
  await writeFile(join(cwd, 'file.txt'), 'new revision\n')
  const nextRevision = await revision()
  expect(nextRevision).not.toBe(first.revision)
  expect(
    (await mutate(`/api/agent-review/${first.id}/findings/${firstFinding.id}/accept`, {}))
      .status,
  ).toBe(409)
  expect((await store.snapshot()).drafts).toEqual([])
  const next = { ...first, id: randomUUID(), revision: nextRevision }
  const response = await mutate('/api/agent-review', next)
  expect(response.status).toBe(202)
  await expect
    .poll(
      async () =>
        (await store.snapshot()).agentReviews.find((item) => item.id === next.id)?.status,
    )
    .toBe('answered')
  expect((await (await request('/api/review')).json()).revision).toBe(nextRevision)
  expect((await store.snapshot()).agentReviews[1]?.findings[0]?.anchor.revision).toBe(
    nextRevision,
  )
  expect(faux.state.callCount).toBe(2)
  expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('new revision\n')
})

it('acknowledges exact start retries after revision or authentication changes without another model call', async () => {
  const { cwd, faux, models, mutate, start, store } = await fixture()
  faux.setResponses([fauxAssistantMessage(answer([finding()]))])
  const input = await start()
  expect((await mutate('/api/agent-review', input)).status).toBe(202)
  await expect
    .poll(async () => (await store.snapshot()).agentReviews[0]?.status)
    .toBe('answered')
  await writeFile(join(cwd, 'file.txt'), 'new revision\n')
  vi.spyOn(models, 'getAvailableOfType').mockRejectedValue(
    new Error('Credentials unavailable'),
  )
  expect((await mutate('/api/agent-review', input)).status).toBe(202)
  expect(
    (await mutate('/api/agent-review', { ...input, prompt: 'Changed request' })).status,
  ).toBe(409)
  expect(faux.state.callCount).toBe(1)
  expect((await store.snapshot()).agentReviews).toHaveLength(1)
})

it('stops old active and queued reviews when the displayed diff changes', async () => {
  const { cwd, faux, request, mutate, start, store } = await fixture({ slow: true })
  faux.setResponses([fauxAssistantMessage(answer([finding('slow answer'.repeat(8))]))])
  const first = await start()
  expect((await mutate('/api/agent-review', first)).status).toBe(202)
  await expect.poll(() => faux.state.callCount).toBe(1)
  expect((await mutate('/api/agent-review', { ...first, id: randomUUID() })).status).toBe(
    202,
  )
  await writeFile(join(cwd, 'file.txt'), 'new revision\n')
  expect((await request('/api/diff')).status).toBe(200)
  await expect
    .poll(async () => (await store.snapshot()).agentReviews.map((run) => run.status))
    .toEqual(['failed', 'failed'])
  expect(
    (await store.snapshot()).agentReviews.every((run) => run.findings.length === 0),
  ).toBe(true)
  expect(faux.state.callCount).toBe(1)
})

it('cancels an in-flight run without retaining findings or creating drafts', async () => {
  const { faux, mutate, request, start, store } = await fixture({ slow: true })
  faux.setResponses([fauxAssistantMessage(answer([finding('slow answer'.repeat(8))]))])
  const input = await start()
  expect((await mutate('/api/agent-review', input)).status).toBe(202)
  await expect.poll(() => faux.state.callCount).toBe(1)
  expect(
    (await request(`/api/agent-review/${input.id}/cancel`, { method: 'POST' })).status,
  ).toBe(403)
  expect((await mutate(`/api/agent-review/${input.id}/cancel`, {})).status).toBe(200)
  await expect
    .poll(async () => (await store.snapshot()).agentReviews[0]?.status)
    .toBe('cancelled')
  expect((await store.snapshot()).agentReviews[0]?.findings).toEqual([])
  expect((await store.snapshot()).drafts).toEqual([])
})

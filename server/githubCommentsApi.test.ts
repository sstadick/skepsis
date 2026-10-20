/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, expect, it, vi } from 'vitest'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { GitHubComments } from '../shared/githubComments.ts'
import type { PullRequest } from '../shared/review.ts'
import type { DiffArgs } from '../shared/types.ts'
import * as github from './github.ts'
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
const discussion = (body: string): GitHubComments => ({
  headSha: pr.headSha,
  baseSha: pr.baseSha,
  fetchedAt: '2026-04-09T12:00:00Z',
  comments: [
    {
      id: 'comment-1',
      author: 'reviewer',
      body,
      url: `${pr.url}#issuecomment-1`,
      createdAt: '2026-04-09T11:00:00Z',
    },
  ],
  reviews: [
    {
      id: 'review-2',
      author: 'reviewer',
      body: 'Approved',
      state: 'APPROVED',
      url: `${pr.url}#pullrequestreview-2`,
      createdAt: '2026-04-09T11:00:00Z',
    },
  ],
  threads: [
    {
      id: 'thread-3',
      path: 'file.txt',
      side: 'RIGHT',
      line: 1,
      startLine: null,
      startSide: null,
      originalLine: 1,
      isOutdated: false,
      isResolved: false,
      comments: [
        {
          id: 'reply-4',
          author: 'reviewer',
          body: 'Published reply',
          url: `${pr.url}/files#discussion_r4`,
          createdAt: '2026-04-09T11:00:00Z',
        },
      ],
    },
  ],
})

async function fixture(pullRequest?: PullRequest) {
  const cwd = await mkdtemp(join(tmpdir(), 'github-comments-api-'))
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
  const faux = fauxProvider({ tokensPerSecond: 100000 })
  const models = createModels()
  models.setProvider(faux.provider)
  const publishReview = vi
    .spyOn(github, 'publishReview')
    .mockRejectedValue(new Error('Unexpected GitHub publication'))
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
      model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
      agent: { model: faux.getModel().id, available: true },
      browserOrigin: 'http://localhost:5173',
    },
  })
  stores.push(store)
  const request = (path: string, init?: RequestInit) =>
    app.request(`http://localhost:4321${path}`, init)
  const token = (await (await request('/api/session')).json()).token as string
  const refresh = (init?: RequestInit) =>
    request('/api/github/comments/refresh', {
      method: 'POST',
      headers: { 'x-skepsis-token': token },
      ...init,
    })
  return { cwd, faux, request, refresh, store, token, publishReview }
}

it('deduplicates concurrent GETs, serves cached readonly discussion and explicitly refreshes without writing private review state', async () => {
  const { cwd, faux, request, refresh, store, publishReview } = await fixture(pr)
  const original = discussion('A published comment')
  Object.freeze(original.comments[0])
  Object.freeze(original.comments)
  Object.freeze(original.reviews[0])
  Object.freeze(original.reviews)
  Object.freeze(original.threads[0]!.comments[0])
  Object.freeze(original.threads[0]!.comments)
  Object.freeze(original.threads[0])
  Object.freeze(original.threads)
  Object.freeze(original)
  const updated = discussion('Updated on explicit refresh')
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const get = vi
    .spyOn(github, 'getPullRequestComments')
    .mockImplementationOnce(async () => {
      await gate
      return original
    })
    .mockResolvedValue(updated)
  const saveDraft = vi.spyOn(store, 'saveDraft')
  const initial = await store.snapshot()
  const first = request('/api/github/comments')
  const second = request('/api/github/comments')
  const concurrentRefresh = refresh()
  try {
    await expect.poll(() => get.mock.calls.length).toBe(1)
  } finally {
    release()
  }
  const responses = await Promise.all([first, second, concurrentRefresh])
  expect(
    await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        return response.json()
      }),
    ),
  ).toEqual([original, original, original])
  expect(get).toHaveBeenCalledExactlyOnceWith(pr)
  expect((await (await request('/api/github/comments')).json()).comments[0].body).toBe(
    'A published comment',
  )
  expect(get).toHaveBeenCalledTimes(1)
  const refreshed = await refresh()
  expect(refreshed.status).toBe(200)
  expect(refreshed.headers.get('cache-control')).toBe('no-store')
  expect(await refreshed.json()).toEqual(updated)
  expect(get).toHaveBeenCalledTimes(2)
  expect(get).toHaveBeenLastCalledWith(pr)
  expect(await (await request('/api/github/comments')).json()).toEqual(updated)
  expect(get).toHaveBeenCalledTimes(2)
  expect(await store.snapshot()).toEqual(initial)
  expect(saveDraft).not.toHaveBeenCalled()
  expect(publishReview).not.toHaveBeenCalled()
  expect(faux.state.callCount).toBe(0)
  expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('after\n')
})

it('returns 404 for local diffs without fetching GitHub discussion', async () => {
  const get = vi
    .spyOn(github, 'getPullRequestComments')
    .mockRejectedValue(new Error('Unexpected GitHub fetch'))
  const { faux, request, refresh, store } = await fixture()
  expect((await request('/api/github/comments')).status).toBe(404)
  expect((await refresh()).status).toBe(404)
  expect(get).not.toHaveBeenCalled()
  expect((await store.snapshot()).drafts).toEqual([])
  expect(faux.state.callCount).toBe(0)
})

it('enforces trusted host and origin, mutation token, body bound and no-store without fetching or mutating state', async () => {
  const get = vi.spyOn(github, 'getPullRequestComments').mockResolvedValue(discussion('OK'))
  const { faux, request, refresh, store, token } = await fixture(pr)
  const initial = await store.snapshot()
  await Promise.all(
    (
      [
        { host: 'evil.test' },
        { origin: 'https://evil.test' },
        { 'sec-fetch-site': 'cross-site' },
      ] as Record<string, string>[]
    ).map(async (headers) => {
      expect((await request('/api/github/comments', { headers })).status).toBe(403)
      expect(
        (await refresh({ headers: { ...headers, 'x-skepsis-token': token } })).status,
      ).toBe(403)
    }),
  )
  expect(
    (
      await request('/api/github/comments', {
        headers: { origin: 'http://localhost:5173' },
      })
    ).status,
  ).toBe(200)
  expect((await refresh({ headers: {} })).status).toBe(403)
  expect(
    (
      await refresh({
        headers: { 'x-skepsis-token': token },
        body: 'x'.repeat(65537),
      })
    ).status,
  ).toBe(413)
  expect(get).toHaveBeenCalledTimes(1)
  expect(await store.snapshot()).toEqual(initial)
  expect(faux.state.callCount).toBe(0)
})

it('sanitizes GitHub errors, never caches failures and retries without a model call or state write', async () => {
  const secret = 'ghp_DO_NOT_ECHO_TEST_SECRET'
  const get = vi
    .spyOn(github, 'getPullRequestComments')
    .mockRejectedValueOnce(new Error(`gh stderr: ${secret}`))
    .mockResolvedValue(discussion('Published'))
  const { faux, request, store } = await fixture(pr)
  const initial = await store.snapshot()
  const failed = await request('/api/github/comments')
  expect(failed.status).toBe(502)
  expect(failed.headers.get('cache-control')).toBe('no-store')
  const error = await failed.text()
  expect(error).toContain('Unable to load GitHub comments')
  expect(error).not.toContain(secret)
  expect((await (await request('/api/github/comments')).json()).comments[0].body).toBe(
    'Published',
  )
  expect(get).toHaveBeenCalledTimes(2)
  expect(await store.snapshot()).toEqual(initial)
  expect(faux.state.callCount).toBe(0)
})

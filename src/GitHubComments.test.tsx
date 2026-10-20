// @vitest-environment happy-dom
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GitHubComments, GitHubReviewThread } from '../shared/githubComments.ts'
import type { PullRequest } from '../shared/review.ts'
import {
  GitHubCommentsPanel,
  GitHubThread,
  useGitHubComments,
  type GitHubCommentsController,
} from './GitHubComments.tsx'

const pr: PullRequest = {
  owner: 'oxidecomputer',
  repository: 'skepsis',
  number: 12,
  url: 'https://github.com/oxidecomputer/skepsis/pull/12',
  title: 'Review comments',
  headSha: 'head',
  baseSha: 'base',
  diffBaseSha: 'diff-base',
}
const timestamp = '2026-01-02T03:04:05Z'
const githubLink = `${pr.url}#issuecomment-123`
const thread: GitHubReviewThread = {
  id: 'thread-1',
  path: 'src/file.ts',
  side: 'RIGHT',
  line: 14,
  startLine: 11,
  startSide: 'RIGHT',
  originalLine: 8,
  isOutdated: true,
  isResolved: true,
  comments: [
    {
      id: 'reply-1',
      author: 'alice',
      body: 'First **inline** point',
      url: `${pr.url}#discussion_r1`,
      createdAt: timestamp,
    },
    {
      id: 'reply-2',
      author: 'bob',
      body: 'A follow-up',
      url: `${pr.url}#discussion_r2`,
      createdAt: timestamp,
    },
  ],
}
const snapshot: GitHubComments = {
  headSha: pr.headSha,
  baseSha: pr.baseSha,
  fetchedAt: timestamp,
  comments: [
    {
      id: 'conversation-1',
      author: 'contributor',
      body: 'A public **conversation**. ![Tracker](https://tracker.example/pixel.png)\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert%281%29)',
      url: githubLink,
      createdAt: timestamp,
    },
  ],
  reviews: [
    {
      id: 'review-1',
      author: 'reviewer',
      body: 'Looks good',
      state: 'APPROVED',
      url: 'https://github.com.evil.example/phishing',
      createdAt: timestamp,
    },
  ],
  threads: [thread],
}

let container: HTMLDivElement
let root: Root
let qc: QueryClient
let selectedPr: PullRequest | null | undefined
let controller: GitHubCommentsController
let navigate: ReturnType<typeof vi.fn<(thread: GitHubReviewThread) => void>>
let requests: { path: string; method: string; token?: string | null }[]
let getResponse: () => Promise<Response>
let postResponse: () => Promise<Response>

function Harness() {
  controller = useGitHubComments(selectedPr)
  return <GitHubCommentsPanel comments={controller} onNavigate={navigate} />
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}
async function render(prValue: PullRequest | null | undefined) {
  selectedPr = prValue
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <Harness />
      </QueryClientProvider>,
    ),
  )
  await flush()
}
async function expand() {
  await act(async () => container.querySelector('summary')!.click())
}
async function refresh() {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('.github-comments-toolbar button')!.click()
  })
  await flush()
}

beforeEach(() => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  qc = new QueryClient({
    defaultOptions: { queries: { retry: 4 }, mutations: { retry: 4 } },
  })
  navigate = vi.fn()
  requests = []
  getResponse = async () => Response.json(snapshot)
  postResponse = async () => Response.json(snapshot)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/session') return Response.json({ token: 'test-session-token' })
      const method = init?.method ?? 'GET'
      requests.push({
        path,
        method,
        token: new Headers(init?.headers).get('x-skepsis-token'),
      })
      if (path === '/api/github/comments' && method === 'GET') return getResponse()
      if (path === '/api/github/comments/refresh' && method === 'POST')
        return postResponse()
      throw new Error(`Unexpected request ${method} ${path}`)
    }),
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  qc.clear()
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('only queries for a PR with a scoped key and does not poll, retry, or refetch on focus', async () => {
  await render(null)
  expect(requests).toEqual([])
  expect(controller.data).toBeUndefined()
  expect(controller.isPending).toBe(false)
  await render(pr)
  expect(requests).toEqual([{ path: '/api/github/comments', method: 'GET', token: null }])
  expect(controller.data).toEqual(snapshot)
  const key = [
    'github-comments',
    JSON.stringify([pr.owner, pr.repository, pr.number, pr.baseSha, pr.headSha]),
  ]
  const query = qc.getQueryCache().find({ queryKey: key })!
  expect(query.options).toMatchObject({
    enabled: true,
    staleTime: 30_000,
    retry: false,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  })
  await act(async () => window.dispatchEvent(new Event('focus')))
  await flush()
  await render({ ...pr, headSha: 'new-head' })
  expect(requests).toHaveLength(2)
  await render(undefined)
  expect(controller.data).toBeUndefined()
  expect(requests).toHaveLength(2)
})

it('shows loading until the PR discussion arrives', async () => {
  let respond!: (value: Response) => void
  getResponse = () => new Promise((resolve) => (respond = resolve))
  await render(pr)
  await expand()
  expect(controller.isPending).toBe(true)
  expect(controller.isFetching).toBe(true)
  expect(container.querySelector('[role="status"]')!.textContent).toContain(
    'Loading GitHub comments',
  )
  await act(async () => respond(Response.json(snapshot)))
  await flush()
  expect(controller.isPending).toBe(false)
  expect(controller.isFetching).toBe(false)
  expect(container.querySelector('[role="status"]')).toBeNull()
})

it('shows published conversation, reviews, and grouped inline replies with safe Markdown', async () => {
  await render(pr)
  expect(container.querySelector('summary')!.textContent).toContain('Published on GitHub')
  expect(container.querySelector('.github-comments-count')!.textContent).toBe('4')
  await expand()
  expect(container.textContent).toContain('separate from private conversations and drafts')
  expect(container.querySelector('[aria-label="PR conversation"] h3')!.textContent).toBe(
    'Conversation (1)',
  )
  expect(container.querySelector('[aria-label="Published reviews"] h3')!.textContent).toBe(
    'Reviews (1)',
  )
  expect(container.querySelector('[aria-label="Inline threads"] h3')!.textContent).toBe(
    'Inline threads (1)',
  )
  expect(container.querySelectorAll('[aria-label="Thread replies"] > li')).toHaveLength(2)
  expect(container.querySelector('.github-thread-location')!.textContent).toBe(
    'src/file.ts:11–14 (new)',
  )
  expect(container.querySelectorAll('.github-thread-label')).toHaveLength(2)
  expect(container.querySelector('.github-comment-state')!.textContent?.trim()).toBe(
    'approved',
  )
  expect(container.querySelectorAll(`time[datetime="${timestamp}"]`)).toHaveLength(4)
  expect(container.querySelectorAll('script, img, iframe, [src], [onerror]')).toHaveLength(
    0,
  )
  expect(container.textContent).toContain('[Image: Tracker]')
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
  expect(
    container.querySelector('a[href="https://github.com.evil.example/phishing"]'),
  ).toBeNull()
  const github = container.querySelector<HTMLAnchorElement>(`a[href="${githubLink}"]`)!
  expect(github).toBeTruthy()
  expect(github.rel).toBe('noopener noreferrer')
  expect(github.target).toBe('_blank')
  expect(requests).toHaveLength(1)
  // An outdated line cannot safely be located in the currently served diff.
  expect(container.querySelector('.github-thread-heading button')).toBeNull()
  expect(navigate).not.toHaveBeenCalled()
  expect(requests).toHaveLength(1)
})

it('navigates a current inline thread to its diff location', async () => {
  const current = { ...thread, id: 'current-thread', isOutdated: false }
  getResponse = async () =>
    Response.json({ ...snapshot, threads: [thread, current] } satisfies GitHubComments)
  await render(pr)
  await expand()
  const headings = container.querySelectorAll('.github-thread-heading')
  expect(headings).toHaveLength(2)
  expect(headings[0]!.querySelector('button')).toBeNull()
  const button = headings[1]!.querySelector<HTMLButtonElement>('button')!
  expect(button.textContent).toBe('Show in diff')
  await act(async () => button.click())
  expect(navigate).toHaveBeenCalledExactlyOnceWith(current)
  expect(requests).toHaveLength(1)
})

it('authenticates an explicit refresh and replaces the cached snapshot without an extra GET', async () => {
  await render(pr)
  await expand()
  let respond!: (value: Response) => void
  postResponse = () => new Promise((resolve) => (respond = resolve))
  await refresh()
  expect(controller.refreshing).toBe(true)
  expect(container.textContent).toContain('Refreshing GitHub comments…')
  expect(
    container.querySelector<HTMLButtonElement>('.github-comments-toolbar button')!.disabled,
  ).toBe(true)
  expect(requests).toEqual([
    { path: '/api/github/comments', method: 'GET', token: null },
    {
      path: '/api/github/comments/refresh',
      method: 'POST',
      token: 'test-session-token',
    },
  ])
  const updated: GitHubComments = {
    ...snapshot,
    comments: [],
    reviews: [],
    threads: [],
    fetchedAt: '2026-01-03T00:00:00Z',
  }
  await act(async () => respond(Response.json(updated)))
  await flush()
  expect(controller.refreshing).toBe(false)
  expect(controller.data).toEqual(updated)
  expect(container.querySelector('.github-comments-count')!.textContent).toBe('0')
  expect(container.textContent).toContain('No published GitHub comments yet.')
  expect(requests).toHaveLength(2)
})

it('does not put a previous PR refresh into a different revision’s cache', async () => {
  await render(pr)
  await expand()
  let respond!: (value: Response) => void
  postResponse = () => new Promise((resolve) => (respond = resolve))
  await refresh()
  const nextPr = { ...pr, headSha: 'next-head' }
  const nextSnapshot = { ...snapshot, headSha: nextPr.headSha, comments: [] }
  getResponse = async () => Response.json(nextSnapshot)
  await render(nextPr)
  expect(controller.data).toEqual(nextSnapshot)
  expect(controller.refreshing).toBe(false)
  await act(async () => respond(Response.json({ ...snapshot, reviews: [] })))
  await flush()
  expect(controller.data).toEqual(nextSnapshot)
  expect(requests.filter((request) => request.method === 'GET')).toHaveLength(2)
})

it('shows GET and refresh errors without retries or discarding successfully loaded comments', async () => {
  getResponse = async () => Response.json({ error: 'GitHub unavailable' }, { status: 503 })
  await render(pr)
  await expand()
  expect(container.querySelector('[role="alert"]')!.textContent).toContain(
    'GitHub unavailable',
  )
  expect(requests).toHaveLength(1)
  postResponse = async () => Response.json(snapshot)
  await refresh()
  expect(controller.error).toBeNull()
  expect(controller.data).toEqual(snapshot)
  postResponse = async () => Response.json({ error: 'Refresh denied' }, { status: 403 })
  await refresh()
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('Refresh denied')
  expect(controller.data).toEqual(snapshot)
  expect(requests).toHaveLength(3)
})

it('can render a standalone multiline thread and an outdated original-line anchor', async () => {
  await act(async () =>
    root.render(
      <GitHubThread
        thread={{
          ...thread,
          startSide: 'LEFT',
          isResolved: false,
          comments: [
            { ...thread.comments[0]!, url: ` \n${pr.url}#discussion_r1` },
            thread.comments[1]!,
          ],
        }}
      />,
    ),
  )
  expect(container.querySelector('.github-thread-location')!.textContent).toContain(
    '11–14 (old → new)',
  )
  expect(container.querySelector('.github-thread-label')!.textContent).toBe('Open')
  expect(container.querySelectorAll('a')).toHaveLength(1)
  await act(async () => root.render(<GitHubThread thread={{ ...thread, line: null }} />))
  expect(container.querySelector('.github-thread-location')!.textContent).toContain(
    'original line 8',
  )
  expect(container.querySelectorAll('[aria-label="Thread replies"] li')).toHaveLength(2)
  expect(container.querySelector('.github-thread-heading button')).toBeNull()
  expect(requests).toEqual([])
})

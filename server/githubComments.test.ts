/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import type { PullRequest } from '../shared/review.ts'
import { createGitHubCommentsClient } from './githubComments.ts'
import type { GitHubCommand, GitHubRunner } from './github.ts'

const pr: PullRequest = {
  owner: 'oxidecomputer',
  repository: 'skepsis',
  number: 42,
  url: 'https://github.com/oxidecomputer/skepsis/pull/42',
  title: 'A PR',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  diffBaseSha: 'c'.repeat(40),
}
const comment = (id: number) => ({
  id: `comment-${id}`,
  author: { login: 'reviewer' },
  body: `Comment ${id}`,
  url: `${pr.url}#issuecomment-${id}`,
  createdAt: '2026-04-09T12:00:00Z',
})
const review = (id: number, state = 'APPROVED') => ({
  ...comment(id),
  id: `review-${id}`,
  url: `${pr.url}#pullrequestreview-${id}`,
  state,
})
const threadComment = (id: number, state = 'COMMENTED') => ({
  ...comment(id),
  pullRequestReview: { state },
})
const thread = (id: number, first = connection([threadComment(id)])) => ({
  id: `thread-${id}`,
  path: 'src/a.ts',
  diffSide: 'RIGHT',
  line: 12,
  startLine: 10,
  startDiffSide: 'LEFT',
  originalLine: 8,
  isResolved: false,
  isOutdated: false,
  comments: first,
})
function connection(nodes: unknown[], next: string | null = null) {
  return { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } }
}
type Kind = 'comments' | 'reviews' | 'reviewThreads' | 'replies'
interface Request {
  query: string
  variables: Record<string, unknown>
}
function kind(query: string): Kind {
  if (query.includes('node(id: $threadId)')) return 'replies'
  if (query.includes('reviewThreads(first:')) return 'reviewThreads'
  if (query.includes('reviews(first:')) return 'reviews'
  return 'comments'
}
function reply(type: Kind, payload: unknown, headSha = pr.headSha, baseSha = pr.baseSha) {
  return {
    data: {
      repository: {
        pullRequest: {
          headRefOid: headSha,
          baseRefOid: baseSha,
          ...(type === 'replies' ? {} : { [type]: payload }),
        },
      },
      ...(type === 'replies' ? { node: payload } : {}),
    },
  }
}
function transport(
  handler: (type: Kind, request: Request) => unknown = (type, request) => {
    if (type === 'replies')
      return reply(type, { id: request.variables.threadId, comments: connection([]) })
    return reply(type, connection(type === 'reviewThreads' ? [thread(1)] : [comment(1)]))
  },
) {
  const calls: { command: GitHubCommand; request: Request; type: Kind }[] = []
  const runner: GitHubRunner = async (command) => {
    const request = JSON.parse(command.input!) as Request
    const type = kind(request.query)
    calls.push({ command, request, type })
    return JSON.stringify(handler(type, request))
  }
  return { client: createGitHubCommentsClient(runner), calls }
}

describe('read-only GitHub discussion', () => {
  it('collects each connection and every reply page, excluding pending reviews', async () => {
    const { client, calls } = transport((type, request) => {
      const { after, threadId } = request.variables
      if (type === 'comments')
        return reply(
          type,
          after ? connection([comment(2)]) : connection([comment(1)], 'c-next'),
        )
      if (type === 'reviews')
        return reply(
          type,
          after
            ? connection([review(4, 'DISMISSED')])
            : connection([review(2, 'PENDING'), { ...review(3), author: null }], 'r-next'),
        )
      if (type === 'reviewThreads')
        return reply(
          type,
          after
            ? connection([
                {
                  ...thread(2, connection([])),
                  path: '-a.ts',
                  line: null,
                  startLine: null,
                  startDiffSide: null,
                  originalLine: null,
                  isOutdated: true,
                  isResolved: true,
                },
              ])
            : connection([thread(1, connection([threadComment(5)], 'reply-1'))], 't-next'),
        )
      return reply(type, {
        id: threadId,
        comments:
          after === 'reply-1'
            ? connection([threadComment(6)], 'reply-2')
            : connection([threadComment(7)]),
      })
    })
    const discussion = await client.getPullRequestComments(pr)
    expect(discussion).toEqual({
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      fetchedAt: expect.any(String),
      comments: [
        {
          id: 'comment-1',
          author: 'reviewer',
          body: 'Comment 1',
          url: comment(1).url,
          createdAt: comment(1).createdAt,
        },
        {
          id: 'comment-2',
          author: 'reviewer',
          body: 'Comment 2',
          url: comment(2).url,
          createdAt: comment(2).createdAt,
        },
      ],
      reviews: [
        {
          id: 'review-3',
          author: '[deleted]',
          body: 'Comment 3',
          url: review(3).url,
          createdAt: review(3).createdAt,
          state: 'APPROVED',
        },
        {
          id: 'review-4',
          author: 'reviewer',
          body: 'Comment 4',
          url: review(4).url,
          createdAt: review(4).createdAt,
          state: 'DISMISSED',
        },
      ],
      threads: [
        {
          id: 'thread-1',
          path: 'src/a.ts',
          side: 'RIGHT',
          line: 12,
          startLine: 10,
          startSide: 'LEFT',
          originalLine: 8,
          isResolved: false,
          isOutdated: false,
          comments: [5, 6, 7].map((id) => ({
            id: `comment-${id}`,
            author: 'reviewer',
            body: `Comment ${id}`,
            url: comment(id).url,
            createdAt: comment(id).createdAt,
          })),
        },
      ],
    })
    expect(Number.isFinite(Date.parse(discussion.fetchedAt))).toBe(true)
    expect(calls.map((call) => call.type)).toEqual([
      'comments',
      'comments',
      'reviews',
      'reviews',
      'reviewThreads',
      'reviewThreads',
      'replies',
      'replies',
    ])
    for (const { command, request, type } of calls) {
      expect(command.command).toBe('gh')
      expect(command.args).toEqual([
        'api',
        'graphql',
        '--hostname',
        'github.com',
        '--method',
        'POST',
        '--input',
        '-',
      ])
      expect(command.cwd).toBeUndefined()
      expect(request.query).toMatch(/^query\(/)
      expect(request.query).not.toMatch(/\bmutation\b/)
      if (type === 'replies' || type === 'reviewThreads')
        expect(request.query).toContain('pullRequestReview { state }')
      else expect(request.query).not.toContain('pullRequestReview { state }')
      expect(request.variables).toMatchObject({
        owner: pr.owner,
        repository: pr.repository,
        number: 42,
      })
    }
    expect(
      calls
        .filter(({ type }) => type === 'replies')
        .map(({ request }) => request.variables.after),
    ).toEqual(['reply-1', 'reply-2'])
  })

  it('filters pending thread comments on every page and omits pending-only threads', async () => {
    const privateComment = (id: number) => ({
      ...threadComment(id, 'PENDING'),
      body: 'Private draft: never publish this',
    })
    const { client, calls } = transport((type, request) => {
      if (type === 'reviewThreads')
        return reply(
          type,
          connection([
            thread(1, connection([privateComment(1), threadComment(2)], 'next')),
            thread(2, connection([privateComment(3)], 'next')),
            thread(3, connection([privateComment(4)])),
          ]),
        )
      if (type === 'replies')
        return reply(type, {
          id: request.variables.threadId,
          comments: connection(
            request.variables.threadId === 'thread-1'
              ? [privateComment(5), threadComment(6, 'DISMISSED')]
              : [privateComment(7)],
          ),
        })
      return reply(type, connection([]))
    })
    const discussion = await client.getPullRequestComments(pr)
    expect(discussion.threads).toHaveLength(1)
    expect(discussion.threads[0]?.id).toBe('thread-1')
    expect(discussion.threads[0]?.comments.map(({ id }) => id)).toEqual([
      'comment-2',
      'comment-6',
    ])
    expect(JSON.stringify(discussion)).not.toContain('Private draft')
    expect(calls.filter(({ type }) => type === 'replies')).toHaveLength(2)
  })

  it.each([
    { owner: 'a/b' },
    { repository: '..' },
    { number: 0 },
    { url: 'https://github.com/other/skepsis/pull/42' },
    { headSha: 'not-a-sha' },
  ])('rejects invalid PR input without a network call: %j', async (change) => {
    const { client, calls } = transport()
    await expect(client.getPullRequestComments({ ...pr, ...change })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it.each([
    'http://github.com/oxidecomputer/skepsis/pull/42#c',
    'https://github.com.evil/oxidecomputer/skepsis/pull/42#c',
    'https://attacker@github.com/oxidecomputer/skepsis/pull/42#c',
    'https://github.com/oxidecomputer/other/pull/42#c',
    'https://github.com/oxidecomputer/skepsis/pull/43#c',
    'https://github.com/oxidecomputer/skepsis/pull/42?redirect=bad',
    'https://github.com/oxidecomputer/skepsis/pull/42/../43#c',
  ])('rejects untrusted comment URL %s', async (url) => {
    const { client } = transport((type) =>
      reply(type, connection([{ ...comment(1), url }])),
    )
    await expect(client.getPullRequestComments(pr)).rejects.toThrow('URL')
  })

  it.each([
    { id: '' },
    { body: 1 },
    { author: {} },
    { createdAt: 'yesterday' },
    { url: null },
  ])('rejects malformed comment data %j', async (change) => {
    const { client } = transport((type) =>
      reply(type, connection([{ ...comment(1), ...change }])),
    )
    await expect(client.getPullRequestComments(pr)).rejects.toThrow()
  })

  it.each([
    { diffSide: 'BOTH' },
    { line: 0 },
    { startLine: -1 },
    { startDiffSide: 'BOTH' },
    { originalLine: 1.5 },
    { isResolved: null },
    { path: '../secrets' },
    { comments: { nodes: [] } },
  ])('rejects malformed thread data %j', async (change) => {
    const { client } = transport((type) =>
      reply(
        type,
        connection(type === 'reviewThreads' ? [{ ...thread(1), ...change }] : []),
      ),
    )
    await expect(client.getPullRequestComments(pr)).rejects.toThrow()
  })

  it.each([
    { label: 'unknown state', pullRequestReview: { state: 'UNKNOWN' } },
    { label: 'missing review', pullRequestReview: null },
    { label: 'missing state', pullRequestReview: {} },
  ])('rejects $label on both initial and reply thread pages', async (change) => {
    const malformed = { ...threadComment(1), pullRequestReview: change.pullRequestReview }
    for (const placement of ['initial', 'reply']) {
      const { client } = transport((type) => {
        if (type === 'replies')
          return reply(type, { id: 'thread-1', comments: connection([malformed]) })
        return reply(
          type,
          connection(
            type === 'reviewThreads'
              ? [
                  thread(
                    1,
                    connection(
                      [placement === 'initial' ? malformed : threadComment(2)],
                      placement === 'reply' ? 'next' : null,
                    ),
                  ),
                ]
              : [],
          ),
        )
      })
      // oxlint-disable-next-line no-await-in-loop
      await expect(client.getPullRequestComments(pr)).rejects.toThrow()
    }
  })

  it('rejects unknown review state and incomplete or malformed GraphQL results', async () => {
    const cases = [
      (type: Kind) =>
        reply(type, connection(type === 'reviews' ? [review(1, 'UNKNOWN')] : [])),
      () => ({
        errors: [{ message: 'private diagnostic' }],
        ...reply('comments', connection([])),
      }),
      () => ({ data: { repository: { pullRequest: null } } }),
      (type: Kind) =>
        reply(type, {
          nodes: [comment(1)],
          pageInfo: { hasNextPage: true, endCursor: null },
        }),
      (type: Kind) =>
        reply(type, { nodes: null, pageInfo: { hasNextPage: false, endCursor: null } }),
    ]
    for (const handler of cases) {
      // oxlint-disable-next-line no-await-in-loop
      await expect(
        transport((type) => handler(type)).client.getPullRequestComments(pr),
      ).rejects.toThrow()
    }
    await expect(
      createGitHubCommentsClient(async () => '{').getPullRequestComments(pr),
    ).rejects.toThrow('JSON')
  })

  it('fails when the PR revision changes on a top-level or nested page', async () => {
    const changed = 'd'.repeat(40)
    const top = transport((type, request) =>
      reply(
        type,
        connection(
          type === 'comments' ? [comment(request.variables.after ? 2 : 1)] : [],
          type === 'comments' && !request.variables.after ? 'next' : null,
        ),
        request.variables.after ? changed : pr.headSha,
      ),
    )
    await expect(top.client.getPullRequestComments(pr)).rejects.toThrow('changed')
    expect(top.calls).toHaveLength(2)

    const nested = transport((type) =>
      type === 'replies'
        ? reply(
            type,
            { id: 'thread-1', comments: connection([threadComment(2)]) },
            pr.headSha,
            changed,
          )
        : reply(
            type,
            connection(
              type === 'reviewThreads'
                ? [thread(1, connection([threadComment(1)], 'next'))]
                : [],
            ),
          ),
    )
    await expect(nested.client.getPullRequestComments(pr)).rejects.toThrow('changed')
    expect(nested.calls.at(-1)?.type).toBe('replies')
  })

  it('rejects duplicate IDs and repeated cursors rather than mixing snapshots', async () => {
    const duplicate = transport((type, request) =>
      reply(
        type,
        connection(
          type === 'comments' ? [comment(1)] : [],
          type === 'comments' && !request.variables.after ? 'next' : null,
        ),
      ),
    )
    await expect(duplicate.client.getPullRequestComments(pr)).rejects.toThrow('changed')
    let count = 0
    const cursor = transport((type) =>
      reply(
        type,
        connection(
          type === 'comments' ? [comment(++count)] : [],
          type === 'comments' ? 'next' : null,
        ),
      ),
    )
    await expect(cursor.client.getPullRequestComments(pr)).rejects.toThrow(
      'cursor repeated',
    )
  })

  it('fails closed at the top-level and nested pagination limits', async () => {
    const top = transport((type, request) =>
      reply(
        type,
        connection(
          type === 'comments' ? [comment(Number(request.variables.after ?? 0) + 1)] : [],
          type === 'comments' ? String(Number(request.variables.after ?? 0) + 1) : null,
        ),
      ),
    )
    await expect(top.client.getPullRequestComments(pr)).rejects.toThrow('pagination limit')
    expect(top.calls).toHaveLength(20)

    const nested = transport((type, request) =>
      type === 'replies'
        ? reply(type, {
            id: 'thread-1',
            comments: connection(
              [threadComment(Number(request.variables.after) + 1)],
              String(Number(request.variables.after) + 1),
            ),
          })
        : reply(
            type,
            connection(
              type === 'reviewThreads'
                ? [thread(1, connection([threadComment(1)], '1'))]
                : [],
            ),
          ),
    )
    await expect(nested.client.getPullRequestComments(pr)).rejects.toThrow(
      'pagination limit',
    )
    expect(nested.calls.filter(({ type }) => type === 'replies')).toHaveLength(19)
  })

  it.each(['wrong thread', 'duplicate reply', 'repeated cursor'])(
    'rejects %s during reply pagination',
    async (failure) => {
      const calls = { replies: 0 }
      const { client } = transport((type) => {
        if (type === 'replies') {
          calls.replies++
          return reply(type, {
            id: failure === 'wrong thread' ? 'thread-2' : 'thread-1',
            comments: connection(
              [threadComment(failure === 'duplicate reply' ? 1 : calls.replies + 1)],
              failure === 'repeated cursor' ? 'next' : null,
            ),
          })
        }
        return reply(
          type,
          connection(
            type === 'reviewThreads'
              ? [thread(1, connection([threadComment(1)], 'next'))]
              : [],
          ),
        )
      })
      await expect(client.getPullRequestComments(pr)).rejects.toThrow()
      expect(calls.replies).toBe(1)
    },
  )

  it('bounds the UTF-8 bytes of all GraphQL responses combined', async () => {
    // Each page is below 16 MiB, but their combined byte count exceeds it.
    const padding = 'é'.repeat(4 * 1024 * 1024)
    const { client, calls } = transport((type) => ({
      ...reply(type, connection([comment(1)], 'next')),
      padding,
    }))
    await expect(client.getPullRequestComments(pr)).rejects.toThrow('size limit')
    expect(calls.map(({ type }) => type)).toEqual(['comments', 'comments'])
  })

  it.each([1, 2])('does not expose runner errors from request %i', async (failedAt) => {
    let requests = 0
    const client = createGitHubCommentsClient(async () => {
      if (++requests === failedAt)
        throw new Error('gh stderr: private token and discussion details')
      return JSON.stringify(reply('comments', connection([comment(1)], 'next')))
    })
    await expect(client.getPullRequestComments(pr)).rejects.toThrow(
      /^GitHub discussion request failed\.$/,
    )
    expect(requests).toBe(failedAt)
  })

  it('bounds aggregate requests across many paginated threads', async () => {
    const many = transport((type, request) => {
      if (type === 'replies')
        return reply(type, {
          id: request.variables.threadId,
          comments: connection([threadComment(999)]),
        })
      if (type !== 'reviewThreads') return reply(type, connection([]))
      const page = Number(request.variables.after ?? 0)
      const nodes = Array.from({ length: page === 4 ? 1 : 50 }, (_, index) =>
        thread(
          page * 50 + index + 1,
          connection([threadComment(page * 50 + index + 1)], 'next'),
        ),
      )
      return reply(type, connection(nodes, page < 4 ? String(page + 1) : null))
    })
    await expect(many.client.getPullRequestComments(pr)).rejects.toThrow('pagination limit')
    expect(many.calls).toHaveLength(200)
  })
})

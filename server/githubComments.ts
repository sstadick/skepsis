/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import type {
  GitHubComment,
  GitHubComments,
  GitHubReview,
  GitHubReviewThread,
} from '../shared/githubComments.ts'
import type { PullRequest } from '../shared/review.ts'
import type { GitHubRunner } from './github.ts'

const PAGE_SIZE = 50
const MAX_PAGES = 20 // Per connection, including each thread's reply connection.
const MAX_REQUESTS = 200 // Also bounds the number of threads with paginated replies.
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024 // Across all GraphQL responses for one read.
const PAGE_INFO = 'pageInfo { hasNextPage endCursor }'
const COMMENT_FIELDS = 'id author { login } body url createdAt'
const THREAD_COMMENT_FIELDS = `${COMMENT_FIELDS} pullRequestReview { state }`
const THREAD_FIELDS = `id path diffSide line startLine startDiffSide originalLine isOutdated isResolved
  comments(first: ${PAGE_SIZE}) { nodes { ${THREAD_COMMENT_FIELDS} } ${PAGE_INFO} }`
const PULL = 'repository(owner: $owner, name: $repository) { pullRequest(number: $number)'

// Each request carries the PR revision, including requests for a single thread's
// replies. GraphQL errors (even alongside data) and incomplete connections fail.
function connectionQuery(field: 'comments' | 'reviews' | 'reviewThreads'): string {
  const fields =
    field === 'reviewThreads'
      ? THREAD_FIELDS
      : `${COMMENT_FIELDS}${field === 'reviews' ? ' state' : ''}`
  return `query($owner: String!, $repository: String!, $number: Int!, $after: String) {
    ${PULL} { headRefOid baseRefOid
      ${field}(first: ${PAGE_SIZE}, after: $after) { nodes { ${fields} } ${PAGE_INFO} }
    } }
  }`
}

const repliesQuery = `query($owner: String!, $repository: String!, $number: Int!, $threadId: ID!, $after: String) {
  ${PULL} { headRefOid baseRefOid } }
  node(id: $threadId) { ... on PullRequestReviewThread {
    id comments(first: ${PAGE_SIZE}, after: $after) { nodes { ${THREAD_COMMENT_FIELDS} } ${PAGE_INFO} }
  } }
}`

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('GitHub returned invalid discussion data.')
  return value as RecordValue
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('GitHub returned invalid discussion data.')
  return value
}

function identifier(value: unknown): string {
  const id = text(value)
  if (!id || id.length > 512) throw new Error('GitHub returned an invalid discussion ID.')
  return id
}

function revision(value: unknown): string {
  const sha = text(value)
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw new Error('GitHub returned an invalid PR revision.')
  return sha
}

function commentUrl(value: unknown, pr: PullRequest): string {
  const url = text(value)
  if (url.length > 4096) throw new Error('GitHub returned an invalid comment URL.')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('GitHub returned an invalid comment URL.')
  }
  const prefix = `/${pr.owner}/${pr.repository}`.toLowerCase()
  if (
    url !== parsed.href ||
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    ![
      `${prefix}/pull/${pr.number}`,
      `${prefix}/pull/${pr.number}/files`,
      `${prefix}/issues/${pr.number}`,
    ].includes(parsed.pathname.toLowerCase())
  ) {
    throw new Error('GitHub returned an invalid comment URL.')
  }
  return url
}

function comment(value: unknown, pr: PullRequest): GitHubComment {
  const node = record(value)
  const createdAt = text(node.createdAt)
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(createdAt) ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    throw new Error('GitHub returned an invalid comment timestamp.')
  }
  const author = node.author === null ? '[deleted]' : identifier(record(node.author).login)
  return {
    id: identifier(node.id),
    author,
    body: text(node.body),
    url: commentUrl(node.url, pr),
    createdAt,
  }
}

function reviewState(value: unknown): string {
  const state = text(value)
  if (
    !['PENDING', 'COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(state)
  )
    throw new Error('GitHub returned an invalid review state.')
  return state
}

function review(value: unknown, pr: PullRequest): GitHubReview | null {
  const node = record(value)
  const state = reviewState(node.state)
  // PENDING reviews aren't public discussion. Never expose their bodies.
  return state === 'PENDING' ? null : { ...comment(node, pr), state }
}

function threadComment(
  value: unknown,
  pr: PullRequest,
): { id: string; published: GitHubComment | null } {
  const node = record(value)
  const id = identifier(node.id)
  const state = reviewState(record(node.pullRequestReview).state)
  // A pending review's comments may be visible to the logged-in gh user only.
  return { id, published: state === 'PENDING' ? null : comment(node, pr) }
}

function line(value: unknown): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error('GitHub returned an invalid review line.')
  return value as number
}

function side(value: unknown): 'LEFT' | 'RIGHT' {
  if (value !== 'LEFT' && value !== 'RIGHT')
    throw new Error('GitHub returned an invalid review side.')
  return value
}

function page(value: unknown): { nodes: unknown[]; next: string | null } {
  const connection = record(value)
  if (!Array.isArray(connection.nodes) || connection.nodes.length > PAGE_SIZE)
    throw new Error('GitHub returned an invalid discussion page.')
  const info = record(connection.pageInfo)
  if (typeof info.hasNextPage !== 'boolean')
    throw new Error('GitHub returned an invalid discussion page.')
  if (info.endCursor !== null && typeof info.endCursor !== 'string')
    throw new Error('GitHub returned an invalid discussion cursor.')
  if (info.hasNextPage && (!connection.nodes.length || !info.endCursor))
    throw new Error('GitHub returned an incomplete discussion page.')
  return {
    nodes: connection.nodes,
    next: info.hasNextPage ? (info.endCursor as string) : null,
  }
}

function thread(
  value: unknown,
  pr: PullRequest,
): { result: GitHubReviewThread; next: string | null; ids: Set<string> } {
  const node = record(value)
  const path = text(node.path)
  // Discussion paths are display data, not local file reads: a filename may
  // legitimately start with '-' even though repositoryFiles disallows it for IO.
  if (
    !path ||
    path.length > 4096 ||
    path.startsWith('/') ||
    [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('GitHub returned an invalid review thread path.')
  if (typeof node.isOutdated !== 'boolean' || typeof node.isResolved !== 'boolean')
    throw new Error('GitHub returned invalid review thread flags.')
  const first = page(node.comments)
  const ids = new Set<string>()
  const comments: GitHubComment[] = []
  for (const commentNode of first.nodes) {
    const item = threadComment(commentNode, pr)
    if (ids.has(item.id)) throw new Error('GitHub replies changed during pagination.')
    ids.add(item.id)
    if (item.published) comments.push(item.published)
  }
  const startSide = node.startDiffSide === null ? null : side(node.startDiffSide)
  return {
    ids,
    result: {
      id: identifier(node.id),
      path,
      side: side(node.diffSide),
      line: line(node.line),
      startLine: line(node.startLine),
      startSide,
      originalLine: line(node.originalLine),
      isOutdated: node.isOutdated,
      isResolved: node.isResolved,
      comments,
    },
    next: first.next,
  }
}

/** Injectable read-only GraphQL transport. The production binding lives in github.ts. */
export function createGitHubCommentsClient(runner: GitHubRunner) {
  async function getPullRequestComments(pr: PullRequest): Promise<GitHubComments> {
    if (
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(pr.owner) ||
      !/^[A-Za-z0-9_.-]+$/.test(pr.repository) ||
      pr.repository === '.' ||
      pr.repository === '..' ||
      !Number.isSafeInteger(pr.number) ||
      pr.number < 1 ||
      pr.url !== `https://github.com/${pr.owner}/${pr.repository}/pull/${pr.number}`
    )
      throw new Error('Invalid GitHub pull request reference.')
    revision(pr.headSha)
    revision(pr.baseSha)
    let requests = 0
    let responseBytes = 0
    const variables = { owner: pr.owner, repository: pr.repository, number: pr.number }
    async function fetch(query: string, extras: RecordValue): Promise<RecordValue> {
      if (++requests > MAX_REQUESTS)
        throw new Error(
          'GitHub discussion pagination limit exceeded; refusing partial data.',
        )
      let output: string
      try {
        output = await runner({
          command: 'gh',
          args: [
            'api',
            'graphql',
            '--hostname',
            'github.com',
            '--method',
            'POST',
            '--input',
            '-',
          ],
          input: JSON.stringify({ query, variables: { ...variables, ...extras } }),
        })
      } catch {
        // Runner errors may include gh stderr, credentials, or private discussion.
        throw new Error('GitHub discussion request failed.')
      }
      if (typeof output !== 'string')
        throw new Error('GitHub returned invalid discussion JSON.')
      responseBytes += Buffer.byteLength(output, 'utf8')
      if (responseBytes > MAX_RESPONSE_BYTES)
        throw new Error(
          'GitHub discussion response size limit exceeded; refusing partial data.',
        )
      let response: RecordValue
      try {
        response = record(JSON.parse(output))
      } catch {
        throw new Error('GitHub returned invalid discussion JSON.')
      }
      if (response.errors !== undefined)
        throw new Error('GitHub GraphQL returned errors; refusing partial discussion data.')
      const data = record(response.data)
      const current = record(record(data.repository).pullRequest)
      if (
        revision(current.headRefOid) !== pr.headSha ||
        revision(current.baseRefOid) !== pr.baseSha
      )
        throw new Error(
          'Pull request head or base changed while reading discussion. Reload the PR.',
        )
      return { ...data, pull: current }
    }

    async function collect<T extends { id: string }>(
      field: 'comments' | 'reviews' | 'reviewThreads',
      parse: (value: unknown) => T | null,
    ): Promise<T[]> {
      const items: T[] = []
      const seenIds = new Set<string>()
      const cursors = new Set<string>()
      let after: string | null = null
      for (let index = 0; index < MAX_PAGES; index++) {
        // oxlint-disable-next-line no-await-in-loop
        const data = await fetch(connectionQuery(field), { after })
        const batch = page(record(data.pull)[field])
        for (const node of batch.nodes) {
          const item = parse(node)
          if (item) {
            if (seenIds.has(item.id))
              throw new Error('GitHub discussion changed during pagination.')
            seenIds.add(item.id)
            items.push(item)
          }
        }
        if (batch.next === null) return items
        if (cursors.has(batch.next))
          throw new Error('GitHub discussion cursor repeated during pagination.')
        cursors.add(batch.next)
        after = batch.next
      }
      throw new Error('GitHub discussion pagination limit exceeded; refusing partial data.')
    }

    const comments = await collect('comments', (node) => comment(node, pr))
    const reviews = await collect('reviews', (node) => review(node, pr))
    const initialThreads = await collect('reviewThreads', (node) => ({
      ...thread(node, pr),
      id: identifier(record(node).id),
    }))
    const threads: GitHubReviewThread[] = []
    for (const initial of initialThreads) {
      const { result, next, ids } = initial
      let after = next
      const cursors = new Set<string>()
      for (let index = 1; after !== null; index++) {
        if (index >= MAX_PAGES)
          throw new Error('GitHub reply pagination limit exceeded; refusing partial data.')
        if (cursors.has(after))
          throw new Error('GitHub reply cursor repeated during pagination.')
        cursors.add(after)
        // oxlint-disable-next-line no-await-in-loop
        const data = await fetch(repliesQuery, { threadId: result.id, after })
        const node = record(data.node)
        if (identifier(node.id) !== result.id)
          throw new Error('GitHub review thread changed during pagination.')
        const batch = page(node.comments)
        for (const value of batch.nodes) {
          const item = threadComment(value, pr)
          if (ids.has(item.id)) throw new Error('GitHub replies changed during pagination.')
          ids.add(item.id)
          if (item.published) result.comments.push(item.published)
        }
        after = batch.next
      }
      if (result.comments.length) threads.push(result)
    }
    return {
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      comments,
      reviews,
      threads,
      fetchedAt: new Date().toISOString(),
    }
  }
  return { getPullRequestComments }
}

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PullRequest, ReviewDraft, SubmitReview } from '../shared/review.ts'
import {
  createGitHubClient,
  PublicationRejected,
  publicationRejection,
  parsePullRequestUrl,
  type GitHubCommand,
  type GitHubRunner,
} from './github.ts'

it('only explicit client rejections release publication intent', () => {
  expect(
    publicationRejection('HTTP/2.0 422 Unprocessable Entity\r\n\r\n{}'),
  ).toBeInstanceOf(PublicationRejected)
  for (const output of [
    'HTTP/2.0 500 Server Error',
    'HTTP/2.0 408 Request Timeout',
    'Connection reset',
    '',
  ]) {
    expect(publicationRejection(output)).toBeUndefined()
  }
})

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const mergeBase = 'c'.repeat(40)
const id = 'c50ab689-5247-4ea6-88d1-3a69110da650'
const draftId = '2ccddcf2-48d8-4e4d-b611-6f8766c57201'
const pr: PullRequest = {
  owner: 'base-owner',
  repository: 'repo',
  number: 42,
  url: 'https://github.com/base-owner/repo/pull/42',
  title: 'Fork PR',
  headSha: head,
  baseSha: base,
  diffBaseSha: mergeBase,
}
const metadata = {
  title: pr.title,
  base: { sha: base },
  head: { sha: head, repo: { full_name: 'fork-owner/repo' }, ref: 'evil;$(touch nope)' },
}
const submission: SubmitReview = {
  id,
  event: 'COMMENT',
  body: 'Summary',
  draftIds: [draftId],
}
const draft: ReviewDraft = {
  id: draftId,
  body: 'Public comment',
  anchor: { path: 'a file;$(nope).ts', side: 'RIGHT', line: 3, revision: head },
}
const patch = '@@ -1,3 +1,3 @@\n context\n-old\n+new\n tail'
const review = { id: 123, html_url: `${pr.url}#pullrequestreview-123` }

function transport(
  overrides: {
    head?: string
    base?: string
    files?: unknown[]
    failPost?: boolean
    reviews?: unknown[]
  } = {},
) {
  const calls: GitHubCommand[] = []
  const runner: GitHubRunner = async (call) => {
    calls.push(call)
    if (call.command !== 'gh') throw new Error('Unexpected git call')
    const endpoint = call.args.find((arg) => arg.startsWith('repos/'))!
    if (call.input) {
      if (overrides.failPost) throw new Error('Connection lost')
      return JSON.stringify(review)
    }
    if (endpoint.includes('/files?'))
      return JSON.stringify(overrides.files ?? [{ filename: draft.anchor.path, patch }])
    if (endpoint.includes('/reviews?')) return JSON.stringify(overrides.reviews ?? [])
    return JSON.stringify({
      ...metadata,
      head: { sha: overrides.head ?? head },
      base: { sha: overrides.base ?? base },
    })
  }
  return { client: createGitHubClient(runner), calls }
}

describe('parsePullRequestUrl', () => {
  it.each([pr.url, `${pr.url}/`, `${pr.url}/files`, `${pr.url}/files/`])(
    'accepts %s',
    (url) => {
      expect(parsePullRequestUrl(url)).toEqual({
        owner: pr.owner,
        repository: pr.repository,
        number: 42,
      })
    },
  )
  it.each([
    'http://github.com/o/r/pull/1',
    'https://github.com.evil/o/r/pull/1',
    'https://user@github.com/o/r/pull/1',
    'https://github.com:443/o/r/pull/1',
    'https://github.com/o/r/issues/1',
    'https://github.com/o/r/pull/0',
    'https://github.com/o/r/pull/01',
    'https://github.com/o/r/pull/9007199254740992',
    'https://github.com/o/../pull/1',
    'https://github.com/o/%72/pull/1',
    'https://github.com/o/r/pull/1?x=1',
    'https://github.com/o/r/pull/1#x',
    'https://github.com/o/r/pull/1/commits',
    `${pr.url}\n`,
  ])('rejects %s', (url) => expect(parsePullRequestUrl(url)).toBeNull())
})

describe('publishing', () => {
  it('preflights without POST and repeats validation when publishing', async () => {
    const { client, calls } = transport()
    await expect(client.preflightReview(pr, submission, [draft])).resolves.toBeUndefined()
    expect(calls).toHaveLength(3)
    expect(calls.some((call) => call.input)).toBe(false)
    await client.publishReview(pr, submission, [draft])
    expect(calls).toHaveLength(7)
  })

  it.each([
    { event: 'REQUEST_CHANGES' as const, body: '  ', draftIds: [draftId] },
    { event: 'COMMENT' as const, body: '', draftIds: [] },
  ])('rejects invalid event content before remote reads: $event', async (input) => {
    const { client, calls } = transport()
    await expect(
      client.preflightReview(pr, { ...submission, ...input }, [draft]),
    ).rejects.toThrow('requires')
    await expect(
      client.publishReview(pr, { ...submission, ...input }, [draft]),
    ).rejects.toBeInstanceOf(PublicationRejected)
    expect(calls).toHaveLength(0)
  })

  it('classifies pre-POST failures but never ambiguous POST failures', async () => {
    await expect(
      transport({ head: base }).client.publishReview(pr, submission, [draft]),
    ).rejects.toBeInstanceOf(PublicationRejected)
    const unavailable = createGitHubClient(async () => {
      throw new Error('Unavailable')
    })
    await expect(unavailable.publishReview(pr, submission, [draft])).rejects.toBeInstanceOf(
      PublicationRejected,
    )
    await expect(
      transport({ failPost: true }).client.publishReview(pr, submission, [draft]),
    ).rejects.not.toBeInstanceOf(PublicationRejected)
  })

  it('sends only selected public fields and the recovery marker via stdin', async () => {
    const { client, calls } = transport()
    const body = 'Literal "quotes"; $(touch nope)\nsecond line'
    const privateDraft = {
      ...draft,
      body,
      turns: [{ question: 'PRIVATE CHAT', answer: 'SECRET' }],
    }
    expect(await client.publishReview(pr, submission, [privateDraft])).toEqual({
      id: 123,
      url: review.html_url,
    })
    const post = calls.find((call) => call.input)!
    expect(post.args).toContain('--input')
    expect(post.args).not.toContain(body)
    expect(post.args.slice(0, 4)).toEqual(['api', '--hostname', 'github.com', '--method'])
    expect(JSON.parse(post.input!)).toEqual({
      event: 'COMMENT',
      commit_id: head,
      body: `Summary\n\n<!-- skepsis-review:${id} -->`,
      comments: [{ body, path: draft.anchor.path, side: 'RIGHT', line: 3 }],
    })
    expect(post.input).not.toMatch(/PRIVATE|SECRET|revision|turns/)
  })

  it.each([
    ['LEFT', 1, true],
    ['RIGHT', 1, true],
    ['LEFT', 2, true],
    ['RIGHT', 2, true],
    ['LEFT', 3, true],
    ['RIGHT', 3, true],
    ['LEFT', 4, false],
    ['RIGHT', 4, false],
  ] as const)('validates %s line %s', async (side, line, valid) => {
    const { client, calls } = transport()
    const promise = client.publishReview(pr, submission, [
      { ...draft, anchor: { ...draft.anchor, side, line } },
    ])
    if (valid) await expect(promise).resolves.toHaveProperty('id', 123)
    else {
      await expect(promise).rejects.toThrow('diff line')
      expect(calls.some((call) => call.input)).toBe(false)
    }
  })

  it('does not accept a deletion on RIGHT or an addition on LEFT', async () => {
    const files = [
      { filename: draft.anchor.path, patch: '@@ -10,1 +20,1 @@\n-removed\n+added' },
    ]
    for (const [side, line] of [
      ['RIGHT', 10],
      ['LEFT', 20],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      await expect(
        transport({ files }).client.publishReview(pr, submission, [
          { ...draft, anchor: { ...draft.anchor, side, line } },
        ]),
      ).rejects.toThrow('diff line')
    }
  })

  it.each([{ head: 'd'.repeat(40) }, { base: 'd'.repeat(40) }])(
    'rejects stale metadata %j',
    async (change) => {
      const { client, calls } = transport(change)
      await expect(client.publishReview(pr, submission, [draft])).rejects.toThrow(
        'head or base changed',
      )
      expect(calls).toHaveLength(1)
    },
  )

  it.each(['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] as const)(
    'supports explicit %s without inline comments',
    async (event) => {
      const { client, calls } = transport()
      await client.publishReview(pr, { ...submission, event, draftIds: [] }, [])
      expect(JSON.parse(calls.find((call) => call.input)!.input!).event).toBe(event)
    },
  )

  it('rechecks metadata after reading files', async () => {
    let reads = 0
    const calls: GitHubCommand[] = []
    const client = createGitHubClient(async (call) => {
      calls.push(call)
      if (call.args.some((arg) => arg.includes('/files?')))
        return JSON.stringify([{ filename: draft.anchor.path, patch }])
      reads++
      return JSON.stringify({
        ...metadata,
        base: { sha: reads > 1 ? 'd'.repeat(40) : base },
      })
    })
    await expect(client.publishReview(pr, submission, [draft])).rejects.toThrow(
      'head or base changed',
    )
    expect(calls.some((call) => call.input)).toBe(false)
  })

  it('rejects unavailable patches and missing paths', async () => {
    for (const files of [[], [{ filename: draft.anchor.path }]]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(
        transport({ files }).client.publishReview(pr, submission, [draft]),
      ).rejects.toThrow('diff line')
    }
  })

  it('fails closed at the file pagination limit', async () => {
    const { client, calls } = transport({
      files: Array.from({ length: 100 }, () => ({ filename: 'x', patch })),
    })
    await expect(client.publishReview(pr, submission, [draft])).rejects.toThrow(
      'pagination limit',
    )
    expect(
      calls.filter((call) => call.args.some((arg) => arg.includes('/files?'))),
    ).toHaveLength(30)
    expect(calls.some((call) => call.input)).toBe(false)
  })

  it('never retries an ambiguous POST and can recover by marker', async () => {
    const { client, calls } = transport({ failPost: true })
    await expect(client.publishReview(pr, submission, [draft])).rejects.toThrow(
      'Connection lost',
    )
    expect(calls.filter((call) => call.input)).toHaveLength(1)
    const recovery = transport({
      reviews: [{ ...review, commit_id: head, body: `<!-- skepsis-review:${id} -->` }],
    })
    expect(await recovery.client.findPublishedReview(pr, id)).toEqual({
      id: 123,
      url: review.html_url,
    })
    expect(
      await recovery.client.findPublishedReview({ ...pr, headSha: 'c'.repeat(40) }, id),
    ).toEqual({ id: 123, url: review.html_url })
    expect(await transport().client.findPublishedReview(pr, id)).toBeNull()
  })
})

describe('isolated preparation', () => {
  const directories: string[] = []
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    )
  })

  async function setup(fetchedHead = head) {
    const directory = await mkdtemp(join(tmpdir(), 'skepsis-github-'))
    directories.push(directory)
    const calls: GitHubCommand[] = []
    const runner: GitHubRunner = async (call) => {
      calls.push(call)
      if (call.command === 'gh') return JSON.stringify(metadata)
      const args = call.args
      if (args.includes('init')) await mkdir(args.at(-1)!, { recursive: true })
      if (args.includes('worktree')) await mkdir(args.at(-2)!, { recursive: true })
      if (args.includes('rev-parse')) return fetchedHead
      if (args.includes('merge-base')) return mergeBase
      return ''
    }
    return { directory, calls, client: createGitHubClient(runner) }
  }

  it('fetches fork PRs from the base repo, pins SHAs, and reuses without resetting', async () => {
    const { directory, calls, client } = await setup()
    const originalCwd = process.cwd()
    const result = await client.preparePullRequest(`${pr.url}/files`, directory)
    expect(result.pullRequest).toEqual(pr)
    expect(result.cwd.startsWith(directory)).toBe(true)
    expect(result.cwd).toContain(`${head}-${base}-${mergeBase}`)
    expect(process.cwd()).toBe(originalCwd)
    const fetches = calls.filter((call) => call.args.includes('fetch'))
    expect(fetches.map((call) => call.args.slice(-2))).toEqual([
      ['https://github.com/base-owner/repo.git', 'refs/pull/42/head'],
      ['https://github.com/base-owner/repo.git', base],
    ])
    expect(
      calls.some((call) =>
        call.args.includes('credential.https://github.com.helper=!gh auth git-credential'),
      ),
    ).toBe(true)
    expect(JSON.stringify(calls)).not.toContain('evil;')
    await client.preparePullRequest(pr.url, directory)
    expect(calls.filter((call) => call.args.includes('worktree'))).toHaveLength(1)
    expect(calls.some((call) => call.args.includes('reset'))).toBe(false)
  })

  it('serializes concurrent preparations of the same PR', async () => {
    const { directory, calls, client } = await setup()
    const [first, second] = await Promise.all([
      client.preparePullRequest(pr.url, directory),
      client.preparePullRequest(pr.url, directory),
    ])
    expect(first).toEqual(second)
    expect(calls.filter((call) => call.args.includes('init'))).toHaveLength(1)
    expect(calls.filter((call) => call.args.includes('worktree'))).toHaveLength(1)
  })

  it('refuses a head ref that moved since metadata was read', async () => {
    const { directory, calls, client } = await setup('d'.repeat(40))
    await expect(client.preparePullRequest(pr.url, directory)).rejects.toThrow(
      'head changed',
    )
    expect(calls.some((call) => call.args.includes('worktree'))).toBe(false)
  })
})

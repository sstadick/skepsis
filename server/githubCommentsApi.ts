/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import type { Hono } from 'hono'
import type { PullRequest } from '../shared/review.ts'
import type { GitHubComments } from '../shared/githubComments.ts'
import { getPullRequestComments } from './github.ts'

/** Separate from private review state: refreshes never run models or write drafts. */
export function mountGitHubCommentsApi(app: Hono, pr: PullRequest | undefined) {
  let cached: GitHubComments | undefined
  let fetched = 0
  let pending: Promise<GitHubComments> | undefined
  const load = (refresh: boolean) => {
    if (pending) return pending
    if (!refresh && cached && Date.now() - fetched < 30_000) return Promise.resolve(cached)
    pending = getPullRequestComments(pr!)
      .then((result) => {
        cached = result
        fetched = Date.now()
        return result
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }
  for (const [method, path, refresh] of [
    ['GET', '/api/github/comments', false],
    ['POST', '/api/github/comments/refresh', true],
  ] as const) {
    app.on(method, path, async (c) => {
      if (!pr) return c.json({ error: 'GitHub comments require a pull request.' }, 404)
      try {
        return c.json(await load(refresh))
      } catch {
        // Never forward gh stderr, credentials, or a partially fetched discussion.
        return c.json(
          {
            error:
              'Unable to load GitHub comments. Check gh authentication and network access; reopen the PR if its head or base changed.',
          },
          502,
        )
      }
    })
  }
}

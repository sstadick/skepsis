/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

/** Published GitHub discussion only; never private agent state or local drafts. */
export interface GitHubComment {
  id: string
  author: string
  body: string
  url: string
  createdAt: string
}

export interface GitHubReview extends GitHubComment {
  state: string
}

export interface GitHubReviewThread {
  id: string
  path: string
  side: 'LEFT' | 'RIGHT'
  line: number | null
  startLine: number | null
  startSide: 'LEFT' | 'RIGHT' | null
  originalLine: number | null
  isOutdated: boolean
  isResolved: boolean
  comments: GitHubComment[]
}

export interface GitHubComments {
  headSha: string
  baseSha: string
  comments: GitHubComment[]
  reviews: GitHubReview[]
  threads: GitHubReviewThread[]
  fetchedAt: string
}

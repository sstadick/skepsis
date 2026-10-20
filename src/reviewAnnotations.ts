/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import type { FileDiffMetadata } from '@pierre/diffs'
import type { GitHubComments, GitHubReviewThread } from '../shared/githubComments.ts'
import type { PullRequest, ReviewAnchor } from '../shared/review.ts'

/** Never relocate outdated comments or attach a different PR revision to these lines. */
export function githubReviewAnchors(
  discussion: GitHubComments | undefined,
  pr: PullRequest | null | undefined,
  revision: string | undefined,
  files: readonly FileDiffMetadata[],
): { thread: GitHubReviewThread; anchor: ReviewAnchor }[] {
  if (
    !discussion ||
    !pr ||
    !revision ||
    discussion.headSha !== pr.headSha ||
    discussion.baseSha !== pr.baseSha
  )
    return []
  return discussion.threads.flatMap((thread) => {
    if (thread.isOutdated || thread.line === null) return []
    const file = files.find(
      (item) =>
        item.name === thread.path ||
        (thread.side === 'LEFT' && item.prevName === thread.path),
    )
    const line = thread.line
    if (
      !file?.hunks.some((hunk) => {
        const start = thread.side === 'LEFT' ? hunk.deletionStart : hunk.additionStart
        const count = thread.side === 'LEFT' ? hunk.deletionCount : hunk.additionCount
        return line >= start && line - start < count
      })
    )
      return []
    return [{ thread, anchor: { path: file.name, side: thread.side, line, revision } }]
  })
}

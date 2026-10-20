/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { parsePatchFiles } from '@pierre/diffs'
import { expect, it } from 'vitest'
import type { GitHubComments, GitHubReviewThread } from '../shared/githubComments.ts'
import type { PullRequest } from '../shared/review.ts'
import { githubReviewAnchors } from './reviewAnnotations.ts'

const revision = 'served-patch-revision'
const pr: PullRequest = {
  owner: 'oxidecomputer',
  repository: 'skepsis',
  number: 12,
  url: 'https://github.com/oxidecomputer/skepsis/pull/12',
  title: 'Review comments',
  headSha: 'head-sha',
  baseSha: 'base-sha',
  diffBaseSha: 'diff-base-sha',
}
const patch = `diff --git a/src/file.ts b/src/file.ts
index abcdef0..1234567 100644
--- a/src/file.ts
+++ b/src/file.ts
@@ -10,4 +10,4 @@
 context
-old one
-old two
+new one
+new two
 rest
@@ -30,1 +30,2 @@
-stale
+fresh
+extra
diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 80%
rename from src/old-name.ts
rename to src/new-name.ts
index abcdef0..1234567 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -7,2 +7,2 @@
-before
+after
 tail
`
const files = parsePatchFiles(patch).flatMap((item) => item.files)

function thread(overrides: Partial<GitHubReviewThread> = {}): GitHubReviewThread {
  return {
    id: 'thread',
    path: 'src/file.ts',
    side: 'RIGHT',
    line: 11,
    startLine: null,
    startSide: null,
    originalLine: null,
    isOutdated: false,
    isResolved: false,
    comments: [],
    ...overrides,
  }
}
function snapshot(threads: GitHubReviewThread[]): GitHubComments {
  return {
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    fetchedAt: '2026-01-02T03:04:05Z',
    comments: [],
    reviews: [],
    threads,
  }
}

it('anchors current LEFT and RIGHT comments, using a multiline range’s end line and retaining resolved threads', () => {
  const right = thread({ id: 'right' })
  const left = thread({ id: 'left', side: 'LEFT' })
  const multiline = thread({
    id: 'multiline',
    startLine: 10,
    startSide: 'LEFT',
    line: 12,
  })
  const resolved = thread({ id: 'resolved', side: 'LEFT', line: 30, isResolved: true })
  expect(
    githubReviewAnchors(snapshot([right, left, multiline, resolved]), pr, revision, files),
  ).toEqual([
    { thread: right, anchor: { path: 'src/file.ts', side: 'RIGHT', line: 11, revision } },
    { thread: left, anchor: { path: 'src/file.ts', side: 'LEFT', line: 11, revision } },
    {
      thread: multiline,
      anchor: { path: 'src/file.ts', side: 'RIGHT', line: 12, revision },
    },
    {
      thread: resolved,
      anchor: { path: 'src/file.ts', side: 'LEFT', line: 30, revision },
    },
  ])
})

it('maps a renamed LEFT comment from its old path to the canonical new file path', () => {
  expect(files.map(({ name, prevName }) => ({ name, prevName }))).toEqual([
    { name: 'src/file.ts', prevName: undefined },
    { name: 'src/new-name.ts', prevName: 'src/old-name.ts' },
  ])
  const renamed = thread({ id: 'renamed', path: 'src/old-name.ts', side: 'LEFT', line: 7 })
  expect(githubReviewAnchors(snapshot([renamed]), pr, revision, files)).toEqual([
    {
      thread: renamed,
      anchor: { path: 'src/new-name.ts', side: 'LEFT', line: 7, revision },
    },
  ])
})

it('leaves outdated, null-line, missing-path, and incompatible patch-line threads unanchored', () => {
  const valid = thread({ id: 'valid' })
  const rejected = [
    thread({ id: 'outdated', isOutdated: true }),
    thread({ id: 'null-line', line: null, originalLine: 11 }),
    thread({ id: 'missing-path', path: 'src/elsewhere.ts' }),
    thread({ id: 'renamed-right-old-path', path: 'src/old-name.ts' }),
    thread({ id: 'outside-hunk', line: 99 }),
    thread({ id: 'wrong-side-line', side: 'LEFT', line: 31 }),
  ]
  expect(githubReviewAnchors(snapshot([valid, ...rejected]), pr, revision, files)).toEqual([
    {
      thread: valid,
      anchor: { path: 'src/file.ts', side: 'RIGHT', line: 11, revision },
    },
  ])
})

it('never attaches discussion from an incompatible head or base to the served patch', () => {
  const current = snapshot([thread()])
  expect(
    githubReviewAnchors({ ...current, headSha: 'older-head' }, pr, revision, files),
  ).toEqual([])
  expect(
    githubReviewAnchors({ ...current, baseSha: 'older-base' }, pr, revision, files),
  ).toEqual([])
  expect(
    githubReviewAnchors(current, { ...pr, headSha: 'newer-head' }, revision, files),
  ).toEqual([])
  expect(
    githubReviewAnchors(current, { ...pr, baseSha: 'newer-base' }, revision, files),
  ).toEqual([])
  expect(githubReviewAnchors(current, pr, undefined, files)).toEqual([])
  expect(githubReviewAnchors(current, null, revision, files)).toEqual([])
  expect(githubReviewAnchors(undefined, pr, revision, files)).toEqual([])
})

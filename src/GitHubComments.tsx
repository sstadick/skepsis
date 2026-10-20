/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  GitHubComment,
  GitHubComments,
  GitHubReviewThread,
} from '../shared/githubComments.ts'
import type { PullRequest } from '../shared/review.ts'
import { ReviewMarkdown, safeReviewUrl } from './ReviewMarkdown.tsx'
import { reviewRequest } from './ReviewPanel.tsx'
import './githubComments.css'
import { ReviewTool } from './ReviewToolbar.tsx'

/** Published GitHub discussion, never local drafts or private agent conversations. */
export function useGitHubComments(pr: PullRequest | null | undefined) {
  const qc = useQueryClient()
  const identity = pr
    ? JSON.stringify([pr.owner, pr.repository, pr.number, pr.baseSha, pr.headSha])
    : null
  const queryKey = ['github-comments', identity] as const
  const query = useQuery({
    queryKey,
    queryFn: () => reviewRequest<GitHubComments>('/api/github/comments'),
    enabled: !!pr,
    staleTime: 30_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const mutation = useMutation({
    mutationFn: (key: typeof queryKey) => {
      if (key[1] === null) throw new Error('GitHub comments require a pull request.')
      return reviewRequest<GitHubComments>('/api/github/comments/refresh', 'POST')
    },
    onSuccess: (snapshot, key) => qc.setQueryData(key, snapshot),
    retry: false,
  })
  const activeMutation = mutation.variables?.[1] === identity
  return {
    data: query.data,
    error: (activeMutation && mutation.error) || query.error,
    isPending: !!pr && query.isPending,
    isFetching: query.isFetching,
    refresh: () => mutation.mutateAsync(queryKey),
    refreshing: activeMutation && mutation.isPending,
  }
}

export type GitHubCommentsController = ReturnType<typeof useGitHubComments>

function githubUrl(value: string) {
  if (!safeReviewUrl(value)) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.port &&
      !url.username &&
      !url.password
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}

function PublishedComment({ comment, state }: { comment: GitHubComment; state?: string }) {
  const date = new Date(comment.createdAt)
  const url = githubUrl(comment.url)
  return (
    <div className="github-published-comment">
      <header className="github-comment-heading">
        <strong>{comment.author}</strong>
        {state && (
          <span className="github-comment-state">
            {state.replaceAll('_', ' ').toLowerCase()}
          </span>
        )}
        <time dateTime={comment.createdAt} title={comment.createdAt}>
          {Number.isNaN(date.getTime()) ? comment.createdAt : date.toLocaleString()}
        </time>
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer">
            View on GitHub
          </a>
        )}
      </header>
      {comment.body && <ReviewMarkdown text={comment.body} />}
    </div>
  )
}

function threadLocation(thread: GitHubReviewThread) {
  const side = thread.side === 'LEFT' ? 'old' : 'new'
  if (thread.line === null)
    return thread.originalLine === null
      ? thread.path
      : `${thread.path} · original line ${thread.originalLine} (${side})`
  if (
    thread.startLine !== null &&
    (thread.startLine !== thread.line ||
      (thread.startSide !== null && thread.startSide !== thread.side))
  ) {
    const startSide = thread.startSide === 'LEFT' ? 'old' : 'new'
    const sides =
      thread.startSide && thread.startSide !== thread.side ? `${startSide} → ${side}` : side
    return `${thread.path}:${thread.startLine}–${thread.line} (${sides})`
  }
  return `${thread.path}:${thread.line} (${side})`
}

export function GitHubThread({
  thread,
  onNavigate,
}: {
  thread: GitHubReviewThread
  onNavigate?: (thread: GitHubReviewThread) => void
}) {
  return (
    <article className="github-thread">
      <header className="github-thread-heading">
        <strong className="github-thread-location">{threadLocation(thread)}</strong>
        <span className="github-thread-label">
          {thread.isResolved ? 'Resolved' : 'Open'}
        </span>
        {thread.isOutdated && (
          <span className="github-thread-label" data-tone="warning">
            Outdated
          </span>
        )}
        {onNavigate && (
          <button type="button" onClick={() => onNavigate(thread)}>
            Show in diff
          </button>
        )}
      </header>
      <ol className="github-comments-list" aria-label="Thread replies">
        {thread.comments.map((comment) => (
          <li key={comment.id}>
            <PublishedComment comment={comment} />
          </li>
        ))}
      </ol>
    </article>
  )
}

export function GitHubCommentsPanel({
  comments,
  onNavigate,
  canNavigate,
}: {
  comments: GitHubCommentsController
  onNavigate?: (thread: GitHubReviewThread) => void
  canNavigate?: (thread: GitHubReviewThread) => boolean
}) {
  const snapshot = comments.data
  const count = snapshot
    ? snapshot.comments.length +
      snapshot.reviews.length +
      snapshot.threads.reduce((total, thread) => total + thread.comments.length, 0)
    : 0
  const hasDiscussion =
    snapshot &&
    (snapshot.comments.length > 0 ||
      snapshot.reviews.length > 0 ||
      snapshot.threads.length > 0)
  return (
    <ReviewTool
      id="github"
      className="github-comments-panel"
      summaryClassName="github-comments-heading"
      heading={
        <>
          Published on GitHub <span className="github-comments-count">{count}</span>
        </>
      }
      compactHeading={
        <>
          GitHub comments <span className="github-comments-count">{count}</span>
        </>
      }
      actions={
        comments.error ? (
          <span
            className="review-tool-state"
            data-tone="error"
            title={comments.error.message}
          >
            Unavailable
          </span>
        ) : comments.isPending ? (
          <span className="review-tool-state" role="status">
            Loading…
          </span>
        ) : undefined
      }
    >
      <div className="github-comments-content">
        <div className="github-comments-toolbar">
          <p>
            Read-only published discussion, separate from private conversations and drafts.
          </p>
          <button
            type="button"
            disabled={comments.refreshing}
            onClick={() => void comments.refresh().catch(() => {})}
          >
            {comments.refreshing ? 'Refreshing…' : 'Refresh comments'}
          </button>
        </div>
        {comments.isPending && !comments.refreshing && (
          <p role="status">Loading GitHub comments…</p>
        )}
        {comments.refreshing && <p role="status">Refreshing GitHub comments…</p>}
        {comments.isFetching && !comments.isPending && !comments.refreshing && (
          <p role="status">Updating GitHub comments…</p>
        )}
        {comments.error && <p role="alert">GitHub comments: {comments.error.message}</p>}
        {snapshot && !hasDiscussion && <p>No published GitHub comments yet.</p>}
        {snapshot && hasDiscussion && (
          <>
            <section className="github-comments-section" aria-label="PR conversation">
              <h3>Conversation ({snapshot.comments.length})</h3>
              <ol className="github-comments-list">
                {snapshot.comments.map((comment) => (
                  <li key={comment.id}>
                    <PublishedComment comment={comment} />
                  </li>
                ))}
              </ol>
            </section>
            <section className="github-comments-section" aria-label="Published reviews">
              <h3>Reviews ({snapshot.reviews.length})</h3>
              <ol className="github-comments-list">
                {snapshot.reviews.map((review) => (
                  <li key={review.id}>
                    <PublishedComment comment={review} state={review.state} />
                  </li>
                ))}
              </ol>
            </section>
            <section className="github-comments-section" aria-label="Inline threads">
              <h3>Inline threads ({snapshot.threads.length})</h3>
              <ol className="github-comments-list">
                {snapshot.threads.map((thread) => (
                  <li key={thread.id}>
                    <GitHubThread
                      thread={thread}
                      onNavigate={
                        !thread.isOutdated &&
                        thread.line !== null &&
                        (!canNavigate || canNavigate(thread))
                          ? onNavigate
                          : undefined
                      }
                    />
                  </li>
                ))}
              </ol>
            </section>
          </>
        )}
      </div>
    </ReviewTool>
  )
}

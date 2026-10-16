/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { useEffect, useRef, useState } from 'react'
import { PUBLICATION_ABANDON_ACK, reviewDraftsDigest } from '../shared/review.ts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReviewAnchor, ReviewSnapshot, SubmitReview } from '../shared/review.ts'

export const anchorKey = (a: ReviewAnchor) =>
  JSON.stringify([a.path, a.side, a.line, a.revision])

export function bufferAnchors(text: Record<string, string>): ReviewAnchor[] {
  return Object.keys(text).flatMap((key) => {
    if (!key.startsWith('[')) return []
    try {
      const [path, side, line, revision] = JSON.parse(key)
      return [{ path, side, line, revision } as ReviewAnchor]
    } catch {
      return []
    }
  })
}

async function reviewRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (method !== 'GET') {
    const session = await fetch('/api/session')
    if (!session.ok) throw new Error('Unable to load session token')
    headers['x-skepsis-token'] = ((await session.json()) as { token: string }).token
  }
  const response = await fetch(path, {
    method,
    headers,
    ...(method === 'GET' || body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw Object.assign(new Error(error?.error ?? `Request failed (${response.status})`), {
      status: response.status,
    })
  }
  return response.status === 204 ? (undefined as T) : response.json()
}

export function useReview() {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['review'],
    queryFn: () => reviewRequest<ReviewSnapshot>('/api/review'),
  })
  // Kept above virtualized cards: recycling never discards unsaved text or mode.
  const [text, setText] = useState<Record<string, string>>({})
  const [modes, setModes] = useState<Record<string, 'ask' | 'draft'>>({})
  const focusComposer = useRef<string | null>(null)
  // Retrying the same input after a lost response must reuse its durable ID.
  const requestIds = useRef(new Map<string, string>())
  const mutation = useMutation({
    mutationFn: async ({
      path,
      method = 'POST',
      body,
      clear,
      creation = false,
    }: {
      path: string
      method?: string
      body?: unknown
      clear?: string
      creation?: boolean
    }) => {
      let requestKey: string | undefined
      let sent = body
      if (
        (creation ||
          (method === 'POST' &&
            (path === '/api/threads' ||
              path.endsWith('/messages') ||
              path === '/api/review/submit'))) &&
        body &&
        typeof body === 'object' &&
        'id' in body
      ) {
        const { id, ...payload } = body
        requestKey = JSON.stringify([method, path, clear, payload])
        const stableId = requestIds.current.get(requestKey) ?? String(id)
        requestIds.current.set(requestKey, stableId)
        sent = { ...payload, id: stableId }
      }
      try {
        await reviewRequest(path, method, sent)
      } catch (error) {
        if (
          requestKey &&
          error instanceof Error &&
          'status' in error &&
          Number(error.status) < 500
        )
          requestIds.current.delete(requestKey)
        throw error
      }
      if (requestKey) requestIds.current.delete(requestKey)
      if (
        path === '/api/review/abandon' &&
        body &&
        typeof body === 'object' &&
        'id' in body
      ) {
        for (const [key, id] of requestIds.current) {
          if (id === body.id) requestIds.current.delete(key)
        }
      }
      return clear
    },
    onSuccess: (clear) => {
      if (clear)
        setText((prev) => {
          const next = { ...prev }
          delete next[clear]
          return next
        })
    },
    onError: (error) => {
      if ('status' in error && error.status === 409) {
        void qc.invalidateQueries({ queryKey: ['diff'] })
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['review'] }),
  })
  // Cancellation must remain available while a publication request is in flight.
  const control = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      reviewRequest(path, 'POST', body),
    onSettled: () => qc.invalidateQueries({ queryKey: ['review'] }),
  })
  return { ...query, text, setText, modes, setModes, mutation, control, focusComposer }
}
export type ReviewController = ReturnType<typeof useReview>

export function LineChat({
  anchor,
  review,
  composing = false,
  onClose,
}: {
  anchor: ReviewAnchor
  review: ReviewController
  composing?: boolean
  onClose?: () => void
}) {
  const snapshot = review.data
  if (!snapshot) return null
  const key = anchorKey(anchor)
  const threads = snapshot.threads.filter((t) => anchorKey(t.anchor) === key)
  const drafts = snapshot.drafts.filter((d) => anchorKey(d.anchor) === key)
  const setText = (id: string, value: string) =>
    review.setText((prev) => ({ ...prev, [id]: value }))
  const mode = review.modes[key] ?? 'ask'
  const busy = review.mutation.isPending
  const send = review.mutation.mutate
  const close = () => {
    review.setText((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    onClose?.()
  }
  const copyAnswer = (answer: string) => {
    if (
      review.text[key]?.trim() &&
      review.text[key] !== answer &&
      !window.confirm('Replace your unsaved composition with this answer?')
    )
      return
    review.focusComposer.current = key
    setText(key, answer)
    review.setModes((prev) => ({ ...prev, [key]: 'draft' }))
  }
  return (
    <section className="durable-line-chat" onClick={(e) => e.stopPropagation()}>
      <small>
        {anchor.path}:{anchor.line} · {anchor.side} ·{' '}
        {anchor.revision !== snapshot.revision ? 'Outdated' : 'Private line chat'}
      </small>
      {threads.map((thread) => (
        <article key={thread.id} className="durable-thread">
          <strong>
            {thread.status}
            {thread.resolved ? ' · Resolved' : ''}
          </strong>
          {thread.turns.map((turn) => (
            <div key={turn.id}>
              <p className="review-prose">
                <strong>You: </strong>
                {turn.question}
              </p>
              {turn.answer && (
                <>
                  <p className="review-prose">
                    <strong>Agent: </strong>
                    {turn.answer}
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => copyAnswer(turn.answer!)}
                  >
                    Create review comment
                  </button>
                </>
              )}
              {turn.error && <p role="alert">{turn.error}</p>}
            </div>
          ))}
          {thread.partial && (
            <p className="review-prose" aria-live="polite">
              {thread.partial}
            </p>
          )}
          <div className="durable-actions">
            {['queued', 'running'].includes(thread.status) && (
              <button
                type="button"
                disabled={review.control.isPending}
                onClick={() =>
                  review.control.mutate({ path: `/api/threads/${thread.id}/cancel` })
                }
              >
                Stop
              </button>
            )}
            {!thread.resolved && (
              <button
                type="button"
                disabled={review.control.isPending}
                onClick={() =>
                  review.control.mutate({ path: `/api/threads/${thread.id}/resolve` })
                }
              >
                Resolve
              </button>
            )}
          </div>
          {thread.providerChange && (
            <div role="alert">
              <p>
                Provider changed from {thread.providerChange.from} to{' '}
                {thread.providerChange.to}. Continuing sends retained private history to the
                new provider. Nothing resumes automatically.
              </p>
              <button
                type="button"
                disabled={review.control.isPending}
                onClick={() =>
                  review.control.mutate({
                    path: `/api/threads/${thread.id}/provider`,
                    body: { provider: thread.providerChange!.to },
                  })
                }
              >
                Allow history to {thread.providerChange.to}
              </button>
            </div>
          )}
          {!thread.resolved && (
            <>
              <textarea
                disabled={busy}
                maxLength={20_000}
                aria-label="Private follow-up"
                value={review.text[thread.id] ?? ''}
                onChange={(e) => setText(thread.id, e.target.value)}
                placeholder="Private follow-up"
              />
              <button
                type="button"
                disabled={
                  busy ||
                  !!thread.providerChange ||
                  !snapshot.agent.available ||
                  ['queued', 'running'].includes(thread.status) ||
                  !review.text[thread.id]?.trim()
                }
                onClick={() =>
                  send({
                    path: `/api/threads/${thread.id}/messages`,
                    body: { id: crypto.randomUUID(), text: review.text[thread.id] },
                    clear: thread.id,
                  })
                }
              >
                Ask agent privately
              </button>
            </>
          )}
        </article>
      ))}
      {drafts.map((draft) => (
        <article key={draft.id}>
          <strong>
            {draft.publishedReviewId ? 'Published review comment' : 'Draft review comment'}
          </strong>
          <textarea
            aria-label="Review comment draft"
            disabled={busy || !!draft.publishedReviewId}
            maxLength={20_000}
            value={review.text[draft.id] ?? draft.body}
            onChange={(e) => setText(draft.id, e.target.value)}
          />
          {!draft.publishedReviewId && (
            <div className="durable-actions">
              <button
                type="button"
                disabled={busy || !(review.text[draft.id] ?? draft.body).trim()}
                onClick={() =>
                  send({
                    path: '/api/drafts',
                    method: 'PUT',
                    body: {
                      id: draft.id,
                      anchor: draft.anchor,
                      body: review.text[draft.id] ?? draft.body,
                    },
                    clear: draft.id,
                  })
                }
              >
                Save draft
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  send({
                    path: `/api/drafts/${draft.id}`,
                    method: 'DELETE',
                    clear: draft.id,
                  })
                }
              >
                Delete draft
              </button>
            </div>
          )}
        </article>
      ))}
      {(composing || review.text[key] !== undefined) && (
        <div>
          <label>
            Compose{' '}
            <select
              value={mode}
              onChange={(e) =>
                review.setModes((prev) => ({
                  ...prev,
                  [key]: e.target.value as 'ask' | 'draft',
                }))
              }
            >
              <option value="ask">Ask agent (private)</option>
              <option value="draft">Draft review comment</option>
            </select>
          </label>
          {!snapshot.agent.available && (
            <p>
              Agent unavailable:{' '}
              {snapshot.agent.error ?? 'Configure an agent model on the server.'} You can
              still save review drafts.
            </p>
          )}
          <textarea
            ref={(node) => {
              if (node && node.checkVisibility() && review.focusComposer.current === key) {
                review.focusComposer.current = null
                node.focus()
              }
            }}
            disabled={busy}
            maxLength={20_000}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                close()
              }
            }}
            aria-label={mode === 'ask' ? 'Private question' : 'New review draft'}
            value={review.text[key] ?? ''}
            onChange={(e) => setText(key, e.target.value)}
          />
          <div className="durable-actions">
            <button
              type="button"
              disabled={
                busy ||
                !review.text[key]?.trim() ||
                (mode === 'ask' && !snapshot.agent.available)
              }
              onClick={() =>
                send(
                  {
                    path: mode === 'ask' ? '/api/threads' : '/api/drafts',
                    method: mode === 'ask' ? 'POST' : 'PUT',
                    creation: true,
                    body: {
                      id: crypto.randomUUID(),
                      anchor,
                      ...(mode === 'ask'
                        ? { text: review.text[key] }
                        : { body: review.text[key] }),
                    },
                    clear: key,
                  },
                  { onSuccess: onClose },
                )
              }
            >
              {mode === 'ask' ? 'Ask agent privately' : 'Save draft'}
            </button>
            <button type="button" onClick={close}>
              Close
            </button>
          </div>
        </div>
      )}
      {review.control.error && <p role="alert">{review.control.error.message}</p>}
      {review.mutation.error && <p role="alert">{review.mutation.error.message}</p>}
    </section>
  )
}

export function ReviewPanel({ review }: { review: ReviewController }) {
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [summary, setSummary] = useState('')
  const [event, setEvent] = useState<SubmitReview['event']>('COMMENT')
  const [preview, setPreview] = useState<{
    fingerprint: string
    payload: SubmitReview
  } | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const snapshot = review.data
  const publication = snapshot?.publication
  const published = useRef<string | null>(null)
  useEffect(() => {
    if (publication?.status === 'published' && published.current !== publication.id) {
      published.current = publication.id
      setSummary('')
      setEvent('COMMENT')
      setSelected({})
      setPreview(null)
    }
  }, [publication?.status, publication?.id])
  const drafts = snapshot?.drafts.filter((d) => !d.publishedReviewId) ?? []
  const chosen = drafts.filter(
    (d) => selected[d.id] && d.anchor.revision === snapshot?.revision,
  )
  const fingerprint = JSON.stringify([snapshot?.revision, chosen, summary, event])
  const unsaved = chosen.some(
    (draft) => review.text[draft.id] !== undefined && review.text[draft.id] !== draft.body,
  )
  useEffect(() => {
    if (preview && (preview.fingerprint !== fingerprint || unsaved)) setPreview(null)
  }, [fingerprint, unsaved, preview])
  useEffect(() => {
    setAcknowledged(false)
    if (publication?.status === 'abandoned') setPreview(null)
  }, [publication?.id, publication?.status])
  if (!snapshot)
    return (
      <div role="status">
        {review.error ? `Review unavailable: ${review.error.message}` : 'Loading review…'}
      </div>
    )
  const anchors = new Map<string, ReviewAnchor>()
  for (const anchor of [
    ...snapshot.threads.map((t) => t.anchor),
    ...snapshot.drafts.map((d) => d.anchor),
    ...bufferAnchors(review.text),
  ])
    anchors.set(anchorKey(anchor), anchor)
  const outdated = [...anchors.values()].filter((a) => a.revision !== snapshot.revision)
  const current = [...anchors.values()].filter((a) => a.revision === snapshot.revision)
  const blocked =
    review.mutation.isPending ||
    publication?.status === 'publishing' ||
    publication?.status === 'uncertain'
  return (
    <details className="durable-review-panel">
      <summary>
        Review · {drafts.length} drafts · {snapshot.threads.length} threads
      </summary>
      <p>
        Only selected saved drafts and summary are published. Private chats are excluded.
      </p>
      {snapshot.agent.codemode && (
        <p>Codemode enabled: sandboxed JavaScript with read-only repository tools.</p>
      )}
      {snapshot.agent.classifier && (
        <p>
          Decision classifier:{' '}
          <code>
            {snapshot.agent.classifier.provider}/{snapshot.agent.classifier.model}
          </code>
          {' at '}
          <code>{snapshot.agent.classifier.endpoint}</code>. Private questions and inspected
          code may be sent to this endpoint as well as the chat provider.
        </p>
      )}
      {!snapshot.pullRequest && (
        <p>Local review: submission requires a GitHub pull request.</p>
      )}
      {!snapshot.agent.available && (
        <p>
          Agent unavailable:{' '}
          {snapshot.agent.error ?? 'Configure an agent model on the server.'} Drafts remain
          available.
        </p>
      )}
      {drafts.map((d) => (
        <label className="draft-selection" key={d.id}>
          <input
            type="checkbox"
            checked={!!selected[d.id]}
            disabled={blocked || d.anchor.revision !== snapshot.revision}
            onChange={(e) => setSelected((prev) => ({ ...prev, [d.id]: e.target.checked }))}
          />
          {d.anchor.path}:{d.anchor.line} ({d.anchor.side})
          {d.anchor.revision !== snapshot.revision ? ' · Outdated (not publishable)' : ''}
          {review.text[d.id] !== undefined && review.text[d.id] !== d.body
            ? ' · Unsaved edits: save before submitting'
            : ''}
        </label>
      ))}
      <details>
        <summary>
          Current threads and draft comments (including unsaved and resolved)
        </summary>
        {current.map((a) => (
          <LineChat key={anchorKey(a)} anchor={a} review={review} />
        ))}
      </details>
      <details>
        <summary>
          Outdated threads/drafts and unsaved compositions ({outdated.length})
        </summary>
        <p>
          These belong to an older revision and are not relocated. Select and copy text to
          recover it at a new location.
        </p>
        {outdated.map((a) => (
          <LineChat key={anchorKey(a)} anchor={a} review={review} />
        ))}
      </details>
      <label>
        Review outcome{' '}
        <select
          disabled={blocked}
          value={event}
          onChange={(e) => setEvent(e.target.value as SubmitReview['event'])}
        >
          <option value="COMMENT">Comment</option>
          <option value="APPROVE">Approve</option>
          <option value="REQUEST_CHANGES">Request changes</option>
        </select>
      </label>
      <textarea
        disabled={blocked}
        maxLength={20_000}
        aria-label="Review summary"
        placeholder="Public review summary"
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
      />
      {unsaved && (
        <p>
          Save edits to selected drafts before previewing. Unselected drafts and private
          compositions are not published.
        </p>
      )}
      <button
        type="button"
        disabled={blocked || unsaved || !snapshot.pullRequest}
        onClick={async () =>
          setPreview({
            fingerprint,
            payload: {
              id: crypto.randomUUID(),
              event,
              body: summary,
              draftIds: chosen.map((d) => d.id),
              draftsDigest: await reviewDraftsDigest(chosen),
            },
          })
        }
      >
        Preview review
      </button>
      {preview && preview.fingerprint === fingerprint && !unsaved && (
        <section className="publication-preview" aria-label="Public review preview">
          <h3>Public review preview</h3>
          <p>Outcome: {preview.payload.event}. Private chats are excluded.</p>
          <p className="review-prose">{preview.payload.body}</p>
          {chosen.map((d) => (
            <article key={d.id}>
              <strong>
                {d.anchor.path}:{d.anchor.line} ({d.anchor.side}) · {d.anchor.revision}
              </strong>
              <p className="review-prose">{d.body}</p>
            </article>
          ))}
          <button
            type="button"
            disabled={blocked}
            onClick={() =>
              review.mutation.mutate({ path: '/api/review/submit', body: preview.payload })
            }
          >
            Confirm submit to GitHub
          </button>
          <button type="button" disabled={blocked} onClick={() => setPreview(null)}>
            Cancel preview
          </button>
        </section>
      )}
      {publication && (
        <p role="status">
          Publication: {publication.status} {publication.error}{' '}
          {publication.url && (
            <a href={publication.url} target="_blank" rel="noreferrer">
              View review
            </a>
          )}
        </p>
      )}
      {publication?.status === 'uncertain' && (
        <>
          <p>
            The result is uncertain. Check GitHub and reconcile before attempting another
            submission. No automatic resubmission occurs.
          </p>
          <button
            type="button"
            disabled={review.mutation.isPending}
            onClick={() => review.mutation.mutate({ path: '/api/review/reconcile' })}
          >
            Reconcile publication
          </button>
          <fieldset disabled={review.mutation.isPending}>
            <legend>Manual unlock — duplicate publication risk</legend>
            <p>
              Check GitHub first. Unlocking does not undo a review and a later submission
              may duplicate it, even if no receipt was found.
            </p>
            <label>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              {PUBLICATION_ABANDON_ACK}
            </label>
            <button
              type="button"
              disabled={!acknowledged}
              onClick={() => {
                if (
                  window.confirm(
                    'Unlock this publication? You must have checked GitHub and accept duplicate publication risk.',
                  )
                )
                  review.mutation.mutate({
                    path: '/api/review/abandon',
                    body: { id: publication.id, acknowledgement: PUBLICATION_ABANDON_ACK },
                  })
              }}
            >
              Unlock without resubmitting
            </button>
          </fieldset>
        </>
      )}
      {review.mutation.error && <p role="alert">{review.mutation.error.message}</p>}
    </details>
  )
}

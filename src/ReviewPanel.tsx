/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PUBLICATION_ABANDON_ACK, reviewDraftsDigest } from '../shared/review.ts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReviewAnchor, ReviewSnapshot, SubmitReview } from '../shared/review.ts'
import { ReviewMarkdown, safeReviewUrl } from './ReviewMarkdown.tsx'
import './review.css'
import { ReviewTool } from './ReviewToolbar.tsx'

type ComposerMode = 'ask' | 'propose-change' | 'draft'

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

export async function reviewRequest<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
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
  const [modes, setModes] = useState<Record<string, ComposerMode>>({})
  const [previews, setPreviews] = useState<Record<string, boolean>>({})
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
  return {
    ...query,
    text,
    setText,
    modes,
    setModes,
    previews,
    setPreviews,
    mutation,
    control,
    focusComposer,
  }
}
export type ReviewController = ReturnType<typeof useReview>

function MarkdownEditor({
  label,
  text,
  preview,
  onPreview,
  children,
}: {
  label: string
  text: string
  preview: boolean
  onPreview: (preview: boolean) => void
  children: ReactNode
}) {
  const inputPane = useRef<HTMLDivElement>(null)
  const focusOnWrite = useRef(false)
  useEffect(() => {
    if (preview || !focusOnWrite.current) return
    focusOnWrite.current = false
    const input = inputPane.current?.querySelector('textarea')
    if (input && !input.disabled && input.checkVisibility()) input.focus()
  }, [preview])
  return (
    <div className="review-editor">
      <div className="review-editor-toolbar">
        <div className="review-segments" role="group" aria-label={`${label} editor mode`}>
          <button
            type="button"
            aria-pressed={!preview}
            onClick={() => {
              if (preview) focusOnWrite.current = true
              else
                inputPane.current
                  ?.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)')
                  ?.focus()
              onPreview(false)
            }}
          >
            Write
          </button>
          <button type="button" aria-pressed={preview} onClick={() => onPreview(true)}>
            Preview
          </button>
        </div>
        <span className="review-hint">Markdown supported</span>
      </div>
      {/* Keep the editor mounted so previewing never resets its selection or scroll. */}
      <div className="review-editor-input" ref={inputPane} hidden={preview}>
        {children}
      </div>
      {preview && (
        <div
          className="review-editor-preview"
          role="region"
          aria-label={`${label} preview`}
        >
          {text.trim() ? (
            <ReviewMarkdown text={text} />
          ) : (
            <p className="review-hint">Nothing to preview yet.</p>
          )}
        </div>
      )}
    </div>
  )
}

function DraftNotice() {
  return (
    <p className="review-notice">
      <strong>Draft only — not published.</strong> Saving keeps this comment private. Select
      it and preview the review before publishing.
    </p>
  )
}

function ChatMessage({
  agent = false,
  label,
  children,
}: {
  agent?: boolean
  label: string
  children: ReactNode
}) {
  return (
    <div
      className={`review-message ${agent ? 'review-message-agent' : 'review-message-user'}`}
    >
      <span className="review-avatar" aria-hidden="true">
        {agent ? 'AI' : 'YO'}
      </span>
      <div className="review-message-card">
        <header className="review-message-header">
          <strong>{agent ? 'Agent' : 'You'}</strong>
          <span>{label}</span>
        </header>
        {children}
      </div>
    </div>
  )
}

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
  const isDraft = mode === 'draft'
  const busy = review.mutation.isPending
  const send = review.mutation.mutate
  const close = () => {
    review.setText((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    review.setPreviews((prev) => ({ ...prev, [key]: false }))
    onClose?.()
  }
  const compose = (text: string, targetMode: ComposerMode) => {
    if (
      review.text[key] &&
      review.text[key] !== text &&
      !window.confirm('Replace your unsaved composition?')
    )
      return
    review.focusComposer.current = key
    setText(key, text)
    review.setPreviews((prev) => ({ ...prev, [key]: false }))
    review.setModes((prev) => ({ ...prev, [key]: targetMode }))
  }
  return (
    <section className="durable-line-chat" onClick={(e) => e.stopPropagation()}>
      <header className="review-line-header">
        <span className="review-location">
          {anchor.path}:{anchor.line} <span>· {anchor.side}</span>
        </span>
        <span
          className="review-pill"
          data-tone={anchor.revision !== snapshot.revision ? 'warning' : undefined}
        >
          {anchor.revision !== snapshot.revision ? 'Outdated' : 'Private line chat'}
        </span>
      </header>
      {threads.map((thread) => (
        <article key={thread.id} className="durable-thread">
          <header className="review-thread-header">
            <strong>Conversation</strong>
            <span
              className="review-pill"
              data-tone={thread.status === 'failed' ? 'warning' : undefined}
            >
              {thread.status}
            </span>
            {thread.resolved && (
              <span className="review-pill" data-tone="success">
                Resolved
              </span>
            )}
          </header>
          <div className="review-timeline">
            {thread.turns.map((turn) => (
              <div key={turn.id} className="review-turn">
                <ChatMessage
                  label={
                    turn.intent === 'propose-change'
                      ? 'Change request · private'
                      : 'Question · private'
                  }
                >
                  <ReviewMarkdown text={turn.question} />
                </ChatMessage>
                {turn.answer && (
                  <ChatMessage
                    agent
                    label={
                      turn.intent === 'propose-change'
                        ? 'Proposed change (private)'
                        : 'Private answer'
                    }
                  >
                    <ReviewMarkdown text={turn.answer} />
                    <div className="durable-actions review-answer-actions">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => compose(turn.answer!, 'draft')}
                      >
                        Create review comment
                      </button>
                      <span className="review-hint">
                        Opens an editable draft, not a publication.
                      </span>
                    </div>
                  </ChatMessage>
                )}
                {turn.error && <p role="alert">{turn.error}</p>}
              </div>
            ))}
            {(thread.partial || ['queued', 'running'].includes(thread.status)) && (
              <ChatMessage agent label="Private response">
                {thread.partial && <ReviewMarkdown text={thread.partial} />}
                {['queued', 'running'].includes(thread.status) && (
                  <div className="review-streaming" role="status">
                    <span className="review-streaming-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    {thread.status === 'queued'
                      ? 'Waiting for the agent…'
                      : thread.partial
                        ? 'Agent is writing…'
                        : 'Agent is thinking…'}
                  </div>
                )}
              </ChatMessage>
            )}
          </div>
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
            <div className="review-consent" role="alert">
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
            <div className="review-follow-up">
              <div className="review-editor-toolbar">
                <strong>Continue privately</strong>
                <span className="review-hint">Markdown supported</span>
              </div>
              <textarea
                disabled={busy}
                maxLength={20_000}
                aria-label="Private follow-up"
                value={review.text[thread.id] ?? ''}
                onChange={(e) => setText(thread.id, e.target.value)}
                placeholder="Ask a follow-up, or describe a change to propose…"
              />
              <div className="durable-actions">
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
                <button
                  type="button"
                  disabled={
                    busy ||
                    !!thread.providerChange ||
                    !snapshot.agent.available ||
                    ['queued', 'running'].includes(thread.status)
                  }
                  onClick={() =>
                    send({
                      path: `/api/threads/${thread.id}/messages`,
                      body: {
                        id: crypto.randomUUID(),
                        intent: 'propose-change',
                        text: review.text[thread.id]?.trim()
                          ? review.text[thread.id]
                          : 'Propose a minimal change to address the issue discussed in this thread.',
                      },
                      clear: thread.id,
                    })
                  }
                >
                  Propose a change
                </button>
              </div>
            </div>
          )}
        </article>
      ))}
      {drafts.map((draft) => (
        <article key={draft.id} className="review-draft">
          <header className="review-thread-header">
            <strong>
              {draft.publishedReviewId
                ? 'Published review comment'
                : 'Draft review comment'}
            </strong>
            <span
              className="review-pill"
              data-tone={draft.publishedReviewId ? 'success' : undefined}
            >
              {draft.publishedReviewId
                ? 'Published'
                : review.text[draft.id] !== undefined &&
                    review.text[draft.id] !== draft.body
                  ? 'Unsaved edits'
                  : 'Saved privately'}
            </span>
          </header>
          {!draft.publishedReviewId && <DraftNotice />}
          <MarkdownEditor
            label="Review comment draft"
            text={review.text[draft.id] ?? draft.body}
            preview={review.previews[draft.id] ?? !!draft.publishedReviewId}
            onPreview={(preview) =>
              review.setPreviews((prev) => ({ ...prev, [draft.id]: preview }))
            }
          >
            <textarea
              aria-label="Review comment draft"
              disabled={busy || !!draft.publishedReviewId}
              maxLength={20_000}
              value={review.text[draft.id] ?? draft.body}
              onChange={(e) => setText(draft.id, e.target.value)}
            />
          </MarkdownEditor>
          <div className="durable-actions">
            <button
              type="button"
              disabled={busy || !(review.text[draft.id] ?? draft.body).trim()}
              onClick={() => compose(review.text[draft.id] ?? draft.body, 'propose-change')}
            >
              Use comment as change request
            </button>
            {!draft.publishedReviewId && (
              <>
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
              </>
            )}
          </div>
        </article>
      ))}
      {(composing || review.text[key] !== undefined) && (
        <div className="review-composer">
          <div className="review-composer-heading">
            <strong>
              {isDraft
                ? 'Draft a review comment'
                : mode === 'propose-change'
                  ? 'Request a proposed change'
                  : 'Start a private conversation'}
            </strong>
            <div
              className="review-segments review-mode-buttons"
              role="group"
              aria-label="Compose"
            >
              {(['ask', 'propose-change', 'draft'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => review.setModes((prev) => ({ ...prev, [key]: value }))}
                >
                  {value === 'ask'
                    ? 'Private question'
                    : value === 'propose-change'
                      ? 'Propose a change (private)'
                      : 'Draft review comment'}
                </button>
              ))}
            </div>
            <label className="review-mode-select">
              Compose{' '}
              <select
                value={mode}
                onChange={(e) =>
                  review.setModes((prev) => ({
                    ...prev,
                    [key]: e.target.value as ComposerMode,
                  }))
                }
              >
                <option value="ask">Private question</option>
                <option value="propose-change">Propose a change (private)</option>
                <option value="draft">Draft review comment</option>
              </select>
            </label>
          </div>
          {isDraft && <DraftNotice />}
          {mode === 'ask' && (
            <p className="review-hint">
              Ask about this line. Your conversation stays private and never becomes a
              review automatically.
            </p>
          )}
          {mode === 'propose-change' && (
            <p className="review-notice">
              A private proposal only: no files are edited or comments published. You can
              copy the answer into an editable review draft.
            </p>
          )}
          {!snapshot.agent.available && (
            <p>
              Agent unavailable:{' '}
              {snapshot.agent.error ?? 'Configure an agent model on the server.'} You can
              still save review drafts.
            </p>
          )}
          <MarkdownEditor
            label={
              isDraft
                ? 'New review draft'
                : mode === 'propose-change'
                  ? 'Private change request'
                  : 'Private question'
            }
            text={review.text[key] ?? ''}
            preview={review.previews[key] ?? false}
            onPreview={(preview) =>
              review.setPreviews((prev) => ({ ...prev, [key]: preview }))
            }
          >
            <textarea
              ref={(node) => {
                if (
                  node &&
                  node.checkVisibility() &&
                  review.focusComposer.current === key
                ) {
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
              aria-label={
                isDraft
                  ? 'New review draft'
                  : mode === 'propose-change'
                    ? 'Private change request'
                    : 'Private question'
              }
              placeholder={
                isDraft
                  ? 'Write a comment for the public review…'
                  : mode === 'propose-change'
                    ? 'What should change, and why?'
                    : 'What would you like to understand?'
              }
              value={review.text[key] ?? ''}
              onChange={(e) => setText(key, e.target.value)}
            />
          </MarkdownEditor>
          <div className="durable-actions">
            <button
              className="review-primary"
              type="button"
              disabled={
                busy || !review.text[key]?.trim() || (!isDraft && !snapshot.agent.available)
              }
              onClick={() =>
                send(
                  {
                    path: isDraft ? '/api/drafts' : '/api/threads',
                    method: isDraft ? 'PUT' : 'POST',
                    creation: true,
                    body: {
                      id: crypto.randomUUID(),
                      anchor,
                      ...(isDraft
                        ? { body: review.text[key] }
                        : {
                            text: review.text[key],
                            ...(mode === 'propose-change'
                              ? { intent: 'propose-change' }
                              : {}),
                          }),
                    },
                    clear: key,
                  },
                  { onSuccess: onClose },
                )
              }
            >
              {isDraft
                ? 'Save draft'
                : mode === 'propose-change'
                  ? 'Ask for a proposed change'
                  : 'Ask agent privately'}
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
  const [summaryPreview, setSummaryPreview] = useState(false)
  const [event, setEvent] = useState<SubmitReview['event']>('COMMENT')
  const [preview, setPreview] = useState<{
    fingerprint: string
    payload: SubmitReview
  } | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const snapshot = review.data
  const publication = snapshot?.publication
  const publicationUrl =
    publication?.url && /^https?:\/\//i.test(publication.url)
      ? safeReviewUrl(publication.url)
      : undefined
  const published = useRef<string | null>(null)
  useEffect(() => {
    if (publication?.status === 'published' && published.current !== publication.id) {
      published.current = publication.id
      setSummary('')
      setSummaryPreview(false)
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
    <ReviewTool
      id="review"
      className="durable-review-panel"
      summaryClassName="review-panel-heading"
      compactHeading={
        <>
          Review <span className="review-pill">{drafts.length} drafts</span>
        </>
      }
      heading={
        <>
          Review{' '}
          <span className="review-pill">
            {drafts.length} draft{drafts.length === 1 ? '' : 's'}
          </span>{' '}
          <span className="review-pill">
            {snapshot.threads.length} private thread
            {snapshot.threads.length === 1 ? '' : 's'}
          </span>
        </>
      }
    >
      <p className="review-notice">
        <strong>You control what is published.</strong> Only selected saved drafts and
        summary are published. Private chats are excluded.
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
      <details className="review-archive">
        <summary>
          Current threads and draft comments (including unsaved and resolved)
        </summary>
        {current.map((a) => (
          <LineChat key={anchorKey(a)} anchor={a} review={review} />
        ))}
      </details>
      <details className="review-archive">
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
      <section className="review-publication-composer" aria-label="Prepare a public review">
        <h3>Prepare a public review</h3>
        <label className="review-outcome">
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
        <MarkdownEditor
          label="Review summary"
          text={summary}
          preview={summaryPreview}
          onPreview={setSummaryPreview}
        >
          <textarea
            disabled={blocked}
            maxLength={20_000}
            aria-label="Review summary"
            placeholder="Public review summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </MarkdownEditor>
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
      </section>
      {preview && preview.fingerprint === fingerprint && !unsaved && (
        <section className="publication-preview" aria-label="Public review preview">
          <h3>Public review preview</h3>
          <p>Outcome: {preview.payload.event}. Private chats are excluded.</p>
          <ReviewMarkdown text={preview.payload.body} />
          {chosen.map((d) => (
            <article key={d.id}>
              <strong>
                {d.anchor.path}:{d.anchor.line} ({d.anchor.side}) · {d.anchor.revision}
              </strong>
              <ReviewMarkdown text={d.body} />
            </article>
          ))}
          <div className="durable-actions">
            <button
              className="review-primary"
              type="button"
              disabled={blocked}
              onClick={() =>
                review.mutation.mutate({
                  path: '/api/review/submit',
                  body: preview.payload,
                })
              }
            >
              Confirm submit to GitHub
            </button>
            <button type="button" disabled={blocked} onClick={() => setPreview(null)}>
              Cancel preview
            </button>
          </div>
        </section>
      )}
      {publication && (
        <p role="status">
          Publication: {publication.status} {publication.error}{' '}
          {publicationUrl && (
            <a href={publicationUrl} target="_blank" rel="noopener noreferrer">
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
    </ReviewTool>
  )
}

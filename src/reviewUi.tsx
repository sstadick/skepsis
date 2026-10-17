/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import type { CommentSyntax, ReviewThreadContent } from '../shared/reviewComments.ts'

export type ReviewComposerKind = 'comment' | 'question'

export interface ReviewComposerDraft {
  kind: ReviewComposerKind
  text: string
}

export interface ReviewComposerSubmit {
  kind: ReviewComposerKind
  text: string
}

function Spinner() {
  return (
    <svg className="score-spinner" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.25"
      />
      <path
        d="M8 2a6 6 0 0 1 6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => ref.current?.showModal(), [])

  return (
    <dialog
      ref={ref}
      className="help-modal"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) ref.current?.close()
      }}
    >
      {children}
    </dialog>
  )
}

function ReviewComposerHelpModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      <h3>Review annotations</h3>
      <ul className="review-help-list">
        <li>
          Open the composer from the gutter <strong>+</strong> button, or press <kbd>c</kbd>{' '}
          on the selected line.
        </li>
        <li>
          <strong>Review comment</strong> leaves a local note inline in this diff.
        </li>
        <li>
          <strong>Ask agent</strong> sends a question about this code. Skepsis answers
          inline with the configured Pi model, and follow-ups keep context.
        </li>
        <li>
          Both modes write local annotations into your working files. They are not GitHub
          review comments, and Skepsis has no Publish step. For GitHub, copy anything you
          want into the PR review and resolve local annotations before committing.
        </li>
      </ul>
      <div className="review-help-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}

function commentMarkerLabel(syntax: CommentSyntax | null): string {
  if (syntax === null) return 'Comment marker: none (file type not recognized)'
  if (syntax.prefix === '') return 'Comment marker: none (plain text)'
  return `Comment marker: ${syntax.suffix ? `${syntax.prefix} ${syntax.suffix}` : syntax.prefix}`
}

function composerPlaceholder(kind: ReviewComposerKind): string {
  return kind === 'question'
    ? 'Ask Agent about this code… (Cmd+Enter to submit)'
    : 'Leave a review comment about this code… (Cmd+Enter to submit)'
}

function composerModeNote(kind: ReviewComposerKind): string {
  return kind === 'question'
    ? 'Agent answers inline with the configured Pi model. Follow-ups keep context.'
    : 'Adds a local review note inline in this diff.'
}

function ActionButton({
  children,
  onClick,
  disabled,
  variant = 'secondary',
  ariaLabel,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  variant?: 'primary' | 'secondary'
  ariaLabel?: string
}) {
  return (
    <button
      type="button"
      className={`btn btn-${variant}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  )
}

function useRestoreTextareaFocus(
  ref: RefObject<HTMLTextAreaElement | null>,
  restoreFocus: boolean,
) {
  useEffect(() => {
    if (restoreFocus) ref.current?.focus()
  }, [restoreFocus, ref])
}

export function ReviewComposer({
  draft,
  onDraftChange,
  onSubmit,
  onCancel,
  submitting,
  error,
  syntax,
  restoreFocus = true,
  onFocusChange,
}: {
  draft: ReviewComposerDraft
  onDraftChange: (draft: ReviewComposerDraft) => void
  onSubmit: (draft: ReviewComposerSubmit) => void
  onCancel: () => void
  submitting: boolean
  error: string | null
  /** Comment syntax the inserted tags will use. Empty prefix: the format has
   *  no comment syntax; null: unrecognized file type. Both insert bare. */
  syntax: CommentSyntax | null
  restoreFocus?: boolean
  onFocusChange?: (focused: boolean) => void
}) {
  const [showHelp, setShowHelp] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useRestoreTextareaFocus(ref, restoreFocus)

  const submit = () => {
    const body = draft.text.trim()
    if (!body || submitting) return
    onSubmit({ kind: draft.kind, text: body })
  }

  return (
    <div className="comment-form" onClick={(event) => event.stopPropagation()}>
      <div className="comment-form-toolbar">
        <div
          className="comment-form-mode-picker"
          role="group"
          aria-label="Review composer mode"
        >
          <button
            type="button"
            className={`comment-form-mode-button${draft.kind === 'comment' ? ' is-active' : ''}`}
            aria-pressed={draft.kind === 'comment'}
            onClick={() => onDraftChange({ ...draft, kind: 'comment' })}
            disabled={submitting}
          >
            Review comment
          </button>
          <button
            type="button"
            className={`comment-form-mode-button${draft.kind === 'question' ? ' is-active' : ''}`}
            aria-pressed={draft.kind === 'question'}
            onClick={() => onDraftChange({ ...draft, kind: 'question' })}
            disabled={submitting}
          >
            Ask agent
          </button>
        </div>
        <button
          type="button"
          className="comment-form-help-button"
          aria-label="Review annotation help"
          onClick={() => setShowHelp(true)}
        >
          ?
        </button>
      </div>
      <textarea
        ref={ref}
        value={draft.text}
        onChange={(event) => onDraftChange({ ...draft, text: event.target.value })}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          }
          if (event.key === 'Escape') onCancel()
        }}
        placeholder={composerPlaceholder(draft.kind)}
        rows={3}
        disabled={submitting}
        aria-label={draft.kind === 'question' ? 'Ask Agent' : 'Review comment'}
      />
      <div className="comment-form-help">
        <div className="comment-form-note">{composerModeNote(draft.kind)}</div>
        <div className="comment-form-note">
          Local annotation in your working files, not a GitHub review comment. For GitHub,
          copy it to the PR review and resolve local annotations before committing.
        </div>
        <div className="comment-form-note">{commentMarkerLabel(syntax)}</div>
      </div>
      <div className="comment-form-actions">
        {error && <div className="comment-form-error">{error}</div>}
        <ActionButton onClick={onCancel} disabled={submitting}>
          Cancel
        </ActionButton>
        <ActionButton
          variant="primary"
          disabled={!draft.text.trim() || submitting}
          onClick={submit}
        >
          {draft.kind === 'question' ? 'Ask agent' : 'Review comment'}
        </ActionButton>
      </div>
      {showHelp && <ReviewComposerHelpModal onClose={() => setShowHelp(false)} />}
    </div>
  )
}

function messageOutcomeLabel(outcome: 'answered' | 'failed'): string {
  return outcome === 'answered' ? 'Answered' : 'Failed'
}

function ThreadFollowUpForm({
  text,
  onTextChange,
  onSubmit,
  submitting,
  error,
  restoreFocus = false,
  onFocusChange,
}: {
  text: string
  onTextChange: (text: string) => void
  onSubmit: (text: string) => void
  submitting: boolean
  error: string | null
  restoreFocus?: boolean
  onFocusChange?: (focused: boolean) => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useRestoreTextareaFocus(ref, restoreFocus)

  const submit = () => {
    const body = text.trim()
    if (!body || submitting) return
    onSubmit(body)
  }

  return (
    <div
      className="review-thread-entry review-thread-follow-up"
      onClick={(event) => event.stopPropagation()}
    >
      <textarea
        ref={ref}
        value={text}
        onChange={(event) => onTextChange(event.target.value)}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          }
        }}
        placeholder="Ask Agent a follow-up… (Cmd+Enter to send)"
        rows={3}
        disabled={submitting}
        aria-label="Ask Agent a follow-up"
      />
      <div className="comment-form-note review-thread-follow-up-note">
        Follow-ups keep the earlier thread context.
      </div>
      <div className="review-thread-follow-up-actions">
        {error && <div className="comment-form-error">{error}</div>}
        <ActionButton
          variant="primary"
          disabled={!text.trim() || submitting}
          onClick={submit}
        >
          {submitting ? 'Sending…' : 'Ask agent'}
        </ActionButton>
      </div>
    </div>
  )
}

export function ReviewThreadCard({
  thread,
  onResolve,
  onFollowUp,
  followUpDraft,
  onFollowUpDraftChange,
  resolving,
  followingUp,
  followUpError,
  followUpRestoreFocus = false,
  onFollowUpFocusChange,
}: {
  thread: ReviewThreadContent
  onResolve: () => void
  onFollowUp: (text: string) => void
  followUpDraft: string
  onFollowUpDraftChange: (text: string) => void
  resolving: boolean
  followingUp: boolean
  followUpError: string | null
  followUpRestoreFocus?: boolean
  onFollowUpFocusChange?: (focused: boolean) => void
}) {
  const isQuestion = thread.kind === 'question'
  const isEmbeddedQuestion = isQuestion && thread.embedded === true
  const status = isQuestion ? thread.status : null
  const statusLabel =
    status === 'answered'
      ? 'Answered'
      : status === 'failed'
        ? 'Failed'
        : isEmbeddedQuestion
          ? 'Answering'
          : 'Pending'
  const initialBody = isQuestion ? thread.question : thread.body
  const replies = isQuestion ? thread.messages.slice(1) : []

  return (
    <article
      className="review-thread"
      aria-label={
        isQuestion
          ? isEmbeddedQuestion
            ? 'Agent question'
            : 'Legacy question'
          : 'Review comment'
      }
    >
      <div className="review-thread-entry">
        <header className="review-thread-header">
          <div className="review-thread-byline">
            {isQuestion ? (
              <>
                {isEmbeddedQuestion ? (
                  <>
                    <span className="review-thread-backend">Agent</span>
                    <span className="review-thread-kind">question</span>
                  </>
                ) : (
                  <span className="review-thread-kind">Legacy question</span>
                )}
                <span
                  className={`review-thread-status review-thread-status-${status}`}
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {statusLabel}
                </span>
              </>
            ) : (
              <span className="review-thread-kind">Review comment</span>
            )}
          </div>
          <ActionButton
            onClick={onResolve}
            disabled={resolving}
            ariaLabel={isQuestion ? 'Resolve agent question' : 'Resolve review comment'}
          >
            {resolving ? 'Resolving…' : 'Resolve'}
          </ActionButton>
        </header>
        <div className="review-thread-body">{initialBody}</div>
      </div>
      {replies.map((message, index) => (
        <div
          // Thread messages are append-only, so their source-order position is
          // stable for the lifetime of the card.
          // oxlint-disable-next-line react/no-array-index-key
          key={`${message.role}-${index}`}
          className={[
            'review-thread-entry',
            'review-thread-reply',
            `review-thread-reply-${message.role}`,
            message.role === 'assistant' ? `review-thread-reply-${message.outcome}` : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <header className="review-thread-header">
            <div className="review-thread-byline">
              <span className="review-thread-backend">
                {message.role === 'assistant' ? 'Agent' : 'You'}
              </span>
              <span className="review-thread-kind">
                {message.role === 'assistant'
                  ? messageOutcomeLabel(message.outcome)
                  : 'follow-up'}
              </span>
            </div>
          </header>
          <div className="review-thread-body">{message.content}</div>
        </div>
      ))}
      {isQuestion && status === 'pending' && isEmbeddedQuestion && (
        <div className="review-thread-entry review-thread-reply review-thread-reply-assistant review-thread-pending">
          <header className="review-thread-header">
            <div className="review-thread-byline">
              <span className="review-thread-backend">Agent</span>
              <span className="review-thread-kind">answering</span>
            </div>
          </header>
          <div className="review-thread-body review-thread-pending-body">
            <Spinner />
            <div>
              <div>Agent is answering…</div>
              <div className="review-thread-note">
                The reply will appear here automatically.
              </div>
            </div>
          </div>
        </div>
      )}
      {isQuestion && status === 'pending' && !isEmbeddedQuestion && (
        <div className="review-thread-entry review-thread-reply review-thread-pending">
          <div className="review-thread-body">
            <div className="review-thread-note">
              This older thread is not run automatically. Resolve it and use Ask agent to
              start a new question.
            </div>
          </div>
        </div>
      )}
      {isQuestion && isEmbeddedQuestion && status !== 'pending' && (
        <ThreadFollowUpForm
          text={followUpDraft}
          onTextChange={onFollowUpDraftChange}
          onSubmit={onFollowUp}
          submitting={followingUp}
          error={followUpError}
          restoreFocus={followUpRestoreFocus}
          onFocusChange={onFollowUpFocusChange}
        />
      )}
    </article>
  )
}

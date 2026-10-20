/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { useId } from 'react'
import type { AgentReviewFinding, AgentReviewRun } from '../shared/agentReview.ts'
import { ReviewMarkdown } from './ReviewMarkdown.tsx'
import type { ReviewController } from './ReviewPanel.tsx'

/** Namespaced above virtualized cards, independently for every run and finding. */
export const findingChatKey = (runId: string, findingId: string) =>
  `agent-review:chat:${JSON.stringify([runId, findingId])}`

export function FindingChat({
  runId,
  run,
  finding,
  review,
  outdated,
}: {
  runId: string
  run: AgentReviewRun | undefined
  finding: AgentReviewFinding
  review: ReviewController
  outdated: boolean
}) {
  const key = findingChatKey(runId, finding.id)
  const open = review.previews[key] ?? false
  const contentId = useId()
  const turns = run?.turns.filter((turn) => turn.findingId === finding.id) ?? []
  const lastTurn = run?.turns.at(-1)
  const active = run?.status === 'queued' || run?.status === 'running'
  const replying = active && lastTurn?.findingId === finding.id
  const text = review.text[key] ?? ''
  const path = `/api/agent-review/${encodeURIComponent(runId)}/findings/${encodeURIComponent(finding.id)}/messages`
  const cancelPath = `/api/agent-review/${encodeURIComponent(runId)}/cancel`
  const enabled = review.data?.agent.enabled ?? review.data?.agent.available ?? false
  const disabledReason = !run
    ? 'Review run unavailable. Previous chat remains readable.'
    : outdated
      ? 'Outdated diff — new replies are disabled. Previous chat remains readable.'
      : !enabled
        ? `Agent unavailable: ${review.data?.agent.error ?? 'Agent inference is disabled.'} Previous chat remains readable.`
        : active
          ? replying
            ? 'A reply is in progress for this finding.'
            : 'A review or reply is in progress for this run.'
          : null
  const canSend =
    !disabledReason && !review.mutation.isPending && !!text.trim() && text.length <= 20_000
  const sendError = review.mutation.variables?.path === path && review.mutation.error
  const cancelError =
    replying && review.control.variables?.path === cancelPath && review.control.error

  return (
    <section
      className="finding-chat"
      aria-label="Private finding chat"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="finding-chat-heading">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => review.setPreviews((previous) => ({ ...previous, [key]: !open }))}
        >
          Chat with agent
        </button>
        <span>
          {turns.length} private follow-up{turns.length === 1 ? '' : 's'}
        </span>
      </div>
      {open && (
        <div id={contentId} className="finding-chat-content">
          <p className="finding-chat-note">
            Private conversation about this finding. Nothing is saved as a draft or
            published automatically.
          </p>
          {turns.map((turn) => (
            <div className="finding-chat-turn" key={turn.id}>
              <div className="finding-chat-message">
                <strong>You · private question</strong>
                <ReviewMarkdown text={turn.question} />
              </div>
              {turn.answer && (
                <div className="finding-chat-message finding-chat-answer">
                  <strong>Agent · private answer</strong>
                  <ReviewMarkdown text={turn.answer} />
                </div>
              )}
              {turn.error && <p role="alert">{turn.error}</p>}
            </div>
          ))}
          {replying && (
            <div className="finding-chat-message finding-chat-answer">
              <strong>Agent · private reply</strong>
              {run.partial && <ReviewMarkdown text={run.partial} />}
              <p className="agent-review-progress" role="status">
                {run.status === 'queued'
                  ? 'Waiting for the reply…'
                  : run.partial
                    ? 'Agent is writing a reply…'
                    : 'Agent is thinking about this finding…'}
              </p>
              <button
                type="button"
                disabled={review.control.isPending}
                onClick={() => review.control.mutate({ path: cancelPath })}
              >
                Stop reply
              </button>
            </div>
          )}
          {cancelError && <p role="alert">{cancelError.message}</p>}
          {sendError && <p role="alert">{sendError.message}</p>}
          <label htmlFor={`${contentId}-question`}>Private follow-up</label>
          <textarea
            id={`${contentId}-question`}
            aria-label="Private finding follow-up"
            maxLength={20_000}
            disabled={review.mutation.isPending}
            value={text}
            onChange={(event) =>
              review.setText((previous) => ({ ...previous, [key]: event.target.value }))
            }
            placeholder="Ask about this finding…"
          />
          {disabledReason && <p className="finding-chat-disabled">{disabledReason}</p>}
          <button
            type="button"
            disabled={!canSend}
            onClick={() => {
              if (!canSend) return
              review.mutation.mutate({
                path,
                body: { id: crypto.randomUUID(), text },
                clear: key,
              })
            }}
          >
            Send private question
          </button>
        </div>
      )}
    </section>
  )
}

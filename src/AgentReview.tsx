/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  DEFAULT_REVIEW_PROMPT,
  type AgentReviewFinding,
  type AgentReviewRun,
  type ReviewAgentModel,
  type ReviewAgentModels,
  type ReviewReasoning,
  type StartAgentReview,
} from '../shared/agentReview.ts'
import type { ReviewAnchor } from '../shared/review.ts'
import { ReviewMarkdown } from './ReviewMarkdown.tsx'
import { FindingChat } from './FindingChat.tsx'
import { reviewRequest, type ReviewController } from './ReviewPanel.tsx'
import './agentReview.css'
import { ReviewTool, useReviewTool } from './ReviewToolbar.tsx'

const PROMPT_KEY = 'agent-review:prompt'
const modelKey = (model: StartAgentReview['model']) =>
  JSON.stringify([model.provider, model.modelId])

/** Keep conventional-comment text intact while applying the safe review Markdown policy. */
export function ConventionalCommentMarkdown({ body }: { body: string }) {
  return <ReviewMarkdown text={body} />
}

export function AgentFinding({
  runId,
  finding,
  review,
  onNavigate,
  displayedRevision,
}: {
  runId: string
  finding: AgentReviewFinding
  review: ReviewController
  onNavigate?: (anchor: ReviewAnchor) => void
  displayedRevision?: string
}) {
  const { anchor } = finding
  const run = review.data?.agentReviews?.find((item) => item.id === runId)
  const outdated =
    !review.data ||
    anchor.revision !== (displayedRevision ?? review.data.revision) ||
    anchor.revision !== review.data.revision ||
    (run !== undefined && run.revision !== review.data.revision)
  const path = `/api/agent-review/${encodeURIComponent(runId)}/findings/${encodeURIComponent(finding.id)}`
  const actionError =
    (review.mutation.variables?.path === `${path}/accept` ||
      review.mutation.variables?.path === `${path}/dismiss`) &&
    review.mutation.error

  return (
    <article className="agent-finding" aria-label="Agent review finding">
      <header className="agent-finding-header">
        <strong>
          {finding.status === 'pending' ? 'Pending suggestion' : 'Agent suggestion'}
        </strong>
        {finding.status === 'accepted' && (
          <span className="agent-review-pill" data-tone="success">
            {review.data?.drafts.some((draft) => draft.id === finding.id)
              ? 'Saved as review draft'
              : 'Accepted — draft removed'}
          </span>
        )}
        {finding.status === 'dismissed' && (
          <span className="agent-review-pill">Dismissed</span>
        )}
        {outdated && (
          <span className="agent-review-pill" data-tone="warning">
            Outdated — diff changed
          </span>
        )}
      </header>
      <div className="agent-finding-location">
        <span>
          {anchor.path}:{anchor.line} ({anchor.side === 'LEFT' ? 'old' : 'new'})
        </span>
        {onNavigate && !outdated && (
          <button type="button" onClick={() => onNavigate(anchor)}>
            Show in diff
          </button>
        )}
      </div>
      <ConventionalCommentMarkdown body={finding.body} />
      {finding.status === 'pending' && (
        <div className="agent-review-actions">
          <button
            type="button"
            disabled={outdated || review.mutation.isPending}
            onClick={() => review.mutation.mutate({ path: `${path}/accept` })}
          >
            Accept for review
          </button>
          <button
            type="button"
            disabled={review.mutation.isPending}
            onClick={() => review.mutation.mutate({ path: `${path}/dismiss` })}
          >
            Dismiss
          </button>
        </div>
      )}
      {actionError && <p role="alert">{actionError.message}</p>}
      <FindingChat
        runId={runId}
        run={run}
        finding={finding}
        review={review}
        outdated={outdated}
      />
    </article>
  )
}

function AgentRun({
  run,
  review,
  onNavigate,
  displayedRevision,
}: {
  run: AgentReviewRun
  review: ReviewController
  onNavigate?: (anchor: ReviewAnchor) => void
  displayedRevision?: string
}) {
  const active = run.status === 'queued' || run.status === 'running'
  const chatTurn = run.turns.at(-1)?.findingId
  const activeChat = active && !!chatTurn
  const outdated = run.revision !== (displayedRevision ?? review.data?.revision)
  const cancelPath = `/api/agent-review/${encodeURIComponent(run.id)}/cancel`
  const cancelError =
    !chatTurn && review.control.variables?.path === cancelPath && review.control.error
  return (
    <article className="agent-review-run" aria-label="Agent review run">
      <header className="agent-review-run-header">
        <strong>
          {run.model.provider}/{run.model.modelId}
        </strong>
        <span>Reasoning: {run.reasoningLevel}</span>
        <span className="agent-review-pill">
          {chatTurn ? `Chat ${run.status}` : run.status}
        </span>
        {outdated && (
          <span className="agent-review-pill" data-tone="warning">
            Outdated — diff changed
          </span>
        )}
        {active && !activeChat && (
          <button
            type="button"
            disabled={review.control.isPending}
            onClick={() => review.control.mutate({ path: cancelPath })}
          >
            Stop review
          </button>
        )}
      </header>
      {active && !activeChat && (
        <p className="agent-review-progress" role="status">
          {run.status === 'queued'
            ? 'Waiting for the agent…'
            : run.partial
              ? 'Agent is writing…'
              : 'Agent is reviewing the diff…'}
        </p>
      )}
      {run.partial && !chatTurn && (
        <section aria-label="Streaming agent review">
          <ReviewMarkdown text={run.partial} />
        </section>
      )}
      {run.summary && (
        <section aria-label="Agent review summary">
          <h3>Summary</h3>
          <ReviewMarkdown text={run.summary} />
        </section>
      )}
      {run.turns.map((turn) =>
        !turn.findingId && turn.error ? (
          <p role="alert" key={turn.id}>
            {turn.error}
          </p>
        ) : null,
      )}
      {cancelError && <p role="alert">{cancelError.message}</p>}
      {run.status === 'answered' && run.findings.length === 0 && (
        <p>No suggested review comments.</p>
      )}
      {run.findings.length > 0 && (
        <div className="agent-review-findings" aria-label="Suggested review comments">
          {run.findings.map((finding) => (
            <AgentFinding
              key={finding.id}
              runId={run.id}
              finding={finding}
              review={review}
              onNavigate={onNavigate}
              displayedRevision={displayedRevision}
            />
          ))}
        </div>
      )}
    </article>
  )
}

export function AgentReviewPanel({
  review,
  onNavigate,
  displayedRevision,
}: {
  review: ReviewController
  onNavigate?: (anchor: ReviewAnchor) => void
  displayedRevision?: string
}) {
  const { open, setOpen } = useReviewTool('agent')
  const [chosenModel, setChosenModel] = useState<string | null>(null)
  const [chosenReasoning, setChosenReasoning] = useState<ReviewReasoning | null>(null)
  const prompt = review.text[PROMPT_KEY] ?? DEFAULT_REVIEW_PROMPT
  const snapshot = review.data
  const enabled = snapshot?.agent.enabled ?? snapshot?.agent.available ?? false
  // Opening the form fetches catalog metadata, never starts inference.
  const catalog = useQuery({
    queryKey: ['agent-review-models'],
    queryFn: () => reviewRequest<ReviewAgentModels>('/api/agent-review/models'),
    enabled: open && enabled,
    retry: false,
  })
  const models = catalog.data?.models ?? []
  const defaultModel =
    models.find((model) =>
      catalog.data?.defaultModel
        ? modelKey(model) === modelKey(catalog.data.defaultModel)
        : false,
    ) ?? models[0]
  const selectedModel: ReviewAgentModel | undefined = chosenModel
    ? models.find((model) => modelKey(model) === chosenModel)
    : defaultModel
  const selectedReasoning =
    selectedModel?.reasoningLevels.find((level) => level === chosenReasoning) ??
    selectedModel?.reasoningLevels[0]
  const startError =
    review.mutation.variables?.path === '/api/agent-review' && review.mutation.error
  const canStart =
    (!displayedRevision || displayedRevision === snapshot?.revision) &&
    enabled &&
    !catalog.isPending &&
    !catalog.isFetching &&
    !catalog.error &&
    !!selectedModel &&
    !!selectedReasoning &&
    !!prompt.trim() &&
    prompt.length <= 20_000 &&
    !review.mutation.isPending

  const runs = snapshot?.agentReviews ?? []
  const active =
    runs.find((run) => run.status === 'running') ??
    runs.find((run) => run.status === 'queued')
  const pending = runs
    .filter((run) => run.revision === snapshot?.revision)
    .flatMap((run) => run.findings)
    .filter((finding) => finding.status === 'pending').length
  const failed = runs.some(
    (run) =>
      run.revision === snapshot?.revision &&
      run.status === 'failed' &&
      !run.turns.at(-1)?.findingId,
  )
  const failedChat = runs.some(
    (run) =>
      run.revision === snapshot?.revision &&
      run.status === 'failed' &&
      !!run.turns.at(-1)?.findingId,
  )
  const activeChat = !!active?.turns.at(-1)?.findingId
  return (
    <ReviewTool
      id="agent"
      className="agent-review-panel"
      heading="Agent Review"
      actions={
        <>
          {active && (
            <>
              <span
                className="review-tool-state"
                role="status"
                title={`${active.model.provider}/${active.model.modelId}`}
              >
                {activeChat
                  ? active.status === 'running'
                    ? 'Chatting…'
                    : 'Chat queued'
                  : active.status === 'running'
                    ? 'Reviewing…'
                    : 'Queued'}
              </span>
              <button
                type="button"
                disabled={review.control.isPending}
                onClick={() =>
                  review.control.mutate({
                    path: `/api/agent-review/${encodeURIComponent(active.id)}/cancel`,
                  })
                }
              >
                {activeChat ? 'Stop reply' : 'Stop review'}
              </button>
            </>
          )}
          {pending > 0 && <span className="review-tool-state">{pending} pending</span>}
          {!active && failed && (
            <span className="review-tool-state" data-tone="error">
              Review failed
            </span>
          )}
          {!active && !failed && failedChat && (
            <span className="review-tool-state" data-tone="error">
              Chat failed
            </span>
          )}
        </>
      }
      toolbar={
        <div className="agent-review-toolbar">
          <button
            type="button"
            aria-expanded={open}
            aria-controls="agent-review-form"
            onClick={() => setOpen(!open)}
          >
            Agent Review
          </button>
          {active && (
            <span role="status">
              {activeChat
                ? active.status === 'running'
                  ? 'Chatting…'
                  : 'Chat queued'
                : active.status === 'running'
                  ? 'Reviewing…'
                  : 'Queued'}
            </span>
          )}
        </div>
      }
    >
      {review.error && <p role="alert">Review unavailable: {review.error.message}</p>}
      <div id="agent-review-form" hidden={!open}>
        <p>
          Conventional Comments by default. Accept suggestions individually; nothing is
          published automatically.
        </p>
        {!enabled && (
          <p role="alert">
            Agent unavailable:{' '}
            {snapshot?.agent.error ?? 'Configure an agent model on the server.'}
          </p>
        )}
        {enabled && catalog.isPending && <p role="status">Loading agent models…</p>}
        {catalog.error && <p role="alert">Models: {catalog.error.message}</p>}
        {catalog.data && models.length === 0 && <p>No agent models available.</p>}
        <div className="agent-review-settings">
          <label>
            Agent model
            <select
              aria-label="Agent model"
              value={selectedModel ? modelKey(selectedModel) : ''}
              disabled={!enabled || !models.length || catalog.isPending}
              onChange={(event) => {
                setChosenModel(event.target.value)
                setChosenReasoning(null)
              }}
            >
              <option value="" disabled>
                Select a model
              </option>
              {models.map((model) => (
                <option key={modelKey(model)} value={modelKey(model)}>
                  {model.name} ({model.provider}/{model.modelId})
                </option>
              ))}
            </select>
          </label>
          <label>
            Reasoning
            <select
              aria-label="Reasoning"
              value={selectedReasoning ?? ''}
              disabled={!enabled || !selectedModel || !selectedReasoning}
              onChange={(event) =>
                setChosenReasoning(event.target.value as ReviewReasoning)
              }
            >
              <option value="" disabled>
                Select a reasoning level
              </option>
              {selectedModel?.reasoningLevels.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Review prompt
          <textarea
            aria-label="Review prompt"
            maxLength={20_000}
            value={prompt}
            onChange={(event) =>
              review.setText((previous) => ({
                ...previous,
                [PROMPT_KEY]: event.target.value,
              }))
            }
          />
        </label>
        <button
          type="button"
          disabled={!canStart}
          onClick={() => {
            if (!canStart || !snapshot || !selectedModel || !selectedReasoning) return
            review.mutation.mutate(
              {
                path: '/api/agent-review',
                creation: true,
                body: {
                  id: crypto.randomUUID(),
                  revision: snapshot.revision,
                  prompt,
                  model: {
                    provider: selectedModel.provider,
                    modelId: selectedModel.modelId,
                  },
                  reasoningLevel: selectedReasoning,
                } satisfies StartAgentReview,
              },
              { onSuccess: () => setOpen(false) },
            )
          }}
        >
          Start review
        </button>
        {startError && <p role="alert">{startError.message}</p>}
      </div>
      {snapshot?.agentReviews?.map((run) => (
        <AgentRun
          key={run.id}
          run={run}
          review={review}
          onNavigate={onNavigate}
          displayedRevision={displayedRevision}
        />
      ))}
    </ReviewTool>
  )
}

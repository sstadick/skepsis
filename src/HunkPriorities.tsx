/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  hasPriorityScore,
  priorityLevel,
  type HunkPriority,
  type PrioritySnapshot,
} from '../shared/priorities.ts'
import type { ReviewAnchor, ReviewSnapshot } from '../shared/review.ts'
import { reviewRequest } from './ReviewPanel.tsx'
import './priorities.css'

export function currentPriorities(snapshot?: PrioritySnapshot, revision?: string) {
  return snapshot && snapshot.revision === revision && snapshot.status !== 'stale'
    ? snapshot.results
    : []
}

export function useHunkPriorities(revision?: string, enabled = false) {
  const qc = useQueryClient()
  const pending = useRef<{ id: string; revision: string } | null>(null)
  const query = useQuery({
    queryKey: ['priorities'],
    queryFn: () => reviewRequest<PrioritySnapshot>('/api/priorities'),
    enabled,
    // SSE normally drives progress. Poll cheaply while active to recover from
    // a dropped event/connection, without reloading the diff or running git.
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1500 : false),
  })
  useEffect(() => {
    if (pending.current?.id === query.data?.runId) pending.current = null
  }, [query.data?.runId])
  const changed = () => qc.invalidateQueries({ queryKey: ['priorities'] })
  const onError = (error: Error) => {
    if ('status' in error && error.status === 409) {
      void qc.invalidateQueries({ queryKey: ['diff'] })
      void qc.invalidateQueries({ queryKey: ['review'] })
    }
  }
  const start = useMutation({
    mutationFn: async () => {
      if (!revision) throw new Error('Load the diff before prioritizing hunks')
      if (pending.current?.revision !== revision)
        pending.current = { id: crypto.randomUUID(), revision }
      try {
        const snapshot = await reviewRequest<PrioritySnapshot>(
          '/api/priorities',
          'POST',
          pending.current,
        )
        pending.current = null
        return snapshot
      } catch (error) {
        // Unknown transport outcomes retain the ID: retrying must not bill for
        // a duplicate batch when only the response was lost.
        if (error instanceof Error && 'status' in error && Number(error.status) < 500)
          pending.current = null
        throw error
      }
    },
    retry: false,
    onSuccess: (snapshot) => qc.setQueryData(['priorities'], snapshot),
    onError,
    onSettled: changed,
  })
  const cancel = useMutation({
    mutationFn: (snapshot: PrioritySnapshot) =>
      reviewRequest<PrioritySnapshot>('/api/priorities/cancel', 'POST', {
        id: snapshot.runId,
        revision: snapshot.revision,
      }),
    retry: false,
    onSuccess: (snapshot) => qc.setQueryData(['priorities'], snapshot),
    onError,
    onSettled: changed,
  })
  const results = useMemo(
    () => currentPriorities(query.data, revision),
    [query.data, revision],
  )
  return { ...query, results, start, cancel }
}

type PriorityController = ReturnType<typeof useHunkPriorities>

export function PriorityBadge({ hunk }: { hunk: HunkPriority }) {
  if (!hasPriorityScore(hunk))
    return (
      <span className="hunk-priority-badge priority-tone" title={hunk.error}>
        {hunk.status === 'queued' ? 'Scoring…' : 'Not scored'}
      </span>
    )
  const level = priorityLevel(hunk.score)
  return (
    <span
      className="hunk-priority-badge priority-tone"
      data-level={level.toLowerCase()}
      title="Expected review-attention level: 0 mechanical, 1 low, 2 normal, 3 high, 4 critical. Not a confirmed defect."
    >
      {level} · {hunk.score.toFixed(1)}/4
    </span>
  )
}

function Confidence({ hunk }: { hunk: HunkPriority }) {
  return hunk.status === 'scored' && hunk.confidence !== undefined ? (
    <span
      className="hunk-priority-confidence"
      data-uncertain={hunk.confidence < 0.65 || undefined}
      title={`Classifier confidence: ${Math.round(hunk.confidence * 100)}%. Scores are estimates; use human judgment.`}
    >
      {hunk.confidence < 0.65 ? 'Uncertain — inspect manually' : hunk.category}
    </span>
  ) : null
}

export function HunkPriorityNote({
  hunk,
  onDiscuss,
}: {
  hunk: HunkPriority
  onDiscuss: () => void
}) {
  return (
    <div className="hunk-priority-note" aria-label="Hunk review priority">
      <span className="hunk-priority-label">Review priority</span>
      <PriorityBadge hunk={hunk} />
      <Confidence hunk={hunk} />
      {hunk.error && <span>{hunk.error}</span>}
      <button type="button" onClick={onDiscuss}>
        Discuss hunk
      </button>
    </div>
  )
}

export function HunkPriorities({
  priorities,
  revision,
  classifier,
  onNavigate,
}: {
  priorities: PriorityController
  revision: string
  classifier?: ReviewSnapshot['agent']['classifier']
  onNavigate: (anchor: ReviewAnchor) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const snapshot = priorities.data
  const stale = snapshot?.status === 'stale' || snapshot?.revision !== revision
  const running = snapshot?.status === 'running'
  const disabledReason = priorities.error
    ? 'Could not load hunk priorities'
    : !snapshot
      ? 'Loading priority settings…'
      : snapshot.unavailableReason
  const sorted = useMemo(
    () => priorities.results.toSorted((a, b) => (b.score ?? -1) - (a.score ?? -1)),
    [priorities.results],
  )
  const error = priorities.start.error ?? priorities.cancel.error ?? priorities.error
  return (
    <section className="hunk-priorities" aria-label="Hunk priorities">
      <div className="hunk-priority-toolbar">
        <button
          type="button"
          disabled={
            !!disabledReason ||
            !snapshot?.available ||
            running ||
            priorities.start.isPending
          }
          title={
            disabledReason ??
            'Send the displayed diff hunks to the configured classifier for review-attention scores'
          }
          onClick={() => {
            priorities.cancel.reset()
            priorities.start.mutate()
          }}
        >
          Prioritize hunks
        </button>
        <span className="hunk-priority-status" role="status">
          {!snapshot
            ? 'Loading…'
            : !snapshot.available
              ? 'Configure a classifier to enable scoring'
              : stale
                ? 'Diff changed — prioritize again'
                : running
                  ? `Scoring ${snapshot.completed}/${snapshot.total} hunks`
                  : snapshot.status === 'idle'
                    ? 'Find where to focus your review'
                    : `${snapshot.completed}/${snapshot.total} processed${snapshot.status === 'cancelled' ? ' · stopped' : ''}`}
        </span>
        {running && (
          <button
            type="button"
            disabled={priorities.cancel.isPending}
            onClick={() => priorities.cancel.mutate(snapshot)}
          >
            Stop scoring
          </button>
        )}
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="hunk-priority-details"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Hide priorities' : 'Show priorities'}
        </button>
      </div>
      {error && <p role="alert">{error.message}</p>}
      {snapshot?.error && !stale && <p role="alert">{snapshot.error}</p>}
      <div id="hunk-priority-details" hidden={!expanded}>
        <p className="hunk-priority-help">
          {snapshot?.unavailableReason ??
            'Scores estimate review attention, not confirmed bugs. Inspect uncertain results manually. Hunks are sorted highest priority first; scores also appear beside their changed lines.'}
        </p>
        {classifier && (
          <p className="hunk-priority-help">
            Explicit scoring sends diff hunks to{' '}
            <code>
              {classifier.provider}/{classifier.model}
            </code>{' '}
            at <code>{classifier.endpoint}</code>. No private conversations are sent. Scores
            last until the server restarts; nothing is marked viewed or published.
          </p>
        )}
        {!stale && sorted.length > 0 && (
          <ol className="hunk-priority-list">
            {sorted.map((hunk) => (
              <li key={hunk.id}>
                <button
                  type="button"
                  data-priority-id={hunk.id}
                  title={hunk.header}
                  onClick={() => {
                    onNavigate(hunk.anchor)
                    setExpanded(false)
                  }}
                >
                  <PriorityBadge hunk={hunk} />
                  <span className="hunk-priority-path">
                    {hunk.path}:{hunk.anchor.line}{' '}
                    <span>({hunk.anchor.side === 'LEFT' ? 'old' : 'new'})</span>
                  </span>
                  <Confidence hunk={hunk} />
                  {hunk.error && <span>{hunk.error}</span>}
                </button>
              </li>
            ))}
          </ol>
        )}
        {snapshot?.status === 'complete' && !snapshot.total && !stale && (
          <p className="hunk-priority-help">No text hunks to score in this diff.</p>
        )}
      </div>
    </section>
  )
}

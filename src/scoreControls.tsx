/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { Tooltip } from '@base-ui/react/tooltip'
import type { ReactElement } from 'react'
import { pendingScoringCount, scoringErrorLabel } from './score.ts'
import type { ScoringSummary } from './score.ts'

const SCORE_TOOLTIP =
  'Model review priority, not bug probability — a low score is not a safety guarantee.'

function ScoreTip({ children }: { children: ReactElement }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger delay={150} closeOnClick render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner className="tooltip-positioner" side="bottom" sideOffset={6}>
          <Tooltip.Popup className="tooltip-popup">
            <span className="score-tooltip-copy">{SCORE_TOOLTIP}</span>
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
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

export function ScoreControls({
  summary,
  triggerPending,
  cancelPending,
  onTrigger,
  onCancel,
}: {
  summary: ScoringSummary
  triggerPending: boolean
  cancelPending: boolean
  onTrigger: () => void
  onCancel: () => void
}) {
  const pending = pendingScoringCount(summary)
  const hasPending = triggerPending || pending > 0
  const hasFailures = summary.failed > 0 || summary.error != null
  const errorLabel = scoringErrorLabel(summary)
  const hasClaimed = summary.claimed > 0
  const pendingLabel = hasClaimed
    ? `Scoring${pending > 1 ? ` (${pending} left)` : ''}`
    : `Queued${pending > 1 ? ` (${pending})` : ''}`

  if (hasPending) {
    return (
      <div className="score-controls">
        <span
          className={'score-status ' + (hasClaimed ? 'running' : 'waiting')}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <Spinner />
          {pendingLabel}
        </span>
        {hasFailures && errorLabel && (
          <span className="score-error" title={errorLabel}>
            {errorLabel}
          </span>
        )}
        <button
          type="button"
          className="unview-all-button"
          onClick={onCancel}
          disabled={triggerPending || cancelPending}
        >
          Cancel
        </button>
      </div>
    )
  }

  if (hasFailures) {
    return (
      <div className="score-controls">
        {errorLabel && (
          <span className="score-error" role="status" title={errorLabel}>
            {errorLabel}
          </span>
        )}
        <ScoreTip>
          <button
            type="button"
            className="unview-all-button"
            onClick={onTrigger}
            disabled={triggerPending}
          >
            Retry
          </button>
        </ScoreTip>
      </div>
    )
  }

  return (
    <div className="score-controls">
      <ScoreTip>
        <button
          type="button"
          className="unview-all-button"
          onClick={onTrigger}
          disabled={triggerPending}
        >
          Score
        </button>
      </ScoreTip>
    </div>
  )
}

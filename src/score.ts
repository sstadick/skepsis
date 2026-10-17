/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import type { HunkScore, ScoringSummary } from '../shared/types.ts'
export type { ScoringSummary } from '../shared/types.ts'

interface RawHunkScore {
  newStart?: unknown
  newCount?: unknown
  oldStart?: unknown
  oldCount?: unknown
  score?: unknown
}

export interface FileScoreDecorations {
  lineScores: Map<string, number>
  signature: string
}

type ScoreLineType = 'change-addition' | 'change-deletion'

const SCORE_ATTR = 'data-skepsis-score'
const SCORE_COLOR_VAR = '--skepsis-score-color'
const SCORE_SIGNATURE_PRECISION = 1000
const originalTitles = new WeakMap<HTMLElement, string | null>()

export const SCORE_GUTTER_CSS = `
  [data-column-number][${SCORE_ATTR}] {
    position: relative;
  }

  [data-column-number][${SCORE_ATTR}]::after {
    content: '';
    position: absolute;
    inset-block: 1px;
    inset-inline-start: 0;
    width: 3px;
    border-radius: 999px;
    background: var(${SCORE_COLOR_VAR}, transparent);
    pointer-events: none;
  }
`

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0
  if (score <= 0) return 0
  if (score >= 1) return 1
  return score
}

function asNonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}

function normalizeHunkScore(value: unknown): HunkScore | null {
  if (value == null || typeof value !== 'object') return null
  const raw = value as RawHunkScore
  const ranges = [raw.oldStart, raw.oldCount, raw.newStart, raw.newCount]
  if (ranges.some((n) => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0))
    return null
  if (
    typeof raw.score !== 'number' ||
    !Number.isFinite(raw.score) ||
    raw.score < 0 ||
    raw.score > 1
  )
    return null
  return raw as HunkScore
}

export function normalizeScoringSummary(value: unknown): ScoringSummary {
  if (value == null || typeof value !== 'object') {
    return { queued: 0, claimed: 0, failed: 0 }
  }
  const raw = value as {
    queued?: unknown
    claimed?: unknown
    failed?: unknown
    error?: unknown
  }
  const error =
    typeof raw.error === 'string' && raw.error.length > 0 ? raw.error : undefined
  return {
    queued: asNonNegativeInteger(raw.queued),
    claimed: asNonNegativeInteger(raw.claimed),
    failed: asNonNegativeInteger(raw.failed),
    ...(error ? { error } : {}),
  }
}

export function pendingScoringCount(summary: ScoringSummary): number {
  return summary.queued + summary.claimed
}

export function scoringErrorLabel(summary: ScoringSummary): string | null {
  if (summary.error) return summary.error
  if (summary.failed > 0) {
    return `Scoring failed for ${summary.failed} hunk${summary.failed === 1 ? '' : 's'}`
  }
  return null
}

function scoreLineKey(lineType: ScoreLineType, lineNumber: number): string {
  return `${lineType}:${lineNumber}`
}

export function normalizeHunkScores(value: unknown): HunkScore[] {
  if (!Array.isArray(value)) return []
  return value
    .map(normalizeHunkScore)
    .filter((score): score is HunkScore => score !== null)
    .toSorted(
      (a, b) =>
        a.oldStart - b.oldStart ||
        a.newStart - b.newStart ||
        a.oldCount - b.oldCount ||
        a.newCount - b.newCount ||
        a.score - b.score,
    )
}

export function createFileScoreDecorations(value: unknown): FileScoreDecorations {
  const normalized = normalizeHunkScores(value)
  const lineScores = new Map<string, number>()
  const signature = normalized
    .map(
      ({ oldStart, oldCount, newStart, newCount, score }) =>
        `${oldStart}:${oldCount}:${newStart}:${newCount}:${Math.round(score * SCORE_SIGNATURE_PRECISION)}`,
    )
    .join('|')

  for (const { oldStart, oldCount, newStart, newCount, score } of normalized) {
    for (let offset = 0; offset < oldCount; offset++) {
      const key = scoreLineKey('change-deletion', oldStart + offset)
      lineScores.set(key, Math.max(score, lineScores.get(key) ?? 0))
    }
    for (let offset = 0; offset < newCount; offset++) {
      const key = scoreLineKey('change-addition', newStart + offset)
      lineScores.set(key, Math.max(score, lineScores.get(key) ?? 0))
    }
  }

  return { lineScores, signature }
}

export function scoreToCSSColor(score: number): string {
  const clamped = clampScore(score)
  if (clamped <= 0) return 'transparent'
  if (clamped < 0.5) {
    const mediumWeight = Math.round((clamped / 0.5) * 100)
    return `color-mix(in oklch, transparent ${100 - mediumWeight}%, var(--score-attention-medium) ${mediumWeight}%)`
  }
  if (clamped >= 1) return 'var(--score-attention-high)'
  const highWeight = Math.round(((clamped - 0.5) / 0.5) * 100)
  if (highWeight <= 0) return 'var(--score-attention-medium)'
  return `color-mix(in oklch, var(--score-attention-medium) ${100 - highWeight}%, var(--score-attention-high) ${highWeight}%)`
}

export function tagScoreLines(
  node: HTMLElement,
  lineScores: ReadonlyMap<string, number>,
): void {
  const sr = node.shadowRoot
  if (!sr) return

  for (const el of sr.querySelectorAll<HTMLElement>(`[${SCORE_ATTR}]`)) {
    el.removeAttribute(SCORE_ATTR)
    el.style.removeProperty(SCORE_COLOR_VAR)
    const title = originalTitles.get(el)
    if (title == null) el.removeAttribute('title')
    else el.setAttribute('title', title)
    originalTitles.delete(el)
  }
  if (lineScores.size === 0) return

  for (const gutter of sr.querySelectorAll<HTMLElement>('[data-column-number]')) {
    const lineType = gutter.getAttribute('data-line-type')
    if (lineType !== 'change-addition' && lineType !== 'change-deletion') continue
    const lineNumber = Number.parseInt(gutter.getAttribute('data-column-number') ?? '', 10)
    if (!Number.isFinite(lineNumber)) continue
    const score = lineScores.get(scoreLineKey(lineType, lineNumber))
    if (score == null) continue
    originalTitles.set(gutter, gutter.getAttribute('title'))
    gutter.title = `Model review priority: ${Math.round(score * 100)}% — not bug probability`
    gutter.setAttribute(SCORE_ATTR, '')
    gutter.style.setProperty(SCORE_COLOR_VAR, scoreToCSSColor(score))
  }
}

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import {
  createFileScoreDecorations,
  normalizeScoringSummary,
  scoreToCSSColor,
} from './score.ts'

describe('createFileScoreDecorations', () => {
  it('maps old and new hunk ranges onto changed gutter lines', () => {
    const decorations = createFileScoreDecorations([
      {
        oldStart: 10,
        oldCount: 2,
        newStart: 20,
        newCount: 3,
        score: 0.75,
      },
      {
        oldStart: 0,
        oldCount: 0,
        newStart: 40,
        newCount: 2,
        score: 0.35,
      },
    ])

    expect(Object.fromEntries(decorations.lineScores)).toEqual({
      'change-deletion:10': 0.75,
      'change-deletion:11': 0.75,
      'change-addition:20': 0.75,
      'change-addition:21': 0.75,
      'change-addition:22': 0.75,
      'change-addition:40': 0.35,
      'change-addition:41': 0.35,
    })
    expect(decorations.signature).toBe('0:0:40:2:350|10:2:20:3:750')
  })

  it('keeps the highest score when score ranges overlap', () => {
    const decorations = createFileScoreDecorations([
      {
        oldStart: 0,
        oldCount: 0,
        newStart: 10,
        newCount: 2,
        score: 0.2,
      },
      {
        oldStart: 0,
        oldCount: 0,
        newStart: 11,
        newCount: 2,
        score: 0.9,
      },
    ])

    expect(Object.fromEntries(decorations.lineScores)).toEqual({
      'change-addition:10': 0.2,
      'change-addition:11': 0.9,
      'change-addition:12': 0.9,
    })
  })

  it('does not turn missing or invalid scores into low-priority markers', () => {
    const range = { newStart: 7, newCount: 1, oldStart: 0, oldCount: 0 }
    const decorations = createFileScoreDecorations([
      { ...range },
      { ...range, score: NaN },
      { ...range, score: 2 },
    ])
    expect(decorations.lineScores.size).toBe(0)
  })

  it('retains zero scores on deletion-only hunks', () => {
    const decorations = createFileScoreDecorations([
      { newStart: 0, newCount: 0, oldStart: 1, oldCount: 1, score: 0 },
    ])
    expect(decorations.lineScores.get('change-deletion:1')).toBe(0)
  })
})

describe('scoreToCSSColor', () => {
  it('uses a transparent → amber → red ramp', () => {
    expect(scoreToCSSColor(0)).toBe('transparent')
    expect(scoreToCSSColor(0.25)).toBe(
      'color-mix(in oklch, transparent 50%, var(--score-attention-medium) 50%)',
    )
    expect(scoreToCSSColor(0.5)).toBe('var(--score-attention-medium)')
    expect(scoreToCSSColor(0.75)).toBe(
      'color-mix(in oklch, var(--score-attention-medium) 50%, var(--score-attention-high) 50%)',
    )
    expect(scoreToCSSColor(1)).toBe('var(--score-attention-high)')
  })
})

describe('normalizeScoringSummary', () => {
  it('defaults missing summary fields and preserves errors', () => {
    expect(normalizeScoringSummary(undefined)).toEqual({
      queued: 0,
      claimed: 0,
      failed: 0,
    })
    expect(
      normalizeScoringSummary({ queued: 2, claimed: 1, failed: 3, error: 'worker died' }),
    ).toEqual({
      queued: 2,
      claimed: 1,
      failed: 3,
      error: 'worker died',
    })
  })
})

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { z } from 'zod'
import type { ReviewAnchor } from './review.ts'

// Clients select a revision, never provide patches, paths, prompts or models.
export const priorityRequestSchema = z
  .object({ id: z.string().uuid(), revision: z.string().min(1).max(200) })
  .strict()
export type PriorityRequest = z.infer<typeof priorityRequestSchema>

export interface HunkPriority {
  id: string
  path: string
  header: string
  anchor: ReviewAnchor
  status: 'queued' | 'scored' | 'failed' | 'skipped'
  /** Continuous expected level, not a discrete verdict. */
  score?: number
  confidence?: number
  category?: string
  error?: string
}

export const PRIORITY_LEVELS = ['Minimal', 'Low', 'Normal', 'High', 'Critical'] as const

// The same bands label sidebar colors, inline badges, and the ranked list.
export function priorityLevel(score: number): (typeof PRIORITY_LEVELS)[number] {
  if (score >= 3.5) return 'Critical'
  if (score >= 2.5) return 'High'
  if (score >= 1.5) return 'Normal'
  if (score >= 0.5) return 'Low'
  return 'Minimal'
}

export function hasPriorityScore(
  hunk: HunkPriority,
): hunk is HunkPriority & { score: number } {
  return (
    hunk.status === 'scored' &&
    typeof hunk.score === 'number' &&
    Number.isFinite(hunk.score) &&
    hunk.score >= 0 &&
    hunk.score <= 4
  )
}

/** Ephemeral, server-lifetime state. Results always retain their original revision. */
export interface PrioritySnapshot {
  revision: string
  runId?: string
  status: 'idle' | 'running' | 'complete' | 'cancelled' | 'stale' | 'failed'
  available: boolean
  unavailableReason?: string
  results: HunkPriority[]
  completed: number
  total: number
  error?: string
}

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { z } from 'zod'
import type { LineThread, ReviewAnchor, ThreadTurn } from './review.ts'

export const reasoningLevels = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export type ReviewReasoning = (typeof reasoningLevels)[number]
export const startAgentReviewSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.string().min(1).max(200),
  prompt: z.string().trim().min(1).max(20_000),
  model: z.strictObject({
    provider: z.string().min(1).max(200),
    modelId: z.string().min(1).max(300),
  }),
  reasoningLevel: z.enum(reasoningLevels),
})
export type StartAgentReview = z.infer<typeof startAgentReviewSchema>

export const findingMessageSchema = z.strictObject({
  id: z.string().uuid(),
  text: z.string().trim().min(1).max(20_000),
})
export type FindingMessage = z.infer<typeof findingMessageSchema>

export interface ReviewAgentModel {
  provider: string
  modelId: string
  name: string
  reasoningLevels: ReviewReasoning[]
}
export interface ReviewAgentModels {
  models: ReviewAgentModel[]
  defaultModel: { provider: string; modelId: string } | null
}

export interface AgentReviewFinding {
  id: string
  anchor: ReviewAnchor
  body: string
  status: 'pending' | 'accepted' | 'dismissed'
}

/** A whole-diff conversation, not a fabricated line anchor. */
export interface AgentReviewRun extends Omit<LineThread, 'anchor'> {
  /** Follow-ups share the original review conversation, scoped to a finding in the UI. */
  turns: (ThreadTurn & { findingId?: string })[]
  revision: string
  model: StartAgentReview['model']
  reasoningLevel: ReviewReasoning
  summary?: string
  findings: AgentReviewFinding[]
}

export interface ReviewLocation {
  path: string
  side: 'LEFT' | 'RIGHT'
  start: number
  count: number
}

export const DEFAULT_REVIEW_PROMPT =
  'Review this diff for correctness, regressions, security issues, and missing tests. Focus on actionable findings, explain their impact, and use Conventional Comments by default.'

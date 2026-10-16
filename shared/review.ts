/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { z } from 'zod'

export const anchorSchema = z.object({
  path: z.string().min(1).max(4096),
  side: z.enum(['LEFT', 'RIGHT']),
  line: z.number().int().positive(),
  revision: z.string().min(1).max(200),
})
export type ReviewAnchor = z.infer<typeof anchorSchema>

const textSchema = z.string().trim().min(1).max(20_000)
export const createThreadSchema = z.object({
  id: z.string().uuid(),
  anchor: anchorSchema,
  text: textSchema,
})
export const threadMessageSchema = z.object({ id: z.string().uuid(), text: textSchema })
export const draftSchema = z.object({
  id: z.string().uuid(),
  anchor: anchorSchema,
  body: textSchema,
})
export const submitReviewSchema = z.object({
  id: z.string().uuid(),
  event: z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']),
  body: z.string().trim().max(20_000),
  draftIds: z.array(z.string().uuid()).max(100),
  draftsDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
})
export type SubmitReview = z.infer<typeof submitReviewSchema>

export const confirmProviderSchema = z.object({ provider: z.string().min(1).max(200) })
export const PUBLICATION_ABANDON_ACK =
  'I checked GitHub and accept the risk of duplicate publication.'
export const abandonPublicationSchema = z.object({
  id: z.string().uuid(),
  acknowledgement: z.literal(PUBLICATION_ABANDON_ACK),
})

export interface PullRequest {
  owner: string
  repository: string
  number: number
  url: string
  title: string
  baseSha: string
  headSha: string
  diffBaseSha: string
}

export interface ThreadTurn {
  id: string
  question: string
  answer?: string
  error?: string
}

export interface LineThread {
  id: string
  anchor: ReviewAnchor
  turns: ThreadTurn[]
  status: 'queued' | 'running' | 'answered' | 'failed' | 'cancelled'
  resolved: boolean
  partial?: string
  providerChange?: { from: string; to: string }
}

export interface ReviewDraft {
  id: string
  anchor: ReviewAnchor
  body: string
  publishedReviewId?: number
}

/** Optimistic guard: publish exactly the saved comments the user previewed. */
export async function reviewDraftsDigest(drafts: readonly ReviewDraft[]): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify(
      drafts.map(({ id, body, anchor }) => [
        id,
        body,
        anchor.path,
        anchor.side,
        anchor.line,
        anchor.revision,
      ]),
    ),
  )
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('')
}

export interface ReviewPublication {
  id: string
  event: SubmitReview['event']
  body: string
  draftIds: string[]
  status: 'publishing' | 'published' | 'uncertain' | 'failed' | 'abandoned'
  reviewId?: number
  url?: string
  error?: string
}

export interface ReviewSnapshot {
  revision: string
  pullRequest: PullRequest | null
  agent: {
    model: string | null
    available: boolean
    error?: string
    codemode?: boolean
    classifier?: { provider: string; model: string; endpoint: string }
  }
  threads: LineThread[]
  drafts: ReviewDraft[]
  publication: ReviewPublication | null
}

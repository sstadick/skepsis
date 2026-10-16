/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { z } from 'zod'
import type { CommentSyntax } from './reviewComments.ts'

// --- Request schemas (validated by server) ---

export const viewedRequestSchema = z.object({
  file: z.string(),
  hash: z.string(),
})

export const viewedDeleteSchema = z.object({
  file: z.string(),
  hash: z.string(),
})

export const viewedDeleteAllSchema = z.object({
  files: z.array(viewedDeleteSchema),
})

export const commentRequestSchema = z.object({
  file: z.string(),
  afterLine: z.number(),
  text: z.string(),
})

export const commentDeleteSchema = z.object({
  file: z.string(),
  line: z.number(),
  threadId: z.string().uuid().optional(),
})

export const commentFollowUpSchema = z.object({
  file: z.string(),
  line: z.number(),
  text: z.string(),
  threadId: z.string().uuid().optional(),
})

export const AGENT_BACKENDS = ['pi', 'claude', 'codex'] as const
export type AgentBackend = (typeof AGENT_BACKENDS)[number]

export const questionClaimRequestSchema = z.object({
  backend: z.enum(AGENT_BACKENDS).optional(),
  worker: z.string().optional(),
})

export const questionAnswerRequestSchema = z.object({
  leaseId: z.string(),
  answer: z.string(),
})

export const questionFailRequestSchema = z.object({
  leaseId: z.string(),
  error: z.string(),
})

export const fileContentsQuerySchema = z.object({
  path: z.string(),
  // Present for renamed files: the path to fetch the old-side content from.
  oldPath: z.string().optional(),
})

// --- Request types (inferred from schemas) ---

export type ViewedRequest = z.infer<typeof viewedRequestSchema>
export type CommentRequest = z.infer<typeof commentRequestSchema>
export type CommentDeleteRequest = z.infer<typeof commentDeleteSchema>
export type CommentFollowUpRequest = z.infer<typeof commentFollowUpSchema>
export type QuestionClaimRequest = z.infer<typeof questionClaimRequestSchema>
export type QuestionAnswerRequest = z.infer<typeof questionAnswerRequestSchema>
export type QuestionFailRequest = z.infer<typeof questionFailRequestSchema>

// --- UI types ---

/** Color scheme. 'system' follows the OS preference; 'light' and 'dark' force
 *  it (e.g. light diffs on a dark desktop). One list drives the API schema,
 *  the toggle cycle, and the client's data-theme validation. */
export const THEME_MODES = ['light', 'dark', 'system'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

export const themeRequestSchema = z.object({ theme: z.enum(THEME_MODES) })

export interface ThemeResponse {
  theme: ThemeMode
}

// --- VCS types ---

/**
 * Concrete revisions at the two ends of the diff, used to fetch full file
 * contents for hunk expansion. `null` when the diff args can't be resolved to
 * concrete endpoints (exotic revsets) — expansion is disabled in that case.
 * The right side is `'workingCopy'` when the diff ends at the working tree
 * (git only; in jj the working copy is the real revision `@`).
 */
export type DiffEndpoints = {
  left: string
  right: { rev: string } | 'workingCopy'
} | null

export type DiffArgs = ({ vcs: 'jj'; args: string[] } | { vcs: 'git'; args: string[] }) & {
  commentsEnabled: boolean
  files: string[]
  endpoints: DiffEndpoints
  /** Args to show in the UI/log command string in place of `args`, for when
   *  the executed args (e.g., a resolved sha) are less readable than the
   *  user-facing form. */
  displayArgs?: string[]
}

// --- Response types (checked via satisfies on the server) ---

export type ViewedMap = Record<string, string>
export type FileHashes = Record<string, string>

export interface DiffResponse {
  /** Identity of this exact patch and its resolved review endpoints. */
  reviewRevision?: string
  patch: string
  revset: string
  vcs: 'jj' | 'git'
  commentsEnabled: boolean
  /** Whether diff endpoints resolved, so /api/file-contents can serve full
   *  file contents for hunk expansion. */
  expandable: boolean
  fileHashes: FileHashes
  viewed: ViewedMap
  /** Per-file comment syntax, shown in the comment form. An empty prefix
   *  means the format has no comment syntax (e.g. plain text); null means the
   *  file type wasn't recognized. Both get bare review tags on insert. Always
   *  empty when comments are disabled. */
  commentSyntaxes: Record<string, CommentSyntax | null>
  error?: string
}

/** Full file contents at each diff endpoint. A side is `null` when the file
 *  does not exist there (added → old null; deleted → new null) or could not be
 *  read (treated as non-expandable by the client). */
export interface FileContentsResponse {
  oldContents: string | null
  newContents: string | null
}

export interface QuestionSummary {
  id: string
  backend: AgentBackend
  state: 'queued'
}

export type QuestionConversationMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string
      outcome: 'answered' | 'failed'
    }

export interface CommentResponse {
  ok: true
  question?: QuestionSummary
}

export interface QuestionJob {
  id: string
  threadId: string
  backend: AgentBackend
  file: string
  line: number
  question: string
  messages: QuestionConversationMessage[]
  excerpt: string
  lineText: string
  commentOpenLine: number
  state: 'queued' | 'claimed' | 'answered' | 'failed'
  createdAt: number
  claimedAt?: number
  claimedBy?: string
  leaseId?: string
  answer?: string
  error?: string
}

export interface QuestionClaim {
  id: string
  backend: AgentBackend
  file: string
  line: number
  question: string
  messages: QuestionConversationMessage[]
  excerpt: string
  lineText: string
  leaseId: string
}

export interface QuestionClaimResponse {
  question: QuestionClaim | null
}

export interface ErrorResponse {
  error: string
}

export interface OkResponse {
  ok: true
}

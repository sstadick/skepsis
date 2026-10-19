/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { z } from 'zod'

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

export const fileContentsQuerySchema = z.object({
  path: z.string(),
  // Present for renamed files: the path to fetch the old-side content from.
  oldPath: z.string().optional(),
})

// --- Request types (inferred from schemas) ---

export type ViewedRequest = z.infer<typeof viewedRequestSchema>

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
  /** Whether diff endpoints resolved, so /api/file-contents can serve full
   *  file contents for hunk expansion. */
  expandable: boolean
  fileHashes: FileHashes
  viewed: ViewedMap
  error?: string
}

/** Full file contents at each diff endpoint. A side is `null` when the path is
 *  absent or untracked (added → old null; deleted → new null). Unsafe, binary,
 *  oversized or failed reads return an API error, never partial contents. */
export interface FileContentsResponse {
  oldContents: string | null
  newContents: string | null
}

export interface ErrorResponse {
  error: string
}

export interface OkResponse {
  ok: true
}

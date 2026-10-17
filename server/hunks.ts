/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

/**
 * Split a git-format patch into per-file hunks for review scoring.
 *
 * Each hunk is content-addressed by its file path, function context, and body.
 * Absolute `@@` line numbers are excluded since they shift when unrelated
 * parts of the file change. That makes the hash stable across line shifts and
 * self-invalidating when the hunk's own content changes — the same trick the
 * viewed store uses with blob IDs.
 *
 * `newStart` is the first line number on the new side, used to line a stored
 * score up with the hunk the client renders without re-hashing on the client.
 */

import { createHash } from 'node:crypto'

export interface Hunk {
  file: string
  /** Start on the new side; git uses zero for an empty side. */
  newStart: number
  newCount: number
  oldStart: number
  oldCount: number
  /** Full hunk text including the `@@` header, for classification. */
  text: string
  /** Content hash of path, function context, and body (not line numbers). */
  hash: string
}

// Match the diff renderer's quoted/unquoted path spelling.
const DIFF_HEADER = /^diff --git (?:"a\/(.+?)"|a\/(.+?)) (?:"b\/(.+?)"|b\/(.+?))$/
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/
/** Diff body lines carry a leading space, `+`, `-`, or `\` ("No newline"). */
const BODY_LINE = /^[ +\-\\]/

function hashHunk(file: string, context: string, body: string[]): string {
  return createHash('sha256')
    .update(file)
    .update('\0')
    .update(context)
    .update('\0')
    .update(body.join('\n'))
    .digest('hex')
    .slice(0, 16)
}

export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = []
  // Distinct occurrences are separate jobs even when their visible text matches.
  // An occurrence ordinal stays stable across unrelated line-number shifts.
  const occurrences = new Map<string, number>()
  let file: string | null = null
  let header: string | null = null
  let newStart = 0
  let newCount = 0
  let oldStart = 0
  let oldCount = 0
  let context = ''
  let body: string[] = []

  const flush = () => {
    if (file && header) {
      const contentHash = hashHunk(file, context, body)
      const occurrence = occurrences.get(contentHash) ?? 0
      occurrences.set(contentHash, occurrence + 1)
      const hash = createHash('sha256').update(`${contentHash}:${occurrence}`).digest('hex')
      hunks.push({
        file,
        newStart,
        newCount,
        oldStart,
        oldCount,
        text: [header, ...body].join('\n'),
        hash,
      })
    }
    header = null
    body = []
  }

  for (const line of patch.split('\n')) {
    const fileMatch = line.match(DIFF_HEADER)
    if (fileMatch) {
      flush()
      file = (fileMatch[3] ?? fileMatch[4])!.trim()
      continue
    }
    if (line.startsWith('diff --git ')) {
      flush()
      file = null
      continue
    }
    const hunkMatch = line.match(HUNK_HEADER)
    if (hunkMatch) {
      flush()
      header = line
      oldStart = Number(hunkMatch[1])
      oldCount = Number(hunkMatch[2] ?? 1)
      newStart = Number(hunkMatch[3])
      newCount = Number(hunkMatch[4] ?? 1)
      context = hunkMatch[5] ?? ''
      continue
    }
    // Body lines only accumulate inside a hunk; the file-header lines
    // (`--- `, `+++ `, `index `) all precede the first `@@`, where header is
    // still null, so their leading `+`/`-` never leak in.
    if (header && BODY_LINE.test(line)) {
      body.push(line)
    } else if (header) {
      flush()
    }
  }
  flush()
  return hunks
}

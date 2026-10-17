/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { randomUUID } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  BARE_COMMENT,
  parseReviewThread,
  REVIEW_STORAGE_RESERVED_TOKENS,
  SKEPSIS_AGENT_MARKER,
  SKEPSIS_ANSWER_SEPARATOR,
  SKEPSIS_ANSWER_STATE,
  SKEPSIS_COMMENT_MARKER,
  SKEPSIS_FAILURE_SEPARATOR,
  SKEPSIS_FAILURE_STATE,
  SKEPSIS_FOLLOWUP_SEPARATOR,
  SKEPSIS_THREAD_ID_PREFIX,
  SKEPSIS_THREAD_MARKER,
  splitSerializedReviewBody,
  type ReviewThreadContent,
} from '../shared/reviewComments.ts'
import type { AgentBackend, ReviewBodyKind } from '../shared/types.ts'
export const EMBEDDED_AGENT_BACKEND: AgentBackend = 'pi'

const STORAGE_RESERVED_PATTERN = new RegExp(
  [...new Set(REVIEW_STORAGE_RESERVED_TOKENS)]
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'g',
)
const THREAD_EXTENSION_PATTERN =
  /\n\nSkepsis-Thread: 1(?:; id=[0-9a-fA-F-]{36})?\n\nSkepsis-Followup:\n/

export interface QuestionContext {
  lineText: string
  excerpt: string
}

export function hasSerializedQuestionMarker(text: string): boolean {
  return splitSerializedReviewBody(text).marker === 'question'
}

export function parseStoredReviewThread(
  text: string,
  managedThreadId?: string,
): ReviewThreadContent {
  return parseReviewThread(text.split('\n'), BARE_COMMENT, '', managedThreadId)
}

/**
 * Escape framing tokens before user or agent text is persisted inside a
 * source-backed review block. Besides preventing premature </review> lines,
 * this keeps user-authored terminal markers from spoofing an answered state.
 */
export function sanitizeReviewStorageText(text: string): string {
  return text.replace(STORAGE_RESERVED_PATTERN, (token) => `\`${token}\``)
}

/** Encode a new managed review body; its version and UUID live on the open tag. */
export function serializeNewReviewBody(
  text: string,
  kind: ReviewBodyKind = 'comment',
): string {
  const prefix = kind === 'comment' ? SKEPSIS_COMMENT_MARKER : ''
  return `${prefix}${sanitizeReviewStorageText(text)}`
}

export function normalizeQuestionText(text: string): string {
  const question = text.trim()
  if (!question) throw new Error('A question cannot be empty')
  return question
}

export function serializeEmbeddedQuestion(text: string): {
  backend: AgentBackend
  question: string
  body: string
} {
  const question = normalizeQuestionText(text)
  const [firstLine = '', ...rest] = question.split('\n')
  return {
    backend: EMBEDDED_AGENT_BACKEND,
    question,
    body:
      SKEPSIS_AGENT_MARKER +
      sanitizeReviewStorageText(
        [`@${EMBEDDED_AGENT_BACKEND} ${firstLine}`, ...rest].join('\n'),
      ),
  }
}

export function appendQuestionAnswer(text: string, answer: string): string {
  return `${text}${questionAnswerSuffix(answer)}`
}

export function appendQuestionFailure(text: string, error: string): string {
  return `${text}${questionFailureSuffix(error)}`
}

export function questionAnswerSuffix(answer: string): string {
  return `${SKEPSIS_ANSWER_SEPARATOR}${sanitizeReviewStorageText(
    answer.trim(),
  )}${SKEPSIS_ANSWER_STATE}`
}

export function questionFailureSuffix(error: string): string {
  return `${SKEPSIS_FAILURE_SEPARATOR}${sanitizeReviewStorageText(
    error.trim(),
  )}${SKEPSIS_FAILURE_STATE}`
}

export function appendQuestionFollowUp(
  text: string,
  followUp: string,
  managedThreadId?: string,
  legacyThreadId = randomUUID(),
): string {
  const version = THREAD_EXTENSION_PATTERN.test(text)
    ? ''
    : managedThreadId
      ? SKEPSIS_THREAD_MARKER
      : `${SKEPSIS_THREAD_ID_PREFIX}${legacyThreadId}`
  return `${text}${version}${SKEPSIS_FOLLOWUP_SEPARATOR}${sanitizeReviewStorageText(
    followUp.trim(),
  )}`
}

export async function resolveSafeReviewFilePath(
  cwd: string,
  file: string,
): Promise<string> {
  const cwdReal = await realpath(cwd)
  const path = resolve(cwd, file)
  const stat = await lstat(path).catch(() => null)
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe review file path: ${file}`)
  }

  const resolved = await realpath(path).catch(() => null)
  if (!resolved) throw new Error(`Unsafe review file path: ${file}`)

  const rel = relative(cwdReal, resolved)
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new Error(`Unsafe review file path: ${file}`)
  }
  return resolved
}

export async function getQuestionContext(
  cwd: string,
  file: string,
  line: number,
  omitLines?: { start: number; end: number },
): Promise<QuestionContext> {
  const content = await readFile(await resolveSafeReviewFilePath(cwd, file), 'utf-8')
  const lines = content.split('\n')
  if (line < 1 || line > lines.length) {
    throw new Error(`Line ${line} out of range (file has ${lines.length} lines)`)
  }

  const visibleLines: number[] = []
  for (let n = 1; n <= lines.length; n++) {
    if (omitLines && n >= omitLines.start && n <= omitLines.end) continue
    visibleLines.push(n)
  }
  const targetAt = visibleLines.indexOf(line)
  if (targetAt < 0) throw new Error(`Context line ${line} is inside the omitted range`)
  const excerptLineNumbers = visibleLines.slice(Math.max(0, targetAt - 4), targetAt + 5)
  const width = String(excerptLineNumbers.at(-1) ?? line).length
  const excerptLines: string[] = []
  for (const n of excerptLineNumbers) {
    excerptLines.push(
      `${n === line ? '>' : ' '} ${String(n).padStart(width)} | ${lines[n - 1] ?? ''}`,
    )
  }

  return {
    lineText: lines[line - 1] ?? '',
    excerpt: excerptLines.join('\n'),
  }
}

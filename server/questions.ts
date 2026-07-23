/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  REVIEW_STORAGE_RESERVED_TOKENS,
  SKEPSIS_ANSWER_SEPARATOR,
  SKEPSIS_ANSWER_STATE,
  SKEPSIS_FAILURE_SEPARATOR,
  SKEPSIS_FAILURE_STATE,
  SKEPSIS_FOLLOWUP_SEPARATOR,
  SKEPSIS_THREAD_ID_PREFIX,
  SKEPSIS_THREAD_MARKER,
} from '../shared/reviewComments.ts'
import type {
  AgentBackend,
  QuestionClaimResponse,
  QuestionConversationMessage,
  QuestionJob,
} from '../shared/types.ts'

const QUESTION_PREFIX = /^\s*@(pi|claude|codex)\b[:\s-]*/i
const STORAGE_RESERVED_PATTERN = new RegExp(
  REVIEW_STORAGE_RESERVED_TOKENS.map((token) =>
    token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ).join('|'),
  'g',
)
const THREAD_EXTENSION_PATTERN =
  /\n\nSkepsis-Thread: 1(?:; id=[0-9a-fA-F-]{36})?\n\nSkepsis-Followup:\n/

export interface ParsedAgentQuestion {
  backend: AgentBackend
  question: string
}

export interface QuestionContext {
  lineText: string
  excerpt: string
}

export interface EnqueueQuestionInput {
  threadId: string
  backend: AgentBackend
  file: string
  line: number
  question: string
  excerpt: string
  lineText: string
  commentOpenLine: number
  messages: QuestionConversationMessage[]
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
export function serializeNewReviewBody(text: string): string {
  return sanitizeReviewStorageText(text)
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

export function parseAgentQuestion(text: string): ParsedAgentQuestion | null {
  const lines = text.trim().split('\n')
  const first = lines[0]
  if (!first) return null
  const match = first.match(QUESTION_PREFIX)
  if (!match) return null
  const backend = match[1]!.toLowerCase() as AgentBackend
  const question = [first.slice(match[0].length), ...lines.slice(1)].join('\n').trim()
  if (!question) {
    throw new Error(`@${backend} review comments need a question after the backend marker`)
  }
  return { backend, question }
}

export async function getQuestionContext(
  cwd: string,
  file: string,
  line: number,
  omitLines?: { start: number; end: number },
): Promise<QuestionContext> {
  const content = await readFile(join(cwd, file), 'utf-8')
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

function publicQuestion(job: QuestionJob): QuestionClaimResponse['question'] {
  return {
    id: job.id,
    backend: job.backend,
    file: job.file,
    line: job.line,
    question: job.question,
    messages: job.messages,
    excerpt: job.excerpt,
    lineText: job.lineText,
    leaseId: job.leaseId!,
  }
}

export class QuestionStore {
  private readonly jobs = new Map<string, QuestionJob>()

  enqueue(input: EnqueueQuestionInput): QuestionJob {
    const job: QuestionJob = {
      id: randomUUID(),
      threadId: input.threadId,
      backend: input.backend,
      file: input.file,
      line: input.line,
      question: input.question,
      messages: input.messages,
      excerpt: input.excerpt,
      lineText: input.lineText,
      commentOpenLine: input.commentOpenLine,
      state: 'queued',
      createdAt: Date.now(),
    }
    this.jobs.set(job.id, job)
    return job
  }

  claim(
    backend: AgentBackend | undefined,
    worker: string | undefined,
  ): QuestionClaimResponse['question'] {
    for (const job of this.jobs.values()) {
      if (job.state !== 'queued') continue
      if (backend && job.backend !== backend) continue
      job.state = 'claimed'
      job.claimedAt = Date.now()
      job.claimedBy = worker
      job.leaseId = randomUUID()
      return publicQuestion(job)
    }
    return null
  }

  getClaimed(id: string, leaseId: string): QuestionJob {
    const job = this.jobs.get(id)
    if (!job) throw new Error(`No such question: ${id}`)
    if (job.state !== 'claimed') {
      throw new Error(`Question ${id} is ${job.state}, not claimable`)
    }
    if (job.leaseId !== leaseId) throw new Error(`Lease mismatch for question ${id}`)
    return job
  }

  markAnswered(id: string, answer: string): void {
    const job = this.jobs.get(id)
    if (!job) throw new Error(`No such question: ${id}`)
    job.state = 'answered'
    job.answer = answer
  }

  markFailed(id: string, error: string): void {
    const job = this.jobs.get(id)
    if (!job) throw new Error(`No such question: ${id}`)
    job.state = 'failed'
    job.error = error
  }

  /**
   * Keep source coordinates stable after a file edit. Both coordinates refer
   * to the pre-edit file; anything strictly after `line` moves by `delta`.
   */
  shiftAfter(file: string, line: number, delta: number): void {
    if (delta === 0) return
    for (const job of this.jobs.values()) {
      if (job.file !== file) continue
      if (job.line > line) job.line += delta
      if (job.commentOpenLine > line) job.commentOpenLine += delta
    }
  }

  /** Remove every question whose review block begins at this current file line. */
  cancelAtComment(file: string, commentOpenLine: number): boolean {
    let removed = false
    for (const [id, job] of this.jobs) {
      if (job.file !== file || job.commentOpenLine !== commentOpenLine) continue
      this.jobs.delete(id)
      removed = true
    }
    return removed
  }

  list(): QuestionJob[] {
    return structuredClone([...this.jobs.values()])
  }
}

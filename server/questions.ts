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
import { REVIEW_CLOSE_TAG, REVIEW_OPEN_TAG } from '../shared/reviewComments.ts'
import type { AgentBackend, QuestionClaimResponse, QuestionJob } from '../shared/types.ts'

const QUESTION_PREFIX = /^\s*@(pi|claude|codex)\b[:\s-]*/i

export interface ParsedAgentQuestion {
  backend: AgentBackend
  question: string
}

export interface QuestionContext {
  lineText: string
  excerpt: string
}

export interface EnqueueQuestionInput {
  backend: AgentBackend
  file: string
  line: number
  question: string
  excerpt: string
  lineText: string
  commentOpenLine: number
  commentBody: string
}

interface StoredQuestion extends QuestionJob {
  commentBody: string
}

function sanitizeAnswer(text: string): string {
  return text
    .replaceAll(REVIEW_OPEN_TAG, `\`${REVIEW_OPEN_TAG}\``)
    .replaceAll(REVIEW_CLOSE_TAG, `\`${REVIEW_CLOSE_TAG}\``)
}

export function appendQuestionAnswer(text: string, answer: string): string {
  return `${text.trimEnd()}\n\nAnswer:\n${sanitizeAnswer(answer.trim())}`
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
): Promise<QuestionContext> {
  const content = await readFile(join(cwd, file), 'utf-8')
  const lines = content.split('\n')
  if (line < 1 || line > lines.length) {
    throw new Error(`Line ${line} out of range (file has ${lines.length} lines)`)
  }

  const start = Math.max(1, line - 4)
  const end = Math.min(lines.length, line + 4)
  const width = String(end).length
  const excerptLines: string[] = []
  for (let n = start; n <= end; n++) {
    excerptLines.push(
      `${n === line ? '>' : ' '} ${String(n).padStart(width)} | ${lines[n - 1] ?? ''}`,
    )
  }

  return {
    lineText: lines[line - 1] ?? '',
    excerpt: excerptLines.join('\n'),
  }
}

function publicQuestion(job: StoredQuestion): QuestionClaimResponse['question'] {
  return {
    id: job.id,
    backend: job.backend,
    file: job.file,
    line: job.line,
    question: job.question,
    excerpt: job.excerpt,
    lineText: job.lineText,
    leaseId: job.leaseId!,
  }
}

export class QuestionStore {
  private readonly jobs = new Map<string, StoredQuestion>()

  enqueue(input: EnqueueQuestionInput): StoredQuestion {
    const job: StoredQuestion = {
      id: randomUUID(),
      backend: input.backend,
      file: input.file,
      line: input.line,
      question: input.question,
      excerpt: input.excerpt,
      lineText: input.lineText,
      commentOpenLine: input.commentOpenLine,
      state: 'queued',
      createdAt: Date.now(),
      commentBody: input.commentBody,
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

  getClaimed(id: string, leaseId: string): StoredQuestion {
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

  list(): QuestionJob[] {
    return [...this.jobs.values()].map(({ commentBody: _, ...job }) => job)
  }
}

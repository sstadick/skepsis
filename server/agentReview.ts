/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { appendComment } from './comment.ts'
import { getCommentSyntax } from './commentSyntax.ts'
import { AGENT_SHUTDOWN, type AgentQuestion, type AgentRuntime } from './agentRuntime.ts'
import {
  EMBEDDED_AGENT_BACKEND,
  getQuestionContext,
  hasSerializedQuestionMarker,
  parseStoredReviewThread,
  questionAnswerSuffix,
  questionFailureSuffix,
  resolveSafeReviewFilePath,
} from './questions.ts'
import {
  BARE_COMMENT,
  parseReviewOpenTag,
  REVIEW_CLOSE_TAG,
  REVIEW_OPEN_TAG,
  reviewTagRegex,
  unwrapReviewLine,
} from '../shared/reviewComments.ts'
import type { AgentBackend, QuestionConversationMessage } from '../shared/types.ts'

export interface ManagedAgentQuestion extends AgentQuestion {
  backend: AgentBackend
  lineText: string
  commentOpenLine: number
}

type ReviewMutation = <T>(fn: () => T | Promise<T>) => Promise<T>
type ReviewChangePublisher = (data: {
  reason: 'answered' | 'failed'
  file: string
  line: number
  id: string
  backend: AgentBackend
  state: 'answered' | 'failed'
}) => void

type ActiveQuestion = ManagedAgentQuestion & {
  controller: AbortController
}

type AgentReviewRuntime = Pick<AgentRuntime, 'answer'> & {
  canResume(threadId: string, requestId: string): Promise<boolean>
}

export function requestIdForMessages(messages: QuestionConversationMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex')
}

function pendingQuestionText(messages: QuestionConversationMessage[]): string {
  const message = messages.toReversed().find((entry) => entry.role === 'user')
  if (!message) throw new Error('Pending question thread has no user message')
  return message.content
}

function abortError(reason: string): Error {
  const error = new Error(reason)
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

async function findManagedThread(
  cwd: string,
  file: string,
  threadId: string,
): Promise<{ openLine: number; closeLine: number; text: string } | null> {
  const content = await readFile(await resolveSafeReviewFilePath(cwd, file), 'utf-8')
  const lines = content.split('\n')
  const syntax = getCommentSyntax(file, lines[0] ?? '') ?? BARE_COMMENT

  // The scan must respect file order so the first matching managed block wins.
  // oxlint-disable no-await-in-loop
  for (let openLine = 1; openLine <= lines.length; openLine++) {
    const sourceLine = lines[openLine - 1]
    if (!sourceLine) continue
    const indent = sourceLine.match(/^(\s*)/)?.[1] ?? ''
    const open = parseReviewOpenTag(sourceLine, syntax, indent)
    if (!open?.managed || open.threadId !== threadId) continue
    const comment = readCommentFromLines(file, lines, openLine)
    return {
      openLine,
      closeLine: comment.closeLine,
      text: comment.text,
    }
  }

  // oxlint-enable no-await-in-loop
  return null
}

function readCommentFromLines(
  file: string,
  lines: string[],
  line: number,
): { text: string; closeLine: number; threadId?: string } {
  if (line < 1 || line > lines.length) {
    throw new Error(`Line ${line} out of range`)
  }

  const syntax = getCommentSyntax(file, lines[0] ?? '') ?? BARE_COMMENT
  const openRe = reviewTagRegex(syntax, REVIEW_OPEN_TAG)
  const closeRe = reviewTagRegex(syntax, REVIEW_CLOSE_TAG)
  if (!openRe.test(lines[line - 1]!)) {
    throw new Error(`Line ${line} is not a <review> open tag`)
  }

  let end = line
  while (end < lines.length && !closeRe.test(lines[end]!)) end++
  if (end >= lines.length) {
    throw new Error(`No </review> close tag found after line ${line}`)
  }

  const indent = lines[line - 1]!.match(/^(\s*)/)?.[1] ?? ''
  const open = parseReviewOpenTag(lines[line - 1]!, syntax, indent)
  return {
    text: lines
      .slice(line, end)
      .map((sourceLine) => unwrapReviewLine(sourceLine, syntax, indent))
      .join('\n'),
    closeLine: end + 1,
    ...(open?.threadId ? { threadId: open.threadId } : {}),
  }
}

function logSkippedRecovery(file: string, line: number, error: unknown): void {
  console.warn('[skepsis] skipped malformed review block during recovery', {
    file,
    line,
    error: error instanceof Error ? error.message : String(error),
  })
}

export class AgentReviewCoordinator {
  private readonly active = new Map<string, ActiveQuestion>()
  private readonly opts: {
    cwd: string
    runtime: AgentReviewRuntime
    mutate: ReviewMutation
    publish: ReviewChangePublisher
  }
  private closed = false

  constructor(opts: {
    cwd: string
    runtime: AgentReviewRuntime
    mutate: ReviewMutation
    publish: ReviewChangePublisher
  }) {
    this.opts = opts
  }

  start(question: ManagedAgentQuestion): string {
    const requestId = question.requestId
    const existing = this.active.get(question.threadId)
    if (existing?.requestId === requestId) return requestId
    if (existing) this.abortThread(existing.threadId)
    if (this.closed) return requestId

    const controller = new AbortController()
    const active: ActiveQuestion = { ...question, controller }
    this.active.set(question.threadId, active)
    controller.signal.addEventListener(
      'abort',
      () => {
        if (this.active.get(active.threadId)?.requestId === active.requestId) {
          this.active.delete(active.threadId)
        }
      },
      { once: true },
    )

    this.run(active).catch((error) => {
      this.active.delete(active.threadId)
      console.error('[skepsis] agent review task failed', error)
    })
    return requestId
  }

  abortThread(threadId: string): void {
    const active = this.active.get(threadId)
    if (!active) return
    active.controller.abort(abortError('Review thread resolved'))
    this.active.delete(threadId)
  }

  async recoverPendingQuestions(files: readonly string[]): Promise<void> {
    if (this.closed) return

    const recovered = new Map<string, ManagedAgentQuestion>()

    // Recovery reads the current working copy serially under the same review
    // mutation lock as writers so the scan sees a coherent source state.
    // oxlint-disable no-await-in-loop
    for (const file of files) {
      const path = await resolveSafeReviewFilePath(this.opts.cwd, file).catch(() => null)
      if (!path) continue
      const content = await readFile(path, 'utf-8')
      const lines = content.split('\n')
      const syntax = getCommentSyntax(file, lines[0] ?? '') ?? BARE_COMMENT

      // Each block parse depends on the previous block's close line so this
      // must advance in source order.
      // oxlint-disable-next-line no-await-in-loop
      for (let openLine = 1; openLine <= lines.length; openLine++) {
        const sourceLine = lines[openLine - 1]
        if (!sourceLine) continue
        const indent = sourceLine.match(/^(\s*)/)?.[1] ?? ''
        const open = parseReviewOpenTag(sourceLine, syntax, indent)
        if (!open?.managed || !open.threadId) continue

        const commentOpenLine = openLine
        try {
          const comment = readCommentFromLines(file, lines, commentOpenLine)
          openLine = comment.closeLine

          if (!hasSerializedQuestionMarker(comment.text)) continue
          const thread = parseStoredReviewThread(comment.text, open.threadId)
          if (
            thread.kind !== 'question' ||
            thread.status !== 'pending' ||
            !thread.threadId
          ) {
            continue
          }

          const requestId = requestIdForMessages(thread.messages)
          const active = this.active.get(thread.threadId)
          if (active?.requestId === requestId) {
            recovered.set(thread.threadId, {
              threadId: thread.threadId,
              requestId,
              backend: thread.backend,
              file,
              line: commentOpenLine - 1,
              excerpt: active.excerpt,
              lineText: active.lineText,
              question: pendingQuestionText(thread.messages),
              messages: thread.messages,
              commentOpenLine,
            })
            continue
          }

          if (!(await this.canResume(thread.threadId, requestId))) continue

          const context = await getQuestionContext(
            this.opts.cwd,
            file,
            commentOpenLine - 1,
            {
              start: commentOpenLine,
              end: comment.closeLine,
            },
          )
          recovered.set(thread.threadId, {
            threadId: thread.threadId,
            requestId,
            backend: thread.backend,
            file,
            line: commentOpenLine - 1,
            excerpt: context.excerpt,
            lineText: context.lineText,
            question: pendingQuestionText(thread.messages),
            messages: thread.messages,
            commentOpenLine,
          })
        } catch (error) {
          logSkippedRecovery(file, commentOpenLine, error)
        }
      }
    }

    // oxlint-enable no-await-in-loop
    for (const active of this.active.values()) {
      const recoveredQuestion = recovered.get(active.threadId)
      if (recoveredQuestion?.requestId === active.requestId) continue
      this.abortThread(active.threadId)
    }

    for (const question of recovered.values()) this.start(question)
  }

  async close(): Promise<void> {
    this.closed = true
    for (const active of this.active.values()) active.controller.abort(AGENT_SHUTDOWN)
    this.active.clear()
  }

  private async canResume(threadId: string, requestId: string): Promise<boolean> {
    return this.opts.runtime.canResume(threadId, requestId)
  }

  private async run(active: ActiveQuestion): Promise<void> {
    try {
      const answer = await this.opts.runtime.answer(
        {
          threadId: active.threadId,
          requestId: active.requestId,
          file: active.file,
          line: active.line,
          excerpt: active.excerpt,
          question: active.question,
          messages: active.messages,
        },
        active.controller.signal,
      )
      if (active.controller.signal.aborted) return
      await this.persist(active, 'answered', answer)
    } catch (error) {
      if (active.controller.signal.aborted || isAbortError(error)) return
      await this.persist(
        active,
        'failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private async persist(
    active: ActiveQuestion,
    state: 'answered' | 'failed',
    text: string,
  ): Promise<void> {
    try {
      await this.opts.mutate(async () => {
        const current = this.active.get(active.threadId)
        if (
          !current ||
          current.requestId !== active.requestId ||
          current.controller.signal.aborted
        ) {
          return
        }

        const thread = await findManagedThread(this.opts.cwd, active.file, active.threadId)
        if (!thread) {
          this.active.delete(active.threadId)
          return
        }

        const parsed = parseStoredReviewThread(thread.text, active.threadId)
        if (parsed.kind !== 'question' || parsed.status !== 'pending') {
          this.active.delete(active.threadId)
          return
        }
        if (requestIdForMessages(parsed.messages) !== active.requestId) {
          this.active.delete(active.threadId)
          return
        }

        await resolveSafeReviewFilePath(this.opts.cwd, active.file)
        await appendComment(
          this.opts.cwd,
          active.file,
          thread.openLine,
          state === 'answered' ? questionAnswerSuffix(text) : questionFailureSuffix(text),
        )
        this.active.delete(active.threadId)
        this.opts.publish({
          reason: state,
          file: active.file,
          line: thread.openLine - 1,
          id: active.requestId,
          backend: active.backend,
          state,
        })
      })
    } catch (error) {
      this.active.delete(active.threadId)
      console.error('[skepsis] agent review persistence failed', error)
    }
  }
}

export function buildManagedQuestion(input: {
  threadId: string
  file: string
  line: number
  excerpt: string
  lineText: string
  question: string
  messages: QuestionConversationMessage[]
  commentOpenLine: number
  backend?: AgentBackend
}): ManagedAgentQuestion {
  return {
    threadId: input.threadId,
    requestId: requestIdForMessages(input.messages),
    backend: input.backend ?? EMBEDDED_AGENT_BACKEND,
    file: input.file,
    line: input.line,
    excerpt: input.excerpt,
    lineText: input.lineText,
    question: input.question,
    messages: input.messages,
    commentOpenLine: input.commentOpenLine,
  }
}

export { EMBEDDED_AGENT_BACKEND }

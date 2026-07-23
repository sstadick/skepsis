/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import type { AgentBackend, QuestionConversationMessage } from './types.ts'

export type CommentSyntax = { prefix: string; suffix?: string }

export const HASH_COMMENT = { prefix: '#' } as const satisfies CommentSyntax
export const SLASH_COMMENT = { prefix: '//' } as const satisfies CommentSyntax
export const XML_COMMENT = {
  prefix: '<!--',
  suffix: '-->',
} as const satisfies CommentSyntax
export const BLOCK_COMMENT = { prefix: '/*', suffix: '*/' } as const satisfies CommentSyntax
export const DASH_COMMENT = { prefix: '--' } as const satisfies CommentSyntax
export const PERCENT_COMMENT = { prefix: '%' } as const satisfies CommentSyntax
export const SEMICOLON_COMMENT = { prefix: ';' } as const satisfies CommentSyntax
export const QUOTE_COMMENT = { prefix: '"' } as const satisfies CommentSyntax
// Fallback for files where we can't determine a comment syntax (unknown or
// ambiguous file types, or formats with no comment support at all, like CSV).
// Review comments are transient working-copy annotations, so a bare tag that
// isn't a syntactically valid comment is still more useful than refusing to
// insert one.
export const BARE_COMMENT = { prefix: '' } as const satisfies CommentSyntax

export const REVIEW_COMMENT_SYNTAXES = [
  HASH_COMMENT,
  SLASH_COMMENT,
  XML_COMMENT,
  BLOCK_COMMENT,
  DASH_COMMENT,
  PERCENT_COMMENT,
  SEMICOLON_COMMENT,
  QUOTE_COMMENT,
] as const satisfies readonly CommentSyntax[]

export const REVIEW_OPEN_TAG = '<review>'
export const REVIEW_CLOSE_TAG = '</review>'
const UUID_SOURCE =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}'
const MANAGED_REVIEW_OPEN_PREFIX = '<review data-skepsis="1" data-thread-id="'
const MANAGED_REVIEW_OPEN_BODY_PATTERN = new RegExp(
  `^${escapeRegex(MANAGED_REVIEW_OPEN_PREFIX)}(${UUID_SOURCE})">$`,
)

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function reviewTagSource(syntax: CommentSyntax, tag: string): string {
  const prefix = escapeRegex(syntax.prefix)
  const suffix = syntax.suffix ? `(?:\\s*${escapeRegex(syntax.suffix)})?` : ''
  const tagSource =
    tag === REVIEW_OPEN_TAG
      ? `(?:${escapeRegex(REVIEW_OPEN_TAG)}|${escapeRegex(
          MANAGED_REVIEW_OPEN_PREFIX,
        )}(?:${UUID_SOURCE})">)`
      : escapeRegex(tag)
  return `${prefix}\\s*${tagSource}${suffix}`
}

export function managedReviewOpenTag(threadId: string): string {
  return `${MANAGED_REVIEW_OPEN_PREFIX}${threadId}">`
}

export function reviewTagRegex(syntax: CommentSyntax, tag: string): RegExp {
  return new RegExp(`^\\s*${reviewTagSource(syntax, tag)}\\s*$`)
}

export function anyReviewTagRegex(syntaxes: readonly CommentSyntax[], tag: string): RegExp {
  const body = syntaxes.map((syntax) => reviewTagSource(syntax, tag)).join('|')
  return new RegExp(`^\\s*(?:${body})\\s*$`)
}

export const REVIEW_OPEN_PATTERN = anyReviewTagRegex(
  REVIEW_COMMENT_SYNTAXES,
  REVIEW_OPEN_TAG,
)
export const REVIEW_CLOSE_PATTERN = anyReviewTagRegex(
  REVIEW_COMMENT_SYNTAXES,
  REVIEW_CLOSE_TAG,
)

// Deliberately not part of the patterns above: a bare tag line could appear as
// genuine content in a normal file (e.g. a literal <review> element in an XML
// fixture), so the client applies these only to files the server has flagged
// as getting the bare fallback.
export const BARE_REVIEW_OPEN_PATTERN = reviewTagRegex(BARE_COMMENT, REVIEW_OPEN_TAG)
export const BARE_REVIEW_CLOSE_PATTERN = reviewTagRegex(BARE_COMMENT, REVIEW_CLOSE_TAG)

export type ReviewThreadContent =
  | { kind: 'comment'; body: string; threadId?: string }
  | {
      kind: 'question'
      backend: AgentBackend
      /** Stable source-backed identity for Skepsis-managed review blocks. */
      threadId?: string
      /** The original question. `messages` contains the complete thread. */
      question: string
      messages: QuestionConversationMessage[]
      status: 'pending' | 'answered' | 'failed'
    }

const AGENT_QUESTION_PREFIX = /^\s*@(pi|claude|codex)\b[:\s-]*/i
export const SKEPSIS_ANSWER_SEPARATOR = '\n\nSkepsis-Answer:\n'
export const SKEPSIS_FAILURE_SEPARATOR = '\n\nSkepsis-Failure:\n'
export const SKEPSIS_ANSWER_STATE = '\n\nSkepsis-State: answered'
export const SKEPSIS_FAILURE_STATE = '\n\nSkepsis-State: failed'
export const SKEPSIS_THREAD_MARKER = '\n\nSkepsis-Thread: 1'
export const SKEPSIS_THREAD_ID_PREFIX = '\n\nSkepsis-Thread: 1; id='
export const SKEPSIS_FOLLOWUP_SEPARATOR = '\n\nSkepsis-Followup:\n'
export const LEGACY_ANSWER_SEPARATOR = '\n\nAnswer:\n'
export const REVIEW_STORAGE_RESERVED_TOKENS = [
  REVIEW_OPEN_TAG,
  '<review ',
  REVIEW_CLOSE_TAG,
  'Skepsis-Answer:',
  'Skepsis-Failure:',
  'Skepsis-Followup:',
  'Skepsis-State:',
  'Skepsis-Thread:',
  'Answer:',
] as const

const THREAD_MARKER_PATTERN = new RegExp(
  `${escapeRegex(
    SKEPSIS_THREAD_MARKER,
  )}(?:; id=(${UUID_SOURCE}))?(?=\\n\\nSkepsis-Followup:(?:\\n|$))`,
)
const THREAD_LIKE_PATTERN = /\n\nSkepsis-Thread:[^\n]*(?=\n\nSkepsis-Followup:(?:\n|$))/
const REVIEW_STORAGE_TOKENS_LONGEST_FIRST = [...REVIEW_STORAGE_RESERVED_TOKENS].toSorted(
  (left, right) => right.length - left.length,
)

export function decodeReviewStorageText(text: string): string {
  let decoded = text
  for (const token of REVIEW_STORAGE_RESERVED_TOKENS) {
    decoded = decoded.replaceAll(`\`${token}\``, token)
  }
  return decoded
}

function hasUnescapedReviewStorageToken(text: string): boolean {
  for (let at = 0; at < text.length; at++) {
    const token = REVIEW_STORAGE_TOKENS_LONGEST_FIRST.find((candidate) =>
      text.startsWith(candidate, at),
    )
    if (!token) continue
    if (text[at - 1] !== '`' || text[at + token.length] !== '`') return true
    at += token.length - 1
  }
  return false
}

type TerminalResponse =
  | { status: 'answered'; prompt: string; answer: string }
  | { status: 'failed'; prompt: string; failure: string }

function isManagedBaseValid(body: string, result: TerminalResponse | null): boolean {
  if (!result) return !hasUnescapedReviewStorageToken(body)
  if (body.includes(LEGACY_ANSWER_SEPARATOR)) return false
  const response = result.status === 'answered' ? result.answer : result.failure
  return (
    !hasUnescapedReviewStorageToken(result.prompt) &&
    !hasUnescapedReviewStorageToken(response)
  )
}

/**
 * Current agent results use a terminal state sentinel. The server reversibly
 * escapes reserved markers in user/agent text, making the last matching
 * section marker unambiguous. The legacy fallback below necessarily retains
 * the old bare "Answer:" ambiguity for already-persisted threads.
 */
function parseTerminalResponse(body: string): TerminalResponse | null {
  if (body.endsWith(SKEPSIS_ANSWER_STATE)) {
    const stateAt = body.length - SKEPSIS_ANSWER_STATE.length
    const answerAt = body.lastIndexOf(SKEPSIS_ANSWER_SEPARATOR, stateAt - 1)
    if (answerAt >= 0) {
      return {
        status: 'answered',
        prompt: body.slice(0, answerAt),
        answer: body.slice(answerAt + SKEPSIS_ANSWER_SEPARATOR.length, stateAt).trim(),
      }
    }
  }

  if (body.endsWith(SKEPSIS_FAILURE_STATE)) {
    const stateAt = body.length - SKEPSIS_FAILURE_STATE.length
    const failureAt = body.lastIndexOf(SKEPSIS_FAILURE_SEPARATOR, stateAt - 1)
    if (failureAt >= 0) {
      return {
        status: 'failed',
        prompt: body.slice(0, failureAt),
        failure: body.slice(failureAt + SKEPSIS_FAILURE_SEPARATOR.length, stateAt).trim(),
      }
    }
  }

  // Skepsis versions before terminal state sentinels persisted replies with a
  // bare "Answer:" section. New questions escape that reserved token before
  // storage, so this ambiguous fallback is limited to old/manual source.
  const legacyAnswerAt = body.lastIndexOf(LEGACY_ANSWER_SEPARATOR)
  if (legacyAnswerAt >= 0) {
    const answer = body.slice(legacyAnswerAt + LEGACY_ANSWER_SEPARATOR.length).trim()
    if (answer) {
      return {
        status: 'answered',
        prompt: body.slice(0, legacyAnswerAt),
        answer,
      }
    }
  }

  return null
}

/**
 * Remove the source file's comment decoration from one line in a review
 * block. Review comments are rendered one source-comment per body line, so
 * this is the inverse of server/comment.ts's renderCommentLines().
 */
export function unwrapReviewLine(
  line: string,
  syntax: CommentSyntax,
  indent: string,
): string {
  const sourceLine = line.endsWith('\n') ? line.slice(0, -1).replace(/\r$/, '') : line
  let body = sourceLine.startsWith(indent)
    ? sourceLine.slice(indent.length)
    : sourceLine.trimStart()
  if (!syntax.prefix) return body
  if (!body.startsWith(syntax.prefix)) return body

  body = body.slice(syntax.prefix.length)
  if (body.startsWith(' ')) body = body.slice(1)

  if (syntax.suffix) {
    if (body.endsWith(` ${syntax.suffix}`)) {
      body = body.slice(0, -(syntax.suffix.length + 1))
    } else if (body.endsWith(syntax.suffix)) {
      body = body.slice(0, -syntax.suffix.length)
    }
  }
  return body
}

export function parseReviewOpenTag(
  line: string,
  syntax: CommentSyntax,
  indent = '',
): { managed: boolean; threadId?: string } | null {
  const body = unwrapReviewLine(line, syntax, indent).trim()
  if (body === REVIEW_OPEN_TAG) return { managed: false }
  const match = body.match(MANAGED_REVIEW_OPEN_BODY_PATTERN)
  if (!match) return null
  return { managed: true, threadId: match[1]! }
}

function questionFromPrompt(
  prompt: string,
): { backend: AgentBackend; question: string } | null {
  const promptLines = prompt.split('\n')
  const firstPromptLine = promptLines[0] ?? ''
  const match = firstPromptLine.match(AGENT_QUESTION_PREFIX)
  if (!match) return null
  const question = [firstPromptLine.slice(match[0].length), ...promptLines.slice(1)]
    .join('\n')
    .trim()
  if (!question) return null
  return {
    backend: match[1]!.toLowerCase() as AgentBackend,
    question,
  }
}

function earliestResultSeparator(
  text: string,
): { at: number; status: 'answered' | 'failed'; separator: string } | null {
  const answerAt = text.indexOf(SKEPSIS_ANSWER_SEPARATOR)
  const failureAt = text.indexOf(SKEPSIS_FAILURE_SEPARATOR)
  if (answerAt < 0 && failureAt < 0) return null
  if (failureAt < 0 || (answerAt >= 0 && answerAt < failureAt)) {
    return {
      at: answerAt,
      status: 'answered',
      separator: SKEPSIS_ANSWER_SEPARATOR,
    }
  }
  return {
    at: failureAt,
    status: 'failed',
    separator: SKEPSIS_FAILURE_SEPARATOR,
  }
}

/**
 * Parse the append-only, versioned portion of a question thread. A follow-up
 * without a result is pending, just like an initial question without a state
 * marker. Result frames retain terminal state sentinels so incomplete writes
 * cannot be displayed as agent replies.
 */
function parseThreadExtension(text: string): {
  messages: QuestionConversationMessage[]
  status: 'pending' | 'answered' | 'failed'
} | null {
  const messages: QuestionConversationMessage[] = []
  let remaining = text
  let status: 'pending' | 'answered' | 'failed' | undefined

  while (remaining) {
    if (!remaining.startsWith(SKEPSIS_FOLLOWUP_SEPARATOR)) return null
    const afterMarker = remaining.slice(SKEPSIS_FOLLOWUP_SEPARATOR.length)
    const result = earliestResultSeparator(afterMarker)
    if (!result) {
      const storedContent = afterMarker.trim()
      if (!storedContent || hasUnescapedReviewStorageToken(storedContent)) return null
      const content = decodeReviewStorageText(storedContent)
      messages.push({ role: 'user', content })
      status = 'pending'
      remaining = ''
      break
    }

    const storedContent = afterMarker.slice(0, result.at).trim()
    if (!storedContent || hasUnescapedReviewStorageToken(storedContent)) return null
    const content = decodeReviewStorageText(storedContent)
    messages.push({ role: 'user', content })

    const afterResult = afterMarker.slice(result.at + result.separator.length)
    const state =
      result.status === 'answered' ? SKEPSIS_ANSWER_STATE : SKEPSIS_FAILURE_STATE
    const stateAt = afterResult.indexOf(state)
    if (stateAt < 0) return null
    const storedResponse = afterResult.slice(0, stateAt).trim()
    if (!storedResponse || hasUnescapedReviewStorageToken(storedResponse)) return null
    const response = decodeReviewStorageText(storedResponse)
    messages.push({
      role: 'assistant',
      content: response,
      outcome: result.status,
    })
    status = result.status
    remaining = afterResult.slice(stateAt + state.length)
    if (remaining && !remaining.startsWith(SKEPSIS_FOLLOWUP_SEPARATOR)) return null
  }

  return status ? { messages, status } : null
}

function findThreadMarker(
  text: string,
  from = 0,
): { at: number; length: number; threadId?: string } | null {
  const match = THREAD_MARKER_PATTERN.exec(text.slice(from))
  if (!match) return null
  return {
    at: from + match.index,
    length: match[0].length,
    ...(match[1] ? { threadId: match[1] } : {}),
  }
}

/**
 * Parse the source-backed body of a review block into presentation data.
 * `bodyLines` excludes the `<review>` and `</review>` marker lines; `indent`
 * is the indentation of the opening marker.
 */
export function parseReviewThread(
  bodyLines: readonly string[],
  syntax: CommentSyntax,
  indent = '',
  managedThreadId?: string,
): ReviewThreadContent {
  const unwrappedLines = bodyLines.map((line) => unwrapReviewLine(line, syntax, indent))
  const body = unwrappedLines.join('\n').trim()
  const decodeBase = managedThreadId
    ? decodeReviewStorageText
    : (text: string): string => text
  const threadMarker = findThreadMarker(body)
  const legacyBody = threadMarker ? body.slice(0, threadMarker.at) : body
  const result = parseTerminalResponse(legacyBody)

  if (!threadMarker && THREAD_LIKE_PATTERN.test(body)) {
    return {
      kind: 'comment',
      body,
      ...(managedThreadId ? { threadId: managedThreadId } : {}),
    }
  }

  // Managed payloads escape every reserved token. Only the one parsed result
  // frame may remain raw in the base exchange; extensions validate each of
  // their payload segments separately.
  if (managedThreadId && !isManagedBaseValid(legacyBody, result)) {
    return { kind: 'comment', body, threadId: managedThreadId }
  }

  const parsed = questionFromPrompt(result?.prompt ?? legacyBody)
  if (!parsed) {
    return {
      kind: 'comment',
      body: decodeBase(body),
      ...(managedThreadId ? { threadId: managedThreadId } : {}),
    }
  }

  const messages: QuestionConversationMessage[] = [
    { role: 'user', content: decodeBase(parsed.question) },
  ]
  if (result?.status === 'answered') {
    messages.push({
      role: 'assistant',
      content: decodeBase(result.answer),
      outcome: 'answered',
    })
  } else if (result?.status === 'failed') {
    messages.push({
      role: 'assistant',
      content: decodeBase(result.failure),
      outcome: 'failed',
    })
  }

  if (threadMarker) {
    // The version boundary is valid only after a complete legacy exchange.
    // This prevents old agent prose containing the new marker from silently
    // changing meaning.
    const secondMarker = findThreadMarker(body, threadMarker.at + threadMarker.length)
    if (
      !result ||
      secondMarker ||
      (managedThreadId &&
        threadMarker.threadId &&
        managedThreadId !== threadMarker.threadId)
    ) {
      return {
        kind: 'comment',
        body,
        ...(managedThreadId ? { threadId: managedThreadId } : {}),
      }
    }
    const extension = parseThreadExtension(
      body.slice(threadMarker.at + threadMarker.length),
    )
    if (!extension) {
      return {
        kind: 'comment',
        body,
        ...(managedThreadId ? { threadId: managedThreadId } : {}),
      }
    }
    messages.push(...extension.messages)
    const threadId = managedThreadId ?? threadMarker.threadId
    return {
      kind: 'question',
      backend: parsed.backend,
      ...(threadId ? { threadId } : {}),
      question: decodeBase(parsed.question),
      messages,
      status: extension.status,
    }
  }

  return {
    kind: 'question',
    backend: parsed.backend,
    ...(managedThreadId ? { threadId: managedThreadId } : {}),
    question: decodeBase(parsed.question),
    messages,
    status: result?.status ?? 'pending',
  }
}

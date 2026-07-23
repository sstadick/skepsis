/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { getCommentSyntax } from './commentSyntax.ts'
import {
  BARE_COMMENT,
  type CommentSyntax,
  managedReviewOpenTag,
  parseReviewOpenTag,
  REVIEW_CLOSE_TAG,
  REVIEW_OPEN_TAG,
  reviewTagRegex,
  unwrapReviewLine,
} from '../shared/reviewComments.ts'

function renderBodyLines(syntax: CommentSyntax, indent: string, text: string): string[] {
  const { prefix, suffix } = syntax
  const wrap = (body: string) => indent + [prefix, body, suffix].filter(Boolean).join(' ')
  return text.split('\n').map((line) => wrap(line))
}

function renderCommentLines(
  syntax: CommentSyntax,
  indent: string,
  text: string,
  threadId: string,
): string[] {
  const { prefix, suffix } = syntax
  const wrap = (body: string) => indent + [prefix, body, suffix].filter(Boolean).join(' ')
  return [
    wrap(managedReviewOpenTag(threadId)),
    ...renderBodyLines(syntax, indent, text),
    wrap(REVIEW_CLOSE_TAG),
  ]
}

function findCommentRange(
  lines: string[],
  syntax: CommentSyntax,
  line: number,
): { end: number } {
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
  return { end }
}

export async function readComment(
  cwd: string,
  file: string,
  line: number,
): Promise<{ text: string; closeLine: number; threadId?: string }> {
  const filePath = join(cwd, file)
  const content = await readFile(filePath, 'utf-8')
  const lines = content.split('\n')
  if (line < 1 || line > lines.length) {
    throw new Error(`Line ${line} out of range`)
  }

  const syntax = getCommentSyntax(file, lines[0] ?? '') ?? BARE_COMMENT
  const { end } = findCommentRange(lines, syntax, line)
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

/**
 * Append body text immediately before a review block's closing tag. The
 * fragment is interpreted as continuing the existing body, so one leading
 * newline advances to the next source line rather than creating an extra
 * blank row.
 */
export async function appendComment(
  cwd: string,
  file: string,
  line: number,
  text: string,
): Promise<{ insertedLineCount: number; previousCloseLine: number }> {
  const filePath = join(cwd, file)
  const content = await readFile(filePath, 'utf-8')
  const lines = content.split('\n')
  if (line < 1 || line > lines.length) {
    throw new Error(`Line ${line} out of range`)
  }

  const syntax = getCommentSyntax(file, lines[0] ?? '') ?? BARE_COMMENT
  const { end } = findCommentRange(lines, syntax, line)
  const indent = lines[line - 1]!.match(/^(\s*)/)?.[1] ?? ''
  const fragmentLines = text.split('\n')
  if (text.startsWith('\n')) fragmentLines.shift()
  const rendered = renderBodyLines(syntax, indent, fragmentLines.join('\n'))

  lines.splice(end, 0, ...rendered)
  await writeFile(filePath, lines.join('\n'))
  return {
    insertedLineCount: rendered.length,
    previousCloseLine: end + 1,
  }
}

export async function insertComment(
  cwd: string,
  file: string,
  afterLine: number,
  text: string,
): Promise<{ openLine: number; insertedLineCount: number; threadId: string }> {
  const filePath = join(cwd, file)
  const content = await readFile(filePath, 'utf-8')
  const lines = content.split('\n')

  if (afterLine < 1 || afterLine > lines.length) {
    throw new Error(`Line ${afterLine} out of range (file has ${lines.length} lines)`)
  }

  const targetLine = lines[afterLine - 1]!
  const indent = targetLine.match(/^(\s*)/)?.[1] ?? ''
  const syntax: CommentSyntax = getCommentSyntax(file, lines[0] ?? '') ?? BARE_COMMENT
  const threadId = randomUUID()
  const commentLines = renderCommentLines(syntax, indent, text, threadId)

  lines.splice(afterLine, 0, ...commentLines)
  await writeFile(filePath, lines.join('\n'))
  return { openLine: afterLine + 1, insertedLineCount: commentLines.length, threadId }
}

export async function replaceComment(
  cwd: string,
  file: string,
  line: number,
  text: string,
): Promise<{
  removedLineCount: number
  insertedLineCount: number
  lineDelta: number
}> {
  const filePath = join(cwd, file)
  const content = await readFile(filePath, 'utf-8')
  const lines = content.split('\n')

  if (line < 1 || line > lines.length) {
    throw new Error(`Line ${line} out of range`)
  }

  const syntax = getCommentSyntax(file, lines[0] ?? '') ?? BARE_COMMENT
  const { end } = findCommentRange(lines, syntax, line)
  const indent = lines[line - 1]!.match(/^(\s*)/)?.[1] ?? ''
  const commentLines = [
    lines[line - 1]!,
    ...renderBodyLines(syntax, indent, text),
    lines[end]!,
  ]
  const removedLineCount = end - line + 2

  lines.splice(line - 1, removedLineCount, ...commentLines)
  await writeFile(filePath, lines.join('\n'))
  return {
    removedLineCount,
    insertedLineCount: commentLines.length,
    lineDelta: commentLines.length - removedLineCount,
  }
}

export async function removeComment(
  cwd: string,
  file: string,
  line: number,
): Promise<{ removedLineCount: number }> {
  const filePath = join(cwd, file)
  const content = await readFile(filePath, 'utf-8')
  const lines = content.split('\n')

  if (line < 1 || line > lines.length) {
    throw new Error(`Line ${line} out of range`)
  }

  const syntax = getCommentSyntax(file, lines[0] ?? '') ?? BARE_COMMENT
  const { end } = findCommentRange(lines, syntax, line)
  const removedLineCount = end - line + 2
  lines.splice(line - 1, removedLineCount)
  await writeFile(filePath, lines.join('\n'))
  return { removedLineCount }
}
